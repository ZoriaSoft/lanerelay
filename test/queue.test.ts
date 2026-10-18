import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderPrompt } from '../src/prompt.js';
import { deferDecision, TaskQueue } from '../src/queue.js';
import type { AttemptResult } from '../src/types.js';

const dirs: string[] = [];
function tmpdirPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'qp-q-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('TaskQueue', () => {
  it('adds and claims in FIFO order', () => {
    const q = new TaskQueue(tmpdirPath());
    const a = q.add('first task');
    const b = q.add('second task');
    expect(q.claim()?.id).toBe(a.id);
    expect(q.claim()?.id).toBe(b.id);
    expect(q.claim()).toBeNull();
  });

  it('claim is atomic (second claimer sees nothing)', () => {
    const dir = tmpdirPath();
    const q1 = new TaskQueue(dir);
    const q2 = new TaskQueue(dir);
    q1.add('task');
    expect(q1.claim()).not.toBeNull();
    expect(q2.claim()).toBeNull();
  });

  it('finish moves items to done/failed with result', () => {
    const q = new TaskQueue(tmpdirPath());
    q.add('x');
    const claimed = q.claim()!;
    q.finish(claimed, 'done', { lane: 'claude' });
    expect(q.list('done')[0]?.result).toBe('done');
    expect(q.list('done')[0]?.lane).toBe('claude');
    expect(q.list('pending')).toHaveLength(0);
    expect(q.list('running')).toHaveLength(0);
  });

  it('lists items across states', () => {
    const q = new TaskQueue(tmpdirPath());
    q.add('will fail');
    q.add('will pass');
    const first = q.claim()!;
    q.finish(first, 'failed', { error: 'boom' });
    const second = q.claim()!;
    q.finish(second, 'done', { lane: 'codex' });
    expect(q.list('pending')).toHaveLength(0);
    expect(q.list('failed')).toHaveLength(1);
    expect(q.list('done')).toHaveLength(1);
    expect(q.list()).toHaveLength(2);
  });

  it('claim skips items deferred past now and hands them out after notBefore', () => {
    const q = new TaskQueue(tmpdirPath());
    const a = q.add('first task');
    const b = q.add('second task');
    const claimed = q.claim()!;
    expect(claimed.id).toBe(a.id);
    const wake = new Date(Date.now() + 3_600_000);
    q.defer(claimed, wake, 'all lanes blocked');
    // Deferred head is skipped; the due item behind it still runs.
    expect(q.claim()?.id).toBe(b.id);
    expect(q.claim()).toBeNull();
    // Past the wake time the deferred item is claimable again, FIFO slot kept.
    const later = new Date(wake.getTime() + 1_000);
    const again = q.claim(later)!;
    expect(again.id).toBe(a.id);
    expect(again.defers).toBe(1);
    expect(again.deferReason).toBe('all lanes blocked');
    expect(again.notBefore).toBeUndefined();
  });

  it('defer is atomic across processes: a second claimer sees only the deferred state', () => {
    const dir = tmpdirPath();
    const q1 = new TaskQueue(dir);
    const q2 = new TaskQueue(dir);
    q1.add('task');
    const claimed = q1.claim()!;
    q1.defer(claimed, new Date(Date.now() + 3_600_000), 'all lanes blocked');
    expect(q2.claim()).toBeNull();
    const pending = q2.list('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.defers).toBe(1);
    expect(q2.list('running')).toHaveLength(0);
  });
});

describe('deferDecision', () => {
  const future = new Date(Date.now() + 3_600_000);

  it('defers all-blocked/timeout until the earliest future reset', () => {
    const later = new Date(future.getTime() + 3_600_000);
    const d = deferDecision('all-blocked', [later, future, null], 0, 10);
    expect(d?.wakeAt.getTime()).toBe(future.getTime());
    expect(d?.reason).toBe('all lanes blocked');
    expect(deferDecision('timeout', [future], 0, 10)?.reason).toBe('wait timed out');
  });

  it('does not defer done/failed verdicts or past the defer cap', () => {
    expect(deferDecision('done', [future], 0, 10)).toBeNull();
    expect(deferDecision('failed', [future], 0, 10)).toBeNull();
    expect(deferDecision('all-blocked', [future], 10, 10)).toBeNull();
    expect(deferDecision('all-blocked', [future], 9, 10)).not.toBeNull();
    // maxDefers 0 = defer forever.
    expect(deferDecision('timeout', [future], 999, 0)).not.toBeNull();
  });

  it('falls back to a short retry when no reset is known', () => {
    const now = new Date();
    const d = deferDecision('all-blocked', [null, null], 0, 10, now)!;
    expect(d.wakeAt.getTime() - now.getTime()).toBe(60_000);
  });
});

describe('renderPrompt', () => {
  const baseAttempt = (lane: string, tail: string): AttemptResult => ({
    lane,
    verdict: { type: 'limited', outputTail: tail, resetAt: null, evidence: 'e' },
    exitCode: 1,
    durationMs: 1000,
  });

  it('returns the bare task when there are no attempts', () => {
    expect(renderPrompt({ task: 'fix it', attempts: [], cwd: '/x', diffSummary: '' })).toBe('fix it');
  });

  it('appends handoff context after a limit', () => {
    const p = renderPrompt({
      task: 'fix the failing test',
      attempts: [baseAttempt('claude', 'did some edits then hit the 5-hour limit')],
      cwd: '/x',
      diffSummary: ' src/foo.ts | 4 ++--',
    });
    expect(p).toContain('fix the failing test');
    expect(p).toContain('already attempted');
    expect(p).toContain('src/foo.ts');
    expect(p).toContain('claude');
    expect(p).toContain('did some edits');
  });

  it('keeps prompts bounded', () => {
    const p = renderPrompt({
      task: 't',
      attempts: [baseAttempt('a', 'x'.repeat(100_000)), baseAttempt('b', 'y'.repeat(100_000))],
      cwd: '/x',
      diffSummary: '',
    });
    expect(p.length).toBeLessThanOrEqual(16_000);
  });
});
