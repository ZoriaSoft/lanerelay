# lanerelay

Run one coding task through a chain of AI agent CLIs — Claude Code, Codex,
Gemini CLI, opencode, Aider, Cursor, GLM, or anything you can call from a
shell. When the CLI in front hits its usage limit (5-hour window, weekly cap,
429), lanerelay marks that lane blocked until its reset time and hands the
task to the next lane with a short handoff note: what was tried, how it
ended, and what changed in the working tree. When the preferred lane resets,
new work goes back to it.

It is a small, local, dependency-light Node CLI. It does not proxy API
traffic, store credentials or switch accounts — it only runs the CLIs you
already have and reads what they print.

```
lanerelay run "fix the failing test in src/parser"
  claude    → "You've hit your weekly limit · resets 3am (UTC)"  → blocked until 03:00 UTC
  codex     → "You’ve hit your usage limit … try again at 6:41 AM" → blocked until 06:41
  opencode  → done
```

(That is a real run from the validation notes below, trimmed.)

## Quickstart

Needs Node 20+ and at least one agent CLI that is already logged in.

```bash
npm install -g lanerelay        # installs `lanerelay` and the short alias `lr`
cd your-repo
lanerelay init                  # writes lanerelay.yaml (claude/codex/gemini lanes)
lanerelay doctor                # checks the config and that each lane's CLI is on PATH
lanerelay run "fix the failing test in src/parser"
lanerelay status                # which lanes are blocked, until when, and why
```

Edit the lane commands in `lanerelay.yaml` to match the CLIs you actually
have; delete lanes you don't use. `npx lanerelay …` works too without a
global install.

A lane is a shell command with a `{{prompt}}` slot. Headless forms that work
with current CLI versions:

```yaml
lanes:
  - name: claude
    kind: claude
    command: "claude -p {{prompt}} --permission-mode acceptEdits"
  - name: codex
    kind: codex
    command: "codex exec --sandbox workspace-write {{prompt}}"
  - name: opencode
    kind: opencode
    cost: free
    command: "opencode run {{prompt}}"
```

lanerelay never gives a lane your terminal's stdin, so headless CLIs that
would otherwise wait for piped input (`claude -p`, `codex exec`,
`opencode run`) start immediately.

## How it differs

There are good tools in this space; pick the one whose model fits you.

| Tool | What it does | When to pick it instead |
|---|---|---|
| [claudexor](https://github.com/razzant/claudexor) | Full control plane (daemon, macOS app, MCP) for Claude Code, Codex, Cursor, OpenCode: multi-account quota rotation, shared thread context, best-of-N races with cross-model review. | You want an orchestration platform with account pools and review, and can run its daemon (Node 24+). |
| [caam](https://github.com/Dicklesworthstone/coding_agent_account_manager) | Swaps saved OAuth credentials between accounts of the same CLI in milliseconds; `caam run` retries a command on another account after a rate limit. | You have several subscriptions for the *same* CLI and want to rotate accounts. |
| [agentswap](https://github.com/bojieli/agentswap) | Local proxy that fails Claude Code / Codex over across subscriptions, API keys and providers, waits through resets, and translates whole sessions between harnesses. | You want transparent failover under the CLI and full session transfer. |
| Claude Code `--fallback-model` | Built-in: switches to another *Claude* model when the default one is overloaded or unavailable. | You only use Claude Code and the problem is overload, not your quota. |
| **lanerelay** | Runs *different* agent CLIs one after another on the same working tree; detects limits from their output, remembers reset times per lane, hands the task over with a text note; queue + watcher for unattended runs. | You pay for several different CLIs and want one task to keep moving across them, with no proxy, daemon or credential handling. |

What lanerelay does **not** do: rotate accounts of one CLI, proxy or
inspect API traffic, transfer a CLI's native session/conversation, or run
several agents on one task at once.

## How it works

```
lanerelay run "task"
   │
   ├─ lane 1 (e.g. claude)  ── exit 0 → done
   │                          └ limit detected → mark blocked until reset,
   │                            build handoff prompt, go next
   ├─ lane 2 (e.g. codex)   ── exit 0 → done
   │                          └ limit → block, hand off again
   └─ all lanes blocked?    ── --wait (default): sleep until the earliest
                               reset, then retry that lane (it returns to
                               preferred order automatically)
                            ── --no-wait: exit code 2
```

- **Detection** is a per-CLI pattern library (`src/patterns.ts`) that scans the
  tail of the child's combined output for cap/429/RESOURCE_EXHAUSTED-style
  messages, plus lane-specific formats (`usage limit reached|<epoch>`,
  `retryDelay:"45s"`, `resets at 12pm`, `resets 9:10pm (Europe/Kiev)`,
  `try again in 40 minutes`, `try again at Jul 19th, 2026 10:27 AM`,
  `Please retry in 34.07s`, weekday and month-day dates, compact durations
  (`143h26m`), ISO timestamps, bare epochs). Transient errors
  (`overloaded_error`, 5xx, retried 429s, model-capacity fallbacks, user
  budget/concurrency caps) are explicitly not limits. Suppression is
  line-scoped: a recovery marker on a *later* line cancels the block, while
  qualifiers *before* the cap on the same line ("Approaching weekly limit",
  "Budget limit reached") don't trigger it.
- **State** lives in `.lanerelay/state.json` in the repo: which lane is blocked,
  until when, and why. `lanerelay status` shows it; `lanerelay unblock` clears it.
- **Handoff prompt** = your task + "another agent already worked on this,
  don't redo finished work" + `git diff --stat` (lanerelay's own
  `.lanerelay/` files left out) + the last lines of each earlier attempt,
  with ANSI codes and any echo of an earlier handoff prompt stripped. The
  next agent continues in the same working tree — changes are shared, not
  copied.
- **Lane order** = cost class (paid first) → observed quota remaining →
  priority. When a CLI prints usage gauges ("usage: 72%", "12% of your
  weekly quota left"), lanerelay tracks each quota window separately
  (session/daily/weekly/monthly) and orders on the *poorest* fresh
  reading — a lane at "session 90%" is still skipped when its weekly cap
  sits at 3%. Readings expire on their window's own TTL (session 8h,
  daily 36h, weekly 9d, monthly 35d, unlabeled 24h). Explicit `--chain`
  order always wins.
- **Logs** for every attempt land in `.lanerelay/logs/` regardless of `--quiet`.
- **Run records** land in `.lanerelay/runs/<id>.json`, rewritten after every
  attempt. If `lanerelay` is killed mid-task (Ctrl+C, OOM, power), the record is
  marked `interrupted`; `lanerelay run --resume <id>` continues the same task with
  the full attempt history in the handoff. `lanerelay report` and `lanerelay status` show
  what's resumable.
- **Lane leases** live in `.lanerelay/leases/<lane>.json` and make concurrency safe:
  every attempt takes an exclusive per-lane lock (atomic `O_EXCL` create,
  dead pids reclaimed), so `lanerelay watch --jobs 2` and a concurrent `lanerelay run`
  never burn the same subscription for two tasks at once. A run whose lanes
  are all leased polls every few seconds until one frees.

## Commands

| Command | What it does |
|---|---|
| `lanerelay init` | Write a starter `lanerelay.yaml` (never overwrites). |
| `lanerelay run "task"` | Run the task through lanes; exit 0 done / 2 all-blocked / 3 failed / 4 wait-timeout. |
| `lanerelay run --chain a,b,c "task"` | Force a lane order, or a named chain from config. |
| `lanerelay run --resume <id>` | Continue an interrupted/failed/blocked run (ids in `lanerelay report`). The next lane gets the full attempt history as handoff. |
| `lanerelay run --no-wait "task"` | Exit 2 instead of sleeping when every lane is blocked. |
| `lanerelay run --diff none\|stat\|full` | Control how much working-tree state goes into the handoff prompt (default `stat`; `full` embeds the bounded `git diff` patch). |
| `lanerelay status` | `available` / `blocked until HH:MM (Nm)` / `unknown` per lane, `[leased by <run>]` when a parallel run holds it, plus unfinished/resumable runs (`--json`). |
| `lanerelay top` | Live dashboard: per-lane blocked countdowns, quota gauges, running tasks on their lanes, queue depth, resumable runs. `--interval <s>`, `--once` / piped = single frame, `q` quits. |
| `lanerelay probe <lane>` / `lanerelay probe --all` | Send a tiny prompt to a lane and classify it: `available`, `limited` (learns the real reset time into state), `auth-error` (bad key/plan — blocked 24h so the watcher won't spin), `error`, `timeout`. Costs a little quota; exit 2 when any lane is limited/auth-error. `--prompt`, `--timeout <s>`, `--json`. |
| `lanerelay report` | Run history: per-lane attempt stats (done/limited/failed/timeout), queue outcomes, resumable runs, recent runs (`--json`, `--jsonl` streams one record per line). `lanerelay report --lane <name>` drills into one lane: every recorded attempt with evidence and log refs. |
| `lanerelay add "task"` | Enqueue a task for the watcher. `lanerelay add --file tasks.txt` (or `-` for stdin) enqueues one task per line — blank lines and `#` comments are skipped. |
| `lanerelay queue` | List pending / running / done / failed items (with the run record id). |
| `lanerelay watch` | Daemon: drain the queue (`--once` exits when empty, `--poll N`). `--jobs N` runs up to N tasks at once, each on a *different* lane (per-lane leases in `.lanerelay/leases/`); `queue.jobs` in config does the same. A task that finds every lane blocked is **deferred**, not failed: it goes back to pending until the earliest lane reset (`queue.maxDefers`, default 10). Outputs interleave — use `-q` and `lanerelay log`. |
| `lanerelay log [selector]` | Tail a lane attempt log from `.lanerelay/logs` (last 200 lines). Selector: run id prefix (`lanerelay log r-abc1`), queue item id, lane name (`lanerelay log claude`), or filename fragment; no selector = newest log. `--lines/-n` (0 = whole file), `--follow/-f` (live tail), `--list` (recent files). |
| `lanerelay prune [--days N]` | Delete run records older than N days (default 30). |
| `lanerelay unblock [lane]` | Clear a lane's blocked state manually. |
| `lanerelay doctor` | Preflight: config parses, every lane's executable resolves (PATH or disk), `{{prompt}}` slot present, `.lanerelay` dirs writable, state file valid, watcher lock and lane leases not stale. `--json`; exit 1 on any FAIL. |

## Configuration (`lanerelay.yaml`)

```yaml
lanes:
  - name: claude                 # referenced by --chain and `lanerelay status`
    kind: claude                 # pattern set: claude|codex|gemini|glm|aider|opencode|cursor|custom
    command: "claude -p {{prompt}} --permission-mode acceptEdits"
    model: claude-sonnet-4.5     # display metadata
    cost: paid                   # paid|free — paid lanes go first by default
    priority: 0                  # lower runs earlier within a cost class
    timeoutMinutes: 45           # per-attempt cap; 0 = none
    defaultResetMinutes: 300     # block this long if no reset time is detected
    patterns:                    # extend/override detection (regex strings)
      limited: ["my custom limit msg"]
      notLimit: ["recovered ok"]
      reset: ["back at ([^.\\n]+)"]
      usage: ["(\\d+)% left"]        # capture is REMAINING %
      usageUsed: ["(\\d+)% used"]    # capture is USED % (left = 100 − used)

chains:
  default: { lanes: [claude, codex, gemini] }

defaults:
  paidFirst: true
  maxWaitMinutes: 60             # cap on sleeping for a free lane
  stateFile: .lanerelay/state.json
  logsDir: .lanerelay/logs
  runsDir: .lanerelay/runs              # run history records for --resume/report

queue:
  dir: .lanerelay/queue
  pollSeconds: 3
  jobs: 1                       # parallel tasks for `lanerelay watch` (`--jobs` overrides)
  maxDefers: 10                 # times a task may wait for a lane reset; 0 = forever

handoff:
  diff: stat                    # none|stat|full — working-tree info in handoff prompts
  diffMaxBytes: 8192            # patch cap when diff: full
hooks:
  limit:                         # fired when a lane hits its cap
    - command: 'notify-send "{{lane}} limited until {{resetAt}}"'
    - webhook: 'https://hooks.example.com/lanerelay'    # JSON POST
  handoff: []                    # task moved to another lane
  finish: []                     # a lane completed the task
  fail: []                       # a lane failed without a limit
```

Command hooks run under `sh -c`. `{{lane}} {{task}} {{status}} {{resetAt}}`
become shell expansions of the matching `LR_*` env vars (`{{task}}` →
`${LR_TASK:-}`), so a task text can never inject shell code; put them inside
double quotes as in the example. Webhooks receive
`{"event","lane","task","status","resetAt","ts"}`.

Lane command templates substitute `{{prompt}}` inline under `sh -c` on POSIX;
on Windows they run via `cmd /c` and the prompt arrives in `%LR_PROMPT%`
(cmd quoting is too fragile for inline substitution). `LR_PROMPT` is also
exported on POSIX, so wrapper scripts can read it instead of the argv slot.

## Limits (the honest list)

- **Detection is output parsing.** Only the last 60 non-empty lines a lane
  prints are scanned, and only for phrases that read as a verdict ("hit
  your usage limit", "rate limit exceeded", "HTTP 429", …) — an agent that
  merely talks about rate limiting, or a stack trace with `:429:`, is not a
  limit. Auth and login errors ("Not logged in", "401 Unauthorized") are
  never treated as limits: the lane fails and the next one runs. When a CLI
  changes its wording, a limit shows up as `failed` instead of `limited`;
  add a `patterns.limited` regex for that lane. The built-in patterns were
  checked against real output of Claude Code 2.1, Codex CLI 0.163 and
  opencode 1.18 (see `test/fixtures/real/`); Gemini CLI, Aider, Cursor and
  GLM patterns come from their source code and docs, not live runs.
- **Reset times.** A reset with a zone ("resets 3am (UTC)", "9:10pm
  (Europe/Kyiv)") is read in that zone. A bare clock time ("try again at
  6:41 AM") is read in your machine's local zone — if a CLI prints it in
  another zone the block can be off by your UTC offset. If no reset
  parses, `defaultResetMinutes` (default 60) applies; `lanerelay unblock`
  clears a block early.
- **Handoff is text, not session state.** The next agent gets the task, a
  `git diff --stat` (or the bounded patch with `--diff full`) and the last
  ~30 lines of each earlier attempt — not the previous agent's
  conversation. It works in the same tree, so file changes carry over.
- **A failing lane is tried once per run.** A lane that exits non-zero
  without a limit, or times out, is skipped for the rest of that run (the
  next lane gets the error in its handoff). Blocked lanes come back after
  their reset when `--no-wait` is off; waiting is capped by
  `maxWaitMinutes` (default 60).
- **Cancel.** Ctrl-C (SIGINT/SIGTERM/SIGHUP) stops the running lane's whole
  process group — SIGTERM, then SIGKILL after 3 s — and marks the run
  `interrupted`; `lanerelay run --resume <id>` continues it. A second
  Ctrl-C skips the grace period. On Windows the tree is killed with
  `taskkill /T /F`.
- **Concurrency.** Lane state writes are read-modify-write under a lock
  file, so two `lanerelay` processes in one repo don't lose each other's
  blocks; per-lane leases stop two runs from using the same lane at once.
  One `lanerelay watch` per repo.
- `kind: custom` gets only the generic patterns.
- Resume is tied to the recorded task text; a finished or already-resumed
  run can't be resumed again.
- Usage gauges are only used when a lane prints one, and each reading
  expires with its window (session 8h, daily 36h, weekly 9d, monthly 35d,
  unlabeled 24h).
- POSIX shells are the tested path. Windows support (`cmd /c`, prompt in
  `%LR_PROMPT%`) is covered by unit tests only.

## Real-CLI validation

Checked on Linux with Claude Code 2.1.302, Codex CLI 0.163.0 and opencode
1.18.14, using a scratch git repo and a "reply with OK" task:

- claude and codex were both out of quota: each was detected as `limited`
  with the right reset, blocked, and the task moved on; opencode (free
  model) finished it. `lanerelay status` showed both blocks with reasons.
- Logged-out claude, logged-out codex (401), an unknown model on both, and
  a broken opencode config were all classified as errors, not limits.
- Ctrl-C during a lane left no lane process behind.

The captured outputs (sanitized) are test fixtures in
`test/fixtures/real/`.

## Development

```bash
npm ci
npm test          # vitest — patterns, real-CLI fixtures, orchestration, cancel, locking
npm run build     # tsc → dist/
npm run smoke     # end-to-end with fake lanes: resume, deferrals, watch, report (needs dist/)
```

### Standalone binary (no Node at runtime)

```bash
scripts/compile.sh            # linux-x64 → dist/bin/lanerelay-linux-x64
scripts/compile.sh all        # linux/darwin x64+arm64, windows-x64
```

Built with `bun build --compile` (falls back to `npx bun` when bun isn't on
PATH). The binary is self-contained (~90 MB) — every `lanerelay` command works
without Node installed.

MIT licensed. Issues and PRs welcome — real limit/error output from CLI
versions not covered in `test/fixtures/real/` is the most useful thing you
can send (strip ids and paths first).
