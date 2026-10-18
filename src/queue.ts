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

  /** Oldest pending item claimed for this watcher; null when queue empty. */
  claim(): QueueItem | null {
    const pendingDir = join(this.dir, 'pending');
    const files = readdirSync(pendingDir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const src = join(pendingDir, f);
      const dst = join(this.dir, 'running', f);
      try {
        renameSync(src, dst); // atomic claim; loser of a race skips to next
      } catch {
        continue;
      }
      try {
        const item = JSON.parse(readFileSync(dst, 'utf8')) as QueueItem;
        item.startedAt = new Date().toISOString();
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

  finish(item: QueueItem, result: QueueItem['result'], extra?: { lane?: string; error?: string }): void {
    item.finishedAt = new Date().toISOString();
    item.result = result;
    item.lane = extra?.lane;
    item.error = extra?.error;
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
