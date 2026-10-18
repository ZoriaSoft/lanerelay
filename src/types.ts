/** Known agent CLI flavors with built-in limit patterns. */
export type LaneKind =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'glm'
  | 'aider'
  | 'opencode'
  | 'cursor'
  | 'custom';

export type CostClass = 'paid' | 'free';

/** Per-lane override or extension of the built-in pattern library. */
export interface LanePatterns {
  /** Extra regex strings (case-insensitive) that mean "quota/rate limit hit". */
  limited?: string[];
  /** Extra regex strings that mean a transient overload; NOT a quota limit. */
  notLimit?: string[];
  /**
   * Regex strings with a first capture group that yields reset info.
   * The capture is parsed for durations ("40 minutes"), clock times ("12pm"),
   * month-day dates ("Oct 22") and ISO timestamps.
   */
  reset?: string[];
  /**
   * Regex strings whose first capture group is a REMAINING quota percentage
   * (e.g. "(\\d+)% left in your window"). Last match in the output wins.
   */
  usage?: string[];
  /**
   * Regex strings whose first capture group is a USED quota percentage
   * (e.g. "used (\\d+)% of your weekly quota"). Left = 100 - used.
   */
  usageUsed?: string[];

  /** Exit codes that always mean "limit hit" regardless of output. */
  exitCodes?: number[];
}

/** How much working-tree state goes into the handoff prompt. */
export interface HandoffConfig {
  /**
   * 'stat' (default): `git diff --stat` + untracked file list.
   * 'full': the stat block plus the actual `git diff` patch (bounded).
   * 'none': no repo state at all — the next agent inspects the tree itself.
   */
  diff?: 'none' | 'stat' | 'full';
  /** Byte cap on the patch body when `diff: full`. Default 8192. */
  diffMaxBytes?: number;
}

export interface LaneConfig {
  name: string;
  /** Agent flavor; selects the built-in pattern set. Default: custom. */
  kind?: LaneKind;
  /** Shell command template; must contain {{prompt}}. Runs via `sh -c` (`cmd /c` on Windows). */
  command: string;
  /** Optional metadata (model name) shown in status/logs. */
  model?: string;
  /** Lower number = preferred. Default 0. */
  priority?: number;
  /** Paid lanes run before free lanes when paidFirst is on. Default: paid. */
  cost?: CostClass;
  /** Per-lane cap on a single attempt (minutes). 0 = no cap. Default 0. */
  timeoutMinutes?: number;
  /** Fallback blocked duration (minutes) when no reset time is detected. */
  defaultResetMinutes?: number;
  patterns?: LanePatterns;
}

export interface ChainConfig {
  /** Lanes that make up this chain, resolved in order. */
  lanes: string[];
}

export interface HookDef {
  /** Shell command run via `sh -c`; {{vars}} templated + env vars passed. */
  command?: string;
  /** HTTPS URL; receives a JSON POST. */
  webhook?: string;
}

export interface HooksConfig {
  /** A lane just hit its limit. */
  limit?: HookDef[];
  /** The task was handed to another lane. */
  handoff?: HookDef[];
  /** A lane finished the task. */
  finish?: HookDef[];
  /** A lane exited non-zero without a detected limit. */
  fail?: HookDef[];
}

export interface QueueConfig {
  /** Directory holding queue items. Default `.qp/queue`. */
  dir?: string;
  /** Poll interval for `qp watch` (seconds). Default 3. */
  pollSeconds?: number;
  /** Parallel workers for `qp watch`. Default 1. */
  jobs?: number;
}

export interface Config {
  lanes: LaneConfig[];
  /** Named lane lists used by `qp run --chain name`. */
  chains?: Record<string, ChainConfig>;
  hooks?: HooksConfig;
  queue?: QueueConfig;
  handoff?: HandoffConfig;
  defaults?: {
    /** Burn paid lanes before free lanes. Default true. */
    paidFirst?: boolean;
    /** Minutes to wait when all lanes are blocked. Default 60. */
    maxWaitMinutes?: number;
    /** Fallback blocked duration (minutes) when no reset time is detected. Default 60. */
    defaultResetMinutes?: number;
    /** Per-attempt cap (minutes) applied to lanes without their own. Default 0. */
    timeoutMinutes?: number;
    /** Directory for per-attempt logs. Default `.qp/logs`. */
    logsDir?: string;
    /** Directory for per-run history records. Default `.qp/runs`. */
    runsDir?: string;
    /** State file path. Default `.qp/state.json`. */
    stateFile?: string;
    /** Directory for lane lease files (parallel runs). Default `.qp/leases`. */
    leasesDir?: string;
  };
}

/** Resolved lane: config defaults applied. */
export interface Lane extends Required<Omit<LaneConfig, 'model' | 'patterns' | 'timeoutMinutes' | 'defaultResetMinutes'>> {
  model?: string;
  timeoutMinutes: number;
  defaultResetMinutes: number;
  patterns: LanePatterns;
}

/** Outcome classification for a single lane attempt. */
export type AttemptVerdict =
  | { type: 'done'; outputTail: string }
  | { type: 'limited'; outputTail: string; resetAt: Date | null; evidence: string }
  | { type: 'failed'; outputTail: string; exitCode: number | null; evidence: string }
  | { type: 'timeout'; outputTail: string };

export interface AttemptResult {
  lane: string;
  verdict: AttemptVerdict;
  exitCode: number | null;
  durationMs: number;
  logFile?: string;
}

export type TaskVerdict =
  | { type: 'done'; lane: string; attempts: AttemptResult[] }
  | { type: 'all-blocked'; attempts: AttemptResult[]; earliestReset: Date | null }
  | { type: 'failed'; attempts: AttemptResult[]; lastError: string }
  | { type: 'timeout'; attempts: AttemptResult[] };
