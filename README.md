# quota-pilot

`qp` — one task, several AI coding CLIs. When the CLI in front hits its
5-hour window, weekly cap, or a 429, `qp` marks that lane blocked until its
reset time, hands the task (plus a note about what was already done and the
current `git diff`) to the next lane, and keeps working. When the preferred
lane's reset passes, new work goes back to it.

You pay for Claude Code, Codex, Gemini CLI, GLM, OpenCode, Aider, Cursor...
Each has its own quota windows. `qp` is the relay runner that keeps your
task moving while subscriptions roll over.

## Why not the alternatives

| Tool kind | Examples | What they do vs qp |
|---|---|---|
| API proxies / key rotators | claude-code-router, ccNexus, teamclaude, quotaswitch | Intercept API calls, rotate keys/accounts for *one* tool. qp drives the *CLIs themselves*, across vendors, and carries task context forward. |
| Multi-account switchers | claude-swap, claude-wrapper | Swap between accounts of the *same* provider. qp hops between *different* agent CLIs and models. |
| Session movers / TUIs | agenthop, agent-hop, agent--relay, claude-squad | Let you manually migrate or multiplex sessions. qp is automatic: it detects the limit in the output, computes the reset, and retries unattended — including while you sleep (`qp watch`). |
| Quota monitors | quota-monitor, cc-usage | Show usage, notify. qp acts on the limit instead of just reporting it. |

The difference in one line: those tools watch or re-route *credentials*;
qp relays the *work item*, with handoff context, across heterogeneous CLIs.

## 30-second quickstart

```bash
npx quota-pilot init        # writes quota-pilot.yaml with claude/codex/gemini lanes
# edit the lane commands to match your installed CLIs
npx quota-pilot run "fix the failing test in src/parser"
```

That's it. `qp` runs the first lane; if it exits with a usage-limit
message, the task moves on to the next lane with a handoff note.

## How it works

```
qp run "task"
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
- **State** lives in `.qp/state.json` in the repo: which lane is blocked,
  until when, and why. `qp status` shows it; `qp unblock` clears it.
- **Handoff prompt** = your task + "previous agents already worked on this,
  don't redo it" + `git diff --stat` + tails of previous attempts. The next
  agent continues in the same working tree — changes are shared, not copied.
- **Lane order** = cost class (paid first) → observed quota remaining →
  priority. When a CLI prints a usage gauge ("usage: 72%", "12% of your
  weekly quota left"), qp remembers it (24h staleness) and prefers the lane
  least likely to die mid-task. Explicit `--chain` order always wins.
- **Logs** for every attempt land in `.qp/logs/` regardless of `--quiet`.
- **Run records** land in `.qp/runs/<id>.json`, rewritten after every
  attempt. If `qp` is killed mid-task (Ctrl+C, OOM, power), the record is
  marked `interrupted`; `qp run --resume <id>` continues the same task with
  the full attempt history in the handoff. `qp report` and `qp status` show
  what's resumable.
- **Lane leases** live in `.qp/leases/<lane>.json` and make concurrency safe:
  every attempt takes an exclusive per-lane lock (atomic `O_EXCL` create,
  dead pids reclaimed), so `qp watch --jobs 2` and a concurrent `qp run`
  never burn the same subscription for two tasks at once. A run whose lanes
  are all leased polls every few seconds until one frees.

## Commands

| Command | What it does |
|---|---|
| `qp init` | Write a starter `quota-pilot.yaml` (never overwrites). |
| `qp run "task"` | Run the task through lanes; exit 0 done / 2 all-blocked / 3 failed / 4 wait-timeout. |
| `qp run --chain a,b,c "task"` | Force a lane order, or a named chain from config. |
| `qp run --resume <id>` | Continue an interrupted/failed/blocked run (ids in `qp report`). The next lane gets the full attempt history as handoff. |
| `qp run --no-wait "task"` | Exit 2 instead of sleeping when every lane is blocked. |
| `qp run --diff none\|stat\|full` | Control how much working-tree state goes into the handoff prompt (default `stat`; `full` embeds the bounded `git diff` patch). |
| `qp status` | `available` / `blocked until HH:MM (Nm)` / `unknown` per lane, `[leased by <run>]` when a parallel run holds it, plus unfinished/resumable runs (`--json`). |
| `qp top` | Live dashboard: per-lane blocked countdowns, quota gauges, running tasks on their lanes, queue depth, resumable runs. `--interval <s>`, `--once` / piped = single frame, `q` quits. |
| `qp probe <lane>` / `qp probe --all` | Send a tiny prompt to a lane and classify it: `available`, `limited` (learns the real reset time into state), `auth-error` (bad key/plan — blocked 24h so the watcher won't spin), `error`, `timeout`. Costs a little quota; exit 2 when any lane is limited/auth-error. `--prompt`, `--timeout <s>`, `--json`. |
| `qp report` | Run history: per-lane attempt stats (done/limited/failed/timeout), queue outcomes, resumable runs, recent runs (`--json`). `qp report --lane <name>` drills into one lane: every recorded attempt with evidence and log refs. |
| `qp add "task"` | Enqueue a task for the watcher. |
| `qp queue` | List pending / running / done / failed items (with the run record id). |
| `qp watch` | Daemon: drain the queue (`--once` exits when empty, `--poll N`). `--jobs N` runs up to N tasks at once, each on a *different* lane (per-lane leases in `.qp/leases/`); `queue.jobs` in config does the same. A task that finds every lane blocked is **deferred**, not failed: it goes back to pending until the earliest lane reset (`queue.maxDefers`, default 10). Outputs interleave — use `-q` and `qp log`. |
| `qp log [selector]` | Tail a lane attempt log from `.qp/logs` (last 200 lines). Selector: run id prefix (`qp log r-abc1`), queue item id, lane name (`qp log claude`), or filename fragment; no selector = newest log. `--lines/-n` (0 = whole file), `--follow/-f` (live tail), `--list` (recent files). |
| `qp prune [--days N]` | Delete run records older than N days (default 30). |
| `qp unblock [lane]` | Clear a lane's blocked state manually. |

## Configuration (`quota-pilot.yaml`)

```yaml
lanes:
  - name: claude                 # referenced by --chain and `qp status`
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
  stateFile: .qp/state.json
  logsDir: .qp/logs
  runsDir: .qp/runs              # run history records for --resume/report

queue:
  dir: .qp/queue
  pollSeconds: 3
  jobs: 1                       # parallel tasks for `qp watch` (`--jobs` overrides)
  maxDefers: 10                 # times a task may wait for a lane reset; 0 = forever

handoff:
  diff: stat                    # none|stat|full — working-tree info in handoff prompts
  diffMaxBytes: 8192            # patch cap when diff: full
hooks:
  limit:                         # fired when a lane hits its cap
    - command: 'notify-send "{{lane}} limited until {{resetAt}}"'
    - webhook: 'https://hooks.example.com/qp'    # JSON POST
  handoff: []                    # task moved to another lane
  finish: []                     # a lane completed the task
  fail: []                       # a lane failed without a limit
```

Command hooks get `{{lane}} {{task}} {{status}} {{resetAt}}` templated and the
same values as `QP_*` env vars. Webhooks receive `{"event","lane","task","status","resetAt","ts"}`.

Lane command templates substitute `{{prompt}}` inline under `sh -c` on POSIX;
on Windows they run via `cmd /c` and the prompt arrives in `%QP_PROMPT%`
(cmd quoting is too fragile for inline substitution). `QP_PROMPT` is also
exported on POSIX, so wrapper scripts can read it instead of the argv slot.

## Limits (the honest list)

- Detection is output-parsing. CLIs that change their limit wording silently
  become `failed`, not `limited` — add a `patterns.limited` regex per lane to
  adapt. If no reset time parses, `defaultResetMinutes` applies.
- One watcher per repo (enforced by `.qp/watch.lock`). The queue is serial
  unless `--jobs N` / `queue.jobs` > 1 — then tasks run in parallel but
  never two on the same lane (leases).
- Handoff is text, not session state: the next agent gets the task, the diff
  summary, and output tails — not the previous agent's conversation memory.
- `kind: custom` only gets the generic patterns (429 / rate limit / quota);
  add explicit patterns for anything exotic.
- Waiting for a reset can exceed `maxWaitMinutes` only when `--no-wait` is
  off; the default cap is 60 minutes.
- Resume is task-text-locked: `qp run --resume <id>` continues the *recorded*
  task (pass a different task text and it's refused). A finished or
  already-resumed run can't be resumed again.
- Usage gauges are only honored when a lane prints one. Readings older than
  24h are ignored (windows reset), and `qp unblock` clears the gauge too.

## Development

```bash
npm ci
npm test          # vitest — pattern library + orchestration + queue
npm run build     # tsc → dist/
test/smoke.sh     # end-to-end: fake lanes, resume, deferrals, watch, report
```

### Standalone binary (no Node at runtime)

```bash
scripts/compile.sh            # linux-x64 → dist/bin/qp-linux-x64
scripts/compile.sh all        # linux/darwin x64+arm64, windows-x64
```

Built with `bun build --compile` (falls back to `npx bun` when bun isn't on
PATH). The binary is self-contained (~90 MB) — every `qp` command works
without Node installed.

MIT licensed. Issues and PRs welcome — new lane patterns for tools we
haven't seen are especially useful.
