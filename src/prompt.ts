import type { AttemptResult } from './types.js';

const MAX_ATTEMPT_TAIL = 1_500;
const MAX_ATTEMPT_LINES = 30;

/** Last line of every handoff prompt; also the marker for echo stripping. */
export const HANDOFF_END = 'Continue the task now. Work in this same repository.';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/**
 * The part of an attempt's output worth showing the next lane: ANSI codes
 * removed, any echo of OUR prompt cut away (codex prints the prompt it got,
 * so a raw tail would nest every earlier handoff inside the new one), then
 * the last few lines, bounded in size.
 */
export function handoffTail(outputTail: string, task?: string): string {
  let s = outputTail.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
  const end = s.lastIndexOf(HANDOFF_END);
  if (end !== -1) s = s.slice(end + HANDOFF_END.length);
  else if (task && task.length >= 12) {
    // First lane: the prompt was the bare task; drop its echo too.
    const t = s.lastIndexOf(task);
    if (t !== -1) s = s.slice(t + task.length);
  }
  const lines = s.split('\n').map((l) => l.trimEnd());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  let out = lines.slice(-MAX_ATTEMPT_LINES).join('\n').trim();
  if (out.length > MAX_ATTEMPT_TAIL) out = '…' + out.slice(-MAX_ATTEMPT_TAIL);
  return out;
}
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
    'CONTEXT: this task was already attempted by another agent CLI that stopped (usage limit, error or timeout — see below).',
    'Do NOT redo finished work. Review the current state of the repo and continue from where it stopped.',
  ];

  if (ctx.diffSummary) {
    blocks.push('', 'Current working tree changes:', '```', ctx.diffSummary, '```');
  }
  if (ctx.diffPatch) {
    blocks.push('', 'Current working tree diff:', '```diff', ctx.diffPatch, '```');
  }

  for (const a of ctx.attempts) {
    const tail = handoffTail(a.verdict.outputTail, ctx.task);
    blocks.push(
      '',
      `--- Attempt on lane "${a.lane}" ended (${a.verdict.type}). Last lines of its output:`,
      '```',
      tail || '(no output)',
      '```',
    );
  }

  blocks.push('', HANDOFF_END);

  const full = blocks.join('\n');
  // Keep the prompt under control: drop oldest attempt tails if needed.
  if (full.length <= MAX_PROMPT) return full;
  const truncated = [ctx.task, '', '---', 'Earlier attempts truncated for length.', '', ctx.diffSummary ? `Working tree:\n${ctx.diffSummary}` : '', ctx.diffPatch ? `\nDiff (truncated):\n${ctx.diffPatch.slice(0, 4_000)}` : '', '', 'Continue the task.'].join('\n');
  return truncated.slice(0, MAX_PROMPT);
}
