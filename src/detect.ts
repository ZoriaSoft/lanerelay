import { AUTH_PATTERNS, type KindPatterns } from './patterns.js';

/**
 * Limit banners are the LAST thing an agent CLI prints before it exits.
 * Only the final lines are scanned, so an agent that spent its run talking
 * about "rate limiting" or quoting a 429 handler earlier in the session
 * cannot trip detection. Counted in non-empty lines, not bytes: a single
 * long JSON error line still fits.
 */
export const DETECT_LINES = 60;

/** The last `DETECT_LINES` non-empty lines of an output tail. */
export function detectionWindow(outputTail: string, lines = DETECT_LINES): string {
  // eslint-disable-next-line no-control-regex
  const clean = outputTail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n');
  const all = clean.split('\n');
  let kept = 0;
  let i = all.length;
  while (i > 0 && kept < lines) {
    i--;
    if (all[i].trim() !== '') kept++;
  }
  return all.slice(i).join('\n');
}

/**
 * The first line at or after `fromIndex` that reads as an auth / login /
 * billing-setup failure, or null. Such a lane is broken, not out of quota:
 * waiting for a "reset" would never help.
 */
export function authErrorAfter(output: string, fromIndex = 0): string | null {
  const lineStart = output.lastIndexOf('\n', fromIndex) + 1;
  for (const line of output.slice(lineStart).split('\n')) {
    for (const p of AUTH_PATTERNS) {
      if (p.test(line)) return line.trim().slice(0, 300);
    }
  }
  return null;
}

export interface Detection {
  limited: true;
  /** Parsed reset instant, or null when the output gave nothing parseable. */
  resetAt: Date | null;
  /** The matched output line, for logs/hooks. */
  evidence: string;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** A time zone named next to a reset time: "(UTC)", "(Europe/Kiev)", "3am UTC". */
const TZ_HINT = /\(\s*(UTC|GMT|Z|[A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)\s*\)|\b(UTC|GMT)\b/;

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  wd: number;
}

/** Wall-clock fields of `at` in `tz`; null for an unknown zone. */
function wallIn(tz: string, at: Date): Wall | null {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    const parts: Record<string, string> = {};
    for (const p of f.formatToParts(at)) parts[p.type] = p.value;
    return {
      y: Number(parts.year),
      mo: Number(parts.month) - 1,
      d: Number(parts.day),
      h: Number(parts.hour) % 24,
      mi: Number(parts.minute),
      wd: WEEKDAYS[parts.weekday.toLowerCase().slice(0, 3)] ?? 0,
    };
  } catch {
    return null;
  }
}

/** The instant whose wall clock in `tz` reads y-mo-d h:mi (overflowing days roll). */
function zonedInstant(tz: string, y: number, mo: number, d: number, h: number, mi: number): Date {
  const target = Date.UTC(y, mo, d, h, mi);
  let guess = target;
  // Two passes settle DST edges: offset at the guess, then at the result.
  for (let i = 0; i < 2; i++) {
    const w = wallIn(tz, new Date(guess))!;
    const asUtc = Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
    guess += target - asUtc;
  }
  return new Date(guess);
}

function zoneOf(s: string): string | null {
  const m = TZ_HINT.exec(s);
  if (!m) return null;
  let tz = m[1] ?? m[2];
  if (tz === 'Z' || tz === 'GMT') tz = 'UTC';
  // Old IANA alias some CLIs print; Intl may only know the new name.
  if (tz === 'Europe/Kiev' && wallIn(tz, new Date()) === null) tz = 'Europe/Kyiv';
  return wallIn(tz, new Date()) ? tz : null;
}

/**
 * Parse a free-form reset hint like "40 minutes", "1 hour 23 minutes",
 * "12pm", "14:30", "Oct 22", "Friday 9am" or an ISO timestamp into a Date.
 * Returns null when nothing parses.
 */
export function parseResetTime(text: string, now: Date): Date | null {
  const s = text.trim();

  // ISO timestamp: 2026-10-18T14:30:00Z or with space / no seconds
  const iso = /(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?/.exec(s);
  if (iso) {
    const d = new Date(s.slice(iso.index));
    if (!Number.isNaN(d.getTime())) return d;
  }

  // Bare epoch timestamp (Claude prints "usage limit reached|1760817600").
  // 10 digits → seconds, 13 → milliseconds. Anything further out than
  // 14 days is treated as garbage — real reset windows are never that far.
  const epoch = /\b(\d{10,13})\b/.exec(s);
  if (epoch) {
    const n = parseInt(epoch[1], 10);
    const d = new Date(epoch[1].length === 10 ? n * 1000 : n);
    if (d.getTime() > now.getTime() && d.getTime() - now.getTime() < 14 * 86_400_000) return d;
  }
  // Composite duration: "1 hour 23 minutes", "40 min", "an hour", "90 seconds",
  // compact "143h26m", fractional "34.07s", "900ms".
  // NB: 'an|one' must be \b-guarded so "9am"/"Friday" don't leak an 'a', and
  // the unit needs (?![a-zA-Z]) not \b — a digit may legitimately follow it
  // ("26m" after "143h"), while a letter means a different word ("4million").
  const dur = /(\d+(?:\.\d+)?|\ban\b|\bone\b)\s*(hours?|hrs?|hr|h|minutes?|mins?|m(?!s)|seconds?|secs?|s|milliseconds?|msecs?|ms)(?![a-zA-Z])/gi;
  let ms = 0;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = dur.exec(s)) !== null) {
    const raw = m[1].toLowerCase();
    const n = /^\d/.test(raw) ? parseFloat(raw) : 1;
    const unit = m[2].toLowerCase();
    matched = true;
    if (unit.startsWith('ms') || unit.startsWith('mse') || unit.startsWith('milli')) ms += n;
    else if (unit.startsWith('h')) ms += n * 3_600_000;
    else if (unit.startsWith('m')) ms += n * 60_000;
    else ms += n * 1_000;
  }
  if (matched && ms > 0) return new Date(now.getTime() + ms);

  // Weekday name, optionally with a time: "Friday", "Friday at 9am"
  const wd = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i.exec(s);
  if (wd && /^[a-z]{3,9}/i.test(wd[0]) && wd[0].toLowerCase().slice(0, 3) in WEEKDAYS) {
    const target = WEEKDAYS[wd[0].toLowerCase().slice(0, 3)];
    const t = clockMatch(s);
    const tz = zoneOf(s);
    if (tz) {
      const w = wallIn(tz, now)!;
      let delta = (target - w.wd + 7) % 7;
      let d = zonedInstant(tz, w.y, w.mo, w.d + delta, t?.hour ?? 0, t?.minute ?? 0);
      if (d.getTime() <= now.getTime()) d = zonedInstant(tz, w.y, w.mo, w.d + delta + 7, t?.hour ?? 0, t?.minute ?? 0);
      return d;
    }
    const d = new Date(now);
    d.setHours(t?.hour ?? 0, t?.minute ?? 0, 0, 0);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0 && d.getTime() <= now.getTime()) delta = 7;
    d.setDate(d.getDate() + delta);
    return d;
  }

  // Month + day, optional year and time: "Oct 22", "October 22, 2026 at 3pm"
  const md =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i.exec(
      s,
    );
  if (md) {
    const month = MONTHS[md[1].toLowerCase().slice(0, 3)];
    const day = parseInt(md[2], 10);
    const year = md[3] ? parseInt(md[3], 10) : now.getFullYear();
    const t = clockMatch(s.slice(md.index + md[0].length));
    const tz = zoneOf(s);
    if (tz) {
      let d = zonedInstant(tz, year, month, day, t?.hour ?? 0, t?.minute ?? 0);
      if (!md[3] && d.getTime() <= now.getTime()) d = zonedInstant(tz, year + 1, month, day, t?.hour ?? 0, t?.minute ?? 0);
      return d;
    }
    const d = new Date(year, month, day, t?.hour ?? 0, t?.minute ?? 0, 0, 0);
    if (!md[3] && d.getTime() <= now.getTime()) d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  // Plain clock time: "12pm", "3:30 pm", "14:30" → today if still future, else tomorrow
  const t = clockMatch(s);
  if (t) {
    // "resets 3am (UTC)" / "9:10pm (Europe/Kiev)": the clock is in that
    // zone, not ours — claude prints its reset in the account's zone.
    const tz = zoneOf(s);
    if (tz) {
      const w = wallIn(tz, now)!;
      let d = zonedInstant(tz, w.y, w.mo, w.d, t.hour, t.minute);
      if (d.getTime() <= now.getTime()) d = zonedInstant(tz, w.y, w.mo, w.d + 1, t.hour, t.minute);
      return d;
    }
    const d = new Date(now);
    d.setHours(t.hour, t.minute, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }

  return null;
}

/** Extract "h[:mm] am|pm" or 24h "H:MM" from a snippet. */
function clockMatch(s: string): { hour: number; minute: number } | null {
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(s);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const min = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const pm = ampm[3].toLowerCase() === 'pm';
    if (h > 12 || min > 59) return null;
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { hour: h, minute: min };
  }
  const h24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(s);
  if (h24) return { hour: parseInt(h24[1], 10), minute: parseInt(h24[2], 10) };
  return null;
}

/** The line of output containing the match (evidence for logs/hooks). */
function evidenceLine(output: string, index: number): string {
  const start = output.lastIndexOf('\n', index) + 1;
  let end = output.indexOf('\n', index);
  if (end === -1) end = output.length;
  return output.slice(start, end).trim().slice(0, 300);
}

/**
 * Decide whether a finished attempt hit a quota/rate limit.
 *
 * Rules:
 * - No `limited` match in the tail window → not limited.
 * - A matching lane exit code → limited even without output match.
 * - A `notLimit` marker on a LATER line than the last cap message means the
 *   lane retried internally and recovered → not limited.
 * - A `notLimit` marker EARLIER on the SAME line is a qualifier
 *   ("Approaching weekly limit", "Budget limit reached") → not limited.
 * - exitCode 0 with no explicit reset hint → transient the lane absorbed →
 *   not limited.
 * - An explicit cap message wins over earlier transient noise in the tail.
 * - An auth/login error on or after the cap line → not limited (broken lane).
 * - Only the last DETECT_LINES non-empty lines are scanned.
 */
export function detectLimit(
  fullTail: string,
  exitCode: number | null,
  patterns: KindPatterns,
  now: Date = new Date(),
): Detection | null {
  const outputTail = detectionWindow(fullTail);
  if (exitCode !== null && patterns.exitCodes.includes(exitCode)) {
    return {
      limited: true,
      resetAt: scanReset(outputTail, patterns, now),
      evidence: `exit code ${exitCode}`,
    };
  }

  // Track the LAST limited match so recovery markers after it can suppress.
  let lastHitIndex = -1;
  let evidence: string | null = null;
  for (const p of patterns.limited) {
    const g = p.global ? p : new RegExp(p.source, p.flags + 'g');
    for (const m of outputTail.matchAll(g)) {
      if (m.index > lastHitIndex) {
        lastHitIndex = m.index;
        evidence = evidenceLine(outputTail, m.index);
      }
    }
  }
  if (lastHitIndex === -1) return null;

  // A notLimit marker suppresses the hit in two cases:
  //   1. It starts on a LATER line than the hit — the lane logged a recovery
  //      ("retrying in 5s") after the cap message and went on working.
  //   2. It sits on the SAME line but BEFORE the hit — a qualifier like
  //      "Approaching weekly limit — resets Friday" or "Budget limit reached"
  //      that only resembles a cap.
  // A notLimit marker embedded AFTER the hit on the same line does NOT
  // suppress: real 429 JSON carries both the cap reason and "Please retry
  // in Ns" in one line, and that line means the lane IS limited.
  const hitLineStart = outputTail.lastIndexOf('\n', lastHitIndex) + 1;
  for (const p of patterns.notLimit) {
    const g = p.global ? p : new RegExp(p.source, p.flags + 'g');
    for (const m of outputTail.matchAll(g)) {
      const mLineStart = outputTail.lastIndexOf('\n', m.index) + 1;
      if (mLineStart > hitLineStart) return null;
      if (mLineStart === hitLineStart && m.index < lastHitIndex) return null;
    }
  }

  // An auth/login failure on the cap line or after it wins: "401
  // Unauthorized … retrying" or "Not logged in" is a broken lane, and a
  // reset would never fix it.
  if (authErrorAfter(outputTail, lastHitIndex) !== null) return null;

  const resetAt = scanReset(outputTail, patterns, now);
  if (exitCode === 0 && resetAt === null) return null;

  return { limited: true, resetAt, evidence: evidence ?? 'rate limit detected' };
}

function scanReset(outputTail: string, patterns: KindPatterns, now: Date): Date | null {
  for (const p of patterns.reset) {
    const g = p.global ? p : new RegExp(p.source, p.flags + 'g');
    for (const m of outputTail.matchAll(g)) {
      if (m[1]) {
        const d = parseResetTime(m[1], now);
        if (d) return d;
      }
    }
  }
  return null;
}

export type QuotaWindow = 'session' | 'daily' | 'weekly' | 'monthly' | 'other';

export interface UsageReading {
  /** Percentage of quota REMAINING (0–100). */
  pctLeft: number;
  /** Which quota window this gauge describes. */
  window: QuotaWindow;
  /** The output line the reading came from. */
  evidence: string;
}

/**
 * Window keywords, most specific first. Claude-style statuslines carry both
 * a session gauge and a weekly gauge — merging them into one number orders
 * lanes on whichever printed last. A custom pattern can pin the window with
 * a named capture group: (?<window>weekly).
 */
const WINDOW_WORDS: [QuotaWindow, RegExp][] = [
  ['weekly', /\b(?:week|weekly|7\s*-?day)\b/i],
  ['monthly', /\b(?:month|monthly|30\s*-?day|billing (?:cycle|period))\b/i],
  ['daily', /\b(?:daily|day|24\s*-?h(?:our)?s?|today)\b/i],
  ['session', /\b(?:session|5\s*-?h(?:our)?s?|current window|conversation|hour(?:ly)?)\b/i],
];

function windowOf(match: RegExpMatchArray, line: string): QuotaWindow {
  const named = match.groups?.window;
  if (named) {
    const s = named.toLowerCase();
    for (const [w, re] of WINDOW_WORDS) if (re.test(s)) return w;
    return 'other';
  }
  for (const [w, re] of WINDOW_WORDS) if (re.test(line)) return w;
  return 'other';
}

const WINDOW_ORDER: Record<QuotaWindow, number> = {
  session: 0,
  daily: 1,
  weekly: 2,
  monthly: 3,
  other: 4,
};

/**
 * Parse the usage gauges a lane printed ("usage: 72%", "12% of your weekly
 * quota left", "used 40% of the window"). Each quota window keeps only its
 * LAST match — CLIs re-print gauges as they move. Returns one reading per
 * distinct window sorted session → other, null when nothing recognizable
 * was emitted.
 */
export function detectUsage(outputTail: string, patterns: KindPatterns): UsageReading[] | null {
  const freshest: Partial<Record<QuotaWindow, { index: number; pctLeft: number }>> = {};
  for (const [list, used] of [
    [patterns.usage ?? [], false],
    [patterns.usageUsed ?? [], true],
  ] as const) {
    for (const p of list) {
      const g = p.global ? p : new RegExp(p.source, p.flags + 'g');
      for (const m of outputTail.matchAll(g)) {
        // First capture group that parses as a number is the percentage.
        // A (?<window>…) named group ahead of it must not shadow the value.
        let n = Number.NaN;
        for (let gi = 1; gi < m.length; gi++) {
          const v = Number.parseFloat(m[gi] ?? '');
          if (Number.isFinite(v)) { n = v; break; }
        }
        if (!Number.isFinite(n)) continue;
        const pctLeft = Math.min(100, Math.max(0, Math.round(used ? 100 - n : n)));
        const w = windowOf(m, evidenceLine(outputTail, m.index));
        const prev = freshest[w];
        if (prev === undefined || m.index >= prev.index) freshest[w] = { index: m.index, pctLeft };
      }
    }
  }
  const readings: UsageReading[] = [];
  for (const [window, v] of Object.entries(freshest)) {
    readings.push({
      window: window as QuotaWindow,
      pctLeft: v.pctLeft,
      evidence: evidenceLine(outputTail, v.index),
    });
  }
  readings.sort((a, b) => WINDOW_ORDER[a.window] - WINDOW_ORDER[b.window]);
  return readings.length > 0 ? readings : null;
}
