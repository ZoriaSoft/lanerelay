import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectAuthError, probeLane } from '../src/probe.js';
import { LaneStore } from '../src/state.js';
import type { Lane } from '../src/types.js';

const NOW = new Date('2026-10-18T10:00:00Z');

const tmpDirs: string[] = [];

function tmpdir2(): string {
  const d = mkdtempSync(join(tmpdir(), 'lanerelay-probe-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Write an executable fake lane script that prints `out` and exits `code`. */
function fakeLane(dir: string, name: string, out: string, code: number, kind: Lane['kind'] = 'claude'): Lane {
  const script = join(dir, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\necho ${JSON.stringify(out)}\nexit ${code}\n`);
  chmodSync(script, 0o755);
  return {
    name,
    kind,
    command: `${script} {{prompt}}`,
    priority: 0,
    cost: 'paid',
    timeoutMinutes: 0,
    defaultResetMinutes: 60,
    patterns: {},
  };
}

describe('detectAuthError', () => {
  it('catches common auth failures', () => {
    expect(detectAuthError('Error: 401 Unauthorized\n')).toBeTruthy();
    expect(detectAuthError('Invalid API key provided\n')).toBeTruthy();
    expect(detectAuthError('Please run /login to continue\n')).toBeTruthy();
    expect(detectAuthError('To use Codex with your ChatGPT plan, upgrade to Plus: https://x\n')).toBeTruthy();
    expect(detectAuthError('all good\n')).toBeNull();
  });
});

describe('probeLane', () => {
  it('classifies a clean exit as available and marks done', async () => {
    const dir = tmpdir2();
    const lane = fakeLane(dir, 'a', 'OK', 0);
    const s = new LaneStore(join(dir, 'state.json'));
    const r = await probeLane(lane, s, { cwd: dir, now: () => NOW });
    expect(r.status).toBe('available');
    expect(s.get('a').lastResult).toBe('done');
    expect(s.blockedUntil('a', NOW)).toBeNull();
  });

  it('classifies a limit message as limited and stores the reset', async () => {
    const dir = tmpdir2();
    const lane = fakeLane(dir, 'a', 'You\'ve hit your limit · resets 9:10pm (Europe/Kiev)', 1);
    const s = new LaneStore(join(dir, 'state.json'));
    const r = await probeLane(lane, s, { cwd: dir, now: () => NOW });
    expect(r.status).toBe('limited');
    expect(r.resetAt?.getHours()).toBe(21);
    expect(s.blockedUntil('a', NOW)?.getHours()).toBe(21);
  });

  it('falls back to defaultResetMinutes when no reset is printed', async () => {
    const dir = tmpdir2();
    const lane = fakeLane(dir, 'a', 'You\'ve hit your session limit', 1);
    const s = new LaneStore(join(dir, 'state.json'));
    const r = await probeLane(lane, s, { cwd: dir, now: () => NOW });
    expect(r.status).toBe('limited');
    expect(r.resetAt?.getTime()).toBe(NOW.getTime() + 60 * 60_000);
  });

  it('classifies auth failures as auth-error and blocks the lane', async () => {
    const dir = tmpdir2();
    const lane = fakeLane(dir, 'a', 'Error: 401 Unauthorized: invalid API key', 1);
    const s = new LaneStore(join(dir, 'state.json'));
    const r = await probeLane(lane, s, { cwd: dir, now: () => NOW });
    expect(r.status).toBe('auth-error');
    expect(s.blockedUntil('a', NOW)).not.toBeNull();
  });

  it('classifies generic failures as error without blocking', async () => {
    const dir = tmpdir2();
    const lane = fakeLane(dir, 'a', 'segfault or something', 3);
    const s = new LaneStore(join(dir, 'state.json'));
    const r = await probeLane(lane, s, { cwd: dir, now: () => NOW });
    expect(r.status).toBe('error');
    expect(s.blockedUntil('a', NOW)).toBeNull();
    expect(s.get('a').lastResult).toBe('failed');
  });

  it('times out a hanging lane', async () => {
    const dir = tmpdir2();
    const script = join(dir, 'hang.sh');
    writeFileSync(script, '#!/bin/sh\nsleep 60\n');
    chmodSync(script, 0o755);
    const lane: Lane = {
      name: 'hang',
      kind: 'custom',
      command: `${script} {{prompt}}`,
      priority: 0,
      cost: 'paid',
      timeoutMinutes: 0,
      defaultResetMinutes: 60,
      patterns: {},
    };
    const s = new LaneStore(join(dir, 'state.json'));
    const r = await probeLane(lane, s, { cwd: dir, timeoutMs: 300, now: () => NOW });
    expect(r.status).toBe('timeout');
    expect(s.get('hang').lastResult).toBe('timeout');
  }, 10_000);
});
