# CHANGELOG

## 0.6.0 — 2026-10-18 (round 6)

### Added

- **`qp top`** — live dashboard on the alternate screen: per-lane status
  with second-precision blocked countdowns, cost class, quota gauges and
  lease owners; running tasks on their leased lanes; queue depth plus the
  next pending items; resumable runs as copy-paste commands; watcher pid.
  Raw ANSI, no new dependencies. `--interval <s>` (default 1), `q`/Ctrl-C
  quits, `--once` or any non-TTY stdout draws a single frame.

### Fixed

- `test/smoke.sh` printed its final line twice (duplicate `printf`).

## 0.5.0 — 2026-10-18 (round 5)

### Added

- **Parallel watch.** `qp watch --jobs N` (or `queue.jobs` in config) drains
  the queue with N workers. Per-lane leases (`.qp/leases/<lane>.json`,
  atomic `O_EXCL` create, dead-pid reclaim, fresh-corrupt files treated as
  held) guarantee two tasks never burn the same lane at once — across
  workers *and* separate `qp` processes, so a manual `qp run` respects a
  watcher's lane. A run whose lanes are all leased polls at 5s instead of
  waiting for a quota reset that doesn't exist. `qp status` shows
  `[leased by <run>]`, `defaults.leasesDir` relocates the directory.
- **`handoff.diff` / `qp run --diff none|stat|full`.** `full` embeds a
  bounded `git diff HEAD` patch (`handoff.diffMaxBytes`, default 8192) in
  the handoff so the next agent sees the actual edits; `none` sends no
  working-tree state. Handoff prompt cap raised 16→32 KiB.
- **Windows lanes.** Command templates spawn via `cmd /d /s /c` on win32;
  `{{prompt}}` becomes `%QP_PROMPT%` (cmd mangles long quoted text and
  caps a line near 8 KiB). `QP_PROMPT` is exported on POSIX too — wrapper
  scripts can read it instead of the argv slot. Timeouts kill the process
  tree via `taskkill /T /F`.
- `queue.jobs` config + validation.

### Fixed

- `qp watch --once` processed a single item then exited; it now drains the
  whole queue, matching its help text.
- `.qp/state.json` was read once at startup: a `qp run` started after a
  watcher learned a block would retry the dead lane anyway. The store now
  reloads when the file's mtime changes (best-effort last-writer-wins).

## 0.4.0 — 2026-10-18 (round 4)

### Added

- **Usage-aware lane ordering.** When a lane prints a quota gauge in its
  output ("usage: 72%", "12% of your weekly quota left", "used 40% of the
  window"), qp records the freshest reading in `.qp/state.json` and, for
  default (non-`--chain`) ordering, sorts free lanes inside a cost class by
  remaining quota — the lane least likely to die mid-task now wins over a
  lower `priority` one that is nearly dry. Explicit `--chain` order always
  wins. New `patterns.usage` / `patterns.usageUsed` config lists capture
  remaining/used percentages for exotic formats; generic patterns cover
  "N% left", "N% remaining", "usage: N%", "used N% of …" shapes. Readings
  go stale after 24h; `qp unblock` clears them.
- `qp status` shows the last gauge per lane (`(42% quota)`); `qp probe`
  records gauges too and reports them (`quotaLeft` in `--json`, suffix in
  the console line).
- `qp prune [--days N]` (default 30) deletes aged `.qp/runs/*.json` records;
  live runs are never touched.

### Fixed

- `patterns.*` config strings are now validated as regexes at load time —
  an invalid pattern fails fast with the lane name instead of crashing on
  the first lane attempt.

## 0.3.0 — 2026-10-18 (round 3)

### Added

- **Run records** (`.qp/runs/<id>.json`): every `qp run` / `qp watch` task
  writes a record after each lane attempt — task, chain, pid, attempts with
  output tails and reset times, final status. Killed mid-task (SIGINT,
  SIGTERM, crash) the record surfaces as `interrupted`.
- **`qp run --resume <id>`** continues an interrupted/failed/all-blocked
  run: same recorded task (a different task text is refused), prior
  attempts seeded into the handoff prompt so the next lane sees the full
  history. Superseded records are marked `resumed` and can't be resumed
  twice; live runs (pid check) and `done` runs are refused too.
- **`qp report`** — aggregates records: per-lane attempt stats
  (done/limited/failed/timeout + last attempt time), queue outcomes,
  resumable runs as copy-paste commands, recent runs (`--json`).
- `qp status` now lists unfinished/resumable runs; `--json` gains an
  `unfinishedRuns` field. `qp queue` items carry the `runId` of their run
  record.
- `defaults.runsDir` config option (default `.qp/runs`).
- `test/smoke.sh` — end-to-end shell smoke: handoff, failed-run resume,
  SIGINT → interrupted → resume, watch/queue/report assertions.

### Fixed

- A `qp run` killed by SIGINT/SIGTERM previously left no trace: Node does
  not fire `exit` under a signal's default disposition, so records now hook
  the signals directly and exit with the conventional code.

## 0.2.0 — 2026-10-18 (round 2)

### Added

- `qp probe <lane>` / `qp probe --all` — sends a tiny prompt to a lane and
  classifies it `available` / `limited` / `auth-error` / `error` /
  `timeout`. Learned reset times and auth blocks are written to
  `.qp/state.json` so `qp status` reflects reality immediately.
  `--prompt`, `--timeout <s>`, `--json`; exit 2 when any lane is limited
  or auth-error.
- Detection fidelity pass calibrated on upstream sources: codex
  `UsageLimitReachedError` strings (Plus/Pro upsells, per-model limits,
  workspace credits, spend caps, `Jul 19th, 2026 10:27 AM` resets),
  claude headless banners (`You've hit your limit · resets 9:10pm (TZ)`,
  `You've hit your session limit`), gemini `TerminalQuotaError`
  (`exhausted your daily quota`, `MODEL_CAPACITY_EXHAUSTED`,
  `Please retry in 34.07s`).

### Fixed

- `notLimit` suppression was position-only: a qualifier on the same line
  *before* the cap ("Approaching weekly limit — resets Friday") fired a
  false limit, and "Please retry in Ns" embedded in a one-line 429 JSON
  after the cap fired a false recovery. Suppression is now line-scoped.
- `parseResetTime` missed compact composites and sub-second units:
  `143h26m` parsed as 26m, `34.07s` and `900ms` not at all.
- `runLane` hung forever when a killed lane's grandchildren held stdio
  open (e.g. `sh -c 'sleep 60'`): finish now resolves on `exit` after a
  short grace period, and timeouts try a process-group kill first.

## 0.1.0 — 2026-10-18 (round 1)

Initial implementation.

### Added

- `qp run "<task>"` — runs the task through configured lanes; detects
  quota/rate-limit exits from output + exit codes, marks the lane blocked
  until its reset time, and hands the task (with a handoff note: prior
  attempts, `git diff --stat`, output tails) to the next free lane.
- `qp run --chain a,b,c` / named `chains:` in config; lane ordering by
  cost class (`paidFirst`) then `priority`.
- Pattern library for claude, codex, gemini, glm, aider, opencode, cursor
  (+ generic fallback for `custom`): cap messages, 429/RESOURCE_EXHAUSTED,
  reset-time parsing for durations, clock times, weekday/month-day dates,
  ISO timestamps and pipe-delimited epochs; transient/recovery suppression.
- `.qp/state.json` per-repo lane block store (atomic writes);
  `qp status [--json]`, `qp unblock [lane]`.
- `qp add`/`qp queue`/`qp watch` file-based queue + single-watcher daemon
  (lockfile, atomic claim, `--once`, `--poll`).
- Hooks on limit/handoff/finish/fail: templated shell commands and JSON
  webhooks (`hooks:` in config, `QP_*` env vars).
- `qp init` writes a starter `quota-pilot.yaml` and gitignores `.qp/`.
- Per-attempt logs in `.qp/logs/`; `--quiet` for clean terminals.
- Config: YAML with validation (duplicate names, missing `{{prompt}}`,
  unknown kinds), `defaults:` for reset/wait/timeout/state paths.

### Notes

- Name under review: `quota-pilot` collides with an existing OpenClaw
  plugin; `pinchhitter` proposed (see ROADMAP.md).
