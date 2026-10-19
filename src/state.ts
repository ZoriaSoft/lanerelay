import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import type { QuotaWindow } from './detect.js';

export interface UsageObservation {
  /** Percentage of quota remaining as last reported by the lane (0–100). */
  pctLeft: number;
  /** Which quota window this gauge describes ('other' when unlabeled). */
  window: QuotaWindow;
  /** ISO timestamp of the observation. */
  observedAt: string;
  /** Output line the reading came from. */
  evidence: string;
}

export interface LaneState {
  /** ISO timestamp until which the lane is blocked; null/undefined = free. */
  blockedUntil?: string;
  /** What blocked it (evidence line from detection). */
  blockedReason?: string;
  /** Last verdict seen: done | limited | failed | timeout. */
  lastResult?: string;
  /** ISO timestamp of the last attempt. */
  lastRunAt?: string;
  /** Last quota gauges the lane printed, one entry per quota window. */
  usage?: UsageObservation[];
}

interface StateFile {
  version: 1;
  lanes: Record<string, LaneState>;
}

/**
 * A reading goes stale once its own window could have rolled over:
 * a "3% left" from yesterday's session must not haunt the lane after the
 * reset refilled it. 'other' (unlabeled gauges) uses a 24h safety net.
 */
const USAGE_STALE_MS: Record<QuotaWindow, number> = {
  session: 8 * 3_600_000,
  daily: 36 * 3_600_000,
  weekly: 9 * 24 * 3_600_000,
  monthly: 35 * 24 * 3_600_000,
  other: 24 * 3_600_000,
};

const WINDOW_SORT: Record<QuotaWindow, number> = {
  session: 0,
  daily: 1,
  weekly: 2,
  monthly: 3,
  other: 4,
};

/**
 * Per-repo lane state persisted in `.lanerelay/state.json`. Written atomically
 * (tmp + rename) so a killed run can't leave a half-written file.
 *
 * Parallel `lanerelay` processes share this file. Reads reload it when its
 * mtime changed since we last saw it. Every write is a read-modify-write
 * under an exclusive lock file (`state.json.lock`, O_EXCL create): the file
 * is re-read inside the lock and only the touched lane is changed, so two
 * runs blocking different lanes at the same moment never drop each other's
 * update. A lock left by a dead process (or older than LOCK_STALE_MS) is
 * broken; if the lock can't be had within LOCK_WAIT_MS the write goes ahead
 * unlocked rather than hang a run.
 */
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 15_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Run `fn` while holding `<path>.lock`. Returns fn's result. */
export function withFileLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lock, 'wx');
      writeSync(fd, String(process.pid));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break;
      let stale = false;
      try {
        const owner = parseInt(readFileSync(lock, 'utf8'), 10);
        const age = Date.now() - statSync(lock).mtimeMs;
        stale = age > LOCK_STALE_MS || (owner > 0 && owner !== process.pid && !pidAlive(owner));
      } catch {
        /* vanished between open and read: just retry */
      }
      if (stale) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) break;
      sleepSync(5 + Math.floor(Math.random() * 10));
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      closeSync(fd);
      rmSync(lock, { force: true });
    }
  }
}

export class LaneStore {
  private readonly path: string;
  private lanes: Record<string, LaneState>;
  private mtimeMs = 0;

  constructor(path: string) {
    this.path = path;
    this.lanes = {};
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.lanes = {};
      this.mtimeMs = 0;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StateFile;
      const lanes = parsed && typeof parsed === 'object' && parsed.lanes ? parsed.lanes : {};
      // Migrate pre-windowed files: usage used to be a single observation.
      for (const s of Object.values(lanes)) {
        const u = s.usage as unknown;
        if (u && !Array.isArray(u) && typeof u === 'object') {
          s.usage = [{ ...(u as UsageObservation), window: 'other' }];
        } else if (Array.isArray(u)) {
          for (const o of u) if (o && typeof o === 'object' && !o.window) o.window = 'other';
        }
      }
      this.lanes = lanes;
    } catch {
      // Corrupt state file: start clean rather than crash. The worst
      // outcome is re-trying a blocked lane once.
      this.lanes = {};
    }
    try {
      this.mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      this.mtimeMs = 0;
    }
  }

  /** Reload the file when another lanerelay process rewrote it since our last read. */
  private refresh(): void {
    let m = 0;
    try {
      m = statSync(this.path).mtimeMs;
    } catch {
      /* absent file */
    }
    if (m !== this.mtimeMs) this.load();
  }

  get(lane: string): LaneState {
    this.refresh();
    return this.lanes[lane] ?? {};
  }

  all(): Record<string, LaneState> {
    this.refresh();
    return { ...this.lanes };
  }

  /** Instant the lane becomes usable again; null when not blocked. */
  blockedUntil(lane: string, now: Date = new Date()): Date | null {
    this.refresh();
    const raw = this.lanes[lane]?.blockedUntil;
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime()) || d <= now) return null;
    return d;
  }

  /** Fresh (non-stale) observations per window, sorted session → other. */
  usageReadings(lane: string, now: Date = new Date()): UsageObservation[] {
    this.refresh();
    const list = this.lanes[lane]?.usage ?? [];
    const fresh = list.filter((o) => {
      const at = new Date(o.observedAt).getTime();
      return Number.isFinite(at) && now.getTime() - at <= (USAGE_STALE_MS[o.window] ?? USAGE_STALE_MS.other);
    });
    return fresh.sort((a, b) => WINDOW_SORT[a.window] - WINDOW_SORT[b.window]);
  }

  /**
   * Effective remaining quota for ordering: the poorest fresh window —
   * a lane whose session gauge reads 90% is still a bad bet when its
   * weekly cap sits at 3%. Null when nothing was observed or every
   * reading went stale.
   */
  quotaLeft(lane: string, now: Date = new Date()): number | null {
    const fresh = this.usageReadings(lane, now);
    if (fresh.length === 0) return null;
    return Math.min(...fresh.map((o) => o.pctLeft));
  }

  /**
   * Store the freshest reading per window. A single reading updates only
   * its window — gauges for other windows keep their previous value.
   */
  markUsage(
    lane: string,
    readings:
      | { pctLeft: number; evidence: string; window?: QuotaWindow }
      | { pctLeft: number; evidence: string; window?: QuotaWindow }[],
  ): void {
    const list = Array.isArray(readings) ? readings : [readings];
    if (list.length === 0) return;
    this.mutate((lanes) => {
      const byWindow: Partial<Record<QuotaWindow, UsageObservation>> = {};
      for (const o of lanes[lane]?.usage ?? []) byWindow[o.window] = o;
      const at = new Date().toISOString();
      for (const r of list) {
        const w = r.window ?? 'other';
        byWindow[w] = { pctLeft: r.pctLeft, window: w, observedAt: at, evidence: r.evidence };
      }
      lanes[lane] = { ...lanes[lane], usage: Object.values(byWindow) };
    });
  }

  markBlocked(lane: string, until: Date, reason: string): void {
    this.mutate((lanes) => {
      lanes[lane] = {
        ...lanes[lane],
        blockedUntil: until.toISOString(),
        blockedReason: reason,
        lastResult: 'limited',
        lastRunAt: new Date().toISOString(),
      };
    });
  }

  markResult(lane: string, result: 'done' | 'failed' | 'timeout'): void {
    this.mutate((lanes) => {
      lanes[lane] = {
        ...lanes[lane],
        lastResult: result,
        lastRunAt: new Date().toISOString(),
      };
    });
  }

  unblock(lane?: string): void {
    this.mutate((lanes) => {
      const clear = (s?: LaneState) => {
        if (!s) return;
        delete s.blockedUntil;
        delete s.blockedReason;
        // A manual unblock usually means the window rolled over or the user
        // swapped credentials — the old gauge is no longer trustworthy.
        delete s.usage;
      };
      if (lane === undefined) {
        for (const s of Object.values(lanes)) clear(s);
      } else {
        clear(lanes[lane]);
      }
    });
  }

  /**
   * Locked read-modify-write: reload from disk inside the lock, apply
   * `fn` to the fresh lane map, write atomically.
   */
  private mutate(fn: (lanes: Record<string, LaneState>) => void): void {
    withFileLock(this.path, () => {
      this.load();
      fn(this.lanes);
      this.save();
    });
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, lanes: this.lanes }, null, 2) + '\n');
    renameSync(tmp, this.path);
    try {
      this.mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      /* keep previous value; next refresh reloads */
    }
  }
}
