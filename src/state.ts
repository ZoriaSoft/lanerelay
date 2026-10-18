import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LaneState {
  /** ISO timestamp until which the lane is blocked; null/undefined = free. */
  blockedUntil?: string;
  /** What blocked it (evidence line from detection). */
  blockedReason?: string;
  /** Last verdict seen: done | limited | failed | timeout. */
  lastResult?: string;
  /** ISO timestamp of the last attempt. */
  lastRunAt?: string;
}

interface StateFile {
  version: 1;
  lanes: Record<string, LaneState>;
}

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
    if (lane === undefined) {
      for (const s of Object.values(this.lanes)) {
        delete s.blockedUntil;
        delete s.blockedReason;
      }
    } else {
      const s = this.lanes[lane];
      if (s) {
        delete s.blockedUntil;
        delete s.blockedReason;
      }
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
