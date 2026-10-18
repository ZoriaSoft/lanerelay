import { execFileSync } from 'node:child_process';

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
