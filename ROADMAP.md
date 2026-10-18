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

## Next (priority order)

1. [ ] **Real-CLI fidelity pass.** Capture actual non-interactive output of
       `claude -p`, `codex exec`, `gemini -p` when limited (community issue
       reports + manual run); extend fixtures, tighten patterns, especially
       codex's JSONL `--json` mode and stream events.
2. [ ] **`qp probe <lane>`**: send a tiny prompt, classify the lane as
       available/limited/auth-error, and learn its real reset format —
       self-calibrating patterns instead of guessing.
3. [ ] **Cost-aware chain planning**: `paidFirst` is coarse; add optional
       `quotaLeft` estimates (parse `/usage`-style outputs where CLIs print
       remaining %) to pick the lane least likely to die mid-task.
4. [ ] **Task-level resume**: persist the attempts of a `qp run` so a later
       `qp run --resume <id>` continues instead of starting cold; show in
       `qp queue`/`qp status`.
5. [ ] **Parallel watch** (opt-in `--jobs N`): claim N queue items across
       *different* lane sets with per-run state namespacing.
6. [ ] **`qp report`**: per-lane success/limit history from `.qp/logs` +
       queue results (which lane actually finishes work, how often each caps).
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
