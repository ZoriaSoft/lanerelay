import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, orderLanes } from '../src/config.js';
import { LaneStore } from '../src/state.js';
import type { Config } from '../src/types.js';

const tmp: string[] = [];
function cfgFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lanerelay-cfg-'));
  tmp.push(dir);
  const p = join(dir, 'lanerelay.yaml');
  writeFileSync(p, yaml);
  return p;
}

afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = `
lanes:
  - name: a
    kind: claude
    command: "echo {{prompt}}"
  - name: b
    kind: codex
    command: "echo {{prompt}}"
    cost: free
    priority: -1
  - name: c
    kind: gemini
    command: "echo {{prompt}}"
    cost: paid
    priority: 5
`;

describe('loadConfig', () => {
  it('parses lanes and validates', () => {
    const cfg = loadConfig(cfgFile(BASE));
    expect(cfg.lanes.map((l) => l.name)).toEqual(['a', 'b', 'c']);
  });

  it('rejects missing {{prompt}} in command', () => {
    expect(() => loadConfig(cfgFile('lanes:\n  - name: x\n    command: "echo hi"\n'))).toThrow(ConfigError);
  });

  it('rejects duplicate lane names', () => {
    expect(() =>
      loadConfig(cfgFile('lanes:\n  - name: x\n    command: "echo {{prompt}}"\n  - name: x\n    command: "echo {{prompt}}"\n')),
    ).toThrow(/duplicate/);
  });

  it('rejects unknown kind', () => {
    expect(() =>
      loadConfig(cfgFile('lanes:\n  - name: x\n    kind: bogus\n    command: "echo {{prompt}}"\n')),
    ).toThrow(/unknown kind/);
  });

  it('rejects an invalid pattern regex with the lane name', () => {
    const yaml = 'lanes:\n  - name: x\n    command: "echo {{prompt}}"\n    patterns:\n      usage: ["["]\n';
    expect(() => loadConfig(cfgFile(yaml))).toThrow(/lane "x"[\s\S]*invalid regex/);
  });

  it('rejects a non-positive queue.jobs', () => {
    expect(() =>
      loadConfig(cfgFile(`${BASE}\nqueue:\n  jobs: 0\n`)),
    ).toThrow(/queue\.jobs/);
    expect(() =>
      loadConfig(cfgFile(`${BASE}\nqueue:\n  jobs: 1.5\n`)),
    ).toThrow(/queue\.jobs/);
  });

  it('accepts a positive queue.jobs', () => {
    const cfg = loadConfig(cfgFile(`${BASE}\nqueue:\n  jobs: 3\n`));
    expect(cfg.queue?.jobs).toBe(3);
  });

  it('rejects an unknown handoff.diff mode', () => {
    expect(() =>
      loadConfig(cfgFile(`${BASE}\nhandoff:\n  diff: everything\n`)),
    ).toThrow(/handoff\.diff/);
    expect(() =>
      loadConfig(cfgFile(`${BASE}\nhandoff:\n  diffMaxBytes: -5\n`)),
    ).toThrow(/diffMaxBytes/);
  });

  it('accepts handoff.diff modes', () => {
    for (const mode of ['none', 'stat', 'full']) {
      const cfg = loadConfig(cfgFile(`${BASE}\nhandoff:\n  diff: ${mode}\n  diffMaxBytes: 4096\n`));
      expect(cfg.handoff?.diff).toBe(mode);
      expect(cfg.handoff?.diffMaxBytes).toBe(4096);
    }
  });
});


describe('orderLanes', () => {
  it('orders paid before free, then priority', () => {
    const cfg = loadConfig(cfgFile(BASE));
    expect(orderLanes(cfg).map((l) => l.name)).toEqual(['a', 'c', 'b']);
  });

  it('respects paidFirst: false', () => {
    const cfg = loadConfig(cfgFile(BASE + 'defaults:\n  paidFirst: false\n'));
    // pure priority order: b(-1), a(0), c(5)
    expect(orderLanes(cfg).map((l) => l.name)).toEqual(['b', 'a', 'c']);
  });

  it('explicit chain order wins over priority/cost', () => {
    const cfg = loadConfig(cfgFile(BASE));
    expect(orderLanes(cfg, 'b,a').map((l) => l.name)).toEqual(['b', 'a']);
  });

  it('named chains resolve from config', () => {
    const cfg = loadConfig(cfgFile(BASE + 'chains:\n  cheap:\n    lanes: [b, c]\n'));
    expect(orderLanes(cfg, 'cheap').map((l) => l.name)).toEqual(['b', 'c']);
  });

  it('unknown lane in chain throws', () => {
    const cfg = loadConfig(cfgFile(BASE));
    expect(() => orderLanes(cfg, 'a,zzz')).toThrow(/no lane named "zzz"/);
  });

  it('with quota readings, richest lane wins over priority inside a cost class', () => {
    // a(paid,p0,3%), c(paid,p5,90%), b(free,p-1,unknown)
    const dir = mkdtempSync(join(tmpdir(), 'lanerelay-ord-'));
    tmp.push(dir);
    const store = new LaneStore(join(dir, 'state.json'));
    store.markUsage('a', { pctLeft: 3, evidence: 'usage 3% left' });
    store.markUsage('c', { pctLeft: 90, evidence: 'usage 90% left' });
    const cfg = loadConfig(cfgFile(BASE));
    expect(orderLanes(cfg, undefined, store).map((l) => l.name)).toEqual(['c', 'a', 'b']);
  });

  it('ungauged lanes count as 100% but stay behind paid cost class', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lanerelay-ord-'));
    tmp.push(dir);
    const store = new LaneStore(join(dir, 'state.json'));
    store.markUsage('a', { pctLeft: 12, evidence: 'e' });
    const cfg = loadConfig(cfgFile(BASE));
    // c(paid, no reading → 100) beats a(paid, 12); b is free → always last
    expect(orderLanes(cfg, undefined, store).map((l) => l.name)).toEqual(['c', 'a', 'b']);
  });

  it('explicit chains ignore quota readings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lanerelay-ord-'));
    tmp.push(dir);
    const store = new LaneStore(join(dir, 'state.json'));
    store.markUsage('b', { pctLeft: 99, evidence: 'e' });
    const cfg = loadConfig(cfgFile(BASE));
    expect(orderLanes(cfg, 'a,b', store).map((l) => l.name)).toEqual(['a', 'b']);
  });
});

describe('LaneStore', () => {
  it('round-trips blocked state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lanerelay-state-'));
    tmp.push(dir);
    const path = join(dir, 'state.json');
    const store = new LaneStore(path);
    const until = new Date(Date.now() + 3600_000);
    store.markBlocked('a', until, 'rate limit hit');

    const fresh = new LaneStore(path);
    expect(fresh.blockedUntil('a')?.toISOString()).toBe(until.toISOString());
    expect(fresh.get('a').blockedReason).toBe('rate limit hit');
    expect(fresh.blockedUntil('b')).toBeNull();
  });

  it('treats expired blocks as free', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lanerelay-state-'));
    tmp.push(dir);
    const store = new LaneStore(join(dir, 'state.json'));
    store.markBlocked('a', new Date(Date.now() - 1000), 'expired');
    expect(store.blockedUntil('a')).toBeNull();
  });

  it('unblock clears one lane or all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lanerelay-state-'));
    tmp.push(dir);
    const store = new LaneStore(join(dir, 'state.json'));
    const until = new Date(Date.now() + 3600_000);
    store.markBlocked('a', until, 'x');
    store.markBlocked('b', until, 'y');
    store.unblock('a');
    expect(store.blockedUntil('a')).toBeNull();
    expect(store.blockedUntil('b')).not.toBeNull();
    store.unblock();
    expect(store.blockedUntil('b')).toBeNull();
  });

  it('survives a corrupt state file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lanerelay-state-'));
    tmp.push(dir);
    const path = join(dir, 'state.json');
    writeFileSync(path, '{not json');
    const store = new LaneStore(path);
    expect(store.blockedUntil('a')).toBeNull();
  });
  it('stores and expires usage readings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lanerelay-state-'));
    tmp.push(dir);
    const path = join(dir, 'state.json');
    const store = new LaneStore(path);
    store.markUsage('a', { pctLeft: 42, evidence: 'usage: 58%' });

    const fresh = new LaneStore(path);
    expect(fresh.quotaLeft('a')).toBe(42);
    expect(fresh.quotaLeft('b')).toBeNull();
    // readings older than 24h are stale — resets refill the gauge
    expect(fresh.quotaLeft('a', new Date(Date.now() + 25 * 3_600_000))).toBeNull();
    // manual unblock (window rolled over / creds swapped) clears the gauge
    fresh.unblock('a');
    expect(fresh.quotaLeft('a')).toBeNull();
  });
  it('stores per-window gauges and orders on the poorest fresh window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lanerelay-state-'));
    tmp.push(dir);
    const store = new LaneStore(join(dir, 'state.json'));
    store.markUsage('a', [
      { pctLeft: 90, window: 'session', evidence: 'session 90%' },
      { pctLeft: 12, window: 'weekly', evidence: 'weekly 12% left' },
    ]);
    expect(store.quotaLeft('a')).toBe(12);
    expect(store.usageReadings('a').map((o) => o.window)).toEqual(['session', 'weekly']);
    // a new reading updates only its own window
    store.markUsage('a', { pctLeft: 40, window: 'weekly', evidence: 'weekly 40% left' });
    expect(store.quotaLeft('a')).toBe(40);
    // session TTL (8h) passes while weekly (9d) survives
    const later = new Date(Date.now() + 10 * 3_600_000);
    expect(store.usageReadings('a', later).map((o) => o.window)).toEqual(['weekly']);
    expect(store.quotaLeft('a', later)).toBe(40);
  });

  it('reads legacy single-gauge state files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lanerelay-state-'));
    tmp.push(dir);
    const path = join(dir, 'state.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        lanes: { a: { usage: { pctLeft: 30, observedAt: new Date().toISOString(), evidence: 'e' } } },
      }),
    );
    const store = new LaneStore(path);
    expect(store.quotaLeft('a')).toBe(30);
    expect(store.usageReadings('a')[0].window).toBe('other');
  });
});
