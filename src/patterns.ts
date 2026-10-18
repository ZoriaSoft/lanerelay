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
  /**
   * Usage gauges a CLI prints (status lines, footer hints). Each pattern's
   * first capture group must yield a percentage of quota REMAINING.
   * Optional: kind tables leave it to GENERIC.
   */
  usage?: RegExp[];
  /** Same as `usage`, but the capture is the percentage quota USED. */
  usageUsed?: RegExp[];
  /** Exit codes meaning "limit" even without matching output. */
  exitCodes: number[];
}

const re = (s: string) => new RegExp(s, 'i');

/** Patterns shared by every lane kind. */
const GENERIC: KindPatterns = {
  limited: [
    re(String.raw`\b429\b`),
    re(String.raw`rate.?limit(?:ed|ing)?\b`),
    re(String.raw`rate_limit_(?:error|exceeded)`),
    re(String.raw`quota (?:exceeded|exhausted|reached)`),
    re(String.raw`usage (?:limit|cap) (?:reached|exceeded|exhausted)`),
    re(String.raw`too many requests`),
    re(String.raw`insufficient_(?:quota|credit)`),
    re(String.raw`credits? (?:exhausted|depleted|insufficient)`),
    // codex: "Your workspace is out of credits." / "hit your spend cap"
    re(String.raw`out of credits`),
    re(String.raw`hit your spend cap`),
    // codex: "You've hit your usage limit for gpt-…"
    re(String.raw`hit (?:your|the|its) usage limit(?:\s+for\b)?`),
  ],
  notLimit: [
    // Transient upstream errors that are NOT a subscription cap.
    re(String.raw`\b(500|502|503|504)\b.*\b(error|unavailable|timeout)`),
    re(String.raw`overloaded_error`),
    re(String.raw`request timed? ?out`),
    // Concurrency / user-configured caps that look like limits but aren't:
    re(String.raw`agent thread limit reached`), // codex: max_threads
    re(String.raw`budget limit reached`), // claude --max-budget-usd
    // Model-capacity fallback text (transient; the model can recover).
    re(String.raw`model is at capacity`),
  ],
  reset: [
    // "try again in 40 minutes" / "retry after 90 seconds" / "in 1 hour 23 minutes"
    re(
      String.raw`(?:try again|retry|resumes?|resets?|available again|back)\s+(?:in|after|at)\s+([^.;\n]{1,60})`,
    ),
    // JSON RPC style: "retryDelay":"45s"
    re(String.raw`retryDelay"?\s*[:=]\s*"?\s*([^.;\n"']{1,40})`),
    // "reached|<epoch>" pipe format (claude headless)
    re(String.raw`reached\|([^.;\n]{1,40})`),
    re(String.raw`resets?[: ]+([^.;\n]{1,60})`),
    // "resets 143h26m" / "reset in 4h12m" without 'at' (compact statuslines)
    re(String.raw`resets?\s+([^.;\n]{1,40})`),
    // Google RPC "Please retry in 34.07s" — capture keeps decimals + unit.
    re(String.raw`please retry in\s+([\d.]+\s*(?:ms|secs?|s|mins?|m|hrs?|h|seconds?|minutes?|hours?)?)`),
  ],
  exitCodes: [],
  usage: [
    // "(session )?(usage|quota) <n>% left|remaining", "usage has <n>% left"
    re(String.raw`(?:session |weekly |daily )?(?:usage|quota)[^\d\n%]{0,30}?(\d{1,3})\s*%\s*(?:left|remain)`),
    // "<n>% of your (weekly )?quota left", "<n>% usage remaining" — filler
    // words (adjectives) allowed between the percent and the anchor word.
    re(String.raw`(\d{1,3})\s*%[^\d\n%]{0,30}?(?:usage|quota|window|allowance|requests?)[^\d\n%]{0,20}?(?:left|remain)`),
  ],
  usageUsed: [
    // "usage: <n>%", "quota=<n>%" — bare percent right after the word means
    // "used", but NOT when a left/remaining qualifier follows.
    re(String.raw`\b(?:usage|quota)[\s:=]{1,4}(\d{1,3})\s*%(?!\s*(?:left|remain))`),
    // "quota used <n>%", "weekly limit consumed <n>%"
    re(String.raw`(?:usage|quota|limit|allowance|requests?)[^\d\n%]{0,40}?(?:used|consumed)[^\d\n%]{0,15}?(\d{1,3})\s*%`),
    // "used <n>% of your (weekly )?quota", "consumed <n>% of the window"
    re(String.raw`(?:used|consumed)[^\d\n%]{0,15}?(\d{1,3})\s*%[^\d\n%]{0,30}?(?:usage|quota|limit|allowance|requests?)`),
    // "<n>% of the (daily )?limit used", "<n>% quota consumed"
    re(String.raw`(\d{1,3})\s*%[^\d\n%]{0,30}?(?:usage|quota|limit|allowance|requests?)[^\d\n%]{0,20}?(?:used|consumed)`),
  ],
};

const CLAUDE: KindPatterns = {
  limited: [
    re(String.raw`(?:you(?:'ve| have) (?:hit|reached|exceeded) )?(?:your )?(?:5[- ]?hour|session|weekly) (?:usage )?(?:limit|cap)`),
    re(String.raw`limit reached`),
    re(String.raw`usage limit (?:has been )?reached`),
    re(String.raw`you'?re out of (?:usage|capacity|extra usage)`),
    re(String.raw`out of extra usage`),
    re(String.raw`hit (?:your|the|its) (?:usage |rate )?limit`),
    // "You've hit your limit · resets 9:10pm (Europe/Kiev)" — a reset suffix
    // after a hit message is definitive even when the wording is unusual.
    re(String.raw`resets?\s+(?:at|in\s+)?\d`),
  ],
  notLimit: [
    re(String.raw`overloaded`),
    re(String.raw`API Error:?\s*5\d\d`),
    re(String.raw`approaching (?:session |weekly )?limit`),
  ],
  reset: [
    // "You've hit your limit · resets 9:10pm (Europe/Kiev)"
    re(String.raw`resets?\s+(?:at|in)\s+([^.;\n]{1,40})`),
    // bare "resets 9:10pm" — same-line suffix after the limit banner
    re(String.raw`resets?\s+([^.;\n]{1,40})`),
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
    // Bare "Rate limit reached for gpt-…" — no reset needed, it IS the cap.
    re(String.raw`rate limit reached for`),
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
    // gemini-cli source: TerminalQuotaError — hard daily/credits caps.
    re(String.raw`exhausted your daily quota`),
    re(String.raw`TerminalQuotaError`),
    re(String.raw`MODEL_CAPACITY_EXHAUSTED`),
    re(String.raw`exhausted your capacity`),
    re(String.raw`exceeded your current quota`),
  ],
  // The CLI's own recovery log says "Retrying in Ns". A bare "retry in" also
  // matches the "Please retry in 34.07s" hint embedded in the 429 payload —
  // same line, before the cap string — and would wrongly suppress the hit.
  notLimit: [re(String.raw`retrying\s+(?:in|after)`)],
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

const CUSTOM: KindPatterns = { limited: [], notLimit: [], reset: [], usage: [], usageUsed: [], exitCodes: [] };

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
    usage: [...(base.usage ?? []), ...(extra.usage ?? []).map(re)],
    usageUsed: [...(base.usageUsed ?? []), ...(extra.usageUsed ?? []).map(re)],
  };
}
