import type { Lane } from './types.js';
import type { LaneStore } from './state.js';

export type LaneStatus = 'available' | 'blocked' | 'unknown';

export interface LaneStatusRow {
  name: string;
  kind: string;
  status: LaneStatus;
  /** Reset instant when blocked. */
  until?: Date;
  reason?: string;
}

/** Status rows in the same order the lanes would run. */
export function laneStatuses(lanes: Lane[], store: LaneStore, now: Date = new Date()): LaneStatusRow[] {
  return lanes.map((l) => {
    const until = store.blockedUntil(l.name, now);
    const st = store.get(l.name);
    if (until) {
      return { name: l.name, kind: l.kind, status: 'blocked', until, reason: st.blockedReason };
    }
    return { name: l.name, kind: l.kind, status: st.lastResult ? 'available' : 'unknown' };
  });
}

export function formatStatus(rows: LaneStatusRow[], now: Date = new Date()): string {
  const lines = rows.map((r) => {
    const head = `${r.name.padEnd(14)} ${r.kind.padEnd(9)}`;
    if (r.status === 'blocked' && r.until) {
      const mins = Math.max(0, Math.ceil((r.until.getTime() - now.getTime()) / 60_000));
      return `${head} blocked until ${r.until.toLocaleTimeString()} (${mins}m)${r.reason ? `  — ${r.reason}` : ''}`;
    }
    return `${head} ${r.status}`;
  });
  return lines.join('\n');
}
