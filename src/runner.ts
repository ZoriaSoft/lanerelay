import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Lane } from './types.js';
import { buildWindowsSpawn, type WinResolver } from './winspawn.js';

/** POSIX shell quoting: wraps in single quotes, escapes embedded ones. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface SpawnSpec {
  file: string;
  args: string[];
  /** Rendered command after {{prompt}} substitution (logged, not spawned). */
  command: string;
  /** Extra environment for the child (on top of LR_PROMPT). */
  env?: Record<string, string>;
  /** Windows: hand args to CreateProcess unquoted (pre-built cmd.exe line). */
  verbatim?: boolean;
}

/**
 * How to run a lane's command template for `platform`:
 * - posix: `sh -c` with {{prompt}} quoted for its shell context inline.
 * - win32: see buildWindowsSpawn. Simple commands that resolve to an .exe
 *   run without a shell; anything else goes through cmd.exe with the prompt
 *   in a delayed-expansion variable, so cmd never parses prompt text.
 * The prompt is also exported as LR_PROMPT for wrapper scripts.
 */
export function buildSpawn(
  template: string,
  prompt: string,
  platform: NodeJS.Platform,
  winOpts: { cwd?: string; env?: NodeJS.ProcessEnv; resolve?: WinResolver } = {},
): SpawnSpec {
  if (platform === 'win32') return buildWindowsSpawn(template, prompt, winOpts);
  const command = substitutePosix(template, prompt);
  return { file: 'sh', args: ['-c', command], command };
}

/**
 * Replace every {{prompt}} slot with a literal that is safe for the quoting
 * context the slot sits in. Users naturally write `"{{prompt}}"` or
 * `'{{prompt}}'`; pasting a single-quoted word there would end up inside
 * double quotes (where `$(...)` and backticks still run) or close the
 * user's own single quotes. Context per slot:
 * - unquoted: `'...'` (shellQuote)
 * - inside "...": backslash-escape `\ " $ \``
 * - inside '...': close the quote, emit shellQuote, reopen
 */
export function substitutePosix(template: string, prompt: string): string {
  const slot = /\{\{\s*prompt\s*\}\}/y;
  let out = '';
  let mode: 'none' | 'single' | 'double' = 'none';
  for (let i = 0; i < template.length; ) {
    slot.lastIndex = i;
    const m = slot.exec(template);
    if (m) {
      if (mode === 'none') out += shellQuote(prompt);
      else if (mode === 'double') out += prompt.replace(/[\\"$`]/g, (c) => '\\' + c);
      else out += "'" + shellQuote(prompt) + "'";
      i += m[0].length;
      continue;
    }
    const c = template[i];
    if (mode === 'single') {
      if (c === "'") mode = 'none';
    } else if (c === '\\' && i + 1 < template.length) {
      out += c + template[i + 1];
      i += 2;
      continue;
    } else if (mode === 'double') {
      if (c === '"') mode = 'none';
    } else if (c === "'") {
      mode = 'single';
    } else if (c === '"') {
      mode = 'double';
    }
    out += c;
    i += 1;
  }
  return out;
}

export interface RunOptions {
  cwd: string;
  /** Mirror child output to our own stdout/stderr. Default true. */
  tee?: boolean;
  /** Directory for per-attempt log files; undefined = don't write logs. */
  logsDir?: string;
  /** Bytes of combined output kept in memory for detection. */
  tailBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  /** true when we killed the child for exceeding lane.timeoutMinutes. */
  timedOut: boolean;
  /** true when killActiveLanes stopped the child (Ctrl-C / shutdown). */
  cancelled?: boolean;
  /** Last tailBytes of combined stdout+stderr (chronological). */
  outputTail: string;
  logFile?: string;
  durationMs: number;
}

class RingBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 0) {
      const head = this.chunks[0];
      const excess = this.size - this.cap;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

const DEFAULT_TAIL = 64 * 1024;

/**
 * Every lane child that is still running, so a signal handler can take the
 * whole set down. Lane children run in their own process group (posix), so
 * a terminal Ctrl-C does NOT reach them on its own — without this they
 * would keep burning quota after lanerelay exits.
 */
const active = new Set<{
  pid: number;
  kill: (signal: NodeJS.Signals) => void;
  done: Promise<unknown>;
  cancel: () => void;
}>();

/** Number of lane children currently running (tests / diagnostics). */
export function activeLaneCount(): number {
  return active.size;
}

/**
 * Stop every running lane child: SIGTERM to each process group, then
 * SIGKILL to whatever is still alive after `graceMs`. Resolves once all
 * children have exited (or the hard kill was sent).
 */
export async function killActiveLanes(graceMs = 3_000): Promise<void> {
  if (active.size === 0) return;
  const entries = [...active];
  for (const e of entries) {
    e.cancel();
    e.kill('SIGTERM');
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), graceMs);
  });
  const res = await Promise.race([Promise.all(entries.map((e) => e.done)).then(() => 'done' as const), timeout]);
  clearTimeout(timer);
  // Grandchildren can outlive the group leader; a final SIGKILL to the
  // group is harmless when it is already gone.
  for (const e of entries) e.kill('SIGKILL');
  if (res === 'timeout') await new Promise((r) => setTimeout(r, 100));
}

/** Run one lane attempt. Command template gets {{prompt}} substituted (quoted). */
export function runLane(lane: Lane, prompt: string, opts: RunOptions): Promise<RunResult> {
  const spec = buildSpawn(lane.command, prompt, process.platform, { cwd: opts.cwd });
  const tail = new RingBuffer(opts.tailBytes ?? DEFAULT_TAIL);
  const tee = opts.tee ?? true;
  const started = Date.now();
  // Not Promise.withResolvers: that is Node 22+, and we support Node 20.
  let resolve!: (r: RunResult) => void;
  const promise = new Promise<RunResult>((r) => {
    resolve = r;
  });

  const child = spawn(spec.file, spec.args, {
    cwd: opts.cwd,
    env: { ...process.env, LR_PROMPT: prompt, ...spec.env },
    windowsVerbatimArguments: spec.verbatim ?? false,
    windowsHide: true,
    // Never hand our stdin to a lane: headless agent CLIs (claude -p,
    // codex exec) otherwise wait for piped input or steal the terminal.
    stdio: ['ignore', 'pipe', 'pipe'],
    // A process group of our own lets killTree hit the whole tree on posix.
    detached: process.platform !== 'win32',
  });

  let logFile: string | undefined;
  let log: WriteStream | undefined;
  if (opts.logsDir) {
    mkdirSync(opts.logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    logFile = join(opts.logsDir, `${stamp}-${lane.name}.log`);
    log = createWriteStream(logFile);
    log.write(`# lane: ${lane.name}\n# command: ${lane.command}\n# started: ${new Date(started).toISOString()}\n\n`);
  }

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const killTree = (signal: NodeJS.Signals) => {
    if (process.platform === 'win32') {
      // No signal granularity on Windows: /T kills the whole tree.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    // A wrapper lane may have spawned grandchildren in its own group; try the
    // group first, then the bare child. ESRCH is expected for plain children.
    try {
      process.kill(-child.pid!, signal);
      return;
    } catch {
      /* not a group leader */
    }
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  let cancelled = false;
  const entry = {
    pid: child.pid ?? -1,
    kill: killTree,
    done: promise,
    cancel: () => {
      cancelled = true;
    },
  };
  if (child.pid !== undefined) active.add(entry);

  if (lane.timeoutMinutes > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 5_000).unref();
    }, lane.timeoutMinutes * 60_000);
    timer.unref();
  }

  const onData = (chunk: Buffer, mirror: NodeJS.WriteStream) => {
    tail.push(chunk);
    log?.write(chunk);
    if (tee) mirror.write(chunk);
  };
  child.stdout.on('data', (c: Buffer) => onData(c, process.stdout));
  child.stderr.on('data', (c: Buffer) => onData(c, process.stderr));

  // 'close' waits for stdio EOF — a killed wrapper can leak pipes through a
  // surviving grandchild, so 'exit' starts a short grace period after which
  // we finish anyway rather than hang on a dead lane's open descriptors.
  let finished = false;
  const finish = (exitCode: number | null) => {
    clearTimeout(timer);
    log?.end(`\n# exit: ${exitCode ?? 'signal'}${timedOut ? ' (timeout)' : ''}\n`);
    resolve({
      exitCode,
      timedOut,
      cancelled,
      outputTail: tail.text(),
      logFile,
      durationMs: Date.now() - started,
    });
  };

  const finishOnce = (code: number | null) => {
    if (finished) return;
    finished = true;
    active.delete(entry);
    finish(code);
  };

  child.on('error', (err) => {
    tail.push(Buffer.from(`spawn error: ${err.message}\n`));
    finishOnce(null);
  });
  child.on('close', (code) => finishOnce(code));
  child.on('exit', (code) => {
    setTimeout(() => finishOnce(code), 1_500).unref();
  });

  return promise;
}
