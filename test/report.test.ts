import { describe, expect, it } from 'vitest';
import { buildReport, formatReport } from '../src/report.js';
import type { QueueItem } from '../src/queue.js';
import type { RunRecord } from '../src/runs.js';
import type { AttemptResult } from '../src/types.js';

function rec(over: Partial<RunRecord> & { id: string }): RunRecord {
  return {
    task: 'task',
    pid: 9999999,
    status: 'done',
    startedAt: '2026-10-18T10:00:00.000Z',
    attempts: [],
    ...over,
  };
}

const limited = (lane: string): AttemptResult => ({
  lane,
  verdict: { type: 'limited', outputTail: 'x', resetAt: null, evidence: 'e' },
  exitCode: 1,
  durationMs: 10,
});
const done = (lane: string): AttemptResult => ({
  lane,
  verdict: { type: 'done', outputTail: 'x' },
  exitCode: 0,
  durationMs: 10,
});

const item = (over: Partial<QueueItem>): QueueItem => ({
  id: 'q',
  task: 't',
  addedAt: '2026-10-18T10:00:00.000Z',
  ...over,
});

describe('buildReport', () => {
  it('aggregates run statuses and per-lane attempt counts', () => {
    const rep = buildReport(
      [
        rec({ id: 'r1', status: 'done', lane: 'claude', attempts: [limited('codex'), done('claude')] }),
        rec({ id: 'r2', status: 'failed', attempts: [limited('codex')] }),
        rec({ id: 'r3', status: 'interrupted', attempts: [{ ...limited('codex'), verdict: { type: 'timeout', outputTail: 'x' } }] }),
      ],
      [],
    );
    expect(rep.runs.total).toBe(3);
    expect(rep.runs.done).toBe(1);
    expect(rep.runs.failed).toBe(1);
    expect(rep.runs.interrupted).toBe(1);
    const codex = rep.lanes.find((l) => l.lane === 'codex')!;
    expect(codex.attempts).toBe(3);
    expect(codex.limited).toBe(2);
    expect(codex.timeout).toBe(1);
    expect(rep.lanes.find((l) => l.lane === 'claude')!.done).toBe(1);
    // most-attempted lane first
    expect(rep.lanes[0].lane).toBe('codex');
  });

  it('marks superseded (resumed) records separately from plain interrupted', () => {
    const rep = buildReport(
      [
        rec({ id: 'r1', status: 'resumed', resumedBy: 'r2', attempts: [limited('claude')] }),
        rec({ id: 'r2', status: 'done', lane: 'codex', resumedFrom: 'r1', attempts: [done('codex')] }),
      ],
      [],
    );
    expect(rep.runs.resumed).toBe(1);
    expect(rep.runs.done).toBe(1);
    expect(rep.runs.interrupted).toBe(0);
    // attempts of the resumed run still count (they really ran)
    expect(rep.lanes.find((l) => l.lane === 'claude')!.limited).toBe(1);
  });

  it('resumable lists non-terminal dead runs, not done/resumed/live ones', () => {
    const rep = buildReport(
      [
        rec({ id: 'dead-interrupted', status: 'interrupted' }),
        rec({ id: 'dead-failed', status: 'failed' }),
        rec({ id: 'dead-blocked', status: 'all-blocked' }),
        rec({ id: 'finished', status: 'done' }),
        rec({ id: 'superseded', status: 'resumed', resumedBy: 'x' }),
        rec({ id: 'live', status: 'running' }),
      ],
      [],
    );
    expect(rep.resumable.map((r) => r.id).sort()).toEqual(['dead-blocked', 'dead-failed', 'dead-interrupted']);
  });

  it('counts queue outcomes from finished items', () => {
    const rep = buildReport(
      [],
      [
        item({ id: '1', result: 'done' }),
        item({ id: '2', result: 'failed' }),
        item({ id: '3', result: 'all-blocked' }),
        item({ id: '4' }),
        item({ id: '5', startedAt: '2026-10-18T11:00:00.000Z' }),
      ],
    );
    expect(rep.queue).toEqual({ done: 1, failed: 2, pending: 1, running: 1 });
  });
});

describe('formatReport', () => {
  it('prints runs summary, lane stats and resumable hint', () => {
    const rep = buildReport(
      [
        rec({ id: 'r-abc', status: 'interrupted', task: 'fix the thing', attempts: [limited('claude')] }),
        rec({ id: 'r-def', status: 'done', lane: 'codex', attempts: [done('codex')] }),
      ],
      [item({ id: 'q1', result: 'done' })],
    );
    const out = formatReport(rep);
    expect(out).toContain('runs: 2 total');
    expect(out).toContain('1 done');
    expect(out).toContain('1 interrupted');
    expect(out).toContain('lanes:');
    expect(out).toContain('claude');
    expect(out).toContain('queue: 1 done');
    expect(out).toContain('qp run --resume r-abc');
    expect(out).toContain('recent runs:');
  });

  it('handles an empty history without crashing', () => {
    const out = formatReport(buildReport([], []));
    expect(out).toContain('runs: 0 total');
    expect(out).not.toContain('lanes:');
  });
});
