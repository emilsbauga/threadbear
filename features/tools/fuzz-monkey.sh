#!/bin/bash
# Builds the GPUI app with `automation` and runs the random-walk fuzzer
# (fuzz-monkey.ts) against it, for use through remote.sh on Tinker Desk:
#
#   desktop/scripts/remote.sh tinker-desk --desk -- features/tools/fuzz-monkey.sh <seed> [minutes] [extra args]
#
# What it finds goes under ~/.cache/threadbear-check/fuzz/<seed>, which is
# where everything Threadbear keeps on that host lives (scripts/check-remote.sh),
# so the host still looks like one with no Threadbear on it.
set -euo pipefail
seed="${1:?usage: fuzz-monkey.sh <seed> [minutes] [args]}"; shift
minutes="${1:-10}"; [ $# -gt 0 ] && shift
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
(cd desktop && cargo build -p threadbear-gpui --features automation 2>&1 | tail -2)
# A private copy, as spec.sh makes, so a later build can't swap it mid-run.
private="$(mktemp -d "${TMPDIR:-/tmp}/fuzz-gpui.XXXXXX")"
trap 'rm -rf "$private"' EXIT
cp "${CARGO_TARGET_DIR:-desktop/target}/debug/threadbear-gpui" "$private/threadbear-gpui"
cp "${CARGO_TARGET_DIR:-desktop/target}/debug/threadbear-web-helper" "$private/threadbear-web-helper" 2>/dev/null || true
export TB_GPUI_BIN="$private/threadbear-gpui"
out="${FUZZ_OUT:-$HOME/.cache/threadbear-check/fuzz/$seed}"   # FUZZ_OUT: the nightly run's own folder
mkdir -p "$out"
cd features
node tools/fuzz-monkey.ts --seed "$seed" --minutes "$minutes" --out "$out" "$@"
