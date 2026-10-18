import { detectLimit } from './detect.js';
import { mergePatterns } from './patterns.js';
import { runLane, type RunOptions } from './runner.js';
import type { LaneStore } from './state.js';
import type { Lane } from './types.js';

export type ProbeStatus = 'available' | 'limited' | 'auth-error' | 'error' | 'timeout';

export interface ProbeResult {
  lane: string;
  status: ProbeStatus;
  /** The output line that drove the classification. */
  evidence: string;
  /** Parsed reset instant when the lane reported one. */
  resetAt: Date | null;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Auth/billing/plan failures that never resolve on their own. Probing these
 * marks the lane auth-error instead of burning retries; `qp run` treats the
 * lane as failed and moves on.
 */
const AUTH_PATTERNS: RegExp[] = [
  /\b401\b.*\b(?:unauthorized|authentication|auth)/i,
  /\b403\b.*\b(?:forbidden|permission denied|access denied)/i,
  /invalid[_ ]?(?:x?[-_])?api[_ ]?key/i,
  /incorrect api key/i,
  /authentication (?:failed|error|required)/i,
  /unauthorized/i,
  /invalid(?: or expired)? (?:oauth )?token/i,
  /token (?:expired|revoked)/i,
  /not (?:logged in|authenticated|signed in)/i,
  /please (?:run|use)?\s*\/?login\b/i,
  /auth(?:entication)? token is (?:missing|invalid)/i,
  /to use codex with your chatgpt plan, upgrade to plus/i,
  /subscription (?:required|expired|inactive)/i,
  /billing (?:error|required|disabled)/i,
  /no (?:active|valid) (?:subscription|plan)/i,
];

/** Find the first auth-evidence line in output; null when none matches. */
export function detectAuthError(output: string): string | null {
  for (const line of output.split('\n')) {
    for (const p of AUTH_PATTERNS) {
      if (p.test(line)) return line.trim().slice(0, 300);
    }
  }
  return null;
}

export interface ProbeOptions {
  cwd: string;
  /** Prompt sent to the lane. Keep it trivial — quota is scarce. */
  prompt?: string;
  /** Hard cap on the probe attempt; overrides lane.timeoutMinutes when set. */
  timeoutMs?: number;
  runOpts?: Omit<RunOptions, 'cwd' | 'timeoutMs'>;
  now?: () => Date;
}

export const DEFAULT_PROBE_PROMPT = 'Reply with exactly this word and nothing else: OK';
const DEFAULT_PROBE_TIMEOUT_MS = 3 * 60_000;

/**
 * Send a tiny prompt through one lane and classify it:
 *   timeout | limited (parse the reset the CLI printed) | auth-error |
 *   available (exit 0) | error (anything else).
 * A discovered reset is written to the lane store; an auth error blocks the
 * lane for a day so the orchestrator skips it until the user fixes creds.
 * Available/error probes only update lastResult — `qp status` then shows the
 * lane as observed rather than unknown.
 */
export async function probeLane(
  lane: Lane,
  store: LaneStore,
  opts: ProbeOptions,
): Promise<ProbeResult> {
  const now = opts.now ?? (() => new Date());
  const prompt = opts.prompt ?? DEFAULT_PROBE_PROMPT;
  const timeoutMs = opts.timeoutMs ?? (lane.timeoutMinutes > 0 ? lane.timeoutMinutes * 60_000 : DEFAULT_PROBE_TIMEOUT_MS);
  const probeLaneConfig = { ...lane, timeoutMinutes: timeoutMs / 60_000 };

  const result = await runLane(probeLaneConfig, prompt, {
    cwd: opts.cwd,
    tee: opts.runOpts?.tee ?? false,
    logsDir: opts.runOpts?.logsDir,
    tailBytes: opts.runOpts?.tailBytes,
  });

  const base = { lane: lane.name, exitCode: result.exitCode, durationMs: result.durationMs };

  if (result.timedOut) {
    store.markResult(lane.name, 'timeout');
    return { ...base, status: 'timeout', evidence: `probe timed out after ${Math.round(timeoutMs / 1000)}s`, resetAt: null };
  }

  const patterns = mergePatterns(lane.kind, lane.patterns);
  const detection = detectLimit(result.outputTail, result.exitCode, patterns, now());
  if (detection) {
    const resetAt =
      detection.resetAt ?? new Date(now().getTime() + lane.defaultResetMinutes * 60_000);
    store.markBlocked(lane.name, resetAt, detection.evidence);
    return { ...base, status: 'limited', evidence: detection.evidence, resetAt };
  }

  const authEvidence = detectAuthError(result.outputTail);
  if (authEvidence) {
    // No real reset exists; block ~24h so a watcher doesn't spin on it.
    const until = new Date(now().getTime() + 24 * 3_600_000);
    store.markBlocked(lane.name, until, authEvidence);
    return { ...base, status: 'auth-error', evidence: authEvidence, resetAt: null };
  }

  if (result.exitCode === 0) {
    store.markResult(lane.name, 'done');
    return { ...base, status: 'available', evidence: 'probe completed (exit 0)', resetAt: null };
  }

  store.markResult(lane.name, 'failed');
  const tail = result.outputTail.trim().split('\n').filter(Boolean).pop() ?? '';
  return {
    ...base,
    status: 'error',
    evidence: tail.slice(0, 300) || `exit code ${result.exitCode ?? 'signal'}`,
    resetAt: null,
  };
}
