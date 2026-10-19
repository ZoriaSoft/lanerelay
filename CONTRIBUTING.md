# Contributing

Issues and pull requests are welcome; contributions are released under the
MIT license.

The most useful contribution is **real limit or error output** from agent
CLI versions not yet covered in `test/fixtures/real/`. Strip session ids,
request ids and local paths first, add the file as a new fixture (never
edit an existing one) and a row to `test/fixtures/real/README.md`.

## Development

```bash
npm ci
npm run typecheck
npm test          # vitest, runs with TZ=UTC
npm run build
npm run smoke     # end-to-end with fake lanes (needs dist/)
```

Node.js 20 or newer. There is no hosted CI, so please run the commands above
before opening a PR.

## Rules of thumb

- Pattern changes (`src/patterns.ts`, `src/detect.ts`) need realistic sample
  output in `test/detect.test.ts`. Never delete a test to make a regex pass.
- `detect.ts` stays pure: inject `now`, no I/O.
- State, queue and run-record writes are atomic (temp file + rename).
- Lane children never get lanerelay's stdin and stay registered so signals
  can stop them.
- Runtime dependencies are `commander` and `yaml` only.
- Commands never touch the network except webhook hooks.
- `src/` stays compatible with Node.js 20 (no 22-only APIs).
- Fixtures and examples use fake values: no real paths, hostnames, tokens
  or user data.
- Keep `README.md` and `README.tr.md` in sync for user-facing features.

## Security issues

See [SECURITY.md](SECURITY.md).
