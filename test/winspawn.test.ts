import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpawn, runLane } from '../src/runner.js';
import {
  buildWindowsSpawn,
  escapeQuotedArg,
  splitWindowsArgs,
  substituteCmd,
  type WinResolver,
} from '../src/winspawn.js';
import type { Lane } from '../src/types.js';

const fake =
  (map: Record<string, string>): WinResolver =>
  (exe) =>
    map[exe.toLowerCase()] ?? null;
const resolve = fake({
  claude: 'C:\\Tools\\claude.exe',
  codex: 'C:\\npm\\codex.cmd',
  'c:\\my tools\\agent.exe': 'C:\\my tools\\agent.exe',
});
const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };

describe('splitWindowsArgs', () => {
  it('splits on whitespace and groups double quotes', () => {
    expect(splitWindowsArgs('a  "b c" d"e f"g')).toEqual(['a', 'b c', 'de fg']);
    expect(splitWindowsArgs('x "" y')).toEqual(['x', '', 'y']);
  });
  it('follows the backslash-before-quote rules', () => {
    expect(splitWindowsArgs('a\\\\b "c\\"d" e\\\\"f g"')).toEqual(['a\\\\b', 'c"d', 'e\\f g']);
  });
  it('returns null for an unbalanced quote', () => {
    expect(splitWindowsArgs('a "b')).toBeNull();
  });
});

describe('escapeQuotedArg', () => {
  it('escapes quotes and the backslashes that precede them', () => {
    expect(escapeQuotedArg('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeQuotedArg('a\\"b')).toBe('a\\\\\\"b');
    expect(escapeQuotedArg('dir\\')).toBe('dir\\\\');
    expect(escapeQuotedArg('C:\\a\\b')).toBe('C:\\a\\b');
  });
  it('round-trips through splitWindowsArgs', () => {
    for (const s of ['plain', 'say "hi"', 'a\\"b', 'dir\\', '\\\\""\\', 'two\nlines']) {
      expect(splitWindowsArgs(`"${escapeQuotedArg(s)}"`)).toEqual([s]);
    }
  });
});

describe('substituteCmd', () => {
  it('quotes bare slots and leaves slots inside quotes alone', () => {
    expect(substituteCmd('x {{prompt}} "t: {{ prompt }}"', '!V!')).toBe('x "!V!" "t: !V!"');
  });
});

describe('buildWindowsSpawn', () => {
  const nasty = 'a" & echo PWNED & rem " %PATH% !x! ^ \n second line';

  it('runs a simple .exe command without a shell, prompt as one argument', () => {
    const spec = buildWindowsSpawn('claude -p {{prompt}} --verbose', nasty, { resolve, env });
    expect(spec.file).toBe('C:\\Tools\\claude.exe');
    expect(spec.args).toEqual(['-p', nasty, '--verbose']);
    expect(spec.verbatim).toBe(false);
    expect(spec.command).not.toContain('PWNED');
  });

  it('treats a quoted slot or an affixed slot as part of one argument', () => {
    expect(buildWindowsSpawn('claude -p "{{prompt}}"', nasty, { resolve, env }).args).toEqual(['-p', nasty]);
    expect(buildWindowsSpawn('claude --prompt={{prompt}}', 'x y', { resolve, env }).args).toEqual(['--prompt=x y']);
    expect(buildWindowsSpawn('"C:\\my tools\\agent.exe" {{prompt}}', 'p', { resolve, env }).file).toBe(
      'C:\\my tools\\agent.exe',
    );
  });

  it('uses cmd.exe with delayed expansion when the template needs cmd syntax', () => {
    const spec = buildWindowsSpawn('claude -p {{prompt}} 2>NUL', nasty, { resolve, env });
    expect(spec.file).toBe(env.ComSpec);
    expect(spec.verbatim).toBe(true);
    expect(spec.args).toEqual(['/d /v:on /s /c "claude -p "!LR_PROMPT_ARG!" 2>NUL"']);
    expect(spec.env).toEqual({ LR_PROMPT_ARG: escapeQuotedArg(nasty) });
    expect(spec.args.join(' ')).not.toContain('PWNED');
  });

  it('defers expansion into batch files (npm .cmd shims)', () => {
    const spec = buildWindowsSpawn('codex exec {{prompt}}', nasty, { resolve, env });
    expect(spec.args).toEqual(['/d /v:on /s /c "codex exec "^!LR_PROMPT_ARG^!""']);
  });

  it('falls back to cmd.exe for unknown programs and builtins', () => {
    const spec = buildWindowsSpawn('echo {{prompt}}', 'x', { resolve, env });
    expect(spec.args).toEqual(['/d /v:on /s /c "echo "!LR_PROMPT_ARG!""']);
  });

  it('is what buildSpawn returns for win32', () => {
    expect(buildSpawn('claude {{prompt}}', 'x', 'win32', { resolve, env }).file).toBe('C:\\Tools\\claude.exe');
  });
});

// Real cmd.exe: only meaningful on Windows.
describe.skipIf(process.platform !== 'win32')('windows: prompt never reaches cmd.exe parsing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-win-'));
  writeFileSync(join(dir, 'echo.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  writeFileSync(join(dir, 'plain.cmd'), '@echo off\r\nnode "%~dp0echo.js" %*\r\n');
  // Same structure as the shims npm generates for package bins.
  writeFileSync(
    join(dir, 'npmshim.cmd'),
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\echo.js" %*',
      '',
    ].join('\r\n'),
  );
  const nasty =
    'fix "it" & echo PWNED>pwned1.txt & rem " | echo PWNED>pwned2.txt %PATH% !PATH! ^caret <in >out.txt\n' +
    'second line with C:\\path\\ and a trailing backslash\\';
  const lane = (command: string): Lane => ({
    name: 'w',
    kind: 'custom',
    command,
    priority: 0,
    cost: 'free',
    timeoutMinutes: 0,
    defaultResetMinutes: 60,
    patterns: {},
  });
  const cases: [string, string][] = [
    ['node echo.js {{prompt}}', nasty],
    ['node echo.js "{{prompt}}"', nasty],
    ['node echo.js {{prompt}} 2>NUL', nasty],
    ['node echo.js "task: {{prompt}}" 2>NUL', `task: ${nasty}`],
    ['plain.cmd {{prompt}}', nasty],
    ['npmshim.cmd {{prompt}}', nasty],
  ];
  for (const [command, expected] of cases) {
    it(`passes the prompt verbatim: ${command}`, async () => {
      const r = await runLane(lane(command), nasty, { cwd: dir, tee: false });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.outputTail)).toEqual([expected]);
      for (const f of ['pwned1.txt', 'pwned2.txt', 'out.txt']) expect(existsSync(join(dir, f))).toBe(false);
    });
  }
});
