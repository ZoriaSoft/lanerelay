import { basename } from 'node:path';
import type { QueueItem } from './queue.js';
import type { RunRecord } from './runs.js';
import { formatCountdown } from './top.js';

export interface LaneReport {
  lane: string;
  attempts: number;
  done: number;
  limited: number;
  failed: number;
  timeout: number;
  lastAt: string;
}

export interface Report {
  runs: {
    total: number;
    done: number;
    'all-blocked': number;
    failed: number;
    timeout: number;
    interrupted: number;
    resumed: number;
    running: number;
  };
  lanes: LaneReport[];
  queue: { done: number; failed: number; pending: number; running: number };
  /** Most recent records (newest first). */
  recent: RunRecord[];
  /** Records that `lanerelay run --resume <id>` can continue. */
  resumable: RunRecord[];
}

const RECENT_LIMIT = 10;
const RESUMABLE_LIMIT = 10;

/**
 * Build a report from run records and queue items. Queue finishes only
 * record done/failed; all-blocked/timeout items defer back to pending until
 * a lane reset, so their failed count only grows on hard errors or once the
 * defer limit hits.
 */
export function buildReport(records: RunRecord[], items: QueueItem[]): Report {
  const runs = {
    total: records.length,
    done: 0,
    'all-blocked': 0,
    failed: 0,
    timeout: 0,
    interrupted: 0,
    resumed: 0,
    running: 0,
  };
  const lanes: Record<string, LaneReport> = {};

  for (const rec of records) {
    runs[rec.status === 'interrupted' && rec.resumedBy ? 'resumed' : rec.status] += 1;
    for (const a of rec.attempts) {
      const row = (lanes[a.lane] ??= {
        lane: a.lane,
        attempts: 0,
        done: 0,
        limited: 0,
        failed: 0,
        timeout: 0,
        lastAt: '',
      });
      row.attempts += 1;
      row[a.verdict.type] += 1;
      const at = rec.finishedAt ?? rec.startedAt;
      if (at > row.lastAt) row.lastAt = at;
    }
  }

  const queue = { done: 0, failed: 0, pending: 0, running: 0 };
  for (const i of items) {
    if (i.result === 'done') queue.done += 1;
    else if (i.result) queue.failed += 1;
    else if (i.startedAt) queue.running += 1;
    else queue.pending += 1;
  }

  return {
    runs,
    lanes: Object.values(lanes).sort((a, b) => b.attempts - a.attempts),
    queue,
    recent: records.slice(0, RECENT_LIMIT),
    resumable: records.filter((r) => r.status === 'interrupted' || (r.status !== 'done' && r.status !== 'resumed' && r.status !== 'running')).slice(0, RESUMABLE_LIMIT),
  };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function formatReport(rep: Report): string {
  const out: string[] = [];
  const r = rep.runs;
  const parts = (['done', 'all-blocked', 'failed', 'timeout', 'interrupted', 'resumed', 'running'] as const)
    .filter((k) => r[k] > 0)
    .map((k) => `${r[k]} ${k}`);
  out.push(`runs: ${r.total} total${parts.length ? ` (${parts.join(', ')})` : ''}`);

  if (rep.lanes.length > 0) {
    out.push('', 'lanes:');
    for (const l of rep.lanes) {
      const counts = `done ${l.done}, limited ${l.limited}, failed ${l.failed}, timeout ${l.timeout}`;
      const last = l.lastAt ? `  last ${l.lastAt.slice(0, 16).replace('T', ' ')}` : '';
      out.push(`  ${l.lane.padEnd(14)} ${String(l.attempts).padStart(3)} attempts   ${counts}${last}`);
    }
  }

  const q = rep.queue;
  if (q.done + q.failed + q.pending + q.running > 0) {
    out.push('', `queue: ${q.done} done, ${q.failed} failed, ${q.pending} pending, ${q.running} running`);
  }

  if (rep.resumable.length > 0) {
    out.push('', 'resumable runs:');
    for (const rec of rep.resumable) {
      out.push(`  lanerelay run --resume ${rec.id}   # ${rec.status} — ${clip(rec.task, 50)}`);
    }
  }

  if (rep.recent.length > 0) {
    out.push('', 'recent runs:');
    for (const rec of rep.recent) {
      const when = rec.startedAt.slice(0, 16).replace('T', ' ');
      const lane = rec.lane ? ` on ${rec.lane}` : '';
      const via = rec.resumedFrom ? ` (resumed ${rec.resumedFrom})` : '';
      out.push(`  ${rec.id}  ${when}  ${rec.status}${lane}${via}  ${clip(rec.task, 50)}`);
    }
  }
  return out.join('\n');
}

/** One lane attempt inside a run, for `lanerelay report --lane` drill-down. */
export interface LaneAttemptRow {
  runId: string;
  task: string;
  at: string;
  verdict: 'done' | 'limited' | 'failed' | 'timeout';
  exitCode: number | null;
  durationMs: number;
  /** Limit evidence / failure reason when the attempt produced one. */
  evidence?: string;
  resetAt?: string;
  logFile?: string;
}

export interface LaneDetail {
  stats: LaneReport;
  /** Newest-first attempt rows across every run record. */
  rows: LaneAttemptRow[];
}

const LANE_ROWS_LIMIT = 20;

/**
 * Drill-down for `lanerelay report --lane <name>`: the lane's aggregate stats plus
 * every recorded attempt, newest first. Records without an attempt on the
 * lane contribute nothing (a run may have failed before reaching it).
 */
export function laneReport(records: RunRecord[], lane: string): LaneDetail {
  const stats: LaneReport = { lane, attempts: 0, done: 0, limited: 0, failed: 0, timeout: 0, lastAt: '' };
  const rows: LaneAttemptRow[] = [];
  for (const rec of records) {
    for (const a of rec.attempts) {
      if (a.lane !== lane) continue;
      stats.attempts += 1;
      stats[a.verdict.type] += 1;
      const at = rec.startedAt;
      if (at > stats.lastAt) stats.lastAt = at;
      rows.push({
        runId: rec.id,
        task: rec.task,
        at,
        verdict: a.verdict.type,
        exitCode: a.exitCode,
        durationMs: a.durationMs,
        evidence: a.verdict.type === 'limited' || a.verdict.type === 'failed' ? a.verdict.evidence : undefined,
        resetAt: a.verdict.type === 'limited' && a.verdict.resetAt ? new Date(a.verdict.resetAt).toISOString() : undefined,
        logFile: a.logFile,
      });
    }
  }
  // Records arrive in caller order; the drill-down contract is newest-first.
  rows.sort((a, b) => b.at.localeCompare(a.at) || b.runId.localeCompare(a.runId));
  return { stats, rows };
}

export function formatLaneReport(detail: LaneDetail): string {
  const { stats, rows } = detail;
  const out: string[] = [];
  if (stats.attempts === 0) {
    return `lane "${stats.lane}": no recorded attempts`;
  }
  out.push(
    `lane ${stats.lane}: ${stats.attempts} attempts ` +
      `(done ${stats.done}, limited ${stats.limited}, failed ${stats.failed}, timeout ${stats.timeout})` +
      `${stats.lastAt ? ` — last ${stats.lastAt.slice(0, 16).replace('T', ' ')}` : ''}`,
  );
  for (const r of rows.slice(0, LANE_ROWS_LIMIT)) {
    const when = r.at.slice(0, 16).replace('T', ' ');
    const dur = formatCountdown(r.durationMs).padStart(6);
    const exit = r.exitCode !== null ? ` exit ${r.exitCode}` : '';
    const ev = r.evidence ? `  — ${clip(r.evidence, 60)}` : '';
    const log = r.logFile ? `  log ${basename(r.logFile)}` : '';
    out.push(`  ${when}  ${r.runId.padEnd(18)} ${r.verdict.padEnd(7)} ${dur}${exit}${ev}${log}`);
  }
  if (rows.length > LANE_ROWS_LIMIT) {
    out.push(`  … and ${rows.length - LANE_ROWS_LIMIT} more (use --json for the full list)`);
  }
  return out.join('\n');
}
