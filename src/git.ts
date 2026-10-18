import { execFileSync } from 'node:child_process';

/** Byte cap applied to the patch when callers don't pass one. */
export const DEFAULT_DIFF_MAX_BYTES = 8_192;

/**
 * Compact summary of the current repo state for handoff notes:
 * porcelain counts + `git diff --stat` (staged + unstaged) + untracked files.
 * Returns empty string outside a git repo or when the tree is clean.
 */
export function gitDiffSummary(cwd: string): string {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'pipe' });
  } catch {
    return '';
  }
  const run = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch {
      return '';
    }
  };

  const parts: string[] = [];
  const stat = run(['diff', '--stat', 'HEAD']).trim();
  if (stat) parts.push(stat);

  const untracked = run(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (untracked.length > 0) {
    const shown = untracked.slice(0, 10);
    parts.push(
      `Untracked files (${untracked.length}): ${shown.join(', ')}${untracked.length > shown.length ? ', …' : ''}`,
    );
  }

  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch && branch !== 'HEAD' && parts.length > 0) {
    parts.unshift(`On branch ${branch}:`);
  }
  return parts.join('\n');
}

/**
 * Bounded `git diff HEAD` patch for handoff notes (`handoff.diff: full`).
 * Returns empty string outside a git repo or when there are no tracked
 * changes; untracked file *contents* are never included (too unbounded) —
 * the stat summary lists their names.
 */
export function gitDiffPatch(cwd: string, maxBytes: number = DEFAULT_DIFF_MAX_BYTES): string {
  try {
    const out = execFileSync('git', ['diff', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: maxBytes + 1024 * 1024,
    }).toString('utf8');
    if (out.length <= maxBytes) return out.trimEnd();
    return `${out.slice(0, maxBytes)}\n[... diff truncated at ${maxBytes} bytes]`;
  } catch {
    return '';
  }
}
