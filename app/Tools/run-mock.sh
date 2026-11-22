#!/usr/bin/env bash
# Runs the app against the mock runner, with a temp data folder so nothing
# touches the real runner. Extra arguments go to the mock runner
# (for example --filler 16).
#   THREADBEAR_BIN=path/to/Threadbear  use a specific binary (default: the staged app)
set -euo pipefail

# THREADBARE_* was the old name for these variables: each stands in for its new name.
for v in $(compgen -e | grep '^THREADBARE_' || true); do n="THREADBEAR_${v#THREADBARE_}"; [ -n "${!n+x}" ] || export "$n=${!v}"; done
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${THREADBEAR_APP_DIR:-$HOME/Applications/Threadbear.app}"
BIN="${THREADBEAR_BIN:-$APP_DIR/Contents/MacOS/Threadbear}"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/threadbear-mock.XXXXXX")"

if [[ ! -x "$BIN" ]]; then
  echo "No app at $BIN. Run ./build-app.sh first or set THREADBEAR_BIN." >&2
  exit 1
fi
if [[ ! -d "$TOOLS_DIR/../../mock-runner/node_modules" ]]; then
  (cd "$TOOLS_DIR/../../mock-runner" && npm install --silent)
fi

node "$TOOLS_DIR/../../mock-runner/server.mjs" --data-dir "$DATA_DIR" "$@" &
MOCK_PID=$!
cleanup() {
  kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

for _ in $(seq 1 100); do
  [[ -f "$DATA_DIR/runner.json" ]] && break
  sleep 0.05
done

"$BIN" --data-dir "$DATA_DIR"
