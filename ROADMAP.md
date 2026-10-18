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
       Follow-up: `qp report --lane claude` drill-down / JSONL export.
6. [ ] **Parallel watch** (opt-in `--jobs N`): claim N queue items across
       *different* lane sets with per-run state namespacing.
7. [ ] TUI `qp top`: live lane grid (blocked countdowns, running task,
       queue depth). Consider blessed or raw ANSI — weigh dep cost.
8. [ ] Homebrew/standalone binary packaging (bun compile or pkg) so non-Node
       users get `qp` without npm.

## Open questions

- Should handoff include `git diff` *content* (bounded) not just `--stat`?
  Agents could review actual edits; size vs usefulness tradeoff.
- Per-task lane affinity ("this lane is bad at Rust repos") — worth a
  `taskTags`/history weighting, or over-engineering?
- Windows support: runner uses `sh -c` — needs cmd.exe/powershell mode
  (spawn `cmd /c` on win32) plus WSL note in README.
