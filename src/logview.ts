import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { QueueItem } from './queue.js';
import type { RunRecord } from './runs.js';

export interface LogEntry {
  /** File name (e.g. `2026-10-18T12-34-56-789Z-claude.log`). */
  name: string;
  /** Lane name parsed out of the file name; null for foreign files. */
  lane: string | null;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

// runLane names logs `<isoStamp>-<lane>.log`; the stamp ends with 'Z' before
// the lane suffix, so `Z-(.+)\.log` recovers even hyphenated lane names.
const LOG_LANE = /Z-(.+)\.log$/;

/** List `.qp/logs/*.log` files, newest first. */
export function listLogs(logsDir: string, limit = 20): LogEntry[] {
  if (!existsSync(logsDir)) return [];
  const out: LogEntry[] = [];
  for (const name of readdirSync(logsDir).filter((f) => f.endsWith('.log'))) {
    const path = join(logsDir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      out.push({ name, lane: LOG_LANE.exec(name)?.[1] ?? null, path, mtimeMs: st.mtimeMs, sizeBytes: st.size });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return out.slice(0, Math.max(1, limit));
}

export interface ResolveInput {
  /** Optional selector: run-id prefix, queue-item id prefix, lane name, or filename fragment. */
  selector?: string;
  /** RunStore.list() — run-id selectors resolve through attempt logFiles. */
  records: RunRecord[];
  /** TaskQueue items (any state) — queue-item ids resolve to their runId. */
  queueItems?: QueueItem[];
  /** Configured lane names — exact match picks that lane's newest log. */
  lanes?: string[];
}

export interface ResolveResult {
  entry?: LogEntry;
  /** Human-readable reason resolution failed. */
  error?: string;
}

function pick(entries: LogEntry[]): LogEntry | undefined {
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))[0];
}

/**
 * Resolve a `qp log` selector to a log file. Order: run-id prefix →
 * queue-item id prefix → exact lane name → filename substring. No selector
 * means the newest log. Newest match wins within each step.
 */
export function resolveLog(logsDir: string, input: ResolveInput): ResolveResult {
  const all = listLogs(logsDir, 10_000);
  const sel = input.selector?.trim();
  if (all.length === 0) {
    return { error: `no logs in ${logsDir} yet — every lane attempt writes one` };
  }
  if (!sel) {
    return { entry: all[0] };
  }

  // 1. run id prefix (records carry the attempt's absolute log path).
  const run = sel.length >= 4 ? input.records.find((r) => r.id === sel || r.id.startsWith(sel)) : undefined;
  if (run) {
    const names = new Set(run.attempts.map((a) => a.logFile).filter((p): p is string => !!p));
    const entries = all.filter((e) => names.has(e.path) || names.has(e.name));
    const entry = pick(entries);
    if (entry) return { entry };
    return { error: `run ${run.id} has no surviving log files (${names.size} expected)` };
  }

  // 2. queue item id prefix → its run record.
  const item = input.queueItems?.find((i) => i.id === sel || i.id.startsWith(sel));
  if (item) {
    if (!item.runId) return { error: `queue item ${item.id} has no run record yet` };
    return resolveLog(logsDir, { ...input, selector: item.runId, queueItems: [] });
  }

  // 3. exact lane name → newest log for that lane.
  if (input.lanes?.includes(sel)) {
    const entries = all.filter((e) => e.lane === sel);
    const entry = pick(entries);
    if (entry) return { entry };
    return { error: `lane "${sel}" has no logs yet` };
  }

  // 4. filename substring.
  const matches = all.filter((e) => e.name.includes(sel) || e.name === sel);
  const entry = pick(matches);
  if (entry) return { entry };
  return { error: `no log file, lane or run id matching "${sel}" (see: qp log --list)` };
}

export interface TailResult {
  text: string;
  /** True when the file exceeded the read window and earlier bytes were skipped. */
  truncated: boolean;
}

const TAIL_WINDOW = 1_048_576; // 1 MiB cap for tail reads

/**
 * Last `lines` lines of `path` (<= 0 means the whole file). Reads only a
 * bounded tail window so multi-MB lane dumps stay cheap; a truncated flag
 * tells the caller to note the cut.
 */
export function tailFile(path: string, lines: number): TailResult {
  const st = statSync(path);
  const window = lines > 0 ? Math.min(st.size, TAIL_WINDOW) : st.size;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(window);
    const read = readSync(fd, buf, 0, window, st.size - window);
    let text = buf.subarray(0, read).toString('utf8');
    if (lines > 0) {
      let parts = text.split('\n');
      if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
      const truncated = window < st.size;
      if (truncated && parts.length > 1) parts = parts.slice(1); // drop the cut first line
      text = parts.slice(-lines).join('\n');
      return { text, truncated };
    }
    return { text, truncated: false };
  } finally {
    closeSync(fd);
  }
}
