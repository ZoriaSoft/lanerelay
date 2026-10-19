import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Starter config written by `lanerelay init`. Uses the three commonest CLI lanes. */
export const STARTER_CONFIG = `# lanerelay config — see README.md for the full reference.
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
    # patterns:                   # per-lane regex overrides (see README)
    #   usage: ["(\\d+)% left"]    # capture REMAINING % → richer lanes run first
    #   usageUsed: ["(\\d+)% used"]# capture USED % (left = 100 − used)

  - name: codex
    kind: codex
    command: "codex exec --sandbox workspace-write {{prompt}}"
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

  # - name: opencode
  #   kind: opencode
  #   command: "opencode run {{prompt}}"
  #   cost: free
  #   priority: 3

# Named chains for 'lanerelay run --chain <name>'; --chain a,b,c also works inline.
chains:
  default:
    lanes: [claude, codex, gemini]
  free-only:
    lanes: [gemini]

defaults:
  paidFirst: true        # burn paid lanes before free ones
  maxWaitMinutes: 60     # how long \`lanerelay run\` will wait when every lane is blocked
  defaultResetMinutes: 60
  timeoutMinutes: 0      # per-attempt cap; lanes may override

queue:
  dir: .lanerelay/queue
  pollSeconds: 3

# Notification hooks — shell commands get {{lane}} {{task}} {{status}} {{resetAt}}
# templated plus LR_* env vars; webhooks receive a JSON POST.
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
 * Make `.lanerelay/` ignore itself (a `*` .gitignore inside it), so attempt
 * logs — which contain prompts and agent output — never get committed, even
 * in a repo whose own .gitignore doesn't mention the dir.
 */
export function ensureRuntimeDir(cwd: string): void {
  const dir = join(cwd, '.lanerelay');
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '# lanerelay runtime state (logs contain prompts) — never commit\n*\n');
}

/**
 * Write the starter config into `cwd` (lanerelay.yaml) and make sure
 * `.lanerelay/` is ignored. Never overwrites an existing config.
 */
export function initConfig(cwd: string): InitResult {
  const path = join(cwd, 'lanerelay.yaml');
  if (existsSync(path)) {
    return { configPath: path, created: false };
  }
  writeFileSync(path, STARTER_CONFIG);
  ensureRuntimeDir(cwd);

  const gi = join(cwd, '.gitignore');
  let note: string | undefined;
  if (existsSync(gi)) {
    const content = readFileSync(gi, 'utf8');
    if (!content.split('\n').some((l) => l.trim() === '.lanerelay/')) {
      writeFileSync(gi, content.replace(/\n?$/, '\n') + '\n# lanerelay runtime state\n.lanerelay/\n');
      note = 'added ".lanerelay/" to .gitignore';
    }
  }
  return { configPath: path, created: true, gitignoreNote: note };
}
