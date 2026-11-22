#!/usr/bin/env bash
# Saves the design screenshots (Sources/Threadbear/Screenshots.swift) from a
# debug build running against the mock runner's demo threads. Nothing touches
# the real runner, the staged app in ~/Applications or its settings (the
# build gets a bundle id of its own, removed afterwards), and the window
# stays behind whatever you're working in.
#
#   Tools/screenshots.sh <out dir> [--only <prefix>] [--appearance light|dark]
#
#   --only 11      just the shots whose names start with 11
#   --appearance   light or dark, whatever the Mac is set to
set -euo pipefail

# THREADBARE_* was the old name for these variables: each stands in for its new name.
for v in $(compgen -e | grep '^THREADBARE_' || true); do n="THREADBEAR_${v#THREADBARE_}"; [ -n "${!n+x}" ] || export "$n=${!v}"; done
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$TOOLS_DIR/.." && pwd)"
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

# Options in any order. A first argument that looked like an option used to
# become the output folder: --help ran the whole set into app/--help.
OUT_DIR=""
APP_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --only|--appearance)
      [ $# -ge 2 ] && [ "${2#-}" = "$2" ] || { echo "$1 needs a value" >&2; exit 2; }
      APP_ARGS+=("$1" "$2")
      shift ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      [ -z "$OUT_DIR" ] || { echo "One output folder, please (got $OUT_DIR and $1)." >&2; exit 2; }
      OUT_DIR="$1" ;;
  esac
  shift
done
[ -n "$OUT_DIR" ] || { usage >&2; exit 2; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/threadbear-shots.XXXXXX")"
DATA_DIR="$WORK/data"
mkdir -p "$DATA_DIR" "$OUT_DIR"

if [[ ! -d "$TOOLS_DIR/../../mock-runner/node_modules" ]]; then
  (cd "$TOOLS_DIR/../../mock-runner" && npm install --silent)
fi

# A bundle (not the bare binary) so the app has its Info.plist, staged in the
# temp folder rather than over the app Mike is using.
# Its output (codesign's "replacing existing signature" and the like) goes
# to a log, shown only if the build fails.
THREADBEAR_APP_DIR="$WORK/Threadbear.app" THREADBEAR_BUILD_CONFIGURATION=debug \
  bash "$APP_ROOT/build-app.sh" >"$WORK/build.log" 2>&1 || { tail -n 40 "$WORK/build.log" >&2; exit 1; }
# Its own bundle id, so its own settings: with the installed app's id it
# read Mike's saved sidebar width and account, and left the shots' window
# size in his preferences. Re-signed ad hoc, since the plist is sealed.
SHOTS_ID="com.mikerosoft.threadbear.shots.$$"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $SHOTS_ID" "$WORK/Threadbear.app/Contents/Info.plist"
codesign --force --sign - "$WORK/Threadbear.app" >/dev/null 2>&1

# Only the demo threads: private fixtures (real transcripts, tb exports)
# must never end up in screenshots that go on GitHub.
node "$TOOLS_DIR/../../mock-runner/server.mjs" --data-dir "$DATA_DIR" --fixtures "$TOOLS_DIR/../../mock-runner/fixtures" --quiet &
MOCK_PID=$!
cleanup() {
  kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$WORK"
  defaults delete "$SHOTS_ID" >/dev/null 2>&1 || true
  rm -rf "$HOME/Library/Preferences/$SHOTS_ID.plist" "$HOME/Library/Saved Application State/$SHOTS_ID.savedState" \
    "$(getconf DARWIN_USER_TEMP_DIR)$SHOTS_ID.savedState" "$HOME/Library/Caches/$SHOTS_ID"
}
trap cleanup EXIT

for _ in $(seq 1 100); do
  [[ -f "$DATA_DIR/runner.json" ]] && break
  sleep 0.05
done

# AppKit's ApplePersistenceIgnoreState line on every run is noise; anything
# else the app says still shows.
"$WORK/Threadbear.app/Contents/MacOS/Threadbear" --data-dir "$DATA_DIR" --screenshots "$OUT_DIR" ${APP_ARGS[@]+"${APP_ARGS[@]}"} \
  2> >(grep -v --line-buffered 'ApplePersistenceIgnoreState' >&2)
