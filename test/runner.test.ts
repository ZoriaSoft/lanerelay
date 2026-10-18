import { describe, expect, it } from 'vitest';
import { buildSpawn, runLane, shellQuote } from '../src/runner.js';
import type { Lane } from '../src/types.js';

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded ones', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('a "b" $HOME `x`')).toBe('\'a "b" $HOME `x`\'');
  });
});

describe('buildSpawn', () => {
  it('posix: sh -c with the prompt substituted inline, quoted', () => {
    const spec = buildSpawn('claude -p {{prompt}} --flag', 'fix "the bug"', 'linux');
    expect(spec.file).toBe('sh');
    expect(spec.args[0]).toBe('-c');
    expect(spec.args[1]).toBe('claude -p \'fix "the bug"\' --flag');
    expect(spec.command).toBe(spec.args[1]);
  });

  it('posix: substitutes every {{prompt}} occurrence and tolerates spaces', () => {
    const spec = buildSpawn('echo {{ prompt }} {{prompt}}', 'x', 'linux');
    expect(spec.args[1]).toBe("echo 'x' 'x'");
  });

  it('win32: cmd /d /s /c with the prompt via %QP_PROMPT%', () => {
    const spec = buildSpawn('claude -p {{prompt}}', 'fix it', 'win32');
    expect(spec.file).toBe('cmd');
    expect(spec.args).toEqual(['/d', '/s', '/c', 'claude -p "%QP_PROMPT%"']);
    // The prompt never lands in the command line (cmd quoting limits).
    expect(spec.command).not.toContain('fix it');
  });
});

describe('runLane', () => {
  it('exports QP_PROMPT to the child environment', async () => {
    const lane: Lane = {
      name: 't',
      kind: 'custom',
      command: 'printf %s "$QP_PROMPT"',
      priority: 0,
      cost: 'free',
      timeoutMinutes: 0,
      defaultResetMinutes: 60,
      patterns: {},
    };
    const r = await runLane(lane, 'sentinel-prompt-text', { cwd: process.cwd(), tee: false });
    expect(r.exitCode).toBe(0);
    expect(r.outputTail).toBe('sentinel-prompt-text');
  });
});
