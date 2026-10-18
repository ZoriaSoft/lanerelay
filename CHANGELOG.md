# CHANGELOG

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
