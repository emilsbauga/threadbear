#!/bin/bash
# One or more fuzz-agent sessions on the machine this runs on, for use through
# remote.sh, so the app and the model both run there and nothing needs Mike's
# Mac awake:
#
#   desktop/scripts/remote.sh tinker-desk --desk -- features/tools/fuzz-agent-desk.sh \
#     <model> <minutes> [area...]
#
# Builds the GPUI app with the scripted control, starts it on the mock
# runner, runs a session per area (each a fresh app) until <minutes> are up,
# and prints where the logs are. Uses whatever `claude` login the host
# already has: nothing is signed in or copied there.
set -euo pipefail
model="${1:?model, e.g. claude:claude-haiku-5-5}"; minutes="${2:-10}"; shift 2 || true
areas=("$@"); [ ${#areas[@]} -gt 0 ] || areas=("Sidebar and inbox")
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
export PATH="$HOME/.local/bin:$PATH"
(cd desktop && cargo build -p threadbear-gpui --features automation 2>&1 | tail -2)
export TB_GPUI_BIN="${CARGO_TARGET_DIR:-desktop/target}/debug/threadbear-gpui"
out="${FUZZ_OUT:-$HOME/.cache/threadbear-check/fuzz-agent/$(date +%Y%m%d-%H%M%S)}"   # FUZZ_OUT: the nightly run's own folder
mkdir -p "$out"
end=$(( $(date +%s) + minutes * 60 ))
n=0
for area in "${areas[@]}"; do
  [ "$(date +%s)" -lt "$end" ] || break
  n=$((n + 1))
  id="fuzz$$-$n"
  desktop/scripts/dev-app.sh start --mock --no-build --id "$id" >/dev/null
  left=$(( (end - $(date +%s)) / 20 ))   # about 20 s a step
  [ "$left" -gt 3 ] || left=3
  node features/tools/fuzz-agent.mjs --model "$model" --id "$id" --area "$area" --steps "$(( left < 30 ? left : 30 ))" --out "$out/$n" || true
  desktop/scripts/dev-app.sh stop --id "$id" >/dev/null 2>&1 || true
done
echo "fuzz-agent logs: $out"
for f in "$out"/*/totals.json; do [ -f "$f" ] && cat "$f"; done
