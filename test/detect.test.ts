import { describe, expect, it } from 'vitest';
import { detectLimit, parseResetTime } from '../src/detect.js';
import { mergePatterns } from '../src/patterns.js';
import type { LaneKind } from '../src/types.js';

const NOW = new Date('2026-10-18T10:00:00Z');

function detect(kind: LaneKind, output: string, exitCode: number | null, now = NOW) {
  return detectLimit(output, exitCode, mergePatterns(kind), now);
}

describe('detectLimit: claude', () => {
  it('catches the classic 5-hour limit with clock reset', () => {
    const out = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit"}}\nClaude AI usage limit reached. Your limit will reset at 1pm.\n';
    const d = detect('claude', out, 1);
    expect(d?.limited).toBe(true);
    expect(d?.resetAt?.getHours()).toBe(13);
    expect(d?.resetAt?.getDate()).toBe(NOW.getDate());
  });

  it('catches pipe-delimited epoch reset', () => {
    const epoch = Math.floor(NOW.getTime() / 1000) + 5400; // +90min
    const out = `You've hit your limit\nClaude AI usage limit reached|${epoch}\n`;
    const d = detect('claude', out, 1);
    expect(d?.limited).toBe(true);
    expect(d?.resetAt?.getTime()).toBe(epoch * 1000);
  });

  it('catches weekly limit', () => {
    const out = 'Claude Code: weekly limit reached. Resets Friday at 9am.\n';
    const d = detect('claude', out, 1);
    expect(d?.limited).toBe(true);
    expect(d?.resetAt?.getDay()).toBe(5);
  });

  it('ignores transient overloaded errors', () => {
    const out = 'API Error: Overloaded\n{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n';
    expect(detect('claude', out, 1)).toBeNull();
  });

  it('does not fire on a clean run that mentions 429 in code context', () => {
    // exit 0 + no reset hint → treated as absorbed transient
    const out = 'I fixed the handler that returned 429 when upstream throttles.\nDone.\n';
    expect(detect('claude', out, 0)).toBeNull();
  });

  it('catches the headless "hit your limit · resets H:MMpm (TZ)" line', () => {
    // Observed 2026: claude -p prints this exact banner on a capped session.
    const out = `You've hit your limit · resets 9:10pm (Europe/Kiev)\n`;
    const d = detect('claude', out, 1);
    expect(d?.limited).toBe(true);
    expect(d?.resetAt?.getHours()).toBe(21);
    expect(d?.resetAt?.getMinutes()).toBe(10);
  });

  it('catches "hit your session limit" (headless report)', () => {
    const out = `You've hit your session limit\n`;
    expect(detect('claude', out, 1)?.limited).toBe(true);
  });

  it('does not fire on "Budget limit reached" (user budget, not quota)', () => {
    const out = 'Budget limit reached for this run. Spawning stopped.\n';
    expect(detect('claude', out, 1)).toBeNull();
  });

  it('does not fire on an "approaching limit" warning with same-line reset', () => {
    const out = 'Approaching weekly limit — resets Friday at 9am. Continuing work.\nDone.\n';
    expect(detect('claude', out, 0)).toBeNull();
  });
});

describe('detectLimit: codex', () => {
  it('catches exhausted retries on 429', () => {
    const out = 'stream error: stream disconnected before completion\nerror: exceeded retry limit, last status: 429 Too Many Requests, retries: 5/5\n';
    const d = detect('codex', out, 1);
    expect(d?.limited).toBe(true);
  });

  it('catches usage limit with relative reset', () => {
    const out = 'ERROR: You have hit your usage limit. Try again in 40 minutes.\n';
    const d = detect('codex', out, 1);
    expect(d?.resetAt?.getTime()).toBe(NOW.getTime() + 40 * 60_000);
  });

  it('catches weekly reset with date', () => {
    const out = 'usage limit reached. Your quota resets Oct 22.\n';
    const d = detect('codex', out, 1);
    expect(d?.resetAt?.getMonth()).toBe(9);
    expect(d?.resetAt?.getDate()).toBe(22);
  });

  it('catches the Plus upsell message with same-day clock reset', () => {
    // codex-rs error.rs Display: plan Free → this exact sentence.
    const out =
      'You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 4:20 PM.\n';
    const d = detect('codex', out, 1);
    expect(d?.limited).toBe(true);
    expect(d?.resetAt?.getHours()).toBe(16);
    expect(d?.resetAt?.getMinutes()).toBe(20);
  });

  it('catches the dated reset "Jul 19th, 2026 10:27 AM"', () => {
    const out =
      'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at Jul 19th, 2026 10:27 AM.\n';
    const d = detect('codex', out, 1);
    expect(d?.limited).toBe(true);
    expect(d?.resetAt?.getMonth()).toBe(6);
    expect(d?.resetAt?.getDate()).toBe(19);
    expect(d?.resetAt?.getHours()).toBe(10);
    expect(d?.resetAt?.getMinutes()).toBe(27);
  });

  it('catches per-model usage limit ("usage limit for gpt-…")', () => {
    const out = 'You’ve hit your usage limit for gpt-5.5-codex. Switch to another model now, or try again later.\n';
    const d = detect('codex', out, 1);
    expect(d?.limited).toBe(true);
    expect(d?.resetAt).toBeNull(); // "try again later" gives no reset
  });

  it('catches workspace credit depletion', () => {
    const out = 'Your workspace is out of credits. Add credits to continue.\n';
    expect(detect('codex', out, 1)?.limited).toBe(true);
  });

  it('catches workspace spend cap', () => {
    const out = 'You hit your spend cap set in your workspace. Increase your spend cap to continue.\n';
    expect(detect('codex', out, 1)?.limited).toBe(true);
  });

  it('does not fire on "Selected model is at capacity" (transient)', () => {
    const out = 'Selected model is at capacity. Please try a different model.\n';
    expect(detect('codex', out, 1)).toBeNull();
  });

  it('does not fire on "agent thread limit reached" (concurrency cap)', () => {
    const out = 'error: agent thread limit reached\n';
    expect(detect('codex', out, 1)).toBeNull();
  });

  it('catches bare "Rate limit reached for gpt-…" org errors', () => {
    const out = '[Error]: Rate limit reached for gpt-5.5-codex in organization org-abcd on tokens per min (TPM): Limit 30000, Used 29872, Requested 512.\n';
    expect(detect('codex', out, 1)?.limited).toBe(true);
  });
});

describe('detectLimit: gemini', () => {
  it('catches RESOURCE_EXHAUSTED with retryDelay', () => {
    const out = '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"86399s"}]}}\n';
    const d = detect('gemini', out, 1);
    expect(d?.limited).toBe(true);
    expect(d?.resetAt?.getTime()).toBe(NOW.getTime() + 86399_000);
  });

  it('catches free-tier daily limit message', () => {
    const out = 'You have reached your daily limit for requests. Your quota will reset in 4 hours.\n';
    const d = detect('gemini', out, 1);
    expect(d?.limited).toBe(true);
    expect(d?.resetAt?.getTime()).toBe(NOW.getTime() + 4 * 3_600_000);
  });

  it('catches the TerminalQuotaError daily-quota sentence (gemini-cli source)', () => {
    // packages/core/src/utils/googleQuotaErrors.ts — PerDay/Daily violation.
    const out = 'You have exhausted your daily quota on this model.\n';
    expect(detect('gemini', out, 1)?.limited).toBe(true);
  });

  it('catches a one-line 429 RPC with embedded "Please retry in"', () => {
    // The retry hint sits AFTER the cap string on the same JSON line — it is
    // a suggested delay, not a recovery, so detection must still fire.
    const out =
      '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota). Please retry in 34.07s","status":"RESOURCE_EXHAUSTED"}}\n';
    const d = detect('gemini', out, 1);
    expect(d?.limited).toBe(true);
    expect(d?.resetAt?.getTime()).toBe(NOW.getTime() + 34_070);
  });

  it('still treats a next-line retry notice as recovery', () => {
    const out =
      'You have exhausted your daily quota on this model.\nretrying in 30 seconds\nall good now\n';
    expect(detect('gemini', out, 0)).toBeNull();
  });
});

describe('detectLimit: aider / others', () => {
  it('catches litellm rate limit error', () => {
    const out = 'litellm.RateLimitError: RateLimitError: OpenrouterException - {"error":{"message":"Rate limit exceeded: free-models-per-day","code":429}}\n';
    expect(detect('aider', out, 1)?.limited).toBe(true);
  });

  it('catches GLM insufficient balance', () => {
    const out = 'Error: {"code":429,"message":"insufficient balance, quota exhausted"}\n';
    expect(detect('glm', out, 1)?.limited).toBe(true);
  });

  it('custom kind still gets generic patterns', () => {
    const out = 'HTTP 429 Too Many Requests from upstream\n';
    expect(detect('custom', out, 1)?.limited).toBe(true);
  });
});

describe('detectLimit: edge cases', () => {
  it('returns null on normal output', () => {
    expect(detect('claude', 'All tests pass. Committed abc123.\n', 0)).toBeNull();
  });

  it('limit deep in output still detected (tail window)', () => {
    const noise = 'x'.repeat(40 * 1024) + '\n';
    const out = noise + '5-hour limit reached. resets at 3pm\n' + noise;
    const d = detect('claude', out.slice(-64 * 1024), 1);
    expect(d?.limited).toBe(true);
  });

  it('notLimit AFTER the cap message suppresses detection (recovery)', () => {
    const out = 'rate limit exceeded, waiting...\nretrying in 5 seconds\nworked, continuing\n';
    // 'retrying' appears after 'rate limit' → lane recovered → not limited
    expect(detect('gemini', out, 0)).toBeNull();
  });

  it('cap message AFTER earlier transient noise still fires', () => {
    const out = 'overloaded_error: Overloaded\n5-hour limit reached. resets 12pm\n';
    expect(detect('claude', out, 1)?.limited).toBe(true);
  });

  it('honors lane-level exit code patterns', () => {
    const patterns = mergePatterns('custom', { exitCodes: [42] });
    const d = detectLimit('no matching text', 42, patterns, NOW);
    expect(d?.limited).toBe(true);
    expect(d?.evidence).toBe('exit code 42');
  });
});

describe('parseResetTime', () => {
  it('parses composite durations', () => {
    expect(parseResetTime('1 hour 23 minutes', NOW)?.getTime()).toBe(NOW.getTime() + 83 * 60_000);
    expect(parseResetTime('90 seconds', NOW)?.getTime()).toBe(NOW.getTime() + 90_000);
    expect(parseResetTime('an hour', NOW)?.getTime()).toBe(NOW.getTime() + 3_600_000);
    expect(parseResetTime('45s', NOW)?.getTime()).toBe(NOW.getTime() + 45_000);
    // codex statusline "resets 143h26m" — compact composite
    expect(parseResetTime('143h26m', NOW)?.getTime()).toBe(NOW.getTime() + 143 * 3_600_000 + 26 * 60_000);
    // gemini RPC "Please retry in 34.07s" / "900ms"
    expect(parseResetTime('34.07s', NOW)?.getTime()).toBe(NOW.getTime() + 34_070);
    expect(parseResetTime('900ms', NOW)?.getTime()).toBe(NOW.getTime() + 900);
  });

  it('parses clock times, rolling past times to tomorrow', () => {
    const pm = parseResetTime('1pm', NOW)!;
    expect(pm.getHours()).toBe(13);
    const early = parseResetTime('9am', NOW)!; // 9am already passed at 10am
    expect(early.getDate()).toBe(NOW.getDate() + 1);
  });

  it('parses 24h clock', () => {
    const t = parseResetTime('14:30', NOW)!;
    expect(t.getHours()).toBe(14);
    expect(t.getMinutes()).toBe(30);
  });

  it('parses month-day', () => {
    const t = parseResetTime('Oct 22', NOW)!;
    expect(t.getMonth()).toBe(9);
    expect(t.getDate()).toBe(22);
  });

  it('parses ISO timestamps', () => {
    const t = parseResetTime('2026-10-18T15:30:00Z', NOW)!;
    expect(t.toISOString()).toBe('2026-10-18T15:30:00.000Z');
  });

  it('returns null on garbage', () => {
    expect(parseResetTime('soon™', NOW)).toBeNull();
    expect(parseResetTime('', NOW)).toBeNull();
  });
});
