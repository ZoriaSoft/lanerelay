import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { Config, Lane, LaneConfig, LaneKind } from './types.js';

export const DEFAULT_CONFIG_FILES = ['quota-pilot.yaml', 'quota-pilot.yml', '.qp/config.yaml'];

export const DEFAULTS = {
  paidFirst: true,
  maxWaitMinutes: 60,
  defaultResetMinutes: 60,
  timeoutMinutes: 0,
  stateFile: '.qp/state.json',
  logsDir: '.qp/logs',
  runsDir: '.qp/runs',
  queueDir: '.qp/queue',
  leasesDir: '.qp/leases',
  pollSeconds: 3,
} as const;

const KINDS: Record<string, true> = {
  claude: true,
  codex: true,
  gemini: true,
  glm: true,
  aider: true,
  opencode: true,
  cursor: true,
  custom: true,
};

export class ConfigError extends Error {}

/** Find the config file for a repo, explicit flag wins. Null when absent. */
export function findConfigFile(cwd: string, explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const name of DEFAULT_CONFIG_FILES) {
    const p = join(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Parse + validate config. Throws ConfigError with a human-readable message. */
export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`cannot parse ${path}: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${path}: expected a YAML mapping at the top level`);
  }
  const cfg = raw as Config;
  if (!Array.isArray(cfg.lanes) || cfg.lanes.length === 0) {
    throw new ConfigError(`${path}: "lanes" must be a non-empty list`);
  }
  const seen = new Set<string>();
  for (const lane of cfg.lanes) {
    validateLane(lane, seen, path);
  }
  for (const [name, chain] of Object.entries(cfg.chains ?? {})) {
    if (!Array.isArray(chain.lanes) || chain.lanes.length === 0) {
      throw new ConfigError(`${path}: chain "${name}" must list at least one lane`);
    }
    for (const ln of chain.lanes) {
      if (!seen.has(ln)) {
        throw new ConfigError(`${path}: chain "${name}" references unknown lane "${ln}"`);
      }
    }
  }
  const jobs = cfg.queue?.jobs;
  if (jobs !== undefined && (!Number.isInteger(jobs) || jobs < 1)) {
    throw new ConfigError(`${path}: queue.jobs must be a positive integer`);
  }
  const maxDefers = cfg.queue?.maxDefers;
  if (maxDefers !== undefined && (!Number.isInteger(maxDefers) || maxDefers < 0)) {
    throw new ConfigError(`${path}: queue.maxDefers must be a non-negative integer`);
  }
  if (cfg.handoff !== undefined) {
    const d = cfg.handoff.diff;
    if (d !== undefined && d !== 'none' && d !== 'stat' && d !== 'full') {
      throw new ConfigError(`${path}: handoff.diff must be "none", "stat" or "full"`);
    }
    const mb = cfg.handoff.diffMaxBytes;
    if (mb !== undefined && (!Number.isInteger(mb) || mb < 0)) {
      throw new ConfigError(`${path}: handoff.diffMaxBytes must be a non-negative integer`);
    }
  }
  return cfg;
}

function validateLane(lane: LaneConfig, seen: Set<string>, path: string): void {
  if (!lane || typeof lane !== 'object') throw new ConfigError(`${path}: lane entries must be mappings`);
  if (!lane.name || typeof lane.name !== 'string') {
    throw new ConfigError(`${path}: every lane needs a "name"`);
  }
  if (seen.has(lane.name)) {
    throw new ConfigError(`${path}: duplicate lane name "${lane.name}"`);
  }
  seen.add(lane.name);
  if (typeof lane.command !== 'string' || !lane.command.includes('{{prompt}}')) {
    throw new ConfigError(
      `${path}: lane "${lane.name}" needs a "command" containing {{prompt}} (the task text is substituted there)`,
    );
  }
  if (lane.kind !== undefined && !(lane.kind in KINDS)) {
    throw new ConfigError(
      `${path}: lane "${lane.name}": unknown kind "${lane.kind}" (one of ${Object.keys(KINDS).join(', ')})`,
    );
  }
  if (lane.cost !== undefined && lane.cost !== 'paid' && lane.cost !== 'free') {
    throw new ConfigError(`${path}: lane "${lane.name}": cost must be "paid" or "free"`);
  }
  if (lane.patterns !== undefined) {
    for (const [key, value] of Object.entries(lane.patterns)) {
      if (key === 'exitCodes') {
        if (!Array.isArray(value) || value.some((n) => typeof n !== 'number')) {
          throw new ConfigError(`${path}: lane "${lane.name}": patterns.exitCodes must be a list of numbers`);
        }
        continue;
      }
      if (!Array.isArray(value)) {
        throw new ConfigError(`${path}: lane "${lane.name}": patterns.${key} must be a list of regex strings`);
      }
      for (const s of value) {
        try {
          new RegExp(String(s));
        } catch (e) {
          throw new ConfigError(`${path}: lane "${lane.name}": patterns.${key} has an invalid regex: ${(e as Error).message}`);
        }
      }
    }
  }
}

/** Apply config defaults to a lane config. */
export function resolveLane(cfg: Config, lane: LaneConfig): Lane {
  const d = { ...DEFAULTS, ...cfg.defaults };
  return {
    name: lane.name,
    kind: lane.kind ?? 'custom',
    command: lane.command,
    model: lane.model,
    priority: lane.priority ?? 0,
    cost: lane.cost ?? 'paid',
    timeoutMinutes: lane.timeoutMinutes ?? d.timeoutMinutes,
    defaultResetMinutes: lane.defaultResetMinutes ?? d.defaultResetMinutes,
    patterns: lane.patterns ?? {},
  };
}

const COST_ORDER = { paid: 0, free: 1 } as const;

interface QuotaQuery {
  /** Latest non-stale quota reading per lane name; null = unknown. */
  quotaLeft(lane: string, now?: Date): number | null;
}

/**
 * Order lanes for a run. A numeric chain ("claude,codex,gemini") or a named
 * chain preserves the order given by the user. Otherwise lanes are ordered by
 * cost class (paid first when paidFirst), then observed quota remaining
 * (richest first — the lane least likely to die mid-task wins ties), then
 * priority, then config order. Lanes without a recent reading count as 100%
 * so ungauged lanes stay preferred over nearly-dry ones.
 */
export function orderLanes(cfg: Config, chain?: string, store?: QuotaQuery): Lane[] {
  const byName = new Map(cfg.lanes.map((l) => [l.name, l]));
  let ordered: LaneConfig[];
  if (chain) {
    const named = cfg.chains?.[chain];
    const names = named ? named.lanes : chain.split(',').map((s) => s.trim()).filter(Boolean);
    ordered = names.map((n) => {
      const l = byName.get(n);
      if (!l) {
        throw new ConfigError(
          named ? `chain "${chain}" references unknown lane "${n}"` : `no lane named "${n}" in config`,
        );
      }
      return l;
    });
  } else {
    const paidFirst = cfg.defaults?.paidFirst ?? DEFAULTS.paidFirst;
    const now = new Date();
    ordered = [...cfg.lanes].sort((a, b) => {
      const ca = paidFirst ? COST_ORDER[a.cost ?? 'paid'] : 0;
      const cb = paidFirst ? COST_ORDER[b.cost ?? 'paid'] : 0;
      if (ca !== cb) return ca - cb;
      const q = (store?.quotaLeft(b.name, now) ?? 100) - (store?.quotaLeft(a.name, now) ?? 100);
      if (q !== 0) return q;
      return (a.priority ?? 0) - (b.priority ?? 0);
    });
  }
  return ordered.map((l) => resolveLane(cfg, l));
}
