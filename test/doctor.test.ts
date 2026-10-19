import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorChecks, firstCommandWord, resolveExecutable, formatDoctor } from '../src/doctor.js';

const tmp: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'lanerelay-doctor-'));
  tmp.push(d);
  return d;
};
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

const cfg = (lanes: string) => `lanes:\n${lanes}`;

describe('firstCommandWord', () => {
  it('skips env assignments and finds the executable', () => {
    expect(firstCommandWord('claude -p "{{prompt}}"')).toBe('claude');
    expect(firstCommandWord('FOO=bar BAZ=1 node agent.mjs {{prompt}}')).toBe('node');
    expect(firstCommandWord('./scripts/agent.sh "{{prompt}}"')).toBe('./scripts/agent.sh');
    expect(firstCommandWord('   ')).toBeNull();
  });
});

describe('resolveExecutable', () => {
  it('finds a name on PATH and a relative file, misses ghosts', () => {
    const d = dir();
    writeFileSync(join(d, 'agent.sh'), '#!/bin/sh\n');
    expect(resolveExecutable('node', d)).toBe('path');
    expect(resolveExecutable('./agent.sh', d)).toBe('file');
    expect(resolveExecutable('./nope.sh', d)).toBeNull();
    expect(resolveExecutable('definitely-not-a-real-binary-zz', d)).toBeNull();
  });
});

describe('doctorChecks', () => {
  it('reports all-clear on a healthy repo', () => {
    const d = dir();
    writeFileSync(
      join(d, 'lanerelay.yaml'),
      cfg(`  - name: main\n    kind: claude\n    command: "node --version {{prompt}}"\n`),
    );
    const checks = doctorChecks({ cwd: d });
    const failures = checks.filter((c) => c.status === 'fail');
    expect(failures).toEqual([]);
    expect(checks.some((c) => c.name === 'config' && c.status === 'ok')).toBe(true);
    expect(checks.some((c) => c.name === 'lane main: executable' && c.status === 'ok')).toBe(true);
  });

  it('fails when no config exists', () => {
    const checks = doctorChecks({ cwd: dir() });
    const c = checks.find((x) => x.name === 'config')!;
    expect(c.status).toBe('fail');
    // lane checks are skipped but dir/git/state checks still run
    expect(checks.some((x) => x.name === 'git')).toBe(true);
  });

  it('fails when the lane executable is missing', () => {
    const d = dir();
    writeFileSync(
      join(d, 'lanerelay.yaml'),
      cfg(`  - name: ghost\n    kind: custom\n    command: 'ghost-cli-zzz {{prompt}}'\n`),
    );
    const c = doctorChecks({ cwd: d }).find((x) => x.name === 'lane ghost: executable')!;
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('ghost-cli-zzz');
  });

  it('fails when the lane command drops {{prompt}}', () => {
    const d = dir();
    writeFileSync(
      join(d, 'lanerelay.yaml'),
      cfg(`  - name: silent\n    kind: claude\n    command: "node --version"\n`),
    );
    // loadConfig enforces the slot → the config check carries the message
    const c = doctorChecks({ cwd: d }).find((x) => x.name === 'config')!;
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('{{prompt}}');
  });

  it('warns on a corrupt state file', () => {
    const d = dir();
    writeFileSync(
      join(d, 'lanerelay.yaml'),
      cfg(`  - name: main\n    kind: claude\n    command: "node --version {{prompt}}"\n`),
    );
    mkdirSync(join(d, '.lanerelay'), { recursive: true });
    writeFileSync(join(d, '.lanerelay', 'state.json'), '{not json');
    expect(doctorChecks({ cwd: d }).find((c) => c.name === 'state file')?.status).toBe('warn');
  });

  it('warns on stale lease files', () => {
    const d = dir();
    writeFileSync(
      join(d, 'lanerelay.yaml'),
      cfg(`  - name: main\n    kind: claude\n    command: "node --version {{prompt}}"\n`),
    );
    const leases = join(d, '.lanerelay', 'leases');
    mkdirSync(leases, { recursive: true });
    // a pid that cannot exist → the lease is stale and reported as such
    writeFileSync(join(leases, 'codex.json'), JSON.stringify({ runId: 'r-x', pid: 999999999, at: 'x' }));
    const c = doctorChecks({ cwd: d }).find((x) => x.name === 'leases')!;
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('stale');
  });
});

describe('formatDoctor', () => {
  it('renders status tags aligned', () => {
    const text = formatDoctor([
      { name: 'a', status: 'ok', detail: 'fine' },
      { name: 'b', status: 'fail', detail: 'broke' },
    ]);
    expect(text).toContain('ok   a');
    expect(text).toContain('FAIL b');
  });
});
