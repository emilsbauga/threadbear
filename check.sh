#!/bin/bash
# Checks the runner and the app on the pinned Node 24: one line per step,
# what failed and the end of the log for each step that failed, and a
# nonzero exit if any did.
#
#   ./check.sh [--quick | --runner | --app] [--all] [--e2e] [--shots DIR] [--local]
#
# With a check host set (THREADBEAR_CHECK_HOST, or "checkHost" in the
# runner's runner.json, an ssh host such as "tinker-desk"; or "checkHosts",
# a list of them, the first free one that can run it taking each run, which
# wins over checkHost so a copy older than the list still finds one), the checks run
# there instead (scripts/check-remote.sh), so test suites and the app's test
# windows stay off this one. If it can't be reached they run
# here. --e2e always runs here, as it needs this Mac's claude login.
#   --local       run here even with a check host set (narrow it down too:
#                 one test file, or swift test --filter)
#
#   (no options)  runner typecheck, unit tests and deploy tests, then the
#                 desktop app's Rust tests and build (desktop/), and the
#                 Swift Mac app's swift build and swift test, and BearDock's
#                 tests, when they changed (below)
#   --quick       runner typecheck and unit tests (about a minute), plus
#                 the Swift Mac app's release build when it changed,
#                 the desktop app's core and client tests when
#                 desktop/ changed, the public site's build (site/)
#                 when it or the guide changed, and the GPUI specs'
#                 pairing check (features/verify-pairing.mjs) when a
#                 spec, its steps or docs/gpui-port/features.md changed,
#                 and their steps' typecheck when features/ changed
#   --runner      only the runner's typecheck and unit tests, nothing else
#                 that --quick adds (Convex, web, app tools, iPhone kit), on
#                 main too: the runner's self-update runs this (deploy.mjs),
#                 so a website test can't hold the runner back, and a Linux
#                 check host can take it
#   --app         the Swift app's swift build and swift test only, changed
#                 or not
#   --all         don't skip the Swift app, dock and deploy tests (below)
#
# When up to 8 of the runner's unit test files fail, those run again on
# their own, one at a time, and a pass then counts: the step's line lists
# the tests that needed it (runner_unit_tests, below, says why).
#
# The deploy tests (a few minutes) only run when something they cover
# changed from main: runner/scripts/, launch.mjs, the launcher or the tests
# themselves. The Swift Mac app is frozen (scripts/swift-freeze.sh), so its
# build and tests only run when something it builds from changed (app/ and
# dock/, and the iPhone kit's files app/ links to: SWIFT_NEEDS, below): not
# what it shares with the GPUI app (the mock runner, shared/'s art and Pele),
# whose own checks are the desktop app's. Except that a change to the mock
# runner, or to the Swift tests that read it, runs just those tests
# (swift test --filter, swift-freeze.sh --mock-tests), --quick included,
# so it needs a Mac. BearDock's tests only run when
# dock/ changed (the app's own build and tests cover how it uses it). The iPhone app's ThreadbearKit
# tests run with any of the options when ios/ or shared/cases changed
# (IOS_NEEDS, below), --quick included, so
# `tb land` runs them (MicTapTests guards a crash the phone hit twice). On
# main itself, with nothing changed, everything but the Swift app runs.
#
# A Swift step that prints nothing for 10 minutes, or runs for an hour, is
# killed and fails, saying which test was running and where it was stuck.
#
# How long the app takes depends on its build cache: under a minute when
# app/.build is warm, 5 to 10 minutes in a folder that has never built
# (a new worktree), as SwiftPM's cache only works where it was made. Run
# it in the background rather than waiting on it.
#   --e2e         also the runner's end-to-end tests: the real claude CLI on
#                 claude-haiku-5-5 and the first Claude login that works (TB_E2E_ACCOUNT,
#                 else runner/src/test-login.ts's pick), then Codex on
#                 gpt-6-luna at low effort and a Codex install into a temp
#                 folder, all in temp folders (several minutes, a few cents;
#                 TB_E2E_SKIP_CODEX=1 leaves the Codex ones out)
#   --shots DIR   also save the app's design screenshots to DIR
#                 (app/Tools/screenshots.sh; look at them afterwards)
#   --only STEPS  just these steps of the run the other options ask for,
#                 by the names it prints, ";" between them, and for the
#                 runner's unit tests optionally the files:
#                 "site build;runner unit tests=test/unit/a.test.ts test/unit/b.test.ts".
#                 A failed run ends with the --only that runs what failed
#                 again. tb land uses it to find which landing of a group
#                 broke the group's check (THREADBEAR_CHECK_ONLY is the same
#                 thing, for a check command it can't add options to).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Node: THREADBEAR_NODE, else the node on PATH, else nvm's newest
# Node 24 or newer, else Homebrew's (runner/scripts/find-node.sh).
. "$ROOT/runner/scripts/find-node.sh"
NODE="$(threadbear_find_node)" || exit 1
QUICK=0
RUNNER_ONLY=0
APP_ONLY=0
ALL=0
E2E=0
SHOTS=""
LOCAL=0
ONLY=""
# tb land runs whatever command the repo's patch names as its check, so it
# asks for --only through the environment; from here on it's the option, which
# is what reaches a check host.
if [ -n "${THREADBEAR_CHECK_ONLY:-}" ]; then
  set -- "$@" --only "$THREADBEAR_CHECK_ONLY"
  unset THREADBEAR_CHECK_ONLY
fi
# And --all: tb land's run of what failed on main, where the Swift steps
# would otherwise skip with nothing changed and blame nobody (17 Nov: four
# hours of group checks halving instead).
if [ "${THREADBEAR_CHECK_ALL:-}" = 1 ]; then
  set -- "$@" --all
fi
unset THREADBEAR_CHECK_ALL
ARGS=("$@")

while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --runner) QUICK=1; RUNNER_ONLY=1 ;;
    --app) APP_ONLY=1 ;;
    --all) ALL=1 ;;
    --e2e) E2E=1 ;;
    --local) LOCAL=1 ;;
    --shots)
      [ $# -ge 2 ] || { echo "--shots needs a folder" >&2; exit 2; }
      case "$2" in /*) SHOTS="$2" ;; *) SHOTS="$PWD/$2" ;; esac
      shift ;;
    --only)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "--only needs the steps to run" >&2; exit 2; }
      ONLY="$2"
      shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$QUICK" = 1 ] && [ "$APP_ONLY" = 1 ]; then
  echo "--quick is the runner's checks and --app the app's; pick one (or neither for both)." >&2
  exit 2
fi
# THREADBEAR_CHECK_HOST_ONLY (below, where the host is picked): a run that's
# for a check host or nowhere. A check command that itself says --local or
# --e2e would run it here all the same (Codex's review, 17 Nov), in tb
# land's own checkout with no packages installed. On a host this isn't set:
# ssh doesn't carry it.
if [ -n "${THREADBEAR_CHECK_HOST_ONLY:-}" ] && { [ "$LOCAL" = 1 ] || [ "$E2E" = 1 ]; }; then
  echo "This check runs on this Mac (--local or --e2e), and this run was only for a check host."
  exit 4
fi
# plain <text> <regex>: whether all of it matches, a line break included
# (grep would take each line by itself), whatever the locale's letters are.
plain() {
  local LC_ALL=C
  [[ "$1" =~ $2 ]]
}
# Step names and test file paths only: it's passed to a check host's shell
# and its file names to node.
ONLY_CHARS='^[A-Za-z0-9 ._/=;()-]*$'
if ! plain "$ONLY" "$ONLY_CHARS" || [ "${ONLY#-}" != "$ONLY" ]; then
  echo "--only takes step names with ; between them (and =files for the runner's unit tests), not: $ONLY" >&2
  exit 2
fi

# The check host: THREADBEAR_CHECK_HOST (set and empty means none), or
# runner.json's checkHost. Read before the THREADBEAR_* names go below.
RUNNER_JSON="${THREADBEAR_HOME:-$HOME/Library/Application Support/Threadbear}/runner.json"
if [ "$LOCAL" = 0 ] && [ "$E2E" = 0 ]; then
  configured_hosts() {
    [ -x "$NODE" ] && [ -f "$RUNNER_JSON" ] && "$NODE" -e '
      try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const h = Array.isArray(j.checkHosts) ? j.checkHosts : j.checkHost; const l = (Array.isArray(h) ? h : [h]).filter((x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(x)); if (l.length) console.log(l.join(",")) } catch {}' "$RUNNER_JSON"
  }
  # A grouped landing's check (tb land sets THREADBEAR_CHECK_GROUP, and
  # THREADBEAR_CHECK_PREFER from what each landing in it asked for) goes to
  # the configured hosts, those asked for tried first (scripts/check-remote.sh):
  # never just the holder's own THREADBEAR_CHECK_HOST, which could leave out
  # every Mac the group needs, or with an empty one run everyone's check on
  # this Mac (Codex's reviews). With nothing configured or asked for, it's the
  # holder's, as before.
  GROUP_HOSTS=""
  if [ -n "${THREADBEAR_CHECK_GROUP:-}${THREADBEAR_CHECK_PREFER:-}" ]; then
    GROUP_HOSTS="$(configured_hosts)"
    [ -n "$GROUP_HOSTS" ] || GROUP_HOSTS="${THREADBEAR_CHECK_PREFER:-}"
  fi
  if [ -n "$GROUP_HOSTS" ]; then
    CHECK_HOST="$GROUP_HOSTS"
  elif [ -n "${THREADBEAR_CHECK_HOST+set}" ]; then
    CHECK_HOST="$THREADBEAR_CHECK_HOST"
  else
    CHECK_HOST="$(configured_hosts)"
  fi
  # THREADBEAR_CHECK_HOST_ONLY: a run that's for a check host or nowhere. tb
  # land sets it for the runs that look for the landing that broke a group
  # (--only, above): those are in a checkout of its own with no packages
  # installed, and several in a row on the Mac someone's working on would be
  # worse than the halving it falls back to. 4, with no step having failed,
  # is nobody's fault.
  if [ -z "$CHECK_HOST" ] && [ -n "${THREADBEAR_CHECK_HOST_ONLY:-}" ]; then
    echo "No check host is set, and this run was only for one."
    exit 4
  fi
  if [ -n "$CHECK_HOST" ]; then
    "$ROOT/scripts/check-remote.sh" "$CHECK_HOST" ${ARGS[@]+"${ARGS[@]}"}
    code=$?
    [ "$code" = 255 ] || exit "$code"
    if [ -n "${THREADBEAR_CHECK_HOST_ONLY:-}" ]; then
      echo "No check host could take it, and this run was only for one."
      exit 4
    fi
    echo "So the checks run on this Mac instead, at low priority."
    # How low is runner.json's jobPriority (runner/src/background.ts), or
    # THREADBEAR_JOB_PRIORITY: background is taskpolicy -b (Mike's, for his
    # M5), low (the default) nice. taskpolicy is macOS's; a Linux runner's
    # self-update (deploy.mjs) gets here too, and there nice does the job
    # (Codex, 9 Nov). THREADBEAR_CHECK_FALLBACK tells it this is the Mac
    # someone's working on.
    export THREADBEAR_CHECK_FALLBACK=1
    PRIORITY="${THREADBEAR_JOB_PRIORITY:-}"
    case "$PRIORITY" in background|low|normal) ;; *)
      PRIORITY="$( [ -x "$NODE" ] && [ -f "$RUNNER_JSON" ] && "$NODE" -e '
        try { const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).jobPriority; if (["background", "low", "normal"].includes(p)) console.log(p) } catch {}' "$RUNNER_JSON")" ;;
    esac
    # nice adds to what it's run at, and tb land and the runner's update
    # already nice this at low, so a check that's at 10 or more stays as it
    # is rather than going to the bottom (Codex's review, 11 Nov).
    NICENESS="$(ps -o nice= -p $$ 2>/dev/null | tr -d ' ')"
    case "$PRIORITY" in
      normal) exec "$0" --local ${ARGS[@]+"${ARGS[@]}"} ;;
      background) if command -v taskpolicy >/dev/null 2>&1; then exec taskpolicy -b "$0" --local ${ARGS[@]+"${ARGS[@]}"}; fi ;;
    esac
    [ "${NICENESS:-0}" -ge 10 ] 2>/dev/null && exec "$0" --local ${ARGS[@]+"${ARGS[@]}"}
    exec nice -n 10 "$0" --local ${ARGS[@]+"${ARGS[@]}"}
  fi
elif [ "$E2E" = 1 ] && [ "$LOCAL" = 0 ]; then
  echo "--e2e runs on this Mac, which has the claude login it needs."
fi

export PATH="$(dirname "$NODE"):$PATH"
export THREADBEAR_NODE="$NODE"
FALLBACK="${THREADBEAR_CHECK_FALLBACK:-}"
# Inside a Threadbear thread these name the live runner and the thread.
# Every test makes its own temp data dir; none may find the real one.
# THREADBEAR_CHECK_BUSY_EXIT is only for sending this run to a host: the
# check-remote tests run under it would otherwise exit with it (Codex, 9 Nov).
unset THREADBEAR_HOME THREADBEAR_DATA_DIR THREADBEAR_PORT THREADBEAR_URL THREADBEAR_LOG \
  THREADBEAR_THREAD_ID THREADBEAR_THREAD_KEY THREADBEAR_RUNNER_VERSION THREADBEAR_RUNNER_HOME THREADBEAR_CHECK_BUSY_EXIT THREADBEAR_CHECK_FALLBACK \
  THREADBEAR_CHECK_PREFER THREADBEAR_CHECK_GROUP THREADBEAR_CHECK_ONLY THREADBEAR_CHECK_HOST_ONLY
# And their old names, which the runner and tb would otherwise take for these.
for v in $(compgen -e | grep '^THREADBARE_' || true); do unset "$v"; done
# The jobs the tests' runners start get no lower than the check itself
# already is, and no test reads the real runner.json for it.
export THREADBEAR_JOB_PRIORITY=normal
# No runner a check starts may install or update a CLI.
export THREADBEAR_CLI_UPDATES=off
# Nor write to the real Convex project (the sync e2e points its own runner
# at a local deployment with THREADBEAR_SYNC_URL).
export THREADBEAR_SYNC=off

# What this checkout changes from main: committed since they parted, plus
# anything uncommitted or untracked. Empty on main itself.
if [ -n "${THREADBEAR_CHECK_CHANGED_FILE:-}" ]; then
  # On a check host: worked out on the Mac that sent the copy, which has
  # no .git (scripts/check-remote.sh).
  CHANGED="$(cat "$THREADBEAR_CHECK_CHANGED_FILE")"
else
CHANGED="$( {
  base="$(git -C "$ROOT" merge-base HEAD main 2>/dev/null)" && git -C "$ROOT" diff --name-only "$base"
  git -C "$ROOT" ls-files --others --exclude-standard
} 2>/dev/null | sort -u)"
fi

# needed <regex>: whether a step whose inputs match it should run.
needed() {
  [ "$ALL" = 1 ] || [ -z "$CHANGED" ] || printf '%s\n' "$CHANGED" | grep -qE "$1|^check\.sh$"
}

# swift_needed [<regex>]: whether the frozen Swift app's build and tests
# should run: with --app or --all, or when something it builds from changed
# (<regex>, else SWIFT_NEEDS). Unlike needed, not on main with nothing
# changed, nor for a change to this file.
# grep to /dev/null rather than -q: -q stops reading at the first match, and
# with pipefail the grep -v before it then fails on the closed pipe (Codex's
# review, 12 Nov: a few thousand changed files said "nothing changed").
#
# What it builds from: app/ and dock/, and the iPhone kit's Swift files and
# Sentry's package that app/ links to (found from its links, as below). Not
# what the GPUI app shares with it (the mock runner, shared/'s art and Pele):
# the Swift app is frozen, and a change to those doesn't build it. The mock
# runner's own Swift tests still run (swift-freeze.sh --mock-tests).
ROOT_REAL="$(cd "$ROOT" && pwd -P)"
# links_out <folder> <into-regex>: the files and folders <folder>'s links
# lead to outside it, matching <into-regex>, as a regex of paths.
links_out() {
  local from="$1" into="$2" link to dir out=""
  while IFS= read -r link; do
    to="$(readlink "$link")"
    dir="$(cd "$(dirname "$link")" && cd "$(dirname "$to")" 2>/dev/null && pwd -P)" || continue
    case "$dir/" in "$ROOT_REAL/$from"/*|"$ROOT_REAL/$from/") continue ;; "$ROOT_REAL"/*) ;; *) continue ;; esac
    to="$dir/$(basename "$to")"
    to="${to#"$ROOT_REAL"/}"
    printf '%s\n' "$to" | grep -E "$into" >/dev/null || continue
    out="$out|^$(printf '%s' "$to" | sed 's/[][\\.*^$()+?{}|]/\\&/g')"
    [ -d "$ROOT_REAL/$to" ] && out="$out/"
  done < <(find "$ROOT_REAL/$from" -type l -not -path '*/.build/*' 2>/dev/null)
  printf '%s' "$out"
}
SWIFT_NEEDS="^(app|dock)/$(links_out app '^ios/')"
swift_needed() {
  [ "$ALL" = 1 ] || [ "$APP_ONLY" = 1 ] \
    || printf '%s\n' "$CHANGED" | grep -E "${1:-$SWIFT_NEEDS}" >/dev/null
}

# What the iPhone kit's tests cover: ios/, the shared cases, and anything
# outside ios/ that ThreadbearKit builds through links (none since 21 Nov
# 2026, when the Swift files it linked from app/ moved into it; the Mac app
# links to them now). On 9 Nov a change to one under app/ used a type the
# kit didn't have, the kit's tests didn't run as nothing under ios/ had
# changed, and the iPhone app stopped building on main.
IOS_NEEDS="^ios/|^shared/cases/$(links_out ios '.')"

skip() {
  printf 'skip  %-20s (%s; --all runs it)\n' "$1" "$2"
}

# Swift's test modules (XCTest, Testing) come with Xcode, not the Command
# Line Tools: with only those, swift test can't build a test target, so its
# steps are skipped and say why (the app's build still runs).
# (An if, not a case: patch trust follows check.sh, and it reads no case.)
XCODE_DIR="${DEVELOPER_DIR:-}"
if [ -z "$XCODE_DIR" ]; then XCODE_DIR="$(xcode-select -p 2>/dev/null || true)"; fi
NO_XCODE=""
if [ -z "$XCODE_DIR" ] || [ "${XCODE_DIR%/CommandLineTools}" != "$XCODE_DIR" ]; then NO_XCODE=1; fi
swift_test_step() {
  if [ -n "$NO_XCODE" ]; then
    printf 'skip  %-20s (needs Xcode; only the Command Line Tools are here)\n' "$1"
  else
    step "$@"
  fi
}

TMP_ROOT="${TMPDIR:-/tmp}"
LOGS="$(mktemp -d "${TMP_ROOT%/}/threadbear-check.XXXXXX")"
FAILED=""

# only_entry <step>: --only's entry for it ("name" or "name=files"), failing
# when --only was given and doesn't name it. (Loops, not a case: step names
# have spaces and brackets in them.)
only_entry() {
  [ -n "$ONLY" ] || return 0
  local rest="$ONLY;" e
  while [ -n "$rest" ]; do
    e="${rest%%;*}"
    rest="${rest#*;}"
    if [ "${e%%=*}" = "$1" ]; then
      printf '%s' "$e"
      return 0
    fi
  done
  return 1
}
# ran_asked <step>: notes a step --only named as run, for the line a run
# with --only ends with. tb land runs what failed on main too before it
# blames a landing, and exit 0 alone wouldn't tell main passing a step from
# main skipping it (the Swift steps never run on main with nothing changed).
ONLY_RAN=""
ran_asked() {
  if [ -n "$ONLY" ] && only_entry "$1" >/dev/null; then ONLY_RAN="$ONLY_RAN${ONLY_RAN:+;}$1"; fi
}
# left_out <step>: says so and succeeds when --only leaves the step out. The
# steps that install packages always run: they aren't checks, and the ones
# asked for need them.
left_out() {
  [ "${1% packages}" = "$1" ] || return 1
  only_entry "$1" >/dev/null && return 1
  printf 'skip  %-20s (--only left it out)\n' "$1"
}

# step <name> <dir> <command...>: runs it with its output in a log file.
step() {
  local name="$1" dir="$2"
  if left_out "$name"; then return; fi
  ran_asked "$name"
  shift 2
  local log="$LOGS/$(printf '%s' "$name" | tr -c 'a-zA-Z0-9' '-').log"
  local start=$SECONDS
  if (cd "$dir" && "$@") >"$log" 2>&1; then
    printf 'ok    %-20s %4ss\n' "$name" "$((SECONDS - start))"
  else
    printf 'FAIL  %-20s %4ss  %s\n' "$name" "$((SECONDS - start))" "$log"
    FAILED="$FAILED$name|$log
"
  fi
}

# The Swift steps run through this, as one frozen test holds the check host
# and so every thread's landing (scripts/limit-step.mjs says how it tells, and
# app/Tests/ModalGuard is the quicker catch for a modal). Each test prints when
# it starts, so 10 minutes of nothing is plenty even on a loaded machine, and a
# build from cold takes 5 to 10 minutes in all but keeps printing.
# NSUnbufferedIO is what makes xctest print as it goes when it isn't on a
# terminal: without it a frozen run's log doesn't say which test.
export NSUnbufferedIO=YES
LIMITED=("$NODE" "$ROOT/scripts/limit-step.mjs"
  --silence "${THREADBEAR_CHECK_SILENCE_SECS:-600}" --total "${THREADBEAR_CHECK_TOTAL_SECS:-3600}" --)

# The runner's unit tests, as `npm test` runs them (runner/package.json),
# plus a reporter that writes the files with a failure. Plenty of them
# start real processes with real timeouts, and on a loaded machine those
# fail with nothing wrong: six did at once, taking 13 to 145 s, while other
# threads built the app on the M5 (6 Nov). So when a few files failed, just
# those run again, one file at a time; passing then counts, but the step
# says which tests needed it, so one that keeps turning up gets fixed. A
# test that fails on its own as well still fails the step.
RERUN_MAX_FILES=8
UNIT_FAILED_FILES=""
runner_unit_tests() {
  local name="runner unit tests" dir="$ROOT/runner"
  local log="$LOGS/runner-unit-tests.log" list="$LOGS/runner-unit-tests.failed"
  local start=$SECONDS
  if left_out "$name"; then return; fi
  # (Run, for --only's last line, also when none of its files are here:
  # files this checkout doesn't have are files it can't fail.)
  ran_asked "$name"
  # All of them, or the files --only names for this step. One this checkout
  # doesn't have can't fail here: tb land runs a group's failed files on each
  # of its landings alone, and another landing's new test isn't in this one.
  local targets=("test/unit/**/*.test.ts") asked f
  asked="$(only_entry "$name")"
  if [ "$asked" != "${asked#*=}" ]; then
    targets=()
    set -f
    for f in ${asked#*=}; do
      if [ "${f#test/unit/}" != "$f" ] && [ "${f%.test.ts}" != "$f" ] && [ "${f#*..}" = "$f" ] && [ -f "$dir/$f" ]; then
        targets+=("$f")
      fi
    done
    set +f
    if [ "${#targets[@]}" = 0 ]; then
      printf 'skip  %-20s (none of the files --only names are in this checkout)\n' "$name"
      return
    fi
  fi
  local run=(node --import=./test/helpers/clean-env.ts --test --test-timeout=300000 --test-force-exit --test-reporter=spec)
  if (cd "$dir" && "${run[@]}" --test-reporter-destination=stdout \
      --test-reporter=./test/helpers/failed-files-reporter.mjs --test-reporter-destination="$list" \
      "${targets[@]}") >"$log" 2>&1; then
    printf 'ok    %-20s %4ss\n' "$name" "$((SECONDS - start))"
    return
  fi
  local files=()
  [ -f "$list" ] && while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done <"$list"
  # For the --only line a failed run ends with: the files, when they're few
  # enough to have been run again and are plain test paths.
  if [ "${#files[@]}" -ge 1 ] && [ "${#files[@]}" -le "$RERUN_MAX_FILES" ]; then
    # The reporter gives whole paths; --only takes them from runner/, as
    # another checkout (and a check host's copy) is somewhere else.
    local real rel=()
    real="$(cd "$dir" && pwd -P)"
    for f in "${files[@]}"; do
      f="${f#"$dir"/}"
      rel+=("${f#"$real"/}")
    done
    UNIT_FAILED_FILES="${rel[*]}"
    if ! plain "$UNIT_FAILED_FILES" '^test/unit/[A-Za-z0-9._/-]+( test/unit/[A-Za-z0-9._/-]+)*$'; then UNIT_FAILED_FILES=""; fi
  fi
  if [ "${#files[@]}" -ge 1 ] && [ "${#files[@]}" -le "$RERUN_MAX_FILES" ]; then
    local relog="$LOGS/runner-unit-tests-again.log"
    if (cd "$dir" && "${run[@]}" --test-concurrency=1 "${files[@]}") >"$relog" 2>&1; then
      printf 'ok    %-20s %4ss  (passed on a second run of the files that failed:)\n' "$name" "$((SECONDS - start))"
      # The tests that failed the first time: the spec reporter's ✖ lines,
      # once each (its summary at the end repeats them).
      sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$log" | grep -E '^[[:space:]]*✖ ' | grep -v '✖ failing tests:' | sed -E 's/^[[:space:]]*/        /' | sort -u | head -n 12
      return
    fi
    printf 'FAIL  %-20s %4ss  %s (failed again on its own; the whole run: %s)\n' "$name" "$((SECONDS - start))" "$relog" "$log"
    FAILED="$FAILED$name|$relog
"
    return
  fi
  printf 'FAIL  %-20s %4ss  %s\n' "$name" "$((SECONDS - start))" "$log"
  FAILED="$FAILED$name|$log
"
}

# Run latency checks before the bulk runner tests put pressure on the Mac.
# The iPhone app's logic and source checks (ios/ThreadbearKit), on the Mac.
# The app itself only builds with Xcode; ios/scripts/sim-shots.sh does that.
# Convex's Swift library (convex-swift) ships for Apple silicon only, so
# on an Intel Mac the kit can't build at all.
if [ "$RUNNER_ONLY" = 1 ]; then
  :
elif [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" != arm64 ]; then
  printf 'skip  %-20s (%s)\n' "iphone kit tests" "Convex's Swift library is Apple silicon only"
elif needed "$IOS_NEEDS"; then
  # The kit measures per-update latency. Run its cases one at a time so
  # unrelated tests do not consume that measurement's CPU and actor time.
  swift_test_step "iphone kit tests" "$ROOT/ios/ThreadbearKit" "${LIMITED[@]}" swift test --disable-keychain --no-parallel
else
  skip "iphone kit tests" "nothing in ios/ changed"
fi

if [ "$APP_ONLY" = 0 ]; then
  if [ ! -d "$ROOT/runner/node_modules" ]; then
    step "runner packages" "$ROOT/runner" npm ci --no-audit --no-fund
  fi
  step "runner typecheck" "$ROOT/runner" npm run typecheck
fi
if [ "$APP_ONLY" = 0 ] && [ "$RUNNER_ONLY" = 0 ]; then
  # The app's Node tools (the tour's end-to-end test, the mock runner)
  # aren't typechecked or run here: at least they have to parse. A quote
  # slip in tour-e2e.mjs went unnoticed until it was next run (2 Nov).
  step "app tools parse" "$ROOT" bash -c 'for f in app/Tools/*.mjs mock-runner/*.mjs; do node --check "$f" || exit 1; done'
  # The Convex functions (convex/), against the generated types in git.
  if [ ! -d "$ROOT/node_modules" ]; then
    step "convex packages" "$ROOT" npm ci --no-audit --no-fund
  fi
  step "convex typecheck" "$ROOT" npm run convex:typecheck
  step "web typecheck" "$ROOT" npm run web:typecheck
  step "web tests" "$ROOT" npm run web:test
  # ESLint with mikecann-lint's rules (eslint.config.mjs; old problems are
  # recorded in eslint-suppressions.json). The whole thing takes about 40 s
  # and 3 GB, so a landing lints only the code files it changed, and all of
  # it when the lint setup or packages changed, with --all, or on main.
  # Old problems fixed by hand don't fail it (--pass-on-unpruned-suppressions):
  # `npx eslint . --prune-suppressions` tidies the file whenever.
  # grep to /dev/null, not -q (see swift_needed).
  if [ "$ALL" = 1 ] || [ -z "$CHANGED" ] \
    || printf '%s\n' "$CHANGED" | grep -E '^(eslint\.config\.mjs|eslint-suppressions\.json|package(-lock)?\.json)$' >/dev/null; then
    # Node's own heap limit (about 2 GB) is under what the whole lint takes,
    # and it died out of memory on the cloud box (21 Nov 2026).
    step "lint" "$ROOT" env NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096" npm run lint:files -- .
  else
    LINT_FILES=()
    while IFS= read -r f; do
      if [ -f "$ROOT/$f" ]; then LINT_FILES+=("$f"); fi
    done < <(printf '%s\n' "$CHANGED" | grep -E '\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$' || true)
    if [ "${#LINT_FILES[@]}" -gt 0 ]; then
      step "lint" "$ROOT" npm run lint:files -- "${LINT_FILES[@]}"
    else
      skip "lint" "no code changed"
    fi
  fi
  # The public site (site/) makes its docs pages from docs/guide.md (and the
  # experiments list from docs/experiments.md), and its build refuses some
  # guide content: a section with no icon in site/docs-icons.json, a link
  # that isn't #slug or https://. Twice on 13 Nov a guide change landed that
  # it refused, and only the next deploy found out. Plain node, no packages
  # and no git (--check), well under a second.
  if needed '^site/|^docs/(guide|experiments)\.md$'; then
    step "site build" "$ROOT/site" node scripts/build.mjs --check
  else
    skip "site build" "nothing the site reads changed"
  fi
  # The GPUI specs (features/) line up with their step files, and every
  # scenario has a features.md id tag of its own: the Desktop workflow's
  # first step. On 13 Nov a spec tagged on its Feature line only passed
  # tb land, then failed that workflow on all three systems and held up
  # every desktop landing after it. Plain node, no packages, under a second.
  if needed '^features/|^docs/gpui-port/features\.md$'; then
    step "feature pairing" "$ROOT/features" node verify-pairing.mjs
  else
    skip "feature pairing" "no spec, step file or features.md changed"
  fi
  # The specs' steps and tools are TypeScript Node runs as it is, so a type
  # error in one showed up only when the Desktop workflow ran that spec
  # (features/tsconfig.json). A few seconds.
  if needed '^features/|^desktop/scripts/own-folder\.ts$'; then
    if [ ! -d "$ROOT/features/node_modules" ]; then
      step "features packages" "$ROOT/features" npm ci --no-audit --no-fund
    fi
    step "features typecheck" "$ROOT/features" npm run typecheck
  else
    skip "features typecheck" "nothing under features/ changed"
  fi
fi
if [ "$APP_ONLY" = 0 ]; then
  runner_unit_tests
  if [ "$QUICK" = 0 ]; then
    if needed '^runner/(scripts/|launch\.mjs$|launcher/|test/deploy/)'; then
      step "runner deploy tests" "$ROOT/runner" bash test/deploy/run.sh
    else
      skip "runner deploy tests" "nothing they cover changed"
    fi
  fi
fi
# The desktop app's Rust (desktop/, the GPUI port), when something it reads
# changed: desktop/ itself, the mock runner its client's tests start and the
# runner code that mock imports (and the icon it serves), the shared cases
# core's tests read, and the art and diagram library (Pele) the GPUI app
# builds in. Nothing ran it before, and
# on 11 Nov a GPUI change that built a file:// URL outside the open gate
# landed on main, exactly what core's open_gate_source test is there to catch.
# --quick runs the small crates' tests (the core logic, the golden
# transcripts, the open-gate source check, the client against the mock),
# which build without GPUI, and a cargo check of the GPUI app when
# something it builds from changed. The full check also builds everything else
# (cargo check of the GPUI app, the dock and every test), a few minutes from
# cold. On a check host cargo's target folder is kept between runs
# (scripts/check-remote.sh), so --quick stays about a minute.
DESKTOP_NEEDS='^desktop/|^rust-toolchain\.toml$|^features/support/sample\.png$|^site/app-doc-slugs\.json$|^mock-runner/|^runner/src/|^shared/cases/|^shared/art/|^shared/rich/|^shared/icons/'
# What cargo builds from outside desktop/ (include_bytes!, include_str!), folders
# or files, for the hashing below.
DESKTOP_BUILT_IN=(shared/art shared/rich site/app-doc-slugs.json features/support/sample.png)
#
# That kept target is shared by every checkout that sends a run, and cargo
# calls a crate fresh when none of its files is newer than its last build: a
# checkout whose edit is older than another checkout's last build would be
# tested as that build. So there (THREADBEAR_CHECK_SHARED_TARGET) what cargo
# builds from is hashed before each cargo step, and any file that differs from
# what that step last built (or all of them, with no record) is touched to now.
# A record per step, as `cargo test` and `cargo check` build different things:
# a --quick run brings core's tests up to date, not the GPUI app's check. The
# record goes before cargo starts and comes back only when the step passed, so
# a run that failed or was cut short (a bad manifest, a killed build) touches
# everything that differs again next time (Codex's review).
cargo_step() {
  local name="$1" sums="" record="" before="$FAILED"
  # Before anything below: a step --only leaves out builds nothing, so it
  # mustn't write down these files as what the shared target was built from.
  if left_out "$name"; then return; fi
  shift
  if [ -z "$CARGO" ]; then
    if [ -n "${THREADBEAR_CHECK_CHANGED_FILE:-}" ]; then
      # On a check host a skip would let a desktop change land unchecked.
      local log="$LOGS/$(printf '%s' "$name" | tr -c 'a-zA-Z0-9' '-').log"
      echo "No cargo on this check host, and something desktop/ reads changed: rustup.rs installs it." >"$log"
      printf 'FAIL  %-20s       %s\n' "$name" "$log"
      FAILED="$FAILED$name|$log
"
    else
      printf 'skip  %-20s (no cargo here: rustup.rs installs it)\n' "$name"
    fi
    return
  fi
  if [ "${THREADBEAR_CHECK_SHARED_TARGET:-}" = 1 ] && [ -n "${CARGO_TARGET_DIR:-}" ]; then
    mkdir -p "$CARGO_TARGET_DIR"
    record="$CARGO_TARGET_DIR/.check-sums-$(printf '%s' "$name" | tr -c 'a-zA-Z0-9' '-')"
    sums="$LOGS/desktop-sums"
    local old="$LOGS/desktop-sums-old" inputs=(desktop) d
    for d in "${DESKTOP_BUILT_IN[@]}"; do [ ! -e "$ROOT/$d" ] || inputs+=("$d"); done
    if [ -f "$record" ]; then mv "$record" "$old"; else : >"$old"; fi
    if ! (cd "$ROOT" && find "${inputs[@]}" \( -type f -o -type l \) -not -path 'desktop/target/*' -print0 | xargs -0 shasum -a 256 | LC_ALL=C sort) >"$sums" \
      || ! LC_ALL=C comm -23 "$sums" "$old" | sed -E 's/^[0-9a-f]+  //' | (cd "$ROOT" && while IFS= read -r f; do touch "$f" || exit 1; done); then
      # Couldn't tell what changed: everything is new, and no record is kept.
      (cd "$ROOT" && find "${inputs[@]}" \( -type f -o -type l \) -not -path 'desktop/target/*' -exec touch {} +)
      record=""
    fi
  fi
  step "$name" "$ROOT/desktop" "${LIMITED[@]}" "$CARGO" "$@"
  [ -z "$record" ] || [ "$FAILED" != "$before" ] || mv "$sums" "$record"
}
# desktop/'s Rust as cargo fmt writes it (desktop/rustfmt.toml, with the
# rustfmt of rust-toolchain.toml), --quick included: no build, a few seconds,
# so it runs wherever this does, this Mac included. The log ends with the fix.
if [ "$APP_ONLY" = 0 ] && [ "$RUNNER_ONLY" = 0 ]; then
  if needed '^desktop/|^rust-toolchain\.toml$'; then
    FMT_CARGO="$(command -v cargo || true)"
    [ -n "$FMT_CARGO" ] || [ ! -x "$HOME/.cargo/bin/cargo" ] || FMT_CARGO="$HOME/.cargo/bin/cargo"
    if [ -n "$FMT_CARGO" ]; then
      step "desktop format" "$ROOT/desktop" bash -c '"$1" fmt --all -- --check && exit 0
        printf "\ndesktop/ is not formatted as cargo fmt writes it (the diff is above).\nFix: cd desktop && cargo fmt --all, then commit what it changed.\n"
        exit 1' _ "$FMT_CARGO"
    elif [ -n "${THREADBEAR_CHECK_CHANGED_FILE:-}" ]; then
      log="$LOGS/desktop-format.log"
      echo "No cargo on this check host, and desktop/ changed: rustup.rs installs it." >"$log"
      printf 'FAIL  %-20s       %s\n' "desktop format" "$log"
      FAILED="${FAILED}desktop format|$log
"
    else
      skip "desktop format" "no cargo here: rustup.rs installs it"
    fi
  else
    skip "desktop format" "nothing in desktop/ changed"
  fi
fi
if [ "$APP_ONLY" = 0 ] && [ "$RUNNER_ONLY" = 0 ]; then
  if ! needed "$DESKTOP_NEEDS"; then
    skip "desktop core tests" "nothing desktop/ reads changed"
  elif [ "$FALLBACK" = 1 ] || { [ "$E2E" = 1 ] && [ "$LOCAL" = 0 ]; }; then
    # This is the Mac someone's working on (no check host could take the run,
    # or --e2e, which runs here for the claude login), and Rust builds stay
    # off it (AGENTS.md): desktop/scripts/remote.sh runs them. A landing that
    # changes desktop/ fails rather than go in unchecked; one that only
    # touches the runner code the mock imports doesn't wait for a host.
    why="Rust builds stay off this Mac; desktop/scripts/remote.sh <host> -- bash -c 'cd desktop && cargo test -p threadbear-core -p threadbear-client'"
    # (Not `needed`: on main, with nothing changed, it says yes to everything.)
    if [ "$FALLBACK" = 1 ] && printf '%s\n' "$CHANGED" | grep -q '^desktop/'; then
      log="$LOGS/desktop-core-tests.log"
      echo "No check host could take this run. $why" >"$log"
      printf 'FAIL  %-20s       %s\n' "desktop core tests" "$log"
      FAILED="${FAILED}desktop core tests|$log
"
    else
      printf 'skip  %-20s (%s)\n' "desktop core tests" "$why"
    fi
  else
    CARGO="$(command -v cargo || true)"
    [ -n "$CARGO" ] || [ ! -x "$HOME/.cargo/bin/cargo" ] || CARGO="$HOME/.cargo/bin/cargo"
    # The client's tests start the mock runner, which needs its packages.
    if [ -n "$CARGO" ] && [ ! -d "$ROOT/mock-runner/node_modules" ]; then
      step "mock runner packages" "$ROOT/mock-runner" npm ci --no-audit --no-fund
    fi
    cargo_step "desktop core tests" test --locked --no-fail-fast -p threadbear-core -p threadbear-client
    # Clippy over the whole workspace, with desktop/Cargo.toml's
    # [workspace.lints] (each says why it's there) and desktop/clippy.toml,
    # --quick included, when the Rust or the toolchain changed: a warning
    # fails it.
    if needed '^desktop/|^rust-toolchain\.toml$'; then
      lint_before="$FAILED"
      cargo_step "desktop lint" clippy --locked --workspace --all-targets -- -D warnings
      if [ "$FAILED" != "$lint_before" ] && [ -f "$LOGS/desktop-lint.log" ]; then
        printf '\nClippy found the problems above. To see them: cd desktop && cargo clippy --workspace --all-targets -- -D warnings\n(desktop/Cargo.toml says what each lint is for; an exception needs #[expect(clippy::..., reason = "...")]).\n' >>"$LOGS/desktop-lint.log"
      fi
    else
      skip "desktop lint" "nothing in desktop/ changed"
    fi
    # The GPUI app itself, which the core tests never build: main's app
    # stopped compiling twice in the week to 13 Nov (tour.rs's
    # panel_available, fixed in 92c48ee73) with every landing's --quick
    # green. With automation on, as the specs and dev apps build it, and its
    # tests, so a test module that stopped compiling fails here too. Only
    # when something it builds from changed: the runner code the mock
    # imports can't break it.
    if [ "$QUICK" = 1 ] && needed '^desktop/|^shared/(art|rich)/|^features/support/sample\.png$'; then
      cargo_step "desktop app check" check --locked -p threadbear-gpui --features automation --all-targets
      # And as it's installed (install-app.sh, stage-update.sh: frame-stats,
      # no automation), so code that slips out of its automation cfg fails
      # here rather than in self-update. Two forks' updates were stuck on
      # just that (emilsbauga's and TeeLusk's, 14 to 16 Nov).
      cargo_step "desktop app check (as installed)" check --locked -p threadbear-gpui --features frame-stats
    fi
    [ "$QUICK" = 1 ] || cargo_step "desktop build" check --locked --workspace --all-targets
  fi
fi
# --quick (what `tb land` runs) builds the Mac app too when app/ or dock/
# changed: in release, as the installed app's self-update and app/install.sh
# build it (app/build-app.sh), so debug-only code that slips out of its
# #if DEBUG fails here. It did twice on main (28 and 29 Oct), and Mike's
# self-update was stuck on an older build for a day. No tests, so it's a
# minute or so on a warm build folder. The full check's own debug build and
# tests cover the rest.
if [ "$QUICK" = 1 ] && [ "$RUNNER_ONLY" = 0 ]; then
  if swift_needed; then
    step "app release build" "$ROOT/app" "${LIMITED[@]}" swift build -c release --product Threadbear --disable-keychain
  else
    skip "app release build" "the Swift app is frozen and nothing it builds changed"
  fi
fi
# The Swift tests that read the mock runner the GPUI app shares, by
# themselves, --quick included, when the mock or they changed: the mock's
# demo data was renamed on 15 Nov and three MockRunnerTests broke on main,
# as nothing here ran them (the mock counts as GPUI-shared, so it doesn't
# build the Swift app). The full check's own app tests cover them when it
# runs those. Not on main with nothing changed, as swift_needed.
read -r -d '' SWIFT_MOCK_NEEDS SWIFT_MOCK_FILTER < <("$ROOT/scripts/swift-freeze.sh" --mock-tests 2>/dev/null; printf '\0')
if [ "$RUNNER_ONLY" = 0 ] && [ -n "$SWIFT_MOCK_NEEDS" ] && [ -n "$SWIFT_MOCK_FILTER" ] \
  && ! { [ "$QUICK" = 0 ] && swift_needed; } \
  && { [ "$ALL" = 1 ] || printf '%s\n' "$CHANGED" | grep -E "$SWIFT_MOCK_NEEDS" >/dev/null; }; then
  # --e2e runs on the Mac someone's working on, for its claude login, and a
  # test target's first build is minutes of Swift: leave these to the check
  # that lands it (Codex's review, 15 Nov). With no check host at all
  # (FALLBACK) they still run here, as the app's release build does, rather
  # than let a mock change land unchecked.
  if [ "$E2E" = 1 ] && [ "$FALLBACK" != 1 ]; then
    skip "app mock tests" "--e2e runs on this Mac; ./check.sh --quick runs them on a check host"
  else
  if [ ! -d "$ROOT/mock-runner/node_modules" ]; then
    step "mock runner packages" "$ROOT/mock-runner" npm ci --no-audit --no-fund
  fi
  swift_test_step "app mock tests" "$ROOT/app" env THREADBEAR_REQUIRE_MOCK=1 "${LIMITED[@]}" swift test --disable-keychain --filter "$SWIFT_MOCK_FILTER"
  fi
fi
if [ "$QUICK" = 0 ] && ! swift_needed; then
  skip "app build and tests" "the Swift app is frozen and nothing it builds changed"
elif [ "$QUICK" = 0 ]; then
  # The app's MockRunnerTests run the real WebSocket client (and the
  # runner restart) against the mock, and skip without its packages: in a
  # fresh checkout or worktree they used to skip while this said ok.
  if [ ! -d "$ROOT/mock-runner/node_modules" ]; then
    step "mock runner packages" "$ROOT/mock-runner" npm ci --no-audit --no-fund
  fi
  step "app build" "$ROOT/app" "${LIMITED[@]}" swift build --disable-keychain
  swift_test_step "app tests" "$ROOT/app" env THREADBEAR_REQUIRE_MOCK=1 "${LIMITED[@]}" swift test --disable-keychain
  # BearDock, the window's docking panels: its layout tests.
  if needed '^dock/'; then
    swift_test_step "dock tests" "$ROOT/dock" "${LIMITED[@]}" swift test --disable-keychain
  else
    skip "dock tests" "nothing in dock/ changed"
  fi
fi
if [ "$E2E" = 1 ]; then
  # Claude's first, then Codex's (codex*.e2e.test.ts: the conversation
  # tests and the install test), which TB_E2E_SKIP_CODEX=1 leaves out.
  # One login for every e2e file, named here so a failure says which.
  TB_E2E_ACCOUNT="$("$NODE" "$ROOT/runner/src/test-login.ts")"
  export TB_E2E_ACCOUNT
  echo "e2e login: $TB_E2E_ACCOUNT"
  E2E_RUN=(node --test --test-reporter=spec --test-concurrency=1 --test-timeout=600000)
  CLAUDE_E2E=()
  CODEX_E2E=()
  for f in "$ROOT"/runner/test/e2e/*.test.ts; do
    case "$(basename "$f")" in codex*) CODEX_E2E+=("$f") ;; *) CLAUDE_E2E+=("$f") ;; esac
  done
  step "runner e2e" "$ROOT/runner" "${E2E_RUN[@]}" "${CLAUDE_E2E[@]}"
  if [ "${TB_E2E_SKIP_CODEX:-0}" = 1 ]; then
    echo "skip  codex e2e            (TB_E2E_SKIP_CODEX=1)"
  elif [ "${#CODEX_E2E[@]}" -gt 0 ]; then
    step "codex e2e" "$ROOT/runner" "${E2E_RUN[@]}" "${CODEX_E2E[@]}"
  fi
fi
[ -z "$SHOTS" ] || step "app screenshots" "$ROOT/app" bash Tools/screenshots.sh "$SHOTS"

if [ -n "$FAILED" ]; then
  printf '%s' "$FAILED" | while IFS='|' read -r name log; do
    # The failures themselves first: swift test runs the core tests before
    # the app's, so a failing core test is hundreds of lines above the end
    # of its log (XCTest's "error:" and "failed (", Swift Testing's ✘, the
    # node test runner's ✖ and "not ok", tsc's "error TS").
    # (swift colours its output even into a file, so that comes off first.)
    failures="$(sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$log" | grep -nE ': error[: ]|^error(\[E[0-9]+\])?:|error TS[0-9]|'"'"' failed \(|^not ok|✖|✘|\.\.\. FAILED$|panicked at' | head -n 20)"
    if [ -n "$failures" ]; then
      echo
      echo "--- $name: what failed (line: text) in $log"
      printf '%s\n' "$failures"
    fi
    echo
    echo "--- $name: end of $log"
    tail -n 30 "$log"
  done
  # What failed, as a whole ./check.sh --only command: run by hand it's the
  # quick way to see a fix work. It names check.sh, as tb land takes no
  # --only and an agent told just "--only" tried it there (19 Nov). tb land
  # reads this line off a group's failed check to run
  # just that on each of the group's landings alone (worktrees.ts, findBroken).
  AGAIN=""
  while IFS='|' read -r name log; do
    [ -n "$name" ] || continue
    if [ "$name" = "runner unit tests" ] && [ -n "$UNIT_FAILED_FILES" ]; then name="$name=$UNIT_FAILED_FILES"; fi
    AGAIN="$AGAIN${AGAIN:+;}$name"
  done <<EOF_FAILED
$FAILED
EOF_FAILED
  if [ -n "$AGAIN" ] && plain "$AGAIN" "$ONLY_CHARS"; then
    echo
    echo "To run only what failed again: ./check.sh --only \"$AGAIN\""
  fi
  [ -z "$ONLY" ] || echo "--only ran: \"$ONLY_RAN\""
  echo
  echo "Logs kept in $LOGS; rm -rf it when you're done."
  exit 1
fi
[ -z "$ONLY" ] || echo "--only ran: \"$ONLY_RAN\""
rm -rf "$LOGS"
[ -z "$SHOTS" ] || echo "Screenshots are in $SHOTS."
