import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LaneStore } from '../src/state.js';
import {
  formatCountdown,
  formatElapsed,
  formatTop,
  topSnapshot,
  type SnapshotSource,
} from '../src/top.js';
import type { Lane } from '../src/types.js';
import type { QueueItem } from '../src/queue.js';
import type { RunRecord } from '../src/runs.js';

const NOW = new Date('2026-10-18T12:00:00Z');

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'lanerelay-top-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const lane = (name: string, kind: Lane['kind'] = 'custom'): Lane => ({
  name,
  kind,
  command: `${name} {{prompt}}`,
  cost: 'paid',
  priority: 0,
});

const rec = (id: string, status: RunRecord['status'], task = 'do the thing'): RunRecord => ({
  id,
  task,
  pid: process.pid,
  status,
  startedAt: '2026-10-18T11:55:00Z',
  attempts: [],
});

const item = (id: string, task: string, chain?: string): QueueItem => ({
  id,
  task,
  chain,
  addedAt: '2026-10-18T11:00:00Z',
});

function source(over: Partial<SnapshotSource> = {}): SnapshotSource {
  return {
    lanes: [lane('claude', 'claude'), lane('codex', 'codex')],
    store: new LaneStore(join(tmp(), 'state.json')),
    leased: {},
    records: [],
    queue: { pending: [], running: [], done: [], failed: [] },
    isResumable: (r) => r.status === 'interrupted' || r.status === 'failed',
    watcherPid: null,
    now: NOW,
    ...over,
  };
}

describe('formatCountdown', () => {
  it('renders compact durations', () => {
    expect(formatCountdown(34_000)).toBe('34s');
    expect(formatCountdown(60_000)).toBe('1m');
    expect(formatCountdown(61_000)).toBe('1m1s');
    expect(formatCountdown(2 * 3_600_000 + 14 * 60_000)).toBe('2h14m');
    expect(formatCountdown(3 * 86_400_000 + 2 * 3_600_000)).toBe('3d2h');
  });

  it('clamps past instants to 0s', () => {
    expect(formatCountdown(-5_000)).toBe('0s');
  });
});

describe('formatElapsed', () => {
  it('counts up from an ISO start', () => {
    expect(formatElapsed('2026-10-18T11:55:00Z', NOW)).toBe('5m');
  });
  it('returns ? on garbage', () => {
    expect(formatElapsed('nope', NOW)).toBe('?');
  });
});

describe('topSnapshot', () => {
  it('maps blocked lanes, leases, runs and queue counts', () => {
    const store = new LaneStore(join(tmp(), 'state.json'));
    const until = new Date('2026-10-18T14:10:00Z');
    store.markBlocked('claude', until, 'usage limit reached');
    store.markUsage('codex', { pctLeft: 42, evidence: 'usage: 58%' });

    const snap = topSnapshot(
      source({
        store,
        leased: { codex: { runId: 'r-live', pid: process.pid, at: '2026-10-18T11:59:00Z' } },
        records: [rec('r-live', 'running'), rec('r-dead', 'interrupted', 'dead task'), rec('r-done', 'done')],
        queue: {
          pending: [item('q1', 'first'), item('q2', 'second')],
          running: [],
          done: [item('q9', 'old')],
          failed: [],
        },
        watcherPid: 4242,
      }),
    );

    const claude = snap.lanes.find((l) => l.name === 'claude')!;
    expect(claude.status).toBe('blocked');
    expect(claude.until?.toISOString()).toBe(until.toISOString());
    const codex = snap.lanes.find((l) => l.name === 'codex')!;
    expect(codex.leasedBy).toBe('r-live');
    expect(codex.quotaLeft).toBe(42);

    expect(snap.running.map((r) => r.id)).toEqual(['r-live']);
    expect(snap.resumable.map((r) => r.id)).toEqual(['r-dead']);
    expect(snap.queue).toEqual({ pending: 2, running: 0, done: 1, failed: 0 });
    expect(snap.laneByRun['r-live']).toBe('codex');
    expect(snap.watcherPid).toBe(4242);
  });
});

describe('formatTop', () => {
  it('renders lanes, countdown, running task, queue and resumable', () => {
    const store = new LaneStore(join(tmp(), 'state.json'));
    store.markBlocked('claude', new Date('2026-10-18T14:10:00Z'), 'usage limit reached');
    const snap = topSnapshot(
      source({
        store,
        leased: { codex: { runId: 'r-live', pid: process.pid, at: 'x' } },
        records: [rec('r-live', 'running', 'migrate the database'), rec('r-dead', 'interrupted')],
        queue: { pending: [item('q1', 'queued task')], running: [], done: [], failed: [] },
      }),
    );
    const text = formatTop(snap, { now: NOW, width: 100, repo: 'demo' });
    expect(text).toContain('lanerelay top');
    expect(text).toContain('demo');
    expect(text).toContain('LANES');
    expect(text).toContain('claude');
    expect(text).toContain('blocked 2h10m');
    expect(text).toContain('[leased by r-live]');
    expect(text).toContain('RUNNING');
    expect(text).toContain('r-live');
    expect(text).toContain('migrate the database');
    expect(text).toContain('queue: 1 pending');
    expect(text).toContain('queued task');
    expect(text).toContain('lanerelay run --resume r-dead');
  });

  it('emits ANSI codes only when color is on', () => {
    const snap = topSnapshot(source());
    expect(formatTop(snap, { now: NOW, color: true })).toContain('\x1b[');
    expect(formatTop(snap, { now: NOW })).not.toContain('\x1b[');
  });

  it('shows watcher pid when a watcher lives', () => {
    const snap = topSnapshot(source({ watcherPid: 777 }));
    expect(formatTop(snap, { now: NOW })).toContain('watcher: running (pid 777)');
    expect(formatTop(topSnapshot(source()), { now: NOW })).toContain('watcher: none');
  });

  it('marks deferred pending items with their wake time', () => {
    const deferred = {
      ...item('q9', 'task waiting for reset'),
      notBefore: '2026-10-18T13:00:00.000Z',
      defers: 2,
    } satisfies QueueItem;
    const snap = topSnapshot(source({ queue: { pending: [deferred], running: [], done: [], failed: [] } }));
    const text = formatTop(snap, { now: NOW, width: 100 });
    expect(text).toContain('task waiting for reset');
    expect(text).toContain('x2]');
    // Past notBefore renders as a normal pending row.
    const due = { ...deferred, notBefore: '2026-10-18T11:00:00.000Z' };
    const snap2 = topSnapshot(source({ queue: { pending: [due], running: [], done: [], failed: [] } }));
    expect(formatTop(snap2, { now: NOW, width: 100 })).not.toContain('[wake ');
  });
});
