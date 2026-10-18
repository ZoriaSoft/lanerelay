import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive } from './runs.js';

export interface LaneLease {
  /** Owner label: usually the run record id holding the lane. */
  runId: string;
  pid: number;
  at: string;
}

/** Entries created internally when liveness can't be attributed to a pid. */
const EXTERNAL_PID = 0;

/** Unparseable lease files older than this are reclaimed (partial writes). */
const CORRUPT_STALE_MS = 30_000;

/**
 * Per-lane mutex as a file in `.qp/leases/<lane>.json`, so parallel
 * `qp watch --jobs` workers (and separate `qp` processes) never burn the
 * same subscription for two tasks at once.
 *
 * Acquisition is `O_EXCL` create — atomic on POSIX and Windows. A lease
 * belongs to (pid, runId): stale files whose owner pid is dead are
 * reclaimed. `heldByOther(lane, runId)` reports leases owned by anything
 * other than that (pid, runId) pair — including a *different* runId in
 * this same process (a second watch worker) and synthetic EXTERNAL_PID
 * entries for unparseable-but-fresh files.
 */
export class LeaseSet {
  /** Lane name → runId of leases taken through this instance. */
  private readonly held = new Map<string, string>();

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(lane: string): string {
    return join(this.dir, `${encodeURIComponent(lane)}.json`);
  }

  private read(lane: string): LaneLease | null {
    try {
      const parsed = JSON.parse(readFileSync(this.file(lane), 'utf8')) as LaneLease;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Lease `lane` for `runId`. Returns false when another live run holds it.
  * Synchronous: in a single process two workers can never interleave
  * between check and create.
  */
  acquire(lane: string, runId: string): boolean {
    if (this.heldByOther(lane, runId)) return false;
    const lease: LaneLease = { runId, pid: process.pid, at: new Date().toISOString() };
    try {
      writeFileSync(this.file(lane), JSON.stringify(lease), { flag: 'wx' });
      this.held.set(lane, runId);
      return true;
    } catch {
      // Exists already: our own lease file outlived map tracking — adopt it.
      const cur = this.read(lane);
      if (cur && cur.pid === process.pid && cur.runId === runId) {
        this.held.set(lane, runId);
        return true;
      }
      return false;
    }
  }

  /**
   * Who else holds `lane`, if anyone, from the perspective of `runId`:
   * a lease owned by another runId (in this process or a live foreign
   * pid). Dead-owner and long-corrupt files are reclaimed and treated as
   * free; freshly-corrupt files are treated as held (likely a partial
   * write by a racer) via a synthetic EXTERNAL_PID lease. A lease owned
   * by (this pid, runId) — even one the `held` map lost track of — is
   * adopted into the map and reported as free.
   */
  heldByOther(lane: string, runId: string): LaneLease | null {
    const cur = this.read(lane);
    if (cur === null) {
      if (!existsSync(this.file(lane))) return null;
      // Unreadable file: held when fresh (write in flight), stale when old.
      let fresh = true;
      try {
        fresh = Date.now() - statSync(this.file(lane)).mtimeMs < CORRUPT_STALE_MS;
      } catch {
        fresh = false;
      }
      if (fresh) return { runId: '?', pid: EXTERNAL_PID, at: '' };
      rmSync(this.file(lane), { force: true });
      return null;
    }
    if (cur.pid === process.pid && cur.runId === runId) {
      // Ours (maybe the map lost track): adopt and report free.
      this.held.set(lane, runId);
      return null;
    }
    if (cur.pid !== process.pid && !pidAlive(cur.pid)) {
      rmSync(this.file(lane), { force: true });
      return null;
    }
    return cur;
  }

  /** All live leases as lane → owner (dead-pid entries are pruned). */
  heldLanes(): Record<string, LaneLease> {
    const out: Record<string, LaneLease> = {};
    if (!existsSync(this.dir)) return out;
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
      const lane = decodeURIComponent(f.replace(/\.json$/, ''));
      const lease = this.read(lane);
      if (lease === null) {
        let old = false;
        try {
          old = Date.now() - statSync(join(this.dir, f)).mtimeMs >= CORRUPT_STALE_MS;
        } catch {
          /* vanished */
        }
        if (old) rmSync(join(this.dir, f), { force: true });
        else out[lane] = { runId: '?', pid: EXTERNAL_PID, at: '' };
        continue;
      }
      if (lease.pid === process.pid || pidAlive(lease.pid)) out[lane] = lease;
      else rmSync(join(this.dir, f), { force: true });
    }
    return out;
  }

  /** Drop `lane`; no-op when this instance doesn't own it. */
  release(lane: string): void {
    const ownRun = this.held.get(lane);
    if (ownRun === undefined) return;
    this.held.delete(lane);
    const cur = this.read(lane);
    if (cur && cur.pid === process.pid && cur.runId === ownRun) {
      rmSync(this.file(lane), { force: true });
    }
  }

  /** Drop every lease owned by `runId` (one watch worker finishing its run). */
  releaseRun(runId: string): void {
    for (const [lane, owner] of [...this.held.entries()]) {
      if (owner === runId) this.release(lane);
    }
  }

  /** Drop every lease this instance owns (run exit, verdict reached). */
  releaseAll(): void {
    for (const lane of [...this.held.keys()]) this.release(lane);
  }

  /**
   * Best-effort cleanup of leases owned by this pid (normal exit / signal
   * path). Other pids' leases are untouched; dead-pid leftovers are
   * reclaimed lazily on the next acquire anyway.
   */
  releaseProcess(): void {
    this.releaseAll();
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
      try {
        const lease = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as LaneLease;
        if (lease.pid === process.pid) rmSync(join(this.dir, f), { force: true });
      } catch {
        /* skip unreadable */
      }
    }
  }
}
