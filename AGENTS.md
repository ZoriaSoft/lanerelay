# AGENTS.md — quota-pilot

## What this is

`qp`: a Node 20+ TypeScript CLI that runs one coding task through a chain of
agent CLIs (claude, codex, gemini, glm, aider, opencode, cursor, custom).
When a lane hits its quota, output-pattern detection marks it blocked until
its reset time and the task moves to the next lane with a handoff prompt.

## Layout

```
src/
  cli.ts         commander wiring — all commands live here
  config.ts      YAML load/validate, lane ordering (paidFirst → quota → priority)
  patterns.ts    per-kind regex library (limited / notLimit / reset /
                 usage / usageUsed / exitCodes)
  detect.ts      detectLimit + parseResetTime + detectUsage — pure, well-tested
  orchestrate.ts runTask: lane loop, handoff, wait-for-reset
  runner.ts      spawn + tee + ring-buffer tail + per-attempt logs (QP_PROMPT
                 env; cmd /c on Windows)
  prompt.ts      handoff prompt composer; git.ts: diff summary + bounded patch
  state.ts       .qp/state.json — lane blockedUntil + per-window usage
                 gauges, atomic writes, mtime-refresh so concurrent qp
                 processes see each other's blocks
  leases.ts      .qp/leases/<lane>.json per-lane mutex for parallel runs
  queue.ts       .qp/queue/{pending,running,done,failed}/*.json, atomic claim
                 + defer() — all-blocked tasks wait in pending/ with a
                 notBefore (queue.maxDefers); deferDecision picks the wake
  logview.ts     `qp log` — run/item/lane/filename selector → attempt log tail
  hooks.ts       command + webhook notifications
  runs.ts        .qp/runs/<id>.json — RunRecord per task execution, resume source
  report.ts      qp report aggregation (lanes / queue / resumable / recent)
  status.ts      lane status rows
  top.ts         qp top dashboard: pure topSnapshot/formatTop + ANSI loop
  init.ts        `qp init` starter config
  doctor.ts      `qp doctor` — preflight checks: config parses, lane
                 executables resolve, .qp dirs writable, state valid,
                 stale watch-lock/leases flagged
test/            vitest; detect.test.ts holds the pattern fixtures
```

## Rules for changes

- **Patterns are the product.** Any change to `patterns.ts`/`detect.ts` needs
  realistic sample outputs in `detect.test.ts`. Never delete a test to make a
  regex pass.
- `detect.ts` and `parseResetTime` stay pure (inject `now`); no I/O.
- State and queue writes are atomic (tmp + rename) — keep it that way.
- Runtime deps: `commander`, `yaml` only. No new dependencies without a strong
  reason — the tool must stay npx-installable and fast.
- Commands never touch the network except `hooks.webhook` POSTs.
- Node 20 compat: no `node:test`-only or 22-only APIs in `src/`.
- English code/comments; README + README.tr.md stay in sync for features.
- Never commit real paths, hostnames, tokens, or user data; examples use
  fake values (`.qp/` is already gitignored).

## Verify

`npm test` and `npm run build` must pass, then `test/smoke.sh` (needs dist/).
It drives fake lanes end-to-end; add a `contains` check when shipping
behavior changes.
