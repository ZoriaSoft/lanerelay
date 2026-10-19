import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LeaseSet } from '../src/leases.js';

const dirs: string[] = [];
function leasesDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lanerelay-lease-'));
  dirs.push(d);
  return join(d, 'leases');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fileFor = (dir: string, lane: string) => join(dir, `${encodeURIComponent(lane)}.json`);

/** A pid that is guaranteed dead (reaped right after spawn). */
function deadPid(): number {
  const p = spawnSync(process.execPath, ['-e', '']);
  if (p.pid === undefined) throw new Error('cannot spawn for dead pid');
  return p.pid;
}

describe('LeaseSet', () => {
  it('acquire creates a lease file and release removes it', () => {
    const dir = leasesDir();
    const ls = new LeaseSet(dir);
    expect(ls.acquire('claude', 'run-1')).toBe(true);
    const lease = JSON.parse(readFileSync(fileFor(dir, 'claude'), 'utf8'));
    expect(lease.runId).toBe('run-1');
    expect(lease.pid).toBe(process.pid);
    ls.release('claude');
    expect(existsSync(fileFor(dir, 'claude'))).toBe(false);
  });

  it('blocks a second run in the same process from the same lane', () => {
    const dir = leasesDir();
    const ls = new LeaseSet(dir);
    expect(ls.acquire('claude', 'run-A')).toBe(true);
    // Same pid, different runId (a second watch worker): must be "other".
    expect(ls.acquire('claude', 'run-B')).toBe(false);
    const other = ls.heldByOther('claude', 'run-B');
    expect(other?.runId).toBe('run-A');
    // The owner itself does not see it as foreign.
    expect(ls.heldByOther('claude', 'run-A')).toBeNull();
  });

  it('re-acquire is a no-op for the owning run', () => {
    const dir = leasesDir();
    const ls = new LeaseSet(dir);
    expect(ls.acquire('claude', 'run-A')).toBe(true);
    expect(ls.acquire('claude', 'run-A')).toBe(true);
  });

  it('releaseRun drops only that run\'s leases', () => {
    const dir = leasesDir();
    const ls = new LeaseSet(dir);
    ls.acquire('a', 'run-1');
    ls.acquire('b', 'run-2');
    ls.releaseRun('run-1');
    expect(existsSync(fileFor(dir, 'a'))).toBe(false);
    expect(existsSync(fileFor(dir, 'b'))).toBe(true);
    // run-2's lease survives → still blocks run-3
    expect(ls.acquire('b', 'run-3')).toBe(false);
  });

  it('reclaims a lease whose owner pid is dead', () => {
    const dir = leasesDir();
    const ls = new LeaseSet(dir);
    writeFileSync(fileFor(dir, 'ghost'), JSON.stringify({ runId: 'old', pid: deadPid(), at: '' }));
    expect(ls.acquire('ghost', 'new-run')).toBe(true);
    const lease = JSON.parse(readFileSync(fileFor(dir, 'ghost'), 'utf8'));
    expect(lease.runId).toBe('new-run');
  });

  it('treats a fresh corrupt file as held, a stale one as free', () => {
    const dir = leasesDir();
    const ls = new LeaseSet(dir);
    writeFileSync(fileFor(dir, 'partial'), '{not json');
    // Fresh garbage: a racer may be mid-write — do not trample it.
    expect(ls.heldByOther('partial', 'me')).not.toBeNull();
    expect(ls.acquire('partial', 'me')).toBe(false);
    // Aged garbage: reclaimed.
    const old = new Date(Date.now() - 60_000);
    utimesSync(fileFor(dir, 'partial'), old, old);
    expect(ls.acquire('partial', 'me')).toBe(true);
  });

  it('release does not remove a file it does not own', () => {
    const dir = leasesDir();
    const ls = new LeaseSet(dir);
    ls.acquire('x', 'run-1');
    // Simulate the map losing the lane while our file still exists:
    // release must only touch files owned by the tracked runId.
    writeFileSync(fileFor(dir, 'x'), JSON.stringify({ runId: 'run-2', pid: process.pid, at: '' }));
    ls.release('x');
    // run-2's file must survive (another worker owns it now).
    expect(existsSync(fileFor(dir, 'x'))).toBe(true);
  });

  it('heldLanes reports live leases and prunes dead ones', () => {
    const dir = leasesDir();
    const ls = new LeaseSet(dir);
    ls.acquire('a', 'run-1');
    writeFileSync(fileFor(dir, 'dead'), JSON.stringify({ runId: 'gone', pid: deadPid(), at: '' }));
    const held = ls.heldLanes();
    expect(held['a']?.runId).toBe('run-1');
    expect(held['dead']).toBeUndefined();
    expect(existsSync(fileFor(dir, 'dead'))).toBe(false);
  });

  it('releaseProcess removes every file owned by this pid', () => {
    const dir = leasesDir();
    const ls = new LeaseSet(dir);
    ls.acquire('a', 'run-1');
    ls.acquire('b', 'run-2');
    // Live foreign pid: detached + unref'd so the test exits without it.
    const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { detached: true, stdio: 'ignore' });
    foreign.unref();
    const foreignPid = foreign.pid!;
    try {
      writeFileSync(fileFor(dir, 'other'), JSON.stringify({ runId: 'ext', pid: foreignPid, at: '' }));
      ls.releaseProcess();
      expect(existsSync(fileFor(dir, 'a'))).toBe(false);
      expect(existsSync(fileFor(dir, 'b'))).toBe(false);
      expect(existsSync(fileFor(dir, 'other'))).toBe(true);
    } finally {
      try {
        process.kill(-foreignPid, 'SIGKILL');
      } catch {
        try {
          process.kill(foreignPid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
    }
  });
});
