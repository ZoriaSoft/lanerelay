import type { LaneKind, LanePatterns } from './types.js';

/**
 * Built-in pattern library for detecting quota/rate-limit exits in agent CLI
 * output. Patterns are matched case-insensitively against the tail of the
 * combined stdout+stderr of an attempt.
 *
 * `limited` patterns fire on real subscription/usage caps.
 * `notLimit` patterns mask transient errors (overload, retryable 429s that a
 * lane recovered from, generic API blips) so we don't block a healthy lane.
 * `reset` patterns have one capture group that reset-time parsing consumes.
 */
export interface KindPatterns {
  limited: RegExp[];
  notLimit: RegExp[];
  reset: RegExp[];
  /** Exit codes meaning "limit" even without matching output. */
  exitCodes: number[];
}

const re = (s: string) => new RegExp(s, 'i');

/** Patterns shared by every lane kind. */
const GENERIC: KindPatterns = {
  limited: [
    re(String.raw`\b429\b`),
    re(String.raw`rate.?limit(?:ed|ing)?\b`),
    re(String.raw`quota (?:exceeded|exhausted|reached)`),
    re(String.raw`usage (?:limit|cap) (?:reached|exceeded|exhausted)`),
    re(String.raw`too many requests`),
    re(String.raw`insufficient_(?:quota|credit)`),
    re(String.raw`credits? (?:exhausted|depleted|insufficient)`),
  ],
  notLimit: [
    // Transient upstream errors that are NOT a subscription cap.
    re(String.raw`\b(500|502|503|504)\b.*\b(error|unavailable|timeout)`),
    re(String.raw`overloaded_error`),
    re(String.raw`request timed? ?out`),
  ],
  reset: [
    // "try again in 40 minutes" / "retry after 90 seconds" / "in 1 hour 23 minutes"
    re(
      String.raw`(?:try again|retry|resumes?|resets?|available again|back)\s+(?:in|after|at)\s+([^.;\n]{1,60})`,
    ),
    // JSON RPC style: "retryDelay":"45s"
    re(String.raw`retryDelay"?\s*[:=]\s*"?\s*([^.;\n"']{1,40})`),
    // "reached|<epoch>" pipe format
    re(String.raw`reached\|([^.;\n]{1,40})`),
    re(String.raw`resets?[: ]+([^.;\n]{1,60})`),
  ],
  exitCodes: [],
};

const CLAUDE: KindPatterns = {
  limited: [
    re(String.raw`(?:you(?:'ve| have) (?:hit|reached|exceeded) )?(?:your )?(?:5[- ]?hour|session|weekly) (?:usage )?(?:limit|cap)`),
    re(String.raw`limit reached`),
    re(String.raw`usage limit (?:has been )?reached`),
    re(String.raw`you'?re out of (?:usage|capacity|extra usage)`),
    re(String.raw`out of extra usage`),
    re(String.raw`hit (?:your|the|its) (?:usage |rate )?limit`),
    re(String.raw`resets?\s+(?:at|in\s+)?\d`),
  ],
  notLimit: [
    re(String.raw`overloaded`),
    re(String.raw`API Error:?\s*5\d\d`),
    re(String.raw`approaching (?:session |weekly )?limit`),
  ],
  reset: [
    re(String.raw`resets?\s+(?:at|in)\s+([^.;\n]{1,40})`),
    re(String.raw`resets?[: ]+([^.;\n]{1,40})`),
  ],
  exitCodes: [],
};

const CODEX: KindPatterns = {
  limited: [
    re(String.raw`exceeded retry limit,?\s*last status:\s*429`),
    re(String.raw`usage limit (?:reached|exceeded)`),
    re(String.raw`hit (?:your|the|its) (?:usage )?limit`),
    re(String.raw`429 Too Many Requests`),
    re(String.raw`rate limit (?:reached|exceeded).*(?:resets?|try again)`),
  ],
  notLimit: [
    re(String.raw`stream (?:disconnected|error)`),
    re(String.raw`retrying.*\b429\b`),
  ],
  reset: [
    re(String.raw`try again (?:in|at)\s+([^.;\n]{1,60})`),
    re(String.raw`resets?\s+(?:in|at|on)\s+([^.;\n]{1,60})`),
    re(String.raw`rate limit (?:reached|exceeded)[^.\n]*?resets?\s+([^.;\n]{1,60})`),
  ],
  exitCodes: [],
};

const GEMINI: KindPatterns = {
  limited: [
    re(String.raw`Resource has been exhausted`),
    re(String.raw`RESOURCE_EXHAUSTED`),
    re(String.raw`429.*(?:quota|rate)`),
    re(String.raw`Quota exceeded for quota metric`),
    re(String.raw`daily (?:request |quota )?limit`),
    re(String.raw`reached (?:your |the )?daily limit`),
    re(String.raw`You have reached your (?:daily |request )?limit`),
  ],
  notLimit: [re(String.raw`retry(?:ing|ed)? (?:in|after)`)],
  reset: [
    re(String.raw`retry (?:in|after)\s+([^.;\n]{1,60})`),
    re(String.raw`resets?\s+(?:in|at)\s+([^.;\n]{1,60})`),
    re(String.raw`quota will reset\s+([^.;\n]{1,60})`),
  ],
  exitCodes: [],
};

const GLM: KindPatterns = {
  limited: [
    re(String.raw`insufficient (?:balance|quota|credit)`),
    re(String.raw`rate limit`),
    re(String.raw`\b429\b`),
    re(String.raw`usage limit`),
  ],
  notLimit: [],
  reset: GENERIC.reset,
  exitCodes: [],
};

const AIDER: KindPatterns = {
  limited: [
    re(String.raw`RateLimitError`),
    re(String.raw`openai\.RateLimitError`),
    re(String.raw`litellm\.\w*RateLimit`),
    re(String.raw`rate limit`),
    re(String.raw`\b429\b`),
  ],
  notLimit: [re(String.raw`retrying in`)],
  reset: GENERIC.reset,
  exitCodes: [],
};

const OPENCODE: KindPatterns = {
  limited: [
    re(String.raw`rate.?limit`),
    re(String.raw`\b429\b`),
    re(String.raw`quota (?:exceeded|exhausted)`),
    re(String.raw`usage limit`),
  ],
  notLimit: [],
  reset: GENERIC.reset,
  exitCodes: [],
};

const CURSOR: KindPatterns = {
  limited: [
    re(String.raw`rate.?limit`),
    re(String.raw`usage (?:limit|cap)`),
    re(String.raw`out of (?:requests|usage)`),
    re(String.raw`\b429\b`),
  ],
  notLimit: [],
  reset: GENERIC.reset,
  exitCodes: [],
};

const CUSTOM: KindPatterns = { limited: [], notLimit: [], reset: [], exitCodes: [] };

export const KIND_PATTERNS: Record<LaneKind, KindPatterns> = {
  claude: { ...GENERIC, limited: [...GENERIC.limited, ...CLAUDE.limited], notLimit: [...GENERIC.notLimit, ...CLAUDE.notLimit], reset: [...CLAUDE.reset, ...GENERIC.reset], exitCodes: CLAUDE.exitCodes },
  codex: { ...GENERIC, limited: [...GENERIC.limited, ...CODEX.limited], notLimit: [...GENERIC.notLimit, ...CODEX.notLimit], reset: [...CODEX.reset, ...GENERIC.reset], exitCodes: CODEX.exitCodes },
  gemini: { ...GENERIC, limited: [...GENERIC.limited, ...GEMINI.limited], notLimit: [...GENERIC.notLimit, ...GEMINI.notLimit], reset: [...GEMINI.reset, ...GENERIC.reset], exitCodes: GEMINI.exitCodes },
  glm: { ...GENERIC, limited: [...GENERIC.limited, ...GLM.limited], notLimit: [...GENERIC.notLimit, ...GLM.notLimit], reset: [...GLM.reset, ...GENERIC.reset], exitCodes: GLM.exitCodes },
  aider: { ...GENERIC, limited: [...GENERIC.limited, ...AIDER.limited], notLimit: [...GENERIC.notLimit, ...AIDER.notLimit], reset: [...AIDER.reset, ...GENERIC.reset], exitCodes: AIDER.exitCodes },
  opencode: { ...GENERIC, limited: [...GENERIC.limited, ...OPENCODE.limited], notLimit: [...GENERIC.notLimit, ...OPENCODE.notLimit], reset: [...OPENCODE.reset, ...GENERIC.reset], exitCodes: OPENCODE.exitCodes },
  cursor: { ...GENERIC, limited: [...GENERIC.limited, ...CURSOR.limited], notLimit: [...GENERIC.notLimit, ...CURSOR.notLimit], reset: [...CURSOR.reset, ...GENERIC.reset], exitCodes: CURSOR.exitCodes },
  custom: { ...GENERIC, limited: [...GENERIC.limited, ...CUSTOM.limited], notLimit: [...GENERIC.notLimit, ...CUSTOM.notLimit], reset: GENERIC.reset, exitCodes: [] },
};

/** Merge lane-level pattern overrides (strings → case-insensitive RegExp). */
export function mergePatterns(kind: LaneKind, extra?: LanePatterns): KindPatterns {
  const base = KIND_PATTERNS[kind] ?? KIND_PATTERNS.custom;
  if (!extra) return base;
  return {
    limited: [...base.limited, ...(extra.limited ?? []).map(re)],
    notLimit: [...base.notLimit, ...(extra.notLimit ?? []).map(re)],
    reset: [...(extra.reset ?? []).map(re), ...base.reset],
    exitCodes: [...base.exitCodes, ...(extra.exitCodes ?? [])],
  };
}
