#!/bin/zsh
# The nightly TestFlight build: when the iPhone app has changed on main since the last one, archive
# main, upload it to App Store Connect and hand it to the internal TestFlight group Mike's phone
# takes every build from (testflight.mjs), so his phone has last night's main without anyone
# running install-phone.sh. Internal testers need no Beta App Review.
#
#   ios/scripts/nightly-testflight.sh           build and upload now if the app changed (waits;
#                                               about 15 minutes, plus App Store processing)
#   ios/scripts/nightly-testflight.sh --force   the same even if nothing changed
#   ios/scripts/nightly-testflight.sh --check   for the schedule's check: prints a failed run's
#                                               log once, else starts a run in the background if
#                                               none has started in 12 hours, and prints nothing
#
# Mike's copy only. It does nothing (and says nothing to the schedule) unless origin is
# mikecann/threadbear and the team's App Store Connect key is on this Mac, so a fork never runs it
# and has nothing to set up. The schedule that runs it lives in Mike's Convex, not in the repo.
#
# It builds what's landed on main (git archive of `main` in this checkout, never a working tree
# another thread is editing) into its own folder, with appstore-upload.sh: same build numbers as
# App Store submissions (UTC YYMMDDHHMM, always increasing, so the two never collide, and a nightly
# build can be the one submitted). The version is the project's, or one patch past the newest
# version App Store Connect has approved or released, whose train takes no more builds.
#
# "The app changed" is anything under ios/ apart from the listing (ios/appstore), docs and the
# kit's tests. The app builds from nothing outside ios/ (its packages are ThreadbearKit,
# SentryBinary and WhisperBinary, all in ios/); add a path to APP_PATHS if that changes.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
APP_PATHS=(ios ':(exclude)ios/appstore' ':(exclude)*.md' ':(exclude)ios/ThreadbearKit/Tests')
KEY=${ASC_KEY:-$HOME/.config/poddle/AuthKey_${ASC_KEY_ID:-7SS6J9F98P}.p8}

mikes_copy() {
  local key
  key=$(git -C "$ROOT" remote get-url origin 2>/dev/null | tr '[:upper:]' '[:lower:]')
  key="${key#*://}"; key="${key#*@}"; key="${key/://}"; key="${key%/}"; key="${key%.git}"
  [[ "$key" == "github.com/mikecann/threadbear" && "$(uname -s)" == Darwin && -f "$KEY" ]]
}
if ! mikes_copy; then
  [[ "${1:-}" == --check ]] || echo "Not Mike's copy (or no App Store Connect key at $KEY): nothing to do."
  exit 0
fi

umask 077
NIGHTLY=$(node "$ROOT/ios/scripts/private-dir.mjs" "$HOME/Library/Caches/Threadbear/ios-builds/nightly") || exit 1
RUNS="$NIGHTLY/runs"
mkdir -p "$RUNS"
LAST="$NIGHTLY/last-commit"   # main's commit at the last build that reached TestFlight

if [[ "${1:-}" == --check ]]; then
  runs=("$RUNS"/20*(N/))
  latest=${runs[-1]:-}
  started=$(cat "$latest/started" 2>/dev/null || echo 0)
  age=$(( $(date +%s) - started ))
  if [[ -n "$latest" && ! -f "$latest/.reported" ]]; then
    if [[ -f "$latest/.failed" ]]; then
      touch "$latest/.reported"
      printf "The nightly TestFlight build of %s failed. The end of its log (%s/run.log):\n%s\n" \
        "$(basename "$latest")" "$latest" "$(tail -30 "$latest/run.log")"
      exit 0
    fi
    [[ -f "$latest/.ok" ]] && touch "$latest/.reported"
  fi
  # One at a time: a run still going is left alone, unless it has gone on for four hours.
  if [[ -f "$NIGHTLY/.running" ]] && kill -0 "$(cat "$NIGHTLY/.running")" 2>/dev/null; then
    if [[ -n "$latest" && ! -f "$latest/.reported" ]] && (( age > 4 * 3600 )); then
      touch "$latest/.reported"
      printf "The nightly TestFlight build of %s has been going for over four hours (pid %s). Its log so far (%s/run.log):\n%s\n" \
        "$(basename "$latest")" "$(cat "$NIGHTLY/.running")" "$latest" "$(tail -30 "$latest/run.log")"
    fi
    exit 0
  fi
  # The schedule checks twice a night; the second only starts one if the first didn't.
  [[ -n "$latest" ]] && (( age < 12 * 3600 )) && exit 0
  main=$(git -C "$ROOT" rev-parse -q --verify main) || exit 0
  last=$(cat "$LAST" 2>/dev/null)
  if [[ -n "$last" ]] && git -C "$ROOT" cat-file -e "$last^{commit}" 2>/dev/null \
    && git -C "$ROOT" diff --quiet "$last" "$main" -- "${APP_PATHS[@]}"; then
    exit 0
  fi
  nohup "$0" > /dev/null 2>&1 &
  exit 0
fi

echo $$ > "$NIGHTLY/.running"
trap 'rm -f "$NIGHTLY/.running"' EXIT
stamp=$(date +%Y-%m-%d-%H%M)
dest="$RUNS/$stamp"
mkdir -p "$dest"
date +%s > "$dest/started"
log="$dest/run.log"
fail() { echo "$1" >> "$log"; touch "$dest/.failed"; echo "$1" >&2; exit 1; }

# THREADBEAR_NIGHTLY_REF builds another commit instead, to try a change to this script first.
main=$(git -C "$ROOT" rev-parse "${THREADBEAR_NIGHTLY_REF:-main}") || fail "no main branch in $ROOT"
last=$(cat "$LAST" 2>/dev/null)
git -C "$ROOT" cat-file -e "$last^{commit}" 2>/dev/null || last=""
if [[ "${1:-}" != --force && -n "$last" ]] && git -C "$ROOT" diff --quiet "$last" "$main" -- "${APP_PATHS[@]}"; then
  echo "The app hasn't changed since the last nightly build (main at ${last:0:10})." | tee "$log"
  touch "$dest/.ok" "$dest/.reported"
  exit 0
fi
echo "main at $main" > "$log"

# What to Test: the app's commits since the last nightly build.
notes="$dest/notes.txt"
if [[ -n "$last" ]]; then
  git -C "$ROOT" log --no-merges --format='- %s' "$last..$main" -- "${APP_PATHS[@]}" | head -40 > "$notes"
else
  echo "Built from main at ${main:0:10}." > "$notes"
fi

src="$NIGHTLY/src"
rm -rf "$src" && mkdir -p "$src"
git -C "$ROOT" archive "$main" | tar -x -C "$src" || fail "couldn't copy main at $main"

project_version=$(sed -n 's/.*MARKETING_VERSION = \([0-9.]*\);/\1/p' "$src/ios/Threadbear.xcodeproj/project.pbxproj" | head -1)
version=$(cd "$src" && node ios/scripts/testflight.mjs version "$project_version" 2>> "$log") \
  || fail "couldn't ask App Store Connect which version to build"
build=$(date -u +%y%m%d%H%M)
echo "building $version ($build); the project says $project_version" >> "$log"

# Background priority on Mike's Mac (it's his laptop); appstore-upload.sh takes the build lock.
( cd "$src" && MARKETING_VERSION="$version" BUILD_NUMBER="$build" UPLOAD=1 \
    taskpolicy -b zsh ios/scripts/appstore-upload.sh ) >> "$log" 2>&1 \
  || fail "appstore-upload.sh failed (its logs are in ~/Library/Caches/Threadbear/ios-builds/appstore/$build)"
( cd "$src" && node ios/scripts/testflight.mjs finish "$build" "$notes" ) >> "$log" 2>&1 \
  || fail "the upload went through but the build didn't reach the TestFlight group"

echo "$main" > "$LAST"
touch "$dest/.ok"
# Sentry has the archive's symbols and App Store Connect the build, so the archive can go.
rm -rf "$src" "$HOME/Library/Caches/Threadbear/ios-builds/appstore/$build"
# The last 10 runs' logs.
runs=("$RUNS"/20*(N/))
while (( ${#runs} > 10 )); do rm -rf "${runs[1]}"; runs=("${runs[@]:1}"); done
echo "Threadbear $version ($build) from main at ${main:0:10} is on TestFlight." | tee -a "$log"
