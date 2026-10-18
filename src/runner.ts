import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Lane } from './types.js';

/** POSIX shell quoting: wraps in single quotes, escapes embedded ones. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
  const command = lane.command.replace(/\{\{\s*prompt\s*\}\}/g, () => shellQuote(prompt));
  const tail = new RingBuffer(opts.tailBytes ?? DEFAULT_TAIL);
  const tee = opts.tee ?? true;
  const started = Date.now();
  const { promise, resolve } = Promise.withResolvers<RunResult>();

  const child = spawn('sh', ['-c', command], { cwd: opts.cwd, env: process.env });

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
  if (lane.timeoutMinutes > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
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

  child.on('error', (err) => {
    tail.push(Buffer.from(`spawn error: ${err.message}\n`));
    finish(null);
  });
  child.on('close', (code) => finish(code));

  return promise;
}
