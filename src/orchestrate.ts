import { authErrorAfter, detectionWindow, detectLimit, detectUsage } from './detect.js';
import { gitDiffPatch, gitDiffSummary } from './git.js';
import { fireHooks } from './hooks.js';
import { mergePatterns } from './patterns.js';
import { renderPrompt } from './prompt.js';
import { runLane, type RunOptions, type RunResult } from './runner.js';
import { LaneStore } from './state.js';
import type { AttemptResult, Config, Lane, TaskVerdict } from './types.js';
import { DEFAULTS } from './config.js';

export interface OrchestrateOptions {
  cwd: string;
  runOpts?: Omit<RunOptions, 'cwd'>;
  /**
   * When every lane is blocked: wait for the earliest reset and retry.
   * --no-wait overrides. Default true.
   */
  wait?: boolean;
  /**
   * Prior attempts of an earlier interrupted/failed run being continued.
   * Seeded into the handoff so the next lane sees the full history.
   */
  resume?: AttemptResult[];
  /**
   * Called with the accumulated attempts after each lane attempt, then
   * once more with the final verdict before runTask returns. Used by the
   * CLI to persist a resumable run record.
   */
  onUpdate?: (attempts: AttemptResult[], verdict: TaskVerdict | null) => void;
  /** Injected for tests. */
  now?: () => Date;
  /** Sleep implementation (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Lane lease set (parallel runs): a lane attempt starts only after its
   * lease is acquired; the lease is released when the child exits.
   * `leaseOwner` identifies this run inside the lease file (run record id).
   */
  leases?: {
    acquire(lane: string, runId: string): boolean;
    heldByOther(lane: string, runId: string): unknown;
    release(lane: string): void;
  };
  leaseOwner?: string;
  /** Handoff diff mode; overrides cfg.handoff.diff. Default 'stat'. */
  diffMode?: 'none' | 'stat' | 'full';
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How often to re-check lanes when all are leased (not blocked) by others. */
const LEASE_POLL_MS = 5_000;

/**
 * Run `task` through the ordered lanes. A lane that hits its limit is marked
 * blocked until its reset time and the task — plus a handoff note — moves to
 * the next free lane. A lane that fails without a limit also moves on (the
 * handoff tells the next agent what happened); `done` ends the loop.
 *
 * When every lane is blocked, wait until the earliest reset (bounded by
 * defaults.maxWaitMinutes) and resume — preferred lanes get the task back
 * once their window rolls over.
 */
export async function runTask(
  task: string,
  cfg: Config,
  lanes: Lane[],
  store: LaneStore,
  opts: OrchestrateOptions,
): Promise<TaskVerdict> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? defaultSleep;
  const wait = opts.wait ?? true;
  const maxWaitMs = (cfg.defaults?.maxWaitMinutes ?? DEFAULTS.maxWaitMinutes) * 60_000;
  const notify = opts.onUpdate ?? (() => {});
  const diffMode = opts.diffMode ?? cfg.handoff?.diff ?? 'stat';
  const owner = opts.leaseOwner ?? `pid-${process.pid}`;
  const started = now().getTime();
  const attempts: AttemptResult[] = [...(opts.resume ?? [])];

  // Lanes that failed or timed out during THIS invocation are not retried:
  // a broken lane (bad flag, missing login, hung CLI) would otherwise be
  // re-run every round while the others wait for their resets. Attempts
  // seeded from --resume don't count — resuming is an explicit retry.
  const broken = new Set<string>();

  for (;;) {
    const candidates = lanes.filter((l) => !broken.has(l.name));
    if (candidates.length === 0) {
      const last = attempts[attempts.length - 1];
      const msg =
        last?.verdict.type === 'failed'
          ? last.verdict.evidence
          : last?.verdict.type ?? 'unknown';
      const verdict: TaskVerdict = { type: 'failed', attempts, lastError: msg };
      notify(attempts, verdict);
      return verdict;
    }
    const free = candidates.filter(
      (l) => store.blockedUntil(l.name, now()) === null && !opts.leases?.heldByOther(l.name, owner),
    );
    if (free.length === 0) {
      const resets = candidates
        .map((l) => store.blockedUntil(l.name, now()))
        .filter((d): d is Date => d !== null)
        .sort((a, b) => a.getTime() - b.getTime());
      const earliest = resets[0] ?? null;
      const leased = opts.leases !== undefined && candidates.some((l) => opts.leases!.heldByOther(l.name, owner));
      if (!wait || (earliest === null && !leased)) {
        const verdict: TaskVerdict = { type: 'all-blocked', attempts, earliestReset: earliest };
        notify(attempts, verdict);
        return verdict;
      }
      // A leased lane may free up any second — cap the nap at LEASE_POLL_MS
      // even when a blocked lane's reset is further out.
      const waitMs = earliest === null ? LEASE_POLL_MS : Math.min(LEASE_POLL_MS, earliest.getTime() - now().getTime());
      if (now().getTime() - started + waitMs > maxWaitMs) {
        const verdict: TaskVerdict = { type: 'timeout', attempts };
        notify(attempts, verdict);
        return verdict;
      }
      if (earliest === null) {
        // Every lane is leased by another run but none is quota-blocked:
        // poll briefly instead of sleeping for a reset that doesn't exist.
        await sleep(LEASE_POLL_MS);
        continue;
      }
      const laneName = candidates.find((l) => store.blockedUntil(l.name, now())?.getTime() === earliest.getTime())?.name ?? 'a lane';
      process.stderr.write(`lanerelay: all lanes blocked; waiting until ${earliest.toLocaleTimeString()} for ${laneName}\n`);
      await sleep(waitMs + 250);
      continue;
    }

    for (const lane of free) {
      // A parallel run may have blocked it since `free` was computed.
      if (store.blockedUntil(lane.name, now()) !== null) continue;
      if (opts.leases && !opts.leases.acquire(lane.name, owner)) continue;
      const prompt = renderPrompt({
        task,
        attempts,
        cwd: opts.cwd,
        diffSummary: diffMode === 'none' ? '' : gitDiffSummary(opts.cwd),
        diffPatch: diffMode === 'full' ? gitDiffPatch(opts.cwd, cfg.handoff?.diffMaxBytes) : '',
      });
      let result: RunResult;
      try {
        result = await runLane(lane, prompt, {
          cwd: opts.cwd,
          tee: opts.runOpts?.tee,
          logsDir: opts.runOpts?.logsDir,
          tailBytes: opts.runOpts?.tailBytes,
        });
      } finally {
        opts.leases?.release(lane.name);
      }

      if (result.cancelled) {
        // Shutting down (Ctrl-C): the lane did nothing wrong. Record no
        // verdict for it; the caller marks the run interrupted.
        return { type: 'failed', attempts, lastError: 'cancelled' };
      }

      const patterns = mergePatterns(lane.kind, lane.patterns);
      const usage = detectUsage(result.outputTail, patterns);
      if (usage) store.markUsage(lane.name, usage);

      if (result.timedOut) {
        attempts.push({ lane: lane.name, verdict: { type: 'timeout', outputTail: result.outputTail }, ...pick(result) });
        store.markResult(lane.name, 'timeout');
        broken.add(lane.name);
        await fireHooks(cfg.hooks, 'fail', { event: 'fail', lane: lane.name, task, status: 'timeout' });
        notify(attempts, null);
        continue;
      }

      const detection = detectLimit(result.outputTail, result.exitCode, patterns, now());
      if (detection) {
        const resetAt =
          detection.resetAt ?? new Date(now().getTime() + lane.defaultResetMinutes * 60_000);
        attempts.push({
          lane: lane.name,
          verdict: { type: 'limited', outputTail: result.outputTail, resetAt, evidence: detection.evidence },
          ...pick(result),
        });
        store.markBlocked(lane.name, resetAt, detection.evidence);
        await fireHooks(cfg.hooks, 'limit', {
          event: 'limit',
          lane: lane.name,
          task,
          status: 'limited',
          resetAt: resetAt.toISOString(),
        });
        await fireHooks(cfg.hooks, 'handoff', {
          event: 'handoff',
          lane: lane.name,
          task,
          status: 'handoff',
          resetAt: resetAt.toISOString(),
        });
        notify(attempts, null);
        continue;
      }

      if (result.exitCode === 0) {
        attempts.push({ lane: lane.name, verdict: { type: 'done', outputTail: result.outputTail }, ...pick(result) });
        store.markResult(lane.name, 'done');
        await fireHooks(cfg.hooks, 'finish', {
          event: 'finish',
          lane: lane.name,
          task,
          status: 'done',
        });
        const verdict: TaskVerdict = { type: 'done', lane: lane.name, attempts };
        notify(attempts, verdict);
        return verdict;
      }

      const auth = authErrorAfter(detectionWindow(result.outputTail));
      attempts.push({
        lane: lane.name,
        verdict: {
          type: 'failed',
          outputTail: result.outputTail,
          exitCode: result.exitCode,
          evidence: auth ? `auth error (exit ${result.exitCode}): ${auth}` : `exit code ${result.exitCode}`,
        },
        ...pick(result),
      });
      store.markResult(lane.name, 'failed');
      broken.add(lane.name);
      await fireHooks(cfg.hooks, 'fail', {
        event: 'fail',
        lane: lane.name,
        task,
        status: `exit ${result.exitCode}`,
      });
      notify(attempts, null);
      // Non-limit failure: try the next lane too — the handoff note carries
      // the error output so the next agent can pick up or start fresh.
    }

    // Every free lane was tried this round; nothing succeeded. Loop again:
    // broken lanes drop out, blocked ones wait for their reset above, and
    // an all-broken chain ends as 'failed' at the top of the loop.
  }
}

function pick(r: { exitCode: number | null; durationMs: number; logFile?: string }) {
  return { exitCode: r.exitCode, durationMs: r.durationMs, logFile: r.logFile };
}
