import type { Lane } from './types.js';
import type { LaneStore, UsageObservation } from './state.js';

export type LaneStatus = 'available' | 'blocked' | 'unknown';

export interface LaneStatusRow {
  name: string;
  kind: string;
  status: LaneStatus;
  /** Reset instant when blocked. */
  until?: Date;
  reason?: string;
  /** Effective quota % remaining = poorest fresh window, when reported. */
  quotaLeft?: number;
  /** Fresh per-window gauge readings (sorted session → other). */
  quota?: UsageObservation[];
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
    const quota = store.usageReadings(l.name, now);
    const quotaLeft = quota.length > 0 ? Math.min(...quota.map((o) => o.pctLeft)) : undefined;
    const leasedBy = leased[l.name]?.runId;
    if (until) {
      return { name: l.name, kind: l.kind, status: 'blocked', until, reason: st.blockedReason, quotaLeft, quota, leasedBy };
    }
    return { name: l.name, kind: l.kind, status: st.lastResult ? 'available' : 'unknown', quotaLeft, quota, leasedBy };
  });
}

/**
 * "(42% quota)" for a single unlabeled gauge, "(weekly 12% quota)" for a
 * named window, "(session 90% · weekly 12% quota)" when several windows are
 * known. Empty string when the lane never printed a gauge.
 */
export function formatQuota(row: Pick<LaneStatusRow, 'quota' | 'quotaLeft'>, lead = ' '): string {
  const list = row.quota ?? [];
  if (list.length === 0) return '';
  if (list.length === 1) {
    const o = list[0];
    return `${lead}(${o.window === 'other' ? '' : `${o.window} `}${o.pctLeft}% quota)`;
  }
  return `${lead}(${list.map((o) => `${o.window === 'other' ? '?' : o.window} ${o.pctLeft}%`).join(' · ')} quota)`;
}

export function formatStatus(rows: LaneStatusRow[], now: Date = new Date()): string {
  const lines = rows.map((r) => {
    const quota = formatQuota(r);
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
