# CHANGELOG

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
