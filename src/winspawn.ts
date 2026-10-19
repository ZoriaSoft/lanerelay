import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Windows lane spawning without letting cmd.exe parse the prompt.
 *
 * 1. Direct: a simple template (no cmd.exe syntax) whose program resolves to
 *    an .exe/.com is spawned without any shell. The prompt is one argv
 *    element and Node quotes it for CreateProcess, so it arrives verbatim.
 * 2. Through cmd.exe: templates that use cmd syntax, or that start a
 *    .cmd/.bat (npm shims), run as `cmd /d /v:on /s /c "..."`. The prompt is
 *    referenced as !LR_PROMPT_ARG!: delayed expansion happens after cmd has
 *    parsed the line, so quotes, `&`, `|`, `>`, `%` and line breaks in the
 *    prompt are never interpreted. LR_PROMPT_ARG holds the prompt escaped for
 *    the program's own argv parser. A batch file re-reads its arguments
 *    (`%*`), so for .cmd/.bat targets the reference is written ^!...^! and
 *    is expanded inside the batch file instead, after it has parsed the line.
 */

export type WinResolver = (exe: string, cwd: string, env: NodeJS.ProcessEnv) => string | null;

export interface WinSpawnSpec {
  file: string;
  args: string[];
  command: string;
  /** Extra environment for the child. */
  env: Record<string, string>;
  /** Pass args to CreateProcess as-is (we quote the cmd.exe line ourselves). */
  verbatim: boolean;
}

const SLOT_G = /\{\{\s*prompt\s*\}\}/g;
/** Characters with meaning to cmd.exe anywhere in a line. */
const CMD_SYNTAX = /[&|<>^()%!\r\n]/;
const MARK = '\u0000';

/** Find a program the way cmd.exe would: cwd first, then PATH, with PATHEXT. */
export const resolveWindowsProgram: WinResolver = (exe, cwd, env) => {
  const w = path.win32;
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const candidates = (base: string) =>
    w.extname(base) ? [base, ...exts.map((e) => base + e)] : exts.map((e) => base + e);
  const dirs = exe.includes('/') || exe.includes('\\') || w.isAbsolute(exe)
    ? [w.resolve(cwd, w.dirname(exe))]
    : [cwd, ...(env.PATH ?? env.Path ?? '').split(';').filter(Boolean)];
  const name = w.basename(exe);
  for (const dir of dirs) {
    for (const c of candidates(name)) {
      const p = w.join(dir, c);
      if (existsSync(p)) return p;
    }
  }
  return null;
};

/**
 * Split a command line into words the way CommandLineToArgvW does for the
 * common cases: whitespace separates, double quotes group, `\"` is a quote.
 * Returns null for an unbalanced quote.
 */
export function splitWindowsArgs(line: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      let n = 0;
      while (line[i + n] === '\\') n++;
      if (line[i + n] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else quoted = !quoted;
        i += n;
      } else {
        cur += '\\'.repeat(n);
        i += n - 1;
      }
      inWord = true;
    } else if (c === '"') {
      quoted = !quoted;
      inWord = true;
    } else if ((c === ' ' || c === '\t') && !quoted) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quoted) return null;
  if (inWord) out.push(cur);
  return out;
}

/** Escape text for use inside a "..." argument parsed by CommandLineToArgvW. */
export function escapeQuotedArg(s: string): string {
  return s.replace(/(\\*)"/g, (_m, b: string) => b + b + '\\"').replace(/(\\+)$/, (b) => b + b);
}

/** Replace {{prompt}} slots with `ref`, adding quotes when the slot is bare. */
export function substituteCmd(template: string, ref: string): string {
  const slot = /\{\{\s*prompt\s*\}\}/y;
  let out = '';
  let quoted = false;
  for (let i = 0; i < template.length; ) {
    slot.lastIndex = i;
    const m = slot.exec(template);
    if (m) {
      out += quoted ? ref : `"${ref}"`;
      i += m[0].length;
      continue;
    }
    if (template[i] === '"') quoted = !quoted;
    out += template[i];
    i += 1;
  }
  return out;
}

export function buildWindowsSpawn(
  template: string,
  prompt: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; resolve?: WinResolver } = {},
): WinSpawnSpec {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const resolveProgram = opts.resolve ?? resolveWindowsProgram;

  const words = splitWindowsArgs(template.replace(SLOT_G, MARK));
  const program = words && words.length > 0 && !words[0].includes(MARK) ? words[0] : null;
  const resolved = program ? resolveProgram(program, cwd, env) : null;
  const ext = resolved ? path.win32.extname(resolved).toLowerCase() : '';

  const withoutSlots = template.replace(SLOT_G, '');
  if (words && resolved && (ext === '.exe' || ext === '.com') && !CMD_SYNTAX.test(withoutSlots)) {
    const args = words.slice(1).map((w) => w.split(MARK).join(prompt));
    const command = [resolved, ...words.slice(1).map((w) => w.split(MARK).join('%LR_PROMPT%'))]
      .map((a) => (/[\s"]/.test(a) || a === '' ? `"${escapeQuotedArg(a)}"` : a))
      .join(' ');
    return { file: resolved, args, command, env: {}, verbatim: false };
  }

  const batch = ext === '.cmd' || ext === '.bat';
  const ref = batch ? '^!LR_PROMPT_ARG^!' : '!LR_PROMPT_ARG!';
  const command = substituteCmd(template, ref);
  return {
    file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    args: [`/d /v:on /s /c "${command}"`],
    command,
    env: { LR_PROMPT_ARG: escapeQuotedArg(prompt) },
    verbatim: true,
  };
}
