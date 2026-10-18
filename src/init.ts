import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Starter config written by `qp init`. Uses the three commonest CLI lanes. */
export const STARTER_CONFIG = `# quota-pilot config — see README.md for the full reference.
# Each lane is one agent CLI. {{prompt}} is replaced by the task text.
lanes:
  - name: claude
    kind: claude
    command: "claude -p {{prompt}} --permission-mode acceptEdits"
    model: claude-sonnet-4.5
    cost: paid
    priority: 0
    timeoutMinutes: 45
    defaultResetMinutes: 300      # 5-hour window if no reset time is detected

  - name: codex
    kind: codex
    command: "codex exec --full-auto {{prompt}}"
    model: gpt-5.5-codex
    cost: paid
    priority: 1
    timeoutMinutes: 45

  - name: gemini
    kind: gemini
    command: "gemini --yolo -p {{prompt}}"
    model: gemini-3-pro
    cost: free
    priority: 2
    defaultResetMinutes: 60

# Named chains for 'qp run --chain <name>'; --chain a,b,c also works inline.
chains:
  default:
    lanes: [claude, codex, gemini]
  free-only:
    lanes: [gemini]

defaults:
  paidFirst: true        # burn paid lanes before free ones
  maxWaitMinutes: 60     # how long \`qp run\` will wait when every lane is blocked
  defaultResetMinutes: 60
  timeoutMinutes: 0      # per-attempt cap; lanes may override

queue:
  dir: .qp/queue
  pollSeconds: 3

# Notification hooks — shell commands get {{lane}} {{task}} {{status}} {{resetAt}}
# templated plus QP_* env vars; webhooks receive a JSON POST.
hooks:
  limit:
    # - command: 'notify-send "lane {{lane}} limited until {{resetAt}}"'
  handoff: []
  finish: []
  fail: []
`;

export interface InitResult {
  configPath: string;
  created: boolean;
  gitignoreNote?: string;
}

/**
 * Write the starter config into `cwd` (quota-pilot.yaml) and make sure
 * `.qp/` is ignored. Never overwrites an existing config.
 */
export function initConfig(cwd: string): InitResult {
  const path = join(cwd, 'quota-pilot.yaml');
  if (existsSync(path)) {
    return { configPath: path, created: false };
  }
  writeFileSync(path, STARTER_CONFIG);
  mkdirSync(join(cwd, '.qp'), { recursive: true });

  const gi = join(cwd, '.gitignore');
  let note: string | undefined;
  if (existsSync(gi)) {
    const content = readFileSync(gi, 'utf8');
    if (!content.split('\n').some((l) => l.trim() === '.qp/')) {
      writeFileSync(gi, content.replace(/\n?$/, '\n') + '\n# qp runtime state\n.qp/\n');
      note = 'added ".qp/" to .gitignore';
    }
  }
  return { configPath: path, created: true, gitignoreNote: note };
}
