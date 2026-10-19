import { describe, expect, it } from 'vitest';
import { buildSpawn, runLane, shellQuote, substitutePosix } from '../src/runner.js';
import { spawnSync } from 'node:child_process';
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

  it('win32: delegates to buildWindowsSpawn (see winspawn.test.ts)', () => {
    const spec = buildSpawn('claude -p {{prompt}} 2>NUL', 'fix it', 'win32', { resolve: () => null, env: {} });
    expect(spec.file).toBe('cmd.exe');
    expect(spec.args).toEqual(['/d /v:on /s /c "claude -p "!LR_PROMPT_ARG!" 2>NUL"']);
    // The prompt never lands in the cmd.exe command line.
    expect(spec.command).not.toContain('fix it');
  });
});

describe('runLane', () => {
  it('exports LR_PROMPT to the child environment', async () => {
    const lane: Lane = {
      name: 't',
      kind: 'custom',
      command: 'printf %s "$LR_PROMPT"',
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

describe.skipIf(process.platform === 'win32')('prompt slot quoting contexts', () => {
  const nasty = 'fix it $(echo PWNED) `echo PWNED` it\'s "quoted" \\ back $HOME';
  const runEcho = (template: string): string => {
    const spec = buildSpawn(template, nasty, 'linux');
    return spawnSync(spec.file, spec.args, { encoding: 'utf8' }).stdout;
  };

  it('passes the prompt verbatim whether the slot is bare, double- or single-quoted', () => {
    for (const t of ['printf %s {{prompt}}', 'printf %s "{{prompt}}"', "printf %s '{{prompt}}'"]) {
      expect(runEcho(t)).toBe(nasty);
    }
  });

  it('keeps surrounding text inside the user quotes', () => {
    expect(runEcho('printf %s "task: {{prompt}} (end)"')).toBe(`task: ${nasty} (end)`);
    expect(runEcho("printf %s 'task: {{prompt}} (end)'")).toBe(`task: ${nasty} (end)`);
  });

  it('an escaped quote outside quotes does not open a string', () => {
    expect(substitutePosix('echo \\" {{prompt}}', 'x')).toBe("echo \\\" 'x'");
  });
});
