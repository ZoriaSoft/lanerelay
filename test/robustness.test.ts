import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, orderLanes } from '../src/config.js';
import { gitDiffSummary } from '../src/git.js';
import { fireHooks, renderHookCommand } from '../src/hooks.js';
import { runTask } from '../src/orchestrate.js';
import { handoffTail, HANDOFF_END, renderPrompt } from '../src/prompt.js';
import { activeLaneCount, killActiveLanes, runLane } from '../src/runner.js';
import { LaneStore } from '../src/state.js';
import type { Lane } from '../src/types.js';

const ROOT = resolve(__dirname, '..');
// Absolute loader URL: `--import tsx` would resolve from the temp cwd.
const TSX = pathToFileURL(require.resolve('tsx')).href;
const dirs: string[] = [];
function workdir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lanerelay-rob-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const lane = (command: string, extra: Partial<Lane> = {}): Lane => ({
  name: 'l',
  kind: 'custom',
  command,
  priority: 0,
  cost: 'paid',
  timeoutMinutes: 0,
  defaultResetMinutes: 60,
  patterns: {},
  ...extra,
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const readPid = (f: string) => parseInt(readFileSync(f, 'utf8'), 10);

// Fake lanes are POSIX shell scripts.
describe.skipIf(process.platform === 'win32')('runner: stdin and cancel', () => {
  it('lane children get no stdin (headless CLIs must not wait on it)', async () => {
    const dir = workdir();
    const started = Date.now();
    const r = await runLane(lane('if read x; then echo got; else echo eof; fi'), 'p', { cwd: dir, tee: false });
    expect(r.outputTail.trim()).toBe('eof');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('killActiveLanes takes down the lane and its grandchildren', async () => {
    if (process.platform === 'win32') return;
    const dir = workdir();
    const pidFile = join(dir, 'gc.pid');
    const p = runLane(lane(`sleep 60 & echo $! > ${pidFile}; wait`), 'p', { cwd: dir, tee: false });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const gc = readPid(pidFile);
    expect(alive(gc)).toBe(true);
    expect(activeLaneCount()).toBe(1);
    await killActiveLanes(1_000);
    const r = await p;
    expect(r.exitCode).not.toBe(0);
    await waitFor(() => !alive(gc), 2_000);
    expect(activeLaneCount()).toBe(0);
  });

  it('SIGINT to `lanerelay run` stops the lane process group and marks the run interrupted', async () => {
    if (process.platform === 'win32') return;
    const dir = workdir();
    const pidFile = join(dir, 'gc.pid');
    const script = join(dir, 'agent.sh');
    writeFileSync(script, `#!/bin/sh\nsleep 60 &\necho $! > ${pidFile}\nwait\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(dir, 'lanerelay.yaml'), `lanes:\n  - name: slow\n    command: "${script} {{prompt}}"\n`);
    const cli = spawn(process.execPath, ['--import', TSX, join(ROOT, 'src', 'cli.ts'), 'run', '-q', 'a task'], {
      cwd: dir,
      stdio: 'ignore',
    });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 15_000);
    const gc = readPid(pidFile);
    expect(alive(gc)).toBe(true);
    const exited = new Promise<number | null>((r) => cli.on('exit', (code) => r(code)));
    cli.kill('SIGINT');
    expect(await exited).toBe(130);
    await waitFor(() => !alive(gc), 3_000);
    const runsDir = join(dir, '.lanerelay', 'runs');
    const rec = JSON.parse(readFileSync(join(runsDir, readdirSync(runsDir)[0]), 'utf8'));
    expect(rec.status).toBe('interrupted');
  }, 30_000);
});

describe('state: concurrent writers', () => {
  it('two processes blocking different lanes at once lose no update', async () => {
    const dir = workdir();
    const path = join(dir, 'state.json');
    const helper = join(__dirname, 'helpers', 'state-writer.ts');
    const run = (prefix: string) =>
      new Promise<number | null>((r) => {
        const c = spawn(process.execPath, ['--import', TSX, helper, path, prefix, '150'], { stdio: 'inherit' });
        c.on('exit', (code) => r(code));
      });
    const codes = await Promise.all([run('a'), run('b'), run('c')]);
    expect(codes).toEqual([0, 0, 0]);
    const lanes = Object.keys(new LaneStore(path).all());
    expect(lanes.length).toBe(3 * 150);
    expect(existsSync(`${path}.lock`)).toBe(false);
  }, 30_000);

  it('breaks a lock left behind by a dead process', () => {
    const dir = workdir();
    const path = join(dir, 'state.json');
    // A pid that is certainly not running.
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
    writeFileSync(`${path}.lock`, dead);
    const s = new LaneStore(path);
    s.markResult('x', 'done');
    expect(new LaneStore(path).get('x').lastResult).toBe('done');
  });
});

// Fake lanes are POSIX shell scripts.
describe.skipIf(process.platform === 'win32')('orchestrator: broken lanes', () => {
  it('a failing lane is not retried while another waits for its reset', async () => {
    const dir = workdir();
    const flaky = join(dir, 'flaky.sh');
    writeFileSync(
      flaky,
      '#!/bin/sh\ntest -f .first && { echo ok; exit 0; } || { touch .first; echo "Rate limit exceeded, try again in 1 minute" >&2; exit 1; }\n',
    );
    const broken = join(dir, 'broken.sh');
    writeFileSync(broken, '#!/bin/sh\necho "broken" >> calls.txt\necho "Error: unknown flag --yolo" >&2\nexit 2\n');
    chmodSync(flaky, 0o755);
    chmodSync(broken, 0o755);
    writeFileSync(
      join(dir, 'lanerelay.yaml'),
      `lanes:\n  - name: flaky\n    kind: codex\n    command: "${flaky} {{prompt}}"\n  - name: broken\n    command: "${broken} {{prompt}}"\n    priority: 1\n`,
    );
    const config = loadConfig(join(dir, 'lanerelay.yaml'));
    const store = new LaneStore(join(dir, 'state.json'));
    let fake = Date.now();
    const v = await runTask('t', config, orderLanes(config), store, {
      cwd: dir,
      wait: true,
      runOpts: { tee: false },
      now: () => new Date(fake),
      sleep: async (ms) => {
        fake += ms;
      },
    });
    expect(v.type).toBe('done');
    expect(v.attempts.map((a) => `${a.lane}:${a.verdict.type}`)).toEqual(['flaky:limited', 'broken:failed', 'flaky:done']);
    expect(readFileSync(join(dir, 'calls.txt'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('every lane broken → failed verdict, with auth evidence when the CLI is logged out', async () => {
    const dir = workdir();
    const a = join(dir, 'a.sh');
    writeFileSync(a, '#!/bin/sh\necho "Not logged in · Please run /login"\nexit 1\n');
    chmodSync(a, 0o755);
    writeFileSync(join(dir, 'lanerelay.yaml'), `lanes:\n  - name: a\n    kind: claude\n    command: "${a} {{prompt}}"\n`);
    const config = loadConfig(join(dir, 'lanerelay.yaml'));
    const store = new LaneStore(join(dir, 'state.json'));
    const v = await runTask('t', config, orderLanes(config), store, { cwd: dir, wait: true, runOpts: { tee: false } });
    expect(v.type).toBe('failed');
    if (v.type === 'failed') expect(v.lastError).toMatch(/^auth error/);
    expect(store.blockedUntil('a')).toBeNull();
  });
});

describe('handoff context', () => {
  it('strips an echoed earlier handoff prompt (codex prints its input)', () => {
    const earlier = renderPrompt({
      task: 'fix the bug',
      attempts: [{ lane: 'x', exitCode: 1, durationMs: 1, verdict: { type: 'failed', exitCode: 1, evidence: '', outputTail: 'boom' } }],
      cwd: '.',
      diffSummary: '',
    });
    const out = `OpenAI Codex\nuser\n${earlier}\nERROR: You’ve hit your usage limit. try again at 6:41 AM.\n`;
    const tail = handoffTail(out, 'fix the bug');
    expect(tail).not.toContain('CONTEXT:');
    expect(tail).not.toContain(HANDOFF_END);
    expect(tail).toBe('ERROR: You’ve hit your usage limit. try again at 6:41 AM.');
  });

  it('keeps only the last lines and drops ANSI codes', () => {
    const out = Array.from({ length: 100 }, (_, i) => `\x1b[32mline ${i}\x1b[0m`).join('\n');
    const tail = handoffTail(out);
    expect(tail.split('\n').length).toBeLessThanOrEqual(30);
    expect(tail).toContain('line 99');
    expect(tail).not.toContain('\x1b');
  });

  it("the git summary leaves out lanerelay's own runtime files", () => {
    const dir = workdir();
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir });
    git('init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
    rmSync(join(dir, 'a.txt'));
    writeFileSync(join(dir, 'new.ts'), 'x');
    mkdirSync(join(dir, '.lanerelay', 'logs'), { recursive: true });
    writeFileSync(join(dir, '.lanerelay', 'logs', 'x.log'), 'x');
    const s = gitDiffSummary(dir);
    expect(s).toContain('new.ts');
    expect(s).toContain('a.txt');
    expect(s).not.toContain('.lanerelay');
  });
});

describe('hooks', () => {
  it('renders {{vars}} as shell expansions, never pasted text', () => {
    expect(renderHookCommand('notify "{{lane}}: {{task}}"')).toBe('notify "${LR_LANE:-}: ${LR_TASK:-}"');
  });

  it('a task string cannot inject shell code into a hook', async () => {
    if (process.platform === 'win32') return;
    const dir = workdir();
    const out = join(dir, 'out.txt');
    const pwned = join(dir, 'pwned');
    await fireHooks({ finish: [{ command: `printf %s "{{task}}" > ${out}` }] }, 'finish', {
      event: 'finish',
      lane: 'l',
      task: `$(touch ${pwned}) "; touch ${pwned}; echo "`,
      status: 'done',
    });
    expect(existsSync(pwned)).toBe(false);
    expect(readFileSync(out, 'utf8')).toBe(`$(touch ${pwned}) "; touch ${pwned}; echo "`);
  });
});

describe('starter config and status formatting', () => {
  it('starter codex lane uses flags current Codex CLI accepts', async () => {
    const { STARTER_CONFIG } = await import('../src/init.js');
    expect(STARTER_CONFIG).not.toContain('--full-auto');
    expect(STARTER_CONFIG).toContain('codex exec --sandbox workspace-write {{prompt}}');
  });

  it('formats countdowns compactly', async () => {
    const { formatCountdown } = await import('../src/status.js');
    expect(formatCountdown(45 * 60_000)).toBe('45m');
    expect(formatCountdown((21 * 60 + 28) * 60_000)).toBe('21h28m');
    expect(formatCountdown(3 * 86_400_000 + 5 * 3_600_000)).toBe('3d5h');
  });
});

describe('runtime dir', () => {
  it('.lanerelay/ ignores itself so logs with prompts are never committed', async () => {
    const { ensureRuntimeDir } = await import('../src/init.js');
    const dir = workdir();
    spawnSync('git', ['init', '-q'], { cwd: dir });
    ensureRuntimeDir(dir);
    writeFileSync(join(dir, '.lanerelay', 'secret.log'), 'prompt text');
    const st = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir }).stdout.toString();
    expect(st).not.toContain('.lanerelay');
  });
});
