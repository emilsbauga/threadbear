#!/bin/bash
# Builds the checkout's main into the GPUI app's staged update, which the
# installed app swaps in when it next quits or launches
# (desktop/gpui/src/app_update.rs). The app runs the copy in its bundle a few
# moments after desktop/ changes on main; it's fine to run by hand too:
#
#   desktop/scripts/stage-update.sh <checkout> [--next <dir>]
#
# <checkout> is the repo whose main to build; --next is where the bundle goes
# (default ~/Applications/.Threadbear GPUI.app.next). Only what's committed on
# main is built, from a clone of its own under
# ~/Library/Caches/Threadbear/update-desktop, so nothing an agent has in the
# checkout gets into the app, and an agent's own builds there aren't waited on.
#
# Where it's built: the release build takes every core for minutes, so it can
# go to the first of runner.json's updateBuildHosts that's a Mac and is free
# (remote.sh, as install-app.sh --build-on does), and only the two binaries
# come back; the bundle's made here, signed with this Mac's identity. Whatever
# that host sends back is what this Mac runs next, and nothing here can tell
# it from what main says, so a host is only trusted with that by being named
# in updateBuildHosts: checkHosts, trusted only to run tests, never grants it
# (Daybreak 108, 12 Nov 2026). With update build hosts set but none answering
# it builds nothing and exits 4, and the app tries again at its next look.
# With none of those but check hosts set (a Mac kept free of heavy builds, as
# Mike's MacBook is) it builds nothing at all and exits 5: the app says to name
# an update build host. With neither (anyone else's copy) it builds here, at
# the background priority the app runs it at, as the Swift app's update does.
#
# Exit 0 with the bundle staged, 3 if another run holds the lock, 4 if no Mac
# could build it (none answered, or the one building it went away or ran short
# of disk), 5 if no host is trusted to build it and this Mac doesn't build,
# 1 on a failed build (an earlier staged bundle is left as it was).
# A busy build host (or one with queued measurements) also exits 4: update
# builds try the leases without queueing, so screen tests can go first. But
# not for ever: with agents keeping Tinker Desk busy all day there was never
# a free moment, and 63 tries over a day built nothing while fixes waited on
# main (18 Nov). Once tries have found every host busy for QUEUE_AFTER (45
# minutes; THREADBEAR_UPDATE_QUEUE_AFTER in seconds), the next run queues
# for the first busy host's lease like any other run and builds when its
# turn comes.
set -euo pipefail

CHECKOUT=""
NEXT_DIR="$HOME/Applications/.Threadbear GPUI.app.next"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --next) NEXT_DIR="$2"; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) CHECKOUT="$1" ;;
  esac
  shift
done
[[ -n "$CHECKOUT" && ( -d "$CHECKOUT/.git" || -f "$CHECKOUT/.git" ) ]] || { echo "No checkout to build from (give the repo's path)." >&2; exit 2; }

# Started from the app, PATH is the bare system one: git, ssh, rsync and
# codesign are in /usr/bin, and cargo, for a build here, in ~/.cargo/bin.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.cargo/bin:$PATH"
CACHE="$HOME/Library/Caches/Threadbear/update-desktop"
SRC="$CACHE/src"
LOCK="$CACHE/lock"
mkdir -p "$CACHE"

# One build at a time. The lock holds the pid of the run that has it, so one
# left by a run that died (the app killed mid-build) is taken over at once
# rather than holding up the next for hours.
if ! mkdir "$LOCK" 2>/dev/null; then
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
    echo "Another update build is running (pid $holder)." >&2
    exit 3
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { echo "Another update build has just started." >&2; exit 3; }
fi
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

MAIN="$(git -C "$CHECKOUT" rev-parse --verify -q refs/heads/main)" || { echo "$CHECKOUT has no main branch." >&2; exit 2; }
echo "Staging main ($(git -C "$CHECKOUT" rev-parse --short "$MAIN")) from $CHECKOUT into $NEXT_DIR"

# A clone of the checkout, moved to its main: only the files that changed get
# new times, so the build is incremental wherever it happens.
if [[ ! -d "$SRC/.git" ]]; then
  rm -rf "$SRC"
  git clone -q --no-checkout "$CHECKOUT" "$SRC"
fi
git -C "$SRC" fetch -q "$CHECKOUT" "refs/heads/main"
git -C "$SRC" checkout -q --detach FETCH_HEAD
git -C "$SRC" clean -qfd -e target

# runner.json's updateBuildHosts and checkHosts, from the data folder the app
# uses. A name ssh would read as an option is never one.
CONFIG="${THREADBEAR_HOME:-$HOME/Library/Application Support/Threadbear}/runner.json"
hosts_in() {
  /usr/bin/python3 -I -c 'import json,sys
try: hosts = json.load(open(sys.argv[1])).get(sys.argv[2]) or []
except Exception: hosts = []
if isinstance(hosts, str): hosts = [hosts]
if not isinstance(hosts, list): hosts = []
print("\n".join(h for h in hosts if isinstance(h, str) and h and not h.startswith("-") and h.strip() == h and " " not in h))' "$CONFIG" "$1" 2>/dev/null || true
}
HOSTS="$(hosts_in updateBuildHosts)"
# checkHost, the one a runner.json from before the list has, counts too.
CHECK_HOSTS="$(hosts_in checkHosts)"
[[ -n "$CHECK_HOSTS" ]] || CHECK_HOSTS="$(hosts_in checkHost)"

# When tries first found every trusted host busy, kept until one builds.
DEFERRED="$CACHE/deferred-since"
QUEUE_AFTER="${THREADBEAR_UPDATE_QUEUE_AFTER:-2700}"
[[ "$QUEUE_AFTER" =~ ^[0-9]+$ ]] || QUEUE_AFTER=2700

BINS="$CACHE/bins"
rm -rf "$BINS"
mkdir -p "$BINS"
FEATURES=frame-stats
if [[ -n "$HOSTS" ]]; then
  # A run the host couldn't finish (it went away, ssh's own 255, or remote.sh's
  # disk check said no with 3) is tried again later, as when none answered. One
  # it finished and failed is a broken main: not tried again until main moves.
  # host_gone <rc>: the host couldn't finish, rather than main failing.
  host_gone() {
    [[ "$1" == 3 || "$1" == 255 || "$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" uname -s </dev/null 2>/dev/null || true)" != Darwin ]]
  }
  remote_failed() {
    local rc="$1"
    if [[ "$rc" == 75 ]]; then
      echo "$HOST is busy or has work queued; the app tries the latest main again later." >&2
      exit 4
    fi
    if host_gone "$rc"; then
      echo "$HOST couldn't finish the build (exit $rc: it went away or is short of disk); the app tries again later." >&2
      exit 4
    fi
    # Main is broken: the next try, once main moves, starts the busy clock afresh.
    rm -f "$DEFERRED"
    echo "The build on $HOST failed (exit $rc)." >&2
    exit 1
  }
  # pipefail, so a failed build fails here rather than handing back the last
  # good build's binaries.
  # This Mac's own id in the folders' key on the host (remote.sh): the clone's
  # path is the same on every Mac with the same user name.
  THREADBEAR_REMOTE_KEY="$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/ { print $4; exit }' || true)"
  export THREADBEAR_REMOTE_KEY="${THREADBEAR_REMOTE_KEY:-$(hostname)}"
  # The build says where it built (remote.sh sets CARGO_TARGET_DIR), and the
  # binaries come from there: not a key worked out here, which an older
  # remote.sh in main would disagree with (Codex's second look, 12 Nov).
  out="$CACHE/remote.out"
  # Request it by environment, so rolling main back to an older remote.sh
  # still builds (it ignores the request) instead of running an unknown flag.
  BUILT_ON=""
  BUSY_HOST=""
  # build_on <host> <try>: 1 tries the leases and gives up (75) if busy, 0
  # queues for them. Sets rc.
  build_on() {
    echo "Building on $1$([[ "$2" == 1 ]] || echo ", queued behind whatever it's running")"
    rc=0
    # In the background and waited on, so the app's SIGTERM at quit reaches
    # remote.sh too (its trap stops the run on the host and leaves the
    # lease): bash holds a trap until a foreground child ends, and the lock
    # here would go while an orphan still queued for a build nobody stages.
    # A build only, so it can go beside another on a host that allows that
    # (remote.sh --build), asked for by environment as TRY is.
    THREADBEAR_REMOTE_BUILD=1 THREADBEAR_REMOTE_TRY="$2" "$SRC/desktop/scripts/remote.sh" "$1" -- bash -c "set -o pipefail; cd desktop && nice cargo build --release -p threadbear-gpui --features $FEATURES 2>&1 | tail -3 && echo \"BUILT_IN=\$CARGO_TARGET_DIR\"" </dev/null > "$out" 2>&1 &
    REMOTE_PID=$!
    wait "$REMOTE_PID" || rc=$?
    REMOTE_PID=""
    cat "$out"
  }
  REMOTE_PID=""
  trap '[[ -z "$REMOTE_PID" ]] || { kill -TERM "$REMOTE_PID" 2>/dev/null; wait "$REMOTE_PID" 2>/dev/null; }; exit 143' TERM
  while IFS= read -r HOST; do
    # A Mac that answers within a few seconds, with no prompt to wait on.
    [[ "$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" uname -s </dev/null 2>/dev/null || true)" == Darwin ]] || continue
    build_on "$HOST" 1
    if [[ "$rc" == 75 ]]; then
      echo "$HOST is busy or has work queued; trying the next trusted build host." >&2
      [[ -n "$BUSY_HOST" ]] || BUSY_HOST="$HOST"
      continue
    fi
    # One that went away or is short of disk leaves the rest a chance, and
    # doesn't reset how long the busy ones have been busy.
    if [[ "$rc" != 0 ]] && host_gone "$rc"; then
      echo "$HOST couldn't finish the build (exit $rc: it went away or is short of disk); trying the next trusted build host." >&2
      continue
    fi
    [[ "$rc" == 0 ]] || remote_failed "$rc"
    BUILT_ON="$HOST"
    break
  done <<<"$HOSTS"
  if [[ -z "$BUILT_ON" && -n "$BUSY_HOST" ]]; then
    now="$(date +%s)"
    since="$(cat "$DEFERRED" 2>/dev/null || true)"
    [[ "$since" =~ ^[0-9]+$ && "$since" -le "$now" ]] || { since="$now"; echo "$now" >"$DEFERRED"; }
    if (( now - since >= QUEUE_AFTER )); then
      echo "Every trusted build host has been busy for $(( (now - since) / 60 )) minutes, so this build waits its turn on $BUSY_HOST rather than trying again later." >&2
      HOST="$BUSY_HOST"
      build_on "$HOST" 0
      [[ "$rc" == 0 ]] || remote_failed "$rc"
      BUILT_ON="$HOST"
    fi
  fi
  if [[ -z "$BUILT_ON" ]]; then
    echo "None of the update build hosts ($(tr '\n' ' ' <<<"$HOSTS")) is a Mac that answered and was free, so nothing was built; the app tries again later." >&2
    exit 4
  fi
  rm -f "$DEFERRED"
  built_in="$(sed -n 's/^BUILT_IN=//p' "$out" | tail -1)"
  [[ "$built_in" == /* ]] || { echo "The build on $HOST didn't say where it built." >&2; exit 1; }
  for bin in threadbear-gpui threadbear-web-helper; do
    scp -q "$HOST:$built_in/release/$bin" "$BINS/$bin" || remote_failed "$?"
  done
elif [[ -n "$CHECK_HOSTS" ]]; then
  # Check hosts run tests; they don't get to say what this Mac runs. And a
  # Mac with check hosts keeps its heavy builds off itself, so not here either.
  echo "No update build hosts in $CONFIG, so nothing was built: check hosts ($(tr '\n' ' ' <<<"$CHECK_HOSTS")) only run tests. Add a Mac you trust with what this one runs to \"updateBuildHosts\" there." >&2
  exit 5
else
  echo "No update build hosts or check hosts in $CONFIG: building here."
  BUILT_ON=""
  # The newest stable Rust, which is what desktop.yml builds and tests with:
  # code that needs a recent Rust passes there and then fails partway
  # through a 20-minute build on an older one (the vendored crates alone
  # need 1.85). Through rustup when there is one, whatever its default
  # toolchain is; an update that fails (offline) builds with the stable
  # that's there. Without rustup (Homebrew's rust), the cargo on PATH.
  cargo=(cargo)
  if command -v rustup >/dev/null; then
    if rustup toolchain install stable --profile minimal --no-self-update >/dev/null 2>&1 || rustup run stable cargo --version >/dev/null 2>&1; then
      cargo=(rustup run stable cargo)
    else
      echo "Couldn't get Rust's stable toolchain (rustup toolchain install stable), so building with rustup's default." >&2
    fi
  fi
  (cd "$SRC/desktop" && CARGO_TARGET_DIR="$CACHE/target" CARGO_HTTP_MULTIPLEXING=false CARGO_NET_RETRY=10 "${cargo[@]}" build --release -p threadbear-gpui --features "$FEATURES") || {
    rc=$?
    [[ "${cargo[0]}" == rustup ]] || echo "The build failed with $(cargo --version 2>/dev/null || echo "this Mac's cargo"). Threadbear is built and tested on the newest stable Rust: rustup (https://rustup.rs) keeps one, and this build uses it when it's there." >&2
    exit "$rc"
  }
  cp "$CACHE/target/release/threadbear-gpui" "$CACHE/target/release/threadbear-web-helper" "$BINS/"
fi

# Made beside where it goes and moved in whole, so the app never finds half a
# bundle staged.
THREADBEAR_BUILT_ON="$BUILT_ON" "$SRC/desktop/scripts/make-bundle.sh" "$BINS" "$NEXT_DIR.making" "$CHECKOUT"
# The bundle has its own copies of the binaries (55 MB).
rm -rf "$BINS"
rm -rf "$NEXT_DIR"
mv "$NEXT_DIR.making" "$NEXT_DIR"
echo "Staged $NEXT_DIR; the app swaps it in when it next quits or launches."
