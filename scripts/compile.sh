#!/bin/sh
# Build standalone `lanerelay` binaries (no Node needed at runtime) via
# `bun build --compile`. Bundles src/cli.ts + commander + yaml directly;
# no `npm run build` step required.
#
#   scripts/compile.sh                  # linux-x64 only (the sandbox default)
#   scripts/compile.sh all              # linux/darwin x64+arm64, windows x64
#   scripts/compile.sh linux-x64 darwin-arm64
#
# Output: dist/bin/lanerelay-<target>[.exe]
set -eu
cd "$(dirname "$0")/.."
if command -v bun >/dev/null 2>&1; then
  BUN="bun"
elif command -v npx >/dev/null 2>&1; then
  # The `bun` npm package is a shim that fetches the real binary.
  BUN="npx --yes bun"
else
  echo "error: neither bun nor npx found — install bun (https://bun.sh)" >&2
  exit 1
fi

targets="$*"
[ -z "$targets" ] && targets="linux-x64"
[ "$targets" = "all" ] && targets="linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64"

mkdir -p dist/bin
for t in $targets; do
  case "$t" in
    windows*) ext=".exe" ;;
    *) ext="" ;;
  esac
  out="dist/bin/lanerelay-${t}${ext}"
  $BUN build --compile --target="bun-${t}" --outfile "$out" src/cli.ts
  echo "built $out"
done
