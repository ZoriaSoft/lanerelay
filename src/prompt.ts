import type { AttemptResult } from './types.js';

const MAX_ATTEMPT_TAIL = 1_500;
// Agent CLIs accept large prompts; a full diff needs headroom. POSIX argv
// caps near 128KB and Windows passes the prompt via env var, so 32KB is safe.
const MAX_PROMPT = 32_000;

interface HandoffCtx {
  task: string;
  attempts: AttemptResult[];
  cwd: string;
  /** gitDiffSummary output; empty when unavailable or diff mode 'none'. */
  diffSummary: string;
  /** gitDiffPatch output (diff mode 'full'); empty otherwise. */
  diffPatch?: string;
}

/**
 * Build the prompt handed to the next lane. The original task comes first;
 * a "handoff" section appended after previous attempts tells the next agent
 * what was tried, what the working tree looks like, and to continue rather
 * than restart.
 */
export function renderPrompt(ctx: HandoffCtx): string {
  if (ctx.attempts.length === 0) return ctx.task;

  const blocks: string[] = [
    ctx.task,
    '',
    '---',
    'CONTEXT: this task was already attempted by other agent CLI(s) that hit their usage limits.',
    'Do NOT redo their work. Review the current state of the repo and continue from where they stopped.',
  ];

  if (ctx.diffSummary) {
    blocks.push('', 'Current working tree changes:', '```', ctx.diffSummary, '```');
  }
  if (ctx.diffPatch) {
    blocks.push('', 'Current working tree diff:', '```diff', ctx.diffPatch, '```');
  }

  for (const a of ctx.attempts) {
    const tail = a.verdict.outputTail.slice(-MAX_ATTEMPT_TAIL);
    blocks.push(
      '',
      `--- Attempt on lane "${a.lane}" ended (${a.verdict.type}). Tail of its output:`,
      '```',
      tail,
      '```',
    );
  }

  blocks.push('', 'Continue the task now. Work in this same repository.');

  const full = blocks.join('\n');
  // Keep the prompt under control: drop oldest attempt tails if needed.
  if (full.length <= MAX_PROMPT) return full;
  const truncated = [ctx.task, '', '---', 'Earlier attempts truncated for length.', '', ctx.diffSummary ? `Working tree:\n${ctx.diffSummary}` : '', ctx.diffPatch ? `\nDiff (truncated):\n${ctx.diffPatch.slice(0, 4_000)}` : '', '', 'Continue the task.'].join('\n');
  return truncated.slice(0, MAX_PROMPT);
}
