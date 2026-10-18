import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Lane } from './types.js';

/** POSIX shell quoting: wraps in single quotes, escapes embedded ones. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface SpawnSpec {
  file: string;
  args: string[];
  /** Rendered command after {{prompt}} substitution (logged, not spawned). */
  command: string;
}

/**
 * How to run a lane's command template for `platform`:
 * - posix: `sh -c` with {{prompt}} single-quoted inline.
 * - win32: `cmd /d /s /c` with {{prompt}} becoming "%QP_PROMPT%". cmd.exe
 *   mangles long single-quoted text and caps a line near 8KB, so the prompt
 *   travels in the QP_PROMPT env var (also exported on posix for scripts).
 */
export function buildSpawn(template: string, prompt: string, platform: NodeJS.Platform): SpawnSpec {
  const slot = /\{\{\s*prompt\s*\}\}/g;
  if (platform === 'win32') {
    const command = template.replace(slot, '"%QP_PROMPT%"');
    return { file: 'cmd', args: ['/d', '/s', '/c', command], command };
  }
  const command = template.replace(slot, () => shellQuote(prompt));
  return { file: 'sh', args: ['-c', command], command };
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

/** Run one lane attempt. Command template gets {{prompt}} substituted (quoted). */
export function runLane(lane: Lane, prompt: string, opts: RunOptions): Promise<RunResult> {
  const spec = buildSpawn(lane.command, prompt, process.platform);
  const tail = new RingBuffer(opts.tailBytes ?? DEFAULT_TAIL);
  const tee = opts.tee ?? true;
  const started = Date.now();
  const { promise, resolve } = Promise.withResolvers<RunResult>();

  const child = spawn(spec.file, spec.args, {
    cwd: opts.cwd,
    env: { ...process.env, QP_PROMPT: prompt },
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
      outputTail: tail.text(),
      logFile,
      durationMs: Date.now() - started,
    });
  };

  const finishOnce = (code: number | null) => {
    if (finished) return;
    finished = true;
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
