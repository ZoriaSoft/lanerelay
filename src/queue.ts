import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface QueueItem {
  id: string;
  task: string;
  /** Optional chain override for this item. */
  chain?: string;
  addedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: 'done' | 'failed' | 'all-blocked' | 'timeout';
  lane?: string;
  /** .lanerelay/runs/<id> record backing this item's execution. */
  runId?: string;
  /**
   * Pending items with a notBefore in the future are skipped by claim() —
   * set by defer() when every lane is quota-blocked so the task retries at
   * the reset instead of dying as 'failed' overnight.
   */
  notBefore?: string;
  /** How many times the item has been deferred back to pending. */
  defers?: number;
  /** Why the item was last deferred (diagnostics only). */
  deferReason?: string;
  error?: string;
}

type ItemState = 'pending' | 'running' | 'done' | 'failed';

const STATES: ItemState[] = ['pending', 'running', 'done', 'failed'];

// Per-process monotonic counter so ids sort FIFO even within one millisecond.
let seq = 0;

/**
 * Single-watcher task queue as JSON files:
 *   <dir>/pending/<ts>-<seq>-<rand>.json   → claimed → running/ → finished → done|failed/
 * Atomic claim = rename; atomic item write = tmp + rename.
 */
export class TaskQueue {
  constructor(readonly dir: string) {
    for (const s of STATES) mkdirSync(join(dir, s), { recursive: true });
  }

  add(task: string, chain?: string): QueueItem {
    const item: QueueItem = {
      id: `${Date.now()}-${String(seq++).padStart(6, '0')}-${randomBytes(4).toString('hex')}`,
      task,
      chain,
      addedAt: new Date().toISOString(),
    };
    this.write('pending', item);
    return item;
  }

  /** Oldest claimable pending item (notBefore passed or unset); null when none. */
  claim(now: Date = new Date()): QueueItem | null {
    const pendingDir = join(this.dir, 'pending');
    const files = readdirSync(pendingDir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const src = join(pendingDir, f);
      // Peek before claiming: a deferred item keeps its FIFO slot but must
      // not be handed out until its notBefore passes.
      try {
        const peek = JSON.parse(readFileSync(src, 'utf8')) as QueueItem;
        const wake = peek.notBefore ? Date.parse(peek.notBefore) : NaN;
        if (Number.isFinite(wake) && wake > now.getTime()) continue;
      } catch {
        /* corrupt or vanished — fall through; rename either claims or skips it */
      }
      const dst = join(this.dir, 'running', f);
      try {
        renameSync(src, dst); // atomic claim; loser of a race skips to next
      } catch {
        continue;
      }
      try {
        const item = JSON.parse(readFileSync(dst, 'utf8')) as QueueItem;
        item.startedAt = new Date().toISOString();
        delete item.notBefore;
        this.writeTo(dst, item);
        return item;
      } catch {
        // Corrupt item: move it aside so it doesn't block the queue.
        renameSync(dst, join(this.dir, 'failed', f));
        continue;
      }
    }
    return null;
  }

  /**
   * Return a claimed item to pending/ until `wakeAt` (a lane's reset time)
   * instead of failing it. The item keeps its id and FIFO position;
   * `defers` counts how often this happened and `runId` records which run
   * asked for the deferral.
   */
  defer(item: QueueItem, wakeAt: Date, reason: string): void {
    item.defers = (item.defers ?? 0) + 1;
    item.notBefore = wakeAt.toISOString();
    item.deferReason = reason;
    const file = `${item.id}.json`;
    const from = join(this.dir, 'running', file);
    const to = join(this.dir, 'pending', file);
    try {
      rmSync(from, { force: true });
    } catch {
      /* already moved */
    }
    this.writeTo(to, item);
  }

  finish(item: QueueItem, result: QueueItem['result'], extra?: { lane?: string; error?: string; runId?: string }): void {
    item.finishedAt = new Date().toISOString();
    item.result = result;
    item.lane = extra?.lane;
    item.error = extra?.error;
    item.runId = extra?.runId;
    const file = `${item.id}.json`;
    const from = join(this.dir, 'running', file);
    const to = join(this.dir, result === 'done' ? 'done' : 'failed', file);
    try {
      rmSync(from, { force: true });
    } catch {
      /* already moved */
    }
    this.writeTo(to, item);
  }

  list(state?: ItemState): QueueItem[] {
    const states = state ? [state] : STATES;
    const items: QueueItem[] = [];
    for (const s of states) {
      const d = join(this.dir, s);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((f) => f.endsWith('.json')).sort()) {
        try {
          items.push(JSON.parse(readFileSync(join(d, f), 'utf8')) as QueueItem);
        } catch {
          /* skip corrupt */
        }
      }
    }
    return items;
  }

  private write(state: ItemState, item: QueueItem): void {
    this.writeTo(join(this.dir, state, `${item.id}.json`), item);
  }

  private writeTo(path: string, item: QueueItem): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(item, null, 2) + '\n');
    renameSync(tmp, path);
  }
}

export interface DeferDecision {
  /** When the item should be tried again (earliest future lane reset). */
  wakeAt: Date;
  reason: string;
}

/**
 * Should a queue item whose run ended in `verdict` be deferred rather than
 * failed? all-blocked/timeout mean "nothing was wrong with the task" — the
 * task waits for the earliest lane reset (or a short retry when no reset is
 * known). `maxDefers` caps repeats per item; 0 = defer forever.
 */
export function deferDecision(
  verdict: 'all-blocked' | 'timeout' | string,
  laneResets: (Date | null)[],
  defers: number,
  maxDefers: number,
  now: Date = new Date(),
): DeferDecision | null {
  if (verdict !== 'all-blocked' && verdict !== 'timeout') return null;
  if (maxDefers !== 0 && defers >= maxDefers) return null;
  const future = laneResets.filter((d): d is Date => d !== null && d.getTime() > now.getTime());
  const wakeAt = future.length > 0 ? new Date(Math.min(...future.map((d) => d.getTime()))) : new Date(now.getTime() + 60_000);
  return { wakeAt, reason: verdict === 'all-blocked' ? 'all lanes blocked' : 'wait timed out' };
}
