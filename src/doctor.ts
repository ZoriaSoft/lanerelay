import { accessSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ConfigError, DEFAULTS, findConfigFile, loadConfig } from './config.js';
import type { Config } from './types.js';
import type { LaneLease } from './leases.js';
import { pidAlive } from './runs.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  /** Short label, e.g. "lane claude: executable". */
  name: string;
  status: CheckStatus;
  detail: string;
}

const ok = (name: string, detail: string): Check => ({ name, status: 'ok', detail });
const warn = (name: string, detail: string): Check => ({ name, status: 'warn', detail });
const fail = (name: string, detail: string): Check => ({ name, status: 'fail', detail });

/**
 * First executable token of a lane command template. Skips leading
 * VAR=value env assignments; returns null for an empty template.
 */
export function firstCommandWord(template: string): string | null {
  for (const tok of template.trim().split(/\s+/)) {
    if (tok === '') continue;
    // POSIX env prefix: KEY=value command … (value must not start with -)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    return tok;
  }
  return null;
}

/**
 * Where a lane's executable resolves: 'file' for a path that exists on
 * disk (absolute or relative to cwd), 'path' for a name found on PATH,
 * null when neither. Honors PATHEXT on Windows.
 */
export function resolveExecutable(
  exe: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): 'file' | 'path' | null {
  if (exe.includes('/') || exe.includes('\\')) {
    const p = isAbsolute(exe) ? exe : resolve(cwd, exe);
    return existsSync(p) ? 'file' : null;
  }
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.PS1').split(';').map((e) => e.toLowerCase())
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const name = process.platform === 'win32' && !exe.toLowerCase().endsWith(ext) ? exe + ext : exe;
      if (existsSync(join(dir, name))) return 'path';
    }
  }
  return null;
}

function dirWritable(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Preflight for a repo: does the config parse, do the lane executables
 * exist, are the .lanerelay dirs writable, is state healthy? Pure reads plus
 * the directory creation every command performs anyway.
 */
export function doctorChecks(opts: { cwd: string; configFlag?: string }): Check[] {
  const { cwd } = opts;
  const checks: Check[] = [];
  let cfg: Config | null = null;

  // --- config -------------------------------------------------------------
  const configPath = findConfigFile(cwd, opts.configFlag ?? process.env.LR_CONFIG);
  if (!configPath) {
    checks.push(
      fail('config', 'no lanerelay.yaml found — run `lanerelay init` or pass --config <path>'),
    );
  } else {
    try {
      cfg = loadConfig(configPath);
      checks.push(ok('config', `${configPath}: ${cfg.lanes.length} lane(s), valid`));
    } catch (e) {
      checks.push(fail('config', e instanceof ConfigError ? e.message : String(e)));
    }
  }

  // --- lanes --------------------------------------------------------------
  for (const lane of cfg?.lanes ?? []) {
    const lname = `lane ${lane.name}`;
    if (!lane.command.includes('{{prompt}}')) {
      checks.push(fail(`${lname}: prompt slot`, 'command lacks {{prompt}} — the task never reaches the agent'));
    }
    if (!lane.kind || lane.kind === 'custom') {
      checks.push(warn(`${lname}: kind`, 'no kind set — only generic limit patterns apply'));
    }
    const exe = lane.command ? firstCommandWord(lane.command) : null;
    if (!exe) {
      checks.push(fail(`${lname}: executable`, 'empty command template'));
    } else {
      const where = resolveExecutable(exe, cwd);
      if (where === null) {
        checks.push(fail(`${lname}: executable`, `"${exe}" not found on PATH or disk`));
      } else {
        checks.push(ok(`${lname}: executable`, `${exe} (${where === 'path' ? 'on PATH' : 'file exists'})`));
      }
    }
  }

  // --- runtime dirs ---------------------------------------------------------
  if (cfg) {
    const d = { ...DEFAULTS, ...cfg.defaults };
    const dirs = [
      d.logsDir,
      d.runsDir,
      cfg.queue?.dir ?? d.queueDir,
      d.leasesDir,
      dirname(d.stateFile),
    ];
    const bad = [...new Set(dirs)].filter((rel) => !dirWritable(join(cwd, rel)));
    if (bad.length > 0) {
      checks.push(fail('runtime dirs', `cannot write: ${bad.join(', ')}`));
    } else {
      checks.push(ok('runtime dirs', [...new Set(dirs)].join(', ')));
    }
  }

  // --- git -----------------------------------------------------------------
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'pipe' });
    checks.push(ok('git', 'inside a work tree — handoff diffs available'));
  } catch {
    checks.push(
      warn('git', 'not a git repo (or git missing) — handoffs carry no diff context'),
    );
  }

  // --- state file -----------------------------------------------------------
  const statePath = join(cwd, { ...DEFAULTS, ...cfg?.defaults }.stateFile);
  if (!existsSync(statePath)) {
    checks.push(ok('state file', 'not created yet'));
  } else {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
      const lanes = parsed?.lanes && typeof parsed.lanes === 'object' ? Object.keys(parsed.lanes).length : 0;
      checks.push(ok('state file', `valid — ${lanes} lane(s) tracked`));
    } catch {
      checks.push(warn('state file', 'corrupt JSON — lanerelay will start fresh on next write'));
    }
  }

  // --- watcher lock ----------------------------------------------------------
  const lockPath = join(cwd, '.lanerelay', 'watch.lock');
  if (existsSync(lockPath)) {
    const pid = parseInt(readFileSync(lockPath, 'utf8'), 10);
    if (pid && pidAlive(pid)) {
      checks.push(ok('watcher', `running (pid ${pid})`));
    } else {
      checks.push(warn('watcher', `stale lock for dead pid ${pid || '?'} — safe to delete .lanerelay/watch.lock`));
    }
  } else {
    checks.push(ok('watcher', 'none running'));
  }

  // --- leases -----------------------------------------------------------------
  const leasesDir = join(cwd, { ...DEFAULTS, ...cfg?.defaults }.leasesDir);
  const leaseFiles = existsSync(leasesDir)
    ? readdirSync(leasesDir).filter((f) => f.endsWith('.json'))
    : [];
  if (leaseFiles.length === 0) {
    checks.push(ok('leases', 'none held'));
  } else {
    const live: string[] = [];
    const stale: string[] = [];
    for (const f of leaseFiles) {
      const lane = decodeURIComponent(f.replace(/\.json$/, ''));
      try {
        const lease = JSON.parse(readFileSync(join(leasesDir, f), 'utf8')) as LaneLease;
        (lease.pid && pidAlive(lease.pid) ? live : stale).push(lane);
      } catch {
        stale.push(`${lane} (corrupt)`);
      }
    }
    const parts = [
      live.length > 0 ? `${live.length} live (${live.join(', ')})` : '',
      stale.length > 0 ? `${stale.length} stale — reclaimed on next run (${stale.join(', ')})` : '',
    ].filter(Boolean);
    checks.push(stale.length > 0 ? warn('leases', parts.join('; ')) : ok('leases', parts.join('; ')));
  }

  return checks;
}

export function formatDoctor(checks: Check[]): string {
  const tag: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  return checks.map((c) => `${tag[c.status]} ${c.name.padEnd(24)} ${c.detail}`).join('\n');
}
