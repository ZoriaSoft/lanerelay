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
  /** Last observed quota % remaining (24h staleness), when the lane reported one. */
  quotaLeft?: number;
  /** Run id currently holding this lane's lease, when another run does. */
  leasedBy?: string;
}

/** Status rows in the same order the lanes would run. */
export function laneStatuses(
  lanes: Lane[],
  store: LaneStore,
  now: Date = new Date(),
  leased: Record<string, { runId: string }> = {},
): LaneStatusRow[] {
  return lanes.map((l) => {
    const until = store.blockedUntil(l.name, now);
    const st = store.get(l.name);
    const quotaLeft = store.quotaLeft(l.name, now) ?? undefined;
    const leasedBy = leased[l.name]?.runId;
    if (until) {
      return { name: l.name, kind: l.kind, status: 'blocked', until, reason: st.blockedReason, quotaLeft, leasedBy };
    }
    return { name: l.name, kind: l.kind, status: st.lastResult ? 'available' : 'unknown', quotaLeft, leasedBy };
  });
}

export function formatStatus(rows: LaneStatusRow[], now: Date = new Date()): string {
  const lines = rows.map((r) => {
    const quota = r.quotaLeft !== undefined ? ` (${r.quotaLeft}% quota)` : '';
    const lease = r.leasedBy !== undefined ? ` [leased by ${r.leasedBy}]` : '';
    const head = `${r.name.padEnd(14)} ${r.kind.padEnd(9)}`;
    if (r.status === 'blocked' && r.until) {
      const mins = Math.max(0, Math.ceil((r.until.getTime() - now.getTime()) / 60_000));
      return `${head} blocked until ${r.until.toLocaleTimeString()} (${mins}m)${quota}${r.reason ? `  — ${r.reason}` : ''}${lease}`;
    }
    return `${head} ${r.status}${quota}${lease}`;
  });
  return lines.join('\n');
}
