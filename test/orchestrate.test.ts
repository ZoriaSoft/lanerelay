import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { orderLanes } from '../src/config.js';
import { runTask } from '../src/orchestrate.js';
import { LaneStore } from '../src/state.js';

const dirs: string[] = [];
function workdir(): string {
  const d = mkdtempSync(join(tmpdir(), 'qp-orch-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a fake agent script and return a config lane pointing at it. */
function fakeLane(
  dir: string,
  name: string,
  script: string,
  extra: Record<string, unknown> = {},
): { name: string; kind: string; command: string } {
  const path = join(dir, `${name}.sh`);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return {
    name,
    kind: extra.kind as string ?? 'custom',
    command: `${path} {{prompt}}`,
    ...extra,
  };
}

function cfg(dir: string, lanes: ReturnType<typeof fakeLane>[], extra = ''): string {
  const yaml = `lanes:\n${lanes
    .map(
      (l) => `  - name: ${l.name}\n    kind: ${l.kind}\n    command: "${l.command}"\n`,
    )
    .join('')}${extra}`;
  const p = join(dir, 'quota-pilot.yaml');
  writeFileSync(p, yaml);
  return p;
}

const silent = { runOpts: { tee: false } };

describe('runTask', () => {
  it('succeeds on the first lane when it exits 0', async () => {
    const dir = workdir();
    const cfgPath = cfg(dir, [
      fakeLane(dir, 'good', 'echo working; exit 0'),
      fakeLane(dir, 'other', 'echo nope; exit 1'),
    ]);
    const config = loadConfig(cfgPath);
    const store = new LaneStore(join(dir, 'state.json'));
    const v = await runTask('fix the test', config, orderLanes(config), store, { cwd: dir, ...silent });
    expect(v.type).toBe('done');
    if (v.type === 'done') expect(v.lane).toBe('good');
    expect(v.attempts).toHaveLength(1);
  });

  it('hands off to the next lane when the first hits a limit', async () => {
    const dir = workdir();
    const cfgPath = cfg(dir, [
      fakeLane(dir, 'limited', 'echo "5-hour limit reached. resets at 11pm" >&2; exit 1', { kind: 'claude' }),
      fakeLane(dir, 'hero', 'printf \'%s\' "$1" > handoff-prompt.txt; echo done; exit 0'),
    ]);
    const config = loadConfig(cfgPath);
    const store = new LaneStore(join(dir, 'state.json'));
    const v = await runTask('the task', config, orderLanes(config), store, { cwd: dir, ...silent });
    expect(v.type).toBe('done');
    if (v.type === 'done') expect(v.lane).toBe('hero');
    expect(v.attempts).toHaveLength(2);
    expect(v.attempts[0].verdict.type).toBe('limited');

    // lane marked blocked in state
    expect(store.blockedUntil('limited')).not.toBeNull();

    // the second lane's prompt should contain the handoff section
    const prompt = readFileSync(join(dir, 'handoff-prompt.txt'), 'utf8');
    expect(prompt).toContain('the task');
    expect(prompt).toContain('already attempted');
    expect(prompt).toContain('limited');
  });

  it('returns all-blocked when every lane is limited and --no-wait', async () => {
    const dir = workdir();
    const cfgPath = cfg(dir, [
      fakeLane(dir, 'x', 'echo "rate limit" >&2; exit 1', { kind: 'codex' }),
      fakeLane(dir, 'y', 'echo "429 Too Many Requests" >&2; exit 1', { kind: 'codex' }),
    ]);
    const config = loadConfig(cfgPath);
    const store = new LaneStore(join(dir, 'state.json'));
    const v = await runTask('t', config, orderLanes(config), store, { cwd: dir, wait: false, ...silent });
    expect(v.type).toBe('all-blocked');
  });

  it('resumes a lane after its reset time passes', async () => {
    const dir = workdir();
    // 'flaky' fails limited on first call (state file marker), succeeds on second
    const flaky = fakeLane(
      dir,
      'flaky',
      'test -f .first-run && { echo ok; exit 0; } || { touch .first-run; echo "rate limit, try again in 1 minute" >&2; exit 1; }',
      { kind: 'codex' },
    );
    const cfgPath = cfg(dir, [flaky]);
    const config = loadConfig(cfgPath);
    const store = new LaneStore(join(dir, 'state.json'));

    // Fake clock that we advance past the 1-minute reset after the sleep call.
    const realNow = Date.now();
    let fakeNow = realNow;
    const v = await runTask('t', config, orderLanes(config), store, {
      cwd: dir,
      wait: true,
      ...silent,
      now: () => new Date(fakeNow),
      sleep: async (ms) => {
        fakeNow += ms;
      },
    });
    expect(v.type).toBe('done');
    expect(v.attempts).toHaveLength(2);
  });

  it('keeps going past a non-limit failure', async () => {
    const dir = workdir();
    const cfgPath = cfg(dir, [
      fakeLane(dir, 'broken', 'echo "segmentation fault"; exit 3'),
      fakeLane(dir, 'fine', 'echo all good; exit 0'),
    ]);
    const config = loadConfig(cfgPath);
    const store = new LaneStore(join(dir, 'state.json'));
    const v = await runTask('t', config, orderLanes(config), store, { cwd: dir, ...silent });
    expect(v.type).toBe('done');
    expect(v.attempts[0].verdict.type).toBe('failed');
  });

  it('reports failed when every lane fails without limits', async () => {
    const dir = workdir();
    const cfgPath = cfg(dir, [
      fakeLane(dir, 'b1', 'exit 1'),
      fakeLane(dir, 'b2', 'exit 2'),
    ]);
    const config = loadConfig(cfgPath);
    const store = new LaneStore(join(dir, 'state.json'));
    const v = await runTask('t', config, orderLanes(config), store, { cwd: dir, wait: false, ...silent });
    expect(v.type).toBe('failed');
  });

  it('skips lanes already blocked in the store', async () => {
    const dir = workdir();
    const cfgPath = cfg(dir, [
      fakeLane(dir, 'blocked', 'echo should-not-run; exit 0'),
      fakeLane(dir, 'open', 'echo hi; exit 0'),
    ]);
    const config = loadConfig(cfgPath);
    const store = new LaneStore(join(dir, 'state.json'));
    store.markBlocked('blocked', new Date(Date.now() + 3600_000), 'pre-blocked');
    const v = await runTask('t', config, orderLanes(config), store, { cwd: dir, ...silent });
    expect(v.type).toBe('done');
    expect(v.attempts).toHaveLength(1);
    expect(v.attempts[0].lane).toBe('open');
  });
});
