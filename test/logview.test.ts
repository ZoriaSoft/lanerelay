import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listLogs, resolveLog, tailFile } from '../src/logview.js';
import type { RunRecord } from '../src/runs.js';
import type { AttemptResult } from '../src/types.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'qp-log-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeLog(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

const run = (id: string, logFile: string): RunRecord => ({
  id,
  task: 't',
  pid: 1,
  status: 'done',
  startedAt: '2026-10-18T10:00:00.000Z',
  attempts: [
    {
      lane: 'claude',
      verdict: { type: 'done', outputTail: 'x' },
      exitCode: 0,
      durationMs: 1,
      logFile,
    } satisfies AttemptResult,
  ],
});

describe('listLogs', () => {
  it('lists .log files newest first and parses lane names', () => {
    const d = tmp();
    writeFileSync(join(d, 'a.txt'), 'not a log');
    const old = writeLog(d, '2026-10-18T09-00-00-000Z-claude.log', 'old');
    const fresh = writeLog(d, '2026-10-18T10-00-00-000Z-codex-fast.log', 'new');
    // mtime decides order, not the name.
    utimesSync(old, new Date(0), new Date(0));
    const logs = listLogs(d);
    expect(logs).toHaveLength(2);
    expect(logs[0]?.path).toBe(fresh);
    expect(logs[0]?.lane).toBe('codex-fast');
    expect(logs[1]?.path).toBe(old);
  });

  it('returns [] for a missing directory', () => {
    expect(listLogs(join(tmp(), 'nope'))).toEqual([]);
  });
});

describe('resolveLog', () => {
  it('returns the newest log with no selector', () => {
    const d = tmp();
    const a = writeLog(d, '2026-10-18T09-00-00-000Z-claude.log', 'a');
    const b = writeLog(d, '2026-10-18T10-00-00-000Z-codex.log', 'b');
    utimesSync(a, new Date(0), new Date(0));
    expect(resolveLog(d, { records: [] }).entry?.path).toBe(b);
  });

  it('resolves a run-id prefix through the record\'s logFile', () => {
    const d = tmp();
    const log = writeLog(d, '2026-10-18T10-00-00-000Z-claude.log', 'x');
    writeLog(d, '2026-10-18T11-00-00-000Z-other.log', 'newer but wrong');
    const rec = run('r-abc123', log);
    const hit = resolveLog(d, { selector: 'r-abc', records: [rec] });
    expect(hit.entry?.path).toBe(log);
    expect(hit.error).toBeUndefined();
  });

  it('errors when the run\'s log files are gone', () => {
    const d = tmp();
    writeLog(d, '2026-10-18T10-00-00-000Z-claude.log', 'x');
    const rec = run('r-abc123', join(d, 'gone-claude.log'));
    const miss = resolveLog(d, { selector: 'r-abc123', records: [rec] });
    expect(miss.error).toContain('no surviving log');
  });

  it('resolves queue-item ids through their runId', () => {
    const d = tmp();
    const log = writeLog(d, '2026-10-18T10-00-00-000Z-codex.log', 'x');
    const rec = run('r-abc123', log);
    const item = { id: 'q-77', task: 't', addedAt: 'x', runId: 'r-abc123' };
    expect(resolveLog(d, { selector: 'q-77', records: [rec], queueItems: [item] }).entry?.path).toBe(log);
  });

  it('resolves an exact lane name and a filename fragment', () => {
    const d = tmp();
    const claude = writeLog(d, '2026-10-18T10-00-00-000Z-claude.log', 'x');
    expect(resolveLog(d, { selector: 'claude', records: [], lanes: ['claude'] }).entry?.path).toBe(claude);
    expect(resolveLog(d, { selector: '10-00-00', records: [], lanes: ['claude'] }).entry?.path).toBe(claude);
  });

  it('errors on an unknown selector and on an empty dir', () => {
    const d = tmp();
    expect(resolveLog(d, { records: [] }).error).toContain('no logs');
    writeLog(d, '2026-10-18T10-00-00-000Z-claude.log', 'x');
    expect(resolveLog(d, { selector: 'zzz', records: [] }).error).toContain('zzz');
  });
});

describe('tailFile', () => {
  it('returns the last N lines and the whole file for 0', () => {
    const d = tmp();
    const p = writeLog(d, 'x.log', Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n'));
    const tail = tailFile(p, 5);
    expect(tail.text.split('\n')).toHaveLength(5);
    expect(tail.text).toContain('line49');
    expect(tail.text).not.toContain('line44');
    expect(tail.truncated).toBe(false);
    const all = tailFile(p, 0);
    expect(all.text).toContain('line0');
  });

  it('drops the partial first line inside a cut window', () => {
    const d = tmp();
    const p = writeLog(d, 'x.log', `${'A'.repeat(100)}\n${'B'.repeat(100)}\n`);
    const tail = tailFile(p, 1);
    expect(tail.text).toBe('B'.repeat(100));
  });
});
