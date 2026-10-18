import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UsageObservation {
  /** Percentage of quota remaining as last reported by the lane (0–100). */
  pctLeft: number;
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
  /** Last quota gauge the lane printed, when it did. */
  usage?: UsageObservation;
}

interface StateFile {
  version: 1;
  lanes: Record<string, LaneState>;
}

/** Usage readings older than this are ignored for ordering (24h). */
const USAGE_STALE_MS = 24 * 3_600_000;

/**
 * Per-repo lane state persisted in `.qp/state.json`. Written atomically
 * (tmp + rename) so a killed run can't leave a half-written file.
 */
export class LaneStore {
  private readonly path: string;
  private lanes: Record<string, LaneState>;

  constructor(path: string) {
    this.path = path;
    this.lanes = {};
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as StateFile;
        if (parsed && typeof parsed === 'object' && parsed.lanes) {
          this.lanes = parsed.lanes;
        }
      } catch {
        // Corrupt state file: start clean rather than crash. The worst
        // outcome is re-trying a blocked lane once.
        this.lanes = {};
      }
    }
  }

  get(lane: string): LaneState {
    return this.lanes[lane] ?? {};
  }

  all(): Record<string, LaneState> {
    return { ...this.lanes };
  }

  /** Instant the lane becomes usable again; null when not blocked. */
  blockedUntil(lane: string, now: Date = new Date()): Date | null {
    const raw = this.lanes[lane]?.blockedUntil;
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime()) || d <= now) return null;
    return d;
  }

  /**
   * Last observed quota gauge for ordering; null when never seen or when
   * the reading is older than the staleness window (resets refill quotas,
   * so an old "3% left" must not haunt the lane after rollover).
   */
  quotaLeft(lane: string, now: Date = new Date()): number | null {
    const u = this.lanes[lane]?.usage;
    if (!u) return null;
    const at = new Date(u.observedAt).getTime();
    if (!Number.isFinite(at) || now.getTime() - at > USAGE_STALE_MS) return null;
    return u.pctLeft;
  }

  markUsage(lane: string, reading: { pctLeft: number; evidence: string }): void {
    this.lanes[lane] = {
      ...this.lanes[lane],
      usage: { pctLeft: reading.pctLeft, observedAt: new Date().toISOString(), evidence: reading.evidence },
    };
    this.save();
  }

  markBlocked(lane: string, until: Date, reason: string): void {
    this.lanes[lane] = {
      ...this.lanes[lane],
      blockedUntil: until.toISOString(),
      blockedReason: reason,
      lastResult: 'limited',
      lastRunAt: new Date().toISOString(),
    };
    this.save();
  }

  markResult(lane: string, result: 'done' | 'failed' | 'timeout'): void {
    this.lanes[lane] = {
      ...this.lanes[lane],
      lastResult: result,
      lastRunAt: new Date().toISOString(),
    };
    this.save();
  }

  unblock(lane?: string): void {
    const clear = (s?: LaneState) => {
      if (!s) return;
      delete s.blockedUntil;
      delete s.blockedReason;
      // A manual unblock usually means the window rolled over or the user
      // swapped credentials — the old gauge is no longer trustworthy.
      delete s.usage;
    };
    if (lane === undefined) {
      for (const s of Object.values(this.lanes)) clear(s);
    } else {
      clear(this.lanes[lane]);
    }
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, lanes: this.lanes }, null, 2) + '\n');
    renameSync(tmp, this.path);
  }
}
