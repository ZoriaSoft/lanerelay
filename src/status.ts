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
  /** Last recorded attempt result (done | limited | failed | timeout). */
  last?: string;
}

/** "45m", "3h05m", "2d4h" — a compact countdown. */
export function formatCountdown(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h${String(mins % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

/** Clock time, with the date when the instant is not today. */
function formatUntil(until: Date, now: Date): string {
  const time = until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (until.toDateString() === now.toDateString()) return time;
  return `${until.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
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
      return { name: l.name, kind: l.kind, status: 'blocked', until, reason: st.blockedReason, quotaLeft, quota, leasedBy, last: st.lastResult };
    }
    return { name: l.name, kind: l.kind, status: st.lastResult ? 'available' : 'unknown', quotaLeft, quota, leasedBy, last: st.lastResult };
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
      const left = formatCountdown(r.until.getTime() - now.getTime());
      return `${head} blocked until ${formatUntil(r.until, now)} (${left})${quota}${r.reason ? `  — ${r.reason}` : ''}${lease}`;
    }
    // A lane that is free but failed or hung last time deserves a hint.
    const last = r.last === 'failed' || r.last === 'timeout' ? ` (last attempt: ${r.last})` : '';
    return `${head} ${r.status}${last}${quota}${lease}`;
  });
  return lines.join('\n');
}
