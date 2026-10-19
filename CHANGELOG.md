# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- `{{prompt}}` is quoted for the shell context it sits in. Templates that
  quoted the slot themselves (`"{{prompt}}"`, `'{{prompt}}'`) let `$(...)`
  and backticks in the task text or an earlier lane's output run as shell
  code.
- `run --resume` rejects run ids with path syntax.

### Docs

- Quickstart installs from source; the package is not on npm yet, so
  `npm install -g lanerelay` / `npx lanerelay` did not work.
- Documented the Windows `%LR_PROMPT%` quoting caveat. Added `SECURITY.md`
  and `CONTRIBUTING.md`.

## [0.9.0] - 2026-10-19

Renamed to **lanerelay** (was `quota-pilot`). Bins: `lanerelay` and `lr`.
Config file `lanerelay.yaml`, runtime dir `.lanerelay/`, env vars `LR_*`
(`LR_PROMPT`, `LR_CONFIG`, hook `LR_LANE`/`LR_TASK`/…).

### Fixed (found by running real CLIs)

- Lane children inherited lanerelay's stdin: `claude -p` waited 3 s for
  piped input on every attempt and `opencode run` hung until its timeout.
  Lanes now get no stdin.
- Ctrl-C left the running agent CLI alive (lanes run in their own process
  group, so the terminal's SIGINT never reached them). SIGINT/SIGTERM/SIGHUP
  now stop every running lane group (SIGTERM, SIGKILL after 3 s), and the run
  record stays `interrupted` instead of being overwritten as `failed`.
- A lane that failed or timed out was retried on every pass of the chain while the other
  lanes waited for their reset. It is now tried once per run.
- Handoff prompts nested: Codex echoes its prompt, so each handoff carried
  the previous one. Tails now drop echoed prompts and ANSI codes and keep
  the last 30 lines; `.lanerelay/` files are left out of the diff summary;
  the note no longer claims every earlier attempt hit a usage limit.
- Reset times with a zone ("resets 3am (UTC)", "(Europe/Kiev)") were read
  in the machine's zone.
- Starter config used `codex exec --full-auto`, which Codex CLI 0.163
  rejects; now `codex exec --sandbox workspace-write`.
- `Promise.withResolvers` (Node 22+) was used despite `engines: >=20`;
  typecheck now targets ES2023.

### Changed

- Limit detection scans only the last 60 non-empty output lines; bare
  `429` and topic mentions of "rate limit(ing)" no longer count; an auth or
  login error on or after the cap line means "not a limit". Failed lanes
  with auth evidence report `auth error (exit N): …`.
- `.lanerelay/state.json` writes are read-modify-write under a lock file;
  concurrent runs no longer drop each other's lane updates.
- Hook commands: `{{var}}` now expands to `${LR_VAR:-}` instead of pasting
  the value, so task text can't inject shell code.
- `lanerelay status`: dates for resets that aren't today, `21h28m`-style
  countdowns, `(last attempt: failed|timeout)` hints.
- `--version` reads package.json; `watch.lock` is created with O_EXCL.

### Tests

- Real CLI output fixtures (`test/fixtures/real/`) for limit, auth and
  generic-error cases; false-positive tests; cancel (process group, CLI
  SIGINT end-to-end); concurrent state writers; hook injection; handoff
  tails. The suite pins `TZ=UTC`.

## [0.8.0] - 2026-10-18

### Added

- **`lanerelay doctor`** — preflight for a repo: does `lanerelay.yaml` parse,
  does every lane's first executable resolve (PATH, PATHEXT on Windows, or
  a file path), does the command carry the `{{prompt}}` slot, are the
  `.lanerelay` dirs writable, is `state.json` valid JSON, is the watcher lock or
  any lane lease held by a dead pid. `ok`/`warn`/`FAIL` lines or `--json`;
  exits 1 when any check FAILs.
- **Per-window quota gauges.** Lanes that print more than one gauge (e.g.
  Claude's session + weekly statusline) no longer collapse to "last one
  wins". `detectUsage` returns one reading per window — inferred from
  keywords on the gauge line (weekly/monthly/daily/session) or pinned by
  a `(?<window>…)` named group in a lane's `usage`/`usageUsed` patterns.
  `.lanerelay/state.json` keeps the freshest reading per window (legacy
  single-reading files migrate to `other`), lane ordering picks the
  *poorest* fresh window, and each window expires on its own TTL
  (session 8h, daily 36h, weekly 9d, monthly 35d, unlabeled 24h) instead
  of a flat 24h. `lanerelay status`/`lanerelay top` render `(session 90% · weekly 12%
  quota)`; `lanerelay probe` still reports the effective (minimum) `quotaLeft`.
- **`lanerelay report --jsonl`** — streams one run record per line for piping
  into `jq`/`duckdb`; `--json` still emits the aggregated report.
- **`lanerelay add --file <path>`** — enqueues one task per line (`-` reads
  stdin; blank lines and `#` comments skipped). Bare `lanerelay add` now exits 1
  with a hint instead of queueing an empty task.

### Fixed

- `package.json` version now tracks the CLI version (0.8.0).

## [0.7.0] - 2026-10-18

### Added

- **Queue deferral.** A `lanerelay watch` task that found every lane blocked or
  timed out waiting used to land in `failed/` — an overnight queue
  self-destructed on a shared 5-hour reset. Items now defer back to
  `pending/` with a `notBefore` (earliest known lane reset, 60s fallback)
  and keep their FIFO slot; `queue.maxDefers` (default 10, 0 = forever)
  caps repeats before the item really fails. `lanerelay queue` marks deferred
  items `[deferred until HH:MM xN — reason]`, `lanerelay top` shows `[wake …]`,
  and `watch --once` reports deferred leftovers instead of exiting quietly.
- **`lanerelay log [selector]`** — tails `.lanerelay/logs/` attempt files: no selector
  picks the newest log; a run-id prefix resolves through the run record's
  attempt refs, a queue-item id through its `runId`, an exact lane name
  picks that lane's newest log, anything else matches filenames.
  `-n/--lines` (0 = whole file), `-f/--follow` live-tails, `--list` shows
  recent files.
- **`lanerelay report --lane <name>`** — per-lane drill-down: aggregate stats plus
  every recorded attempt (newest first) with duration, evidence and the
  log file ref. `--json` for the full list; exit 1 when the lane has no
  attempts.
- **Standalone binaries** — `scripts/compile.sh [targets…]` (or
  `npm run compile`) bundles lanerelay into self-contained `dist/bin/lanerelay-*`
  executables via `bun build --compile` (`npx bun` when bun isn't on PATH).
  Default target linux-x64; `all` also builds darwin x64/arm64 and
  windows-x64. linux-x64 binary verified end-to-end.

### Fixed

- `watch --once` no longer silently abandons deferred items — it prints how
  many are left and when the first wakes.

## [0.6.0] - 2026-10-18

### Added

- **`lanerelay top`** — live dashboard on the alternate screen: per-lane status
  with second-precision blocked countdowns, cost class, quota gauges and
  lease owners; running tasks on their leased lanes; queue depth plus the
  next pending items; resumable runs as copy-paste commands; watcher pid.
  Raw ANSI, no new dependencies. `--interval <s>` (default 1), `q`/Ctrl-C
  quits, `--once` or any non-TTY stdout draws a single frame.

### Fixed

- `test/smoke.sh` printed its final line twice (duplicate `printf`).

## [0.5.0] - 2026-10-18

### Added

- **Parallel watch.** `lanerelay watch --jobs N` (or `queue.jobs` in config) drains
  the queue with N workers. Per-lane leases (`.lanerelay/leases/<lane>.json`,
  atomic `O_EXCL` create, dead-pid reclaim, fresh-corrupt files treated as
  held) guarantee two tasks never burn the same lane at once — across
  workers *and* separate `lanerelay` processes, so a manual `lanerelay run` respects a
  watcher's lane. A run whose lanes are all leased polls at 5s instead of
  waiting for a quota reset that doesn't exist. `lanerelay status` shows
  `[leased by <run>]`, `defaults.leasesDir` relocates the directory.
- **`handoff.diff` / `lanerelay run --diff none|stat|full`.** `full` embeds a
  bounded `git diff HEAD` patch (`handoff.diffMaxBytes`, default 8192) in
  the handoff so the next agent sees the actual edits; `none` sends no
  working-tree state. Handoff prompt cap raised 16→32 KiB.
- **Windows lanes.** Command templates spawn via `cmd /d /s /c` on win32;
  `{{prompt}}` becomes `%LR_PROMPT%` (cmd mangles long quoted text and
  caps a line near 8 KiB). `LR_PROMPT` is exported on POSIX too — wrapper
  scripts can read it instead of the argv slot. Timeouts kill the process
  tree via `taskkill /T /F`.
- `queue.jobs` config + validation.

### Fixed

- `lanerelay watch --once` processed a single item then exited; it now drains the
  whole queue, matching its help text.
- `.lanerelay/state.json` was read once at startup: a `lanerelay run` started after a
  watcher learned a block would retry the dead lane anyway. The store now
  reloads when the file's mtime changes (best-effort last-writer-wins).

## [0.4.0] - 2026-10-18

### Added

- **Usage-aware lane ordering.** When a lane prints a quota gauge in its
  output ("usage: 72%", "12% of your weekly quota left", "used 40% of the
  window"), lanerelay records the freshest reading in `.lanerelay/state.json` and, for
  default (non-`--chain`) ordering, sorts free lanes inside a cost class by
  remaining quota — the lane least likely to die mid-task now wins over a
  lower `priority` one that is nearly dry. Explicit `--chain` order always
  wins. New `patterns.usage` / `patterns.usageUsed` config lists capture
  remaining/used percentages for exotic formats; generic patterns cover
  "N% left", "N% remaining", "usage: N%", "used N% of …" shapes. Readings
  go stale after 24h; `lanerelay unblock` clears them.
- `lanerelay status` shows the last gauge per lane (`(42% quota)`); `lanerelay probe`
  records gauges too and reports them (`quotaLeft` in `--json`, suffix in
  the console line).
- `lanerelay prune [--days N]` (default 30) deletes aged `.lanerelay/runs/*.json` records;
  live runs are never touched.

### Fixed

- `patterns.*` config strings are now validated as regexes at load time —
  an invalid pattern fails fast with the lane name instead of crashing on
  the first lane attempt.

## [0.3.0] - 2026-10-18

### Added

- **Run records** (`.lanerelay/runs/<id>.json`): every `lanerelay run` / `lanerelay watch` task
  writes a record after each lane attempt — task, chain, pid, attempts with
  output tails and reset times, final status. Killed mid-task (SIGINT,
  SIGTERM, crash) the record surfaces as `interrupted`.
- **`lanerelay run --resume <id>`** continues an interrupted/failed/all-blocked
  run: same recorded task (a different task text is refused), prior
  attempts seeded into the handoff prompt so the next lane sees the full
  history. Superseded records are marked `resumed` and can't be resumed
  twice; live runs (pid check) and `done` runs are refused too.
- **`lanerelay report`** — aggregates records: per-lane attempt stats
  (done/limited/failed/timeout + last attempt time), queue outcomes,
  resumable runs as copy-paste commands, recent runs (`--json`).
- `lanerelay status` now lists unfinished/resumable runs; `--json` gains an
  `unfinishedRuns` field. `lanerelay queue` items carry the `runId` of their run
  record.
- `defaults.runsDir` config option (default `.lanerelay/runs`).
- `test/smoke.sh` — end-to-end shell smoke: handoff, failed-run resume,
  SIGINT → interrupted → resume, watch/queue/report assertions.

### Fixed

- A `lanerelay run` killed by SIGINT/SIGTERM previously left no trace: Node does
  not fire `exit` under a signal's default disposition, so records now hook
  the signals directly and exit with the conventional code.

## [0.2.0] - 2026-10-18

### Added

- `lanerelay probe <lane>` / `lanerelay probe --all` — sends a tiny prompt to a lane and
  classifies it `available` / `limited` / `auth-error` / `error` /
  `timeout`. Learned reset times and auth blocks are written to
  `.lanerelay/state.json` so `lanerelay status` reflects reality immediately.
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

## [0.1.0] - 2026-10-18

Initial implementation.

### Added

- `lanerelay run "<task>"` — runs the task through configured lanes; detects
  quota/rate-limit exits from output + exit codes, marks the lane blocked
  until its reset time, and hands the task (with a handoff note: prior
  attempts, `git diff --stat`, output tails) to the next free lane.
- `lanerelay run --chain a,b,c` / named `chains:` in config; lane ordering by
  cost class (`paidFirst`) then `priority`.
- Pattern library for claude, codex, gemini, glm, aider, opencode, cursor
  (+ generic fallback for `custom`): cap messages, 429/RESOURCE_EXHAUSTED,
  reset-time parsing for durations, clock times, weekday/month-day dates,
  ISO timestamps and pipe-delimited epochs; transient/recovery suppression.
- `.lanerelay/state.json` per-repo lane block store (atomic writes);
  `lanerelay status [--json]`, `lanerelay unblock [lane]`.
- `lanerelay add`/`lanerelay queue`/`lanerelay watch` file-based queue + single-watcher daemon
  (lockfile, atomic claim, `--once`, `--poll`).
- Hooks on limit/handoff/finish/fail: templated shell commands and JSON
  webhooks (`hooks:` in config, `LR_*` env vars).
- `lanerelay init` writes a starter `lanerelay.yaml` and gitignores `.lanerelay/`.
- Per-attempt logs in `.lanerelay/logs/`; `--quiet` for clean terminals.
- Config: YAML with validation (duplicate names, missing `{{prompt}}`,
  unknown kinds), `defaults:` for reset/wait/timeout/state paths.

### Notes

- Name under review: `lanerelay` collides with an existing OpenClaw
  plugin; `pinchhitter` proposed (see ROADMAP.md).
