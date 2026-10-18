import type { LaneLease } from './leases.js';
import type { QueueItem } from './queue.js';
import type { RunRecord } from './runs.js';
import type { LaneStore } from './state.js';
import { laneStatuses, type LaneStatusRow } from './status.js';
import type { Lane } from './types.js';

/** Everything `qp top` draws on one refresh. */
export interface TopSnapshot {
  lanes: LaneStatusRow[];
  /** Cost class per lane name. */
  cost: Record<string, string>;
  /** Live runs (status 'running' with a live pid). */
  running: RunRecord[];
  /** Unfinished runs `qp run --resume` can continue (dead/interrupted/failed). */
  resumable: RunRecord[];
  /** Queue item counts by state. */
  queue: { pending: number; running: number; done: number; failed: number };
  /** Next pending items, FIFO order. */
  pending: QueueItem[];
  /** lane → runId that holds its lease (live leases only). */
  leaseByLane: Record<string, string>;
  /** runId → leased lane name (reverse of leaseByLane). */
  laneByRun: Record<string, string>;
  /** Pid of the running `qp watch` daemon; null when none. */
  watcherPid: number | null;
}

export interface SnapshotSource {
  /** Lanes in run order (orderLanes result). */
  lanes: Lane[];
  /** Lane state store (.qp/state.json). */
  store: LaneStore;
  /** Live lane leases (LeaseSet.heldLanes() or {}). */
  leased: Record<string, LaneLease>;
  /** Run records (RunStore.list()). */
  records: RunRecord[];
  /** Queue items grouped by state directory (TaskQueue.list per state). */
  queue: Record<'pending' | 'running' | 'done' | 'failed', QueueItem[]>;
  /** Whether a record may be resumed (RunStore.resumable). */
  isResumable: (r: RunRecord) => boolean;
  /** Pid from .qp/watch.lock when the file exists; null otherwise. */
  watcherPid: number | null;
  now?: Date;
}

const PENDING_PREVIEW = 3;
const RUNNING_PREVIEW = 6;
const RESUMABLE_PREVIEW = 5;

/** Build the snapshot from already-loaded stores — pure, no I/O. */
export function topSnapshot(src: SnapshotSource): TopSnapshot {
  const now = src.now ?? new Date();
  const leaseByLane: Record<string, string> = {};
  const laneByRun: Record<string, string> = {};
  for (const [lane, lease] of Object.entries(src.leased)) {
    leaseByLane[lane] = lease.runId;
    laneByRun[lease.runId] = lane;
  }
  return {
    lanes: laneStatuses(src.lanes, src.store, now, src.leased),
    cost: Object.fromEntries(src.lanes.map((l) => [l.name, l.cost])),
    running: src.records.filter((r) => r.status === 'running'),
    resumable: src.records.filter((r) => r.status !== 'running' && src.isResumable(r)),
    queue: {
      pending: src.queue.pending.length,
      running: src.queue.running.length,
      done: src.queue.done.length,
      failed: src.queue.failed.length,
    },
    pending: src.queue.pending,
    leaseByLane,
    laneByRun,
    watcherPid: src.watcherPid,
  };
}

/** "2h14m" / "4m12s" / "59s" countdown text for a future instant. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`;
}

/** "4m12s" elapsed text since an ISO timestamp. */
export function formatElapsed(startedAt: string, now: Date): string {
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return '?';
  return formatCountdown(now.getTime() - t);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s;
}

const ANSI = {
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
} as const;

export interface FormatOpts {
  now?: Date;
  /** Terminal columns; lines and task fields clip to this. */
  width?: number;
  /** Emit ANSI colors. */
  color?: boolean;
  /** Repo label shown in the header. */
  repo?: string;
}

/**
 * Render one dashboard frame. Pure text; the TTY loop in `runTop` handles
 * the alternate screen and cursor. Sections: lanes (with live countdowns),
 * running tasks, queue depth + next pending, resumable runs.
 */
export function formatTop(snap: TopSnapshot, opts: FormatOpts = {}): string {
  const now = opts.now ?? new Date();
  const width = Math.max(40, opts.width ?? 100);
  const paint = (code: keyof typeof ANSI, s: string) => (opts.color ? `${ANSI[code]}${s}${ANSI.reset}` : s);

  const out: string[] = [];
  out.push(
    `${paint('cyan', 'qp top')}  ${opts.repo ? `${opts.repo}  ` : ''}${now.toLocaleTimeString()}${opts.color ? '  ·  q to quit' : ''}`,
  );
  out.push(snap.watcherPid ? `watcher: running (pid ${snap.watcherPid})` : paint('dim', 'watcher: none'));
  out.push('');

  // --- lanes ---------------------------------------------------------------
  out.push(paint('dim', 'LANES'));
  if (snap.lanes.length === 0) {
    out.push(paint('dim', '  no lanes configured'));
  }
  for (const r of snap.lanes) {
    const cost = (snap.cost[r.name] ?? '?').padEnd(4);
    const quota = r.quotaLeft !== undefined ? `  ${r.quotaLeft}% quota` : '';
    const lease = r.leasedBy ? `  [leased by ${r.leasedBy}]` : '';
    const prefix = `  ${r.name.padEnd(14)} ${r.kind.padEnd(9)} ${cost} `;
    if (r.status === 'blocked' && r.until) {
      const left = formatCountdown(r.until.getTime() - now.getTime());
      const reason = r.reason ? `  — ${clip(r.reason, Math.max(20, width - 60))}` : '';
      out.push(`${prefix}${paint('yellow', `blocked ${left}`)} → ${r.until.toLocaleTimeString()}${quota}${reason}${lease}`);
    } else {
      const state = r.status === 'available' ? paint('green', 'available') : paint('dim', 'unknown');
      out.push(`${prefix}${state}${quota}${lease}`);
    }
  }

  // --- running runs ---------------------------------------------------------
  out.push('', paint('dim', 'RUNNING'));
  if (snap.running.length === 0) {
    out.push(paint('dim', '  nothing running'));
  }
  for (const rec of snap.running.slice(0, RUNNING_PREVIEW)) {
    const lane = snap.laneByRun[rec.id];
    const laneTag = lane ? ` on ${lane}` : ` (pid ${rec.pid})`;
    out.push(`  ${rec.id}  ${formatElapsed(rec.startedAt, now).padStart(7)}${laneTag.padEnd(12)}  ${clip(rec.task, Math.max(20, width - 45))}`);
  }
  if (snap.running.length > RUNNING_PREVIEW) {
    out.push(paint('dim', `  … and ${snap.running.length - RUNNING_PREVIEW} more`));
  }

  // --- queue ---------------------------------------------------------------
  const q = snap.queue;
  out.push('', `queue: ${q.pending} pending · ${q.running} running · ${q.done} done · ${q.failed} failed`);
  for (const item of snap.pending.slice(0, PENDING_PREVIEW)) {
    const chain = item.chain ? ` [${item.chain}]` : '';
    const wake = item.notBefore ? Date.parse(item.notBefore) : NaN;
    const deferred =
      Number.isFinite(wake) && wake > now.getTime()
        ? ` ${paint('dim', `[wake ${new Date(wake).toLocaleTimeString()}${item.defers ? ` x${item.defers}` : ''}]`)}`
        : '';
    out.push(`  ${item.id}  ${clip(item.task, Math.max(20, width - 30))}${chain}${deferred}`);
  }
  if (snap.pending.length > PENDING_PREVIEW) {
    out.push(paint('dim', `  … and ${snap.pending.length - PENDING_PREVIEW} more pending`));
  }

  // --- resumable ------------------------------------------------------------
  if (snap.resumable.length > 0) {
    out.push('', paint('dim', 'RESUMABLE'));
    for (const rec of snap.resumable.slice(0, RESUMABLE_PREVIEW)) {
      out.push(`  qp run --resume ${rec.id}   # ${rec.status} — ${clip(rec.task, Math.max(20, width - 50))}`);
    }
  }

  // Plain frames clip to width; colored frames must not be cut mid-escape.
  return out.map((l) => (opts.color ? l : clip(l, width))).join('\n');
}

export interface TopIo {
  /** Writable output (usually process.stdout). */
  out: NodeJS.WritableStream & { isTTY?: boolean; columns?: number };
  /** Optional input for 'q'/Ctrl-C handling (usually process.stdin). */
  inp?: NodeJS.ReadStream & { isTTY?: boolean; setRawMode?: (b: boolean) => void };
}

/**
 * Live dashboard loop: full redraw on an alternate screen every `intervalMs`.
 * Falls back to a single frame when stdout is not a TTY (piped output,
 * `qp top --once`) so scripts and `top | less` stay sane.
 */
export async function runTop(opts: {
  collect: () => { snap: TopSnapshot; repo: string };
  intervalMs: number;
  once?: boolean;
  io: TopIo;
}): Promise<void> {
  const { io } = opts;
  const frame = () => {
    const { snap, repo } = opts.collect();
    return `${formatTop(snap, { width: io.out.columns, color: Boolean(io.out.isTTY), repo })}\n`;
  };

  if (opts.once || !io.out.isTTY) {
    io.out.write(frame());
    return;
  }

  const inp = io.inp;
  const canKeys = Boolean(inp?.isTTY && inp.setRawMode);
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (canKeys) {
        inp!.setRawMode!(false);
        inp!.pause();
        inp!.off('data', onKey);
      }
      process.off('SIGWINCH', redraw);
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      io.out.write('\x1b[?25h\x1b[?1049l'); // show cursor, leave alt screen
      resolve();
    };
    const onKey = (b: Buffer) => {
      if (b.includes(0x03) || b.toString('utf8').includes('q')) finish(); // Ctrl-C or q
    };
    const redraw = () => io.out.write(`\x1b[H${frame()}\x1b[J`); // home + frame + clear below

    io.out.write('\x1b[?1049h\x1b[?25l'); // alt screen, hide cursor
    if (canKeys) {
      inp!.setRawMode!(true);
      inp!.resume();
      inp!.on('data', onKey);
    }
    process.on('SIGWINCH', redraw);
    // TTY without key input still quits cleanly on signals.
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
    redraw();
    const timer = setInterval(redraw, opts.intervalMs);
  });
}
