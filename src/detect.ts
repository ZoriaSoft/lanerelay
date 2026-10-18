import type { KindPatterns } from './patterns.js';

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
  // Composite duration: "1 hour 23 minutes", "40 min", "an hour", "90 seconds".
  // NB: 'an|one' must be \b-guarded so "9am"/"Friday" don't leak an 'a'.
  const dur = /(\d+(?:\.\d+)?|\ban\b|\bone\b)\s*(hours?|hrs?|hr|h|minutes?|mins?|m(?!s)|seconds?|secs?|s)\b/gi;
  let ms = 0;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = dur.exec(s)) !== null) {
    const raw = m[1].toLowerCase();
    const n = /^\d/.test(raw) ? parseFloat(raw) : 1;
    const unit = m[2].toLowerCase();
    matched = true;
    if (unit.startsWith('h')) ms += n * 3_600_000;
    else if (unit.startsWith('m')) ms += n * 60_000;
    else ms += n * 1_000;
  }
  if (matched && ms > 0) return new Date(now.getTime() + ms);

  // Weekday name, optionally with a time: "Friday", "Friday at 9am"
  const wd = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i.exec(s);
  if (wd && /^[a-z]{3,9}/i.test(wd[0]) && wd[0].toLowerCase().slice(0, 3) in WEEKDAYS) {
    const target = WEEKDAYS[wd[0].toLowerCase().slice(0, 3)];
    const t = clockMatch(s);
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
    const d = new Date(year, month, day, t?.hour ?? 0, t?.minute ?? 0, 0, 0);
    if (!md[3] && d.getTime() <= now.getTime()) d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  // Plain clock time: "12pm", "3:30 pm", "14:30" → today if still future, else tomorrow
  const t = clockMatch(s);
  if (t) {
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
 * - A `notLimit` marker AFTER the last cap message means the lane retried
 *   internally and recovered → not limited.
 * - exitCode 0 with no explicit reset hint → transient the lane absorbed →
 *   not limited.
 * - An explicit cap message wins over earlier transient noise in the tail.
 */
export function detectLimit(
  outputTail: string,
  exitCode: number | null,
  patterns: KindPatterns,
  now: Date = new Date(),
): Detection | null {
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

  for (const p of patterns.notLimit) {
    const g = p.global ? p : new RegExp(p.source, p.flags + 'g');
    for (const m of outputTail.matchAll(g)) {
      if (m.index > lastHitIndex) return null;
    }
  }

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
