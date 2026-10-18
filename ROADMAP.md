# ROADMAP

## Name proposal

**pinchhitter** — free on npm and GitHub (checked 2026-10-18), captures the
relief-substitution mechanic (a pinch hitter bats when the starter can't).
Current name `quota-pilot` collides with `singledevai-droid/openclaw-quota-pilot`
(an OpenClaw/VS Code quota plugin). Runner-up `runrelay` also free but the
"relay" space is crowded (bethvourc/agent--relay, ACNoonan/relay-cli).
Keep `quota-pilot` unless the owner prefers `pinchhitter`.

## Done (round 1)

- [x] Core: per-CLI limit pattern library (claude/codex/gemini/glm/aider/
      opencode/cursor/custom), reset-time parser (durations, clock, weekday,
      month-day, ISO, epoch), recovery suppression, 51 tests.
- [x] `qp run` with lane ordering (paid-first, priority), handoff prompts
      with git diff summary, per-attempt logs, `--chain`, `--no-wait`.
- [x] `.qp/state.json` lane block store; `qp status`, `qp unblock`.
- [x] File queue + `qp add`, `qp queue`, `qp watch` daemon with lock.
- [x] Hooks: command (templated) + webhook on limit/handoff/finish/fail.
- [x] `qp init` starter config; config validation; YAML named chains.

## Done (round 2)

- [x] Real-CLI fidelity pass: patterns calibrated against codex-rs error.rs
      (spend caps, workspace credits, per-model limits, `Jul 19th, 2026
      10:27 AM` resets, capacity fallbacks), claude headless banners
      (`You've hit your limit · resets 9:10pm (TZ)`, session limit, Budget
      limit), gemini googleQuotaErrors.ts (TerminalQuotaError,
      MODEL_CAPACITY_EXHAUSTED, `Please retry in 34.07s`, daily-quota line).
- [x] Detection rewrite: line-scoped notLimit suppression (recovery on a
      later line OR qualifier before the cap on the same line), ms/compact
      duration parsing (`143h26m`, `34.07s`, `900ms`), decimals in
      `please retry in` capture.
- [x] `qp probe <lane>|--all`: classifies available/limited/auth-error/
      error/timeout; writes learned resets + auth blocks to state; 7 tests.
- [x] Runner fix: killed lanes whose grandchildren hold stdio no longer
      hang the run ('exit' grace period replaces 'close' wait).

## Done (round 3)

- [x] Task-level resume: `.qp/runs/<id>.json` records per run (task, chain,
      pid, attempts, final status), rewritten after every attempt;
      SIGINT/SIGTERM mark them `interrupted`. `qp run --resume <id>`
      continues the recorded task with the prior attempts in the handoff;
      superseded records are `resumed`, done/live/different-task resumes
      refused. Record ids printed on run start and shown on queue items.
- [x] `qp report` (+`--json`): per-lane attempt stats, queue outcomes,
      resumable runs (copy-paste commands), recent runs. `qp status` lists
      unfinished runs.
- [x] `test/smoke.sh`: end-to-end shell smoke (build → fake lanes →
      handoff/resume/SIGINT/watch/report).


## Done (round 4)

- [x] Usage-aware chain planning: `detectUsage` parses quota gauges
      ("usage: 72%", "12% of your weekly quota left", "used 40% of…",
      per-lane `patterns.usage`/`usageUsed` overrides) into
      `.qp/state.json`; `orderLanes` sorts free lanes inside a cost class
      by remaining quota (rich first, unknown = 100, stale after 24h).
      `qp status`/`qp probe` surface the reading; `qp unblock` clears it.
- [x] `qp prune --days N` (default 30) removes aged run records; live runs
      and corrupt files are skipped.
- [x] Config validation now compiles `patterns.*` regexes at load — bad
      patterns fail fast with the lane name.

## Done (round 5)

- [x] **Parallel watch** (`--jobs N` / `queue.jobs`): N workers drain the
      queue; per-lane file leases (`.qp/leases/<lane>.json`, O_EXCL create,
      dead-pid reclaim, fresh-corrupt treated as held) guarantee two runs
      never share a subscription — across workers *and* separate `qp`
      processes. All-leased lanes poll at 5s instead of waiting for a
      quota reset that doesn't exist. `LaneStore` now reloads on mtime
      change so blocks learned by one worker are seen by the others.
      `qp status` shows `[leased by <run>]`.
- [x] **`handoff.diff` + `qp run --diff none|stat|full`**: `full` embeds a
      bounded `git diff HEAD` patch (config `diffMaxBytes`, default 8 KiB)
      so the next agent sees actual edits, not just --stat; `none` sends
      no repo state. Prompt cap raised 16→32 KiB.
- [x] Windows spawn support: lanes run via `cmd /d /s /c` on win32 with
      the prompt in `%QP_PROMPT%` (cmd's 8KB line limit), `taskkill /T /F`
      tree-kill on timeout. `QP_PROMPT` exported on POSIX too — wrapper
      scripts can read it instead of argv.
- [x] `qp watch --once` now drains the whole queue before exiting (was:
      one item).

## Done (round 6)

- [x] **`qp top`**: live dashboard (alt screen, raw ANSI, no deps) —
      per-lane blocked countdowns, quota gauges, lease owners, running
      tasks on their lanes, queue depth + next pending, resumable runs,
      watcher pid. `--interval`, `--once`/piped → single frame, `q` quits.
      Rendering is split into pure `topSnapshot`/`formatTop` (8 tests) and
      a thin TTY loop.

## Done (round 7)

- [x] **Queue deferral.** A `qp watch` task that found every lane blocked
      or timed out waiting used to land in `failed/` — overnight queues
      self-destructed on a shared 5h reset. Items now defer back to
      `pending/` with a `notBefore` = earliest lane reset (`deferDecision`
      pure helper; `queue.maxDefers`, default 10, 0 = forever). `claim()`
      skips future notBefore (FIFO slot kept); deferred items show
      `[deferred until …]` in `qp queue` and `[wake …]` in `qp top`.
      `watch --once` reports leftovers instead of a silent early exit.
- [x] **`qp log [selector]`** — tails `.qp/logs/` (200 lines, `--lines 0` =
      whole file, `--follow`, `--list`). Selector resolves run-id prefix →
      queue-item id → lane name → filename fragment; records carry the
      absolute log path so ids find the right attempt.
- [x] **`qp report --lane <name>`** — drill-down: per-lane stats plus every
      recorded attempt (verdict, duration, evidence, log ref), `--json`.
- [x] **Standalone binary** (`scripts/compile.sh` → `bun build --compile`,
      `npx bun` fallback): `dist/bin/qp-*` self-contained binaries for
      linux/darwin x64+arm64 and windows-x64; linux-x64 verified end-to-end
      (init/run/status/report) on the sandbox.

## Done (round 8)

- [x] **`qp doctor`** — preflight: config parses, lane executables resolve
      (PATH / PATHEXT / file), `{{prompt}}` slot, `.qp` dirs writable,
      state JSON valid, watcher lock and leases checked for dead pids.
      ok/warn/FAIL lines or `--json`; exit 1 on FAIL. 9 tests.
- [x] **Per-window quota gauges** — `detectUsage` returns one reading per
      window (session/daily/weekly/monthly/other; keywords on the line or
      a `(?<window>…)` group). State keeps the freshest reading per
      window (legacy files migrate), ordering takes the *poorest* fresh
      window, and staleness is per-window TTL (8h/36h/9d/35d/24h).
      `qp status`/`qp top` render multi-window gauges.
- [x] **`qp report --jsonl`** — one run record per line; **`qp add
      --file`** (`-` = stdin) enqueues one task per line.

## Next (priority order)

1. [x] **Real-CLI fidelity pass** (partial, r2): codex/claude/gemini strings
       now sourced from upstream code + issue reports. Still open: capture
       *live* non-interactive output (`claude -p`, `codex exec --json`
       JSONL event stream) — needs accounts.
2. [x] **`qp probe <lane>`** (r2): classifies the lane and writes learned
       resets/auth blocks to state. Open follow-up: `--learn` mode that
       writes observed patterns back into the lane's `patterns:` config.
3. [x] **Cost-aware chain planning** (r4): `quotaLeft` readings drive
       ordering. Follow-up idea: `--learn` probes could refresh gauges
       before runs; per-window gauges (session vs weekly) unmodeled.
4. [x] **Task-level resume** (r3): see Done (round 3). Follow-up idea:
      ~~`qp runs prune`~~ → shipped as `qp prune` (r4).
5. [x] **`qp report`** (r3): per-lane attempts + queue + resumable/recent.
       Drill-down shipped (r7) as `qp report --lane <name>`; open: JSONL
       export.
6. [x] **Parallel watch** (r5): `--jobs N`/`queue.jobs`, per-lane file
       leases shared with `qp run`. Follow-up: per-chain lane sets when a
       task is pinned to a subset.
7. [x] TUI `qp top` (r6): shipped with raw ANSI, zero deps. Follow-up:
       `top --jobs`-style per-worker view, key to open the latest log file.
8. [x] Standalone binary packaging (r7): `scripts/compile.sh` →
       `dist/bin/qp-<target>` via `bun build --compile` (npx fallback).
       Remaining for round 8: Homebrew tap formula + release-asset pipeline
       once the repo goes public; windows/darwin binaries untested beyond
       `bun build` success.

## Open questions

- ~~Should handoff include `git diff` *content* (bounded) not just `--stat`?~~
  Shipped (r5) as `handoff.diff: full` — default stays `stat`.
- Per-task lane affinity ("this lane is bad at Rust repos") — worth a
  `taskTags`/history weighting, or over-engineering?
- ~~Windows support: runner uses `sh -c`~~ shipped (r5): `cmd /c` +
  `%QP_PROMPT%` + `taskkill /T /F`. Remaining: WSL-vs-native note in README
  if users report friction.
