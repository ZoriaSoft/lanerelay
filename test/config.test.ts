import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, orderLanes } from '../src/config.js';
import { LaneStore } from '../src/state.js';
import type { Config } from '../src/types.js';

const tmp: string[] = [];
function cfgFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qp-cfg-'));
  tmp.push(dir);
  const p = join(dir, 'quota-pilot.yaml');
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
});

describe('LaneStore', () => {
  it('round-trips blocked state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qp-state-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'qp-state-'));
    tmp.push(dir);
    const store = new LaneStore(join(dir, 'state.json'));
    store.markBlocked('a', new Date(Date.now() - 1000), 'expired');
    expect(store.blockedUntil('a')).toBeNull();
  });

  it('unblock clears one lane or all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qp-state-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'qp-state-'));
    tmp.push(dir);
    const path = join(dir, 'state.json');
    writeFileSync(path, '{not json');
    const store = new LaneStore(path);
    expect(store.blockedUntil('a')).toBeNull();
  });
});
