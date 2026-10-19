import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authErrorAfter, detectLimit } from '../src/detect.js';
import { mergePatterns } from '../src/patterns.js';
import { detectAuthError } from '../src/probe.js';
import type { LaneKind } from '../src/types.js';

// Real CLI output, sanitized — see test/fixtures/real/README.md.
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'real', name), 'utf8');

// The suite runs with TZ=UTC (vitest.config.ts).
const NOW = new Date('2026-10-19T05:18:00Z');

function detect(kind: LaneKind, out: string, exit: number | null) {
  return detectLimit(out, exit, mergePatterns(kind), NOW);
}

describe('real CLI samples: limits', () => {
  it('claude 2.1 weekly limit → limited, reset read in UTC', () => {
    const d = detect('claude', fixture('claude-weekly-limit.txt'), 1);
    expect(d?.limited).toBe(true);
    // 3am UTC already passed at 05:18 UTC → tomorrow 03:00 UTC.
    expect(d?.resetAt?.toISOString()).toBe('2026-10-20T03:00:00.000Z');
  });

  it('claude reset in UTC stays correct on a machine in another zone', async () => {
    const { parseResetTime } = await import('../src/detect.js');
    const prev = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      expect(parseResetTime('3am (UTC)', NOW)?.toISOString()).toBe('2026-10-20T03:00:00.000Z');
    } finally {
      process.env.TZ = prev;
    }
  });

  it('codex 0.163 usage limit (curly apostrophe, "try again at 6:41 AM") → limited', () => {
    const d = detect('codex', fixture('codex-usage-limit.txt'), 1);
    expect(d?.limited).toBe(true);
    expect(d?.evidence).toContain('hit your usage limit');
    expect(d?.resetAt?.toISOString()).toBe('2026-10-19T06:41:00.000Z');
  });
});

describe('real CLI samples: errors that are NOT limits', () => {
  const notLimits: [string, LaneKind, boolean][] = [
    ['claude-not-logged-in.txt', 'claude', true],
    ['claude-bad-model.txt', 'claude', false],
    ['codex-bad-model.txt', 'codex', false],
    ['codex-no-auth.txt', 'codex', true],
    ['opencode-bad-config.txt', 'opencode', false],
  ];
  for (const [file, kind, isAuth] of notLimits) {
    it(`${file} → not limited${isAuth ? ', auth error' : ''}`, () => {
      const out = fixture(file);
      expect(detect(kind, out, 1)).toBeNull();
      // Every kind table must agree — a lane's `kind` can be set wrong.
      for (const k of ['claude', 'codex', 'gemini', 'glm', 'aider', 'opencode', 'cursor', 'custom'] as LaneKind[]) {
        expect(detect(k, out, 1)).toBeNull();
      }
      if (isAuth) expect(detectAuthError(out)).not.toBeNull();
      else expect(detectAuthError(out)).toBeNull();
    });
  }

  it('opencode success output → not limited', () => {
    expect(detect('opencode', fixture('opencode-ok.txt'), 0)).toBeNull();
  });
});

describe('false positives', () => {
  it('agent prose about rate limiting is not a limit, even on a failed exit', () => {
    const out = [
      'I added rate limiting middleware to the API router.',
      'The handler now returns HTTP status 200 or a Retry-After header.',
      'Tests: 3 failed (unrelated flaky network test).',
    ].join('\n');
    for (const k of ['claude', 'codex', 'gemini', 'glm', 'aider', 'opencode', 'cursor'] as LaneKind[]) {
      expect(detect(k, out, 1)).toBeNull();
    }
  });

  it('a bare 429 that is not an HTTP status is not a limit', () => {
    const out = 'TypeError: cannot read properties of undefined\n    at main (src/app.ts:429:13)\n';
    for (const k of ['claude', 'codex', 'glm', 'aider', 'opencode', 'cursor', 'custom'] as LaneKind[]) {
      expect(detect(k, out, 1)).toBeNull();
    }
  });

  it('a limit message far above the end of the output is ignored', () => {
    const early = "You've hit your weekly limit · resets 3am (UTC)\n";
    const work = Array.from({ length: 80 }, (_, i) => `step ${i}: edited file`).join('\n');
    expect(detect('claude', early + work + '\nerror: tests failed\n', 1)).toBeNull();
    // …while the same banner as the last line still fires.
    expect(detect('claude', work + '\n' + early, 1)?.limited).toBe(true);
  });

  it('an auth error after a 429 line wins (broken credentials, not quota)', () => {
    const out = 'HTTP error 429 Too Many Requests\nERROR: unexpected status 401 Unauthorized: invalid api key\n';
    expect(detect('codex', out, 1)).toBeNull();
    expect(authErrorAfter(out)).toContain('401');
  });

  it('a 429 after an earlier auth hiccup is still a limit', () => {
    const out = 'warn: token expired, refreshed\nERROR: exceeded retry limit, last status: 429 Too Many Requests\n';
    expect(detect('codex', out, 1)?.limited).toBe(true);
  });
});
