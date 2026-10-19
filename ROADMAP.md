# Roadmap

## Name

The project was renamed from `quota-pilot` to `lanerelay` in 0.9.0 (the old
name collides with an existing npm package). CLI: `lanerelay`, short alias
`lr`.

## Shipped

- **0.9.0** — validated against real CLIs (Claude Code 2.1.302, Codex CLI
  0.163.0, opencode 1.18.14; sanitized output in `test/fixtures/real/`);
  lanes get no stdin; Ctrl-C stops the running lane's process group;
  locked state writes; detection scans only the output tail; zone-aware
  reset parsing; clean handoff tails; hook templating cannot inject shell
  code.
- **0.8.0** — `lanerelay doctor`, per-window quota gauges
  (session/daily/weekly/monthly), `report --jsonl`, `add --file`.
- **0.7.0** — queue deferral until the earliest lane reset, `lanerelay log`,
  `report --lane`, standalone binaries via `bun build --compile`.
- **0.6.0** — `lanerelay top` live dashboard.
- **0.5.0** — parallel `watch --jobs N` with per-lane leases,
  `handoff.diff: none|stat|full`, Windows spawn support.
- **0.4.0** — usage-aware lane ordering from quota gauges, `lanerelay prune`,
  regex validation at config load.
- **0.3.0** — task-level resume (`run --resume`), `lanerelay report`,
  end-to-end smoke script.
- **0.2.0** — limit patterns calibrated against upstream CLI sources,
  `lanerelay probe`.
- **0.1.0** — core detection and reset parsing, `run` with handoff prompts,
  lane state, file queue and `watch`, hooks, `init`.

See `CHANGELOG.md` for details.

## Next

- [ ] Live validation for Gemini CLI, Aider, Cursor and GLM lanes.
- [ ] Windows end-to-end coverage beyond the unit and cmd.exe tests.
- [ ] Optional per-lane `stdin: inherit` for CLIs that need a TTY.
- [ ] npm release, then a Homebrew tap and release assets for the
      standalone binaries (windows/darwin binaries are built but untested).
- [ ] `probe --learn`: write observed patterns back into a lane's
      `patterns:` config and refresh gauges before runs.
- [ ] Per-chain lane sets for `watch --jobs` when a task is pinned to a
      subset of lanes.
- [ ] `top`: per-worker view and a key to open the latest log file.

## Open questions

- Per-task lane affinity ("this lane is bad at Rust repos"): worth a
  `taskTags` / history weighting, or over-engineering?
- A WSL-vs-native note in the README if Windows users report friction.
