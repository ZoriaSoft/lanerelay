import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../src/runs.js';
import type { AttemptResult } from '../src/types.js';

const dirs: string[] = [];
function workdir(): string {
  const d = mkdtempSync(join(tmpdir(), 'qp-runs-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const attempt = (lane: string, type: AttemptResult['verdict']['type']): AttemptResult => ({
  lane,
  verdict:
    type === 'limited'
      ? { type, outputTail: 't', resetAt: new Date('2026-10-18T22:00:00Z'), evidence: 'e' }
      : type === 'failed'
        ? { type, outputTail: 't', exitCode: 1, evidence: 'e' }
        : ({ type, outputTail: 't' } as AttemptResult['verdict']),
  exitCode: type === 'done' ? 0 : 1,
  durationMs: 123,
});

describe('RunStore', () => {
  it('create → get roundtrips attempts and revives Date fields', () => {
    const store = new RunStore(join(workdir(), 'runs'));
    const rec = store.create({ task: 'fix it', chain: 'a,b' });
    rec.attempts.push(attempt('a', 'limited'));
    store.update(rec);

    const back = store.get(rec.id)!;
    expect(back.task).toBe('fix it');
    expect(back.chain).toBe('a,b');
    expect(back.status).toBe('running');
    expect(back.attempts).toHaveLength(1);
    const v = back.attempts[0].verdict;
    expect(v.type).toBe('limited');
    if (v.type === 'limited') {
      expect(v.resetAt).toBeInstanceOf(Date);
      expect(v.resetAt?.toISOString()).toBe('2026-10-18T22:00:00.000Z');
    }
  });

  it('finish stamps status, lane and finishedAt', () => {
    const store = new RunStore(join(workdir(), 'runs'));
    const rec = store.create({ task: 't' });
    store.finish(rec, 'done', { lane: 'hero' });
    const back = store.get(rec.id)!;
    expect(back.status).toBe('done');
    expect(back.lane).toBe('hero');
    expect(back.finishedAt).toBeTruthy();
  });

  it('markInterrupted flips a running record', () => {
    const store = new RunStore(join(workdir(), 'runs'));
    const rec = store.create({ task: 't' });
    store.markInterrupted(rec);
    expect(store.get(rec.id)!.status).toBe('interrupted');
    // terminal records are untouched
    const done = store.create({ task: 't2' });
    store.finish(done, 'done');
    store.markInterrupted(done);
    expect(store.get(done.id)!.status).toBe('done');
  });

  it('markResumed records the successor id', () => {
    const store = new RunStore(join(workdir(), 'runs'));
    const old = store.create({ task: 't' });
    store.markInterrupted(old);
    const next = store.create({ task: 't', resumedFrom: old.id });
    store.markResumed(old, next.id);
    const back = store.get(old.id)!;
    expect(back.status).toBe('resumed');
    expect(back.resumedBy).toBe(next.id);
  });

  it('resumable: done/resumed never; dead-pid running yes; own pid no', () => {
    const store = new RunStore(join(workdir(), 'runs'));
    const mk = (status: RunRecord['status'], pid: number): RunRecord => ({
      id: 'x',
      task: 't',
      pid,
      status,
      startedAt: new Date().toISOString(),
      attempts: [],
    });
    expect(store.resumable(mk('done', 9999999))).toBe(false);
    expect(store.resumable(mk('resumed', 9999999))).toBe(false);
    expect(store.resumable(mk('interrupted', 9999999))).toBe(true);
    expect(store.resumable(mk('failed', 9999999))).toBe(true);
    expect(store.resumable(mk('running', 9999999))).toBe(true); // dead pid → interrupted
    expect(store.resumable(mk('running', process.pid))).toBe(false); // own live pid
  });

  it('list newest-first and reports dead-pid running as interrupted', () => {
    const store = new RunStore(join(workdir(), 'runs'));
    const a = store.create({ task: 'first' });
    store.finish(a, 'failed', { error: 'x' });
    const b = store.create({ task: 'second' });
    // startedAt drives list() order; set it explicitly — ms-grained ids collide otherwise
    b.startedAt = new Date(Date.parse(a.startedAt) + 1000).toISOString();
    b.pid = 9999999; // simulate a killed owner
    store.update(b);

    const list = store.list();
    expect(list.map((r) => r.task)).toEqual(['second', 'first']);
    expect(list[0].status).toBe('interrupted');
    expect(store.resumable(list[0])).toBe(true);
    // dead-pid reclassification is read-only — the file keeps its content
    expect(store.get(b.id)!.status).toBe('running');
  });
});
