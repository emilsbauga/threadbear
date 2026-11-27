#!/bin/bash
# How a check takes its turn on a check host: scripts/check-remote.sh runs
# this there, from the run's copy, in place of locking the host itself.
#
#   bash host-turn.sh <first|after> <now|wait> <check folder> <run id> <host name> <command>
#
# A landing's check (tb land sets THREADBEAR_CHECK_FIRST) goes first: while
# one waits, nothing else that comes in through the host's gate starts
# (other checks, GPUI builds and measurements: scripts/perf-lock.pl, and on
# Tinker Desk `heavy` jobs too). It still waits for what's running to end:
# first in line, not another slot. On 23 Nov landings waited 2.6 hours, with
# every landing behind them, for agents' builds, spec runs and checks that
# came in after them.
#
# A waiting first run marks itself with first/<run id> in the check folder,
# a file it holds a lock on while it waits. --on-host deletes it once the run
# has the host, and check-remote.sh does when it withdraws the run, so a
# marker counts only while it's there and locked: one whose run was killed
# is a file nobody holds, and is passed over (and swept after half a day).
#
# Everything else ("after") lets any such marker go first: it waits while
# one is there before taking the gate, and once it has the gate, looks again
# and gives it back if one came in while it waited (two waiting on a lock
# are let in in no particular order), and so on while it waits there for the
# check lock (builds hold that shared, and with two at once a check could
# otherwise sit at the gate through a whole build, ahead of a landing).
#
# It runs where ssh starts, in $HOME, and so does the command: a --shots
# run's pidfile is a path from there (Codex's review).
#
# Takes the gate, then the check lock, as check-remote.sh did itself: the
# gate (perf-lock.pl) keeps builds that hold the check lock shared from
# keeping a check out. now: without waiting, exit 75 if either is taken (or
# a first run is waiting, for an "after" one).
set -u
kind="${1:?first or after}" when="${2:?now or wait}" base="${3:?check folder}" id="${4:?run id}" name="${5:?host name}" cmd="${6:?command}"
first="$base/first" gate="$base/gate" lock="$base/lock"
mkdir -p "$first" || exit 1
if [ "$(uname -s)" = Darwin ]; then
  # -s quiets contention while a waiter retries. Bad paths and other lock
  # errors still print; the wait itself is explained once below.
  HOLD=(/usr/bin/lockf -k) TRY=(/usr/bin/lockf -s -t 0 -k)
else
  HOLD=(flock) TRY=(flock -n -E 75)
fi

# Whether a first run other than this one is waiting: a marker someone holds.
# Taking its lock for a moment (75: someone has it) is how that's asked; a
# marker deleted meanwhile is made again empty by the lock and held by no one.
first_waiting() {
  local f
  for f in "$first"/*; do
    [ -f "$f" ] || continue
    case "${f##*/}" in "$id" | *.*) continue ;; esac
    "${TRY[@]}" "$f" true 2>/dev/null
    [ $? != 75 ] || return 0
  done
  return 1
}

case "$kind:$when" in
  first:now) exec "${TRY[@]}" "$gate" "${TRY[@]}" "$lock" /bin/sh -c "$cmd" ;;
  first:wait)
    "${TRY[@]}" "$gate" "${TRY[@]}" "$lock" true 2>/dev/null || echo "Waiting for another check on $name to finish..."
    exec "${HOLD[@]}" "$first/$id" "${HOLD[@]}" "$gate" "${HOLD[@]}" "$lock" /bin/sh -c "$cmd" ;;
  after:now)
    ! first_waiting || exit 75
    exec "${TRY[@]}" "$gate" /bin/bash "$0" after inside-now "$base" "$id" "$name" "$cmd" ;;
  after:inside-now)
    ! first_waiting || exit 75
    exec "${TRY[@]}" "$lock" /bin/sh -c "$cmd" ;;
  after:wait)
    "${TRY[@]}" "$gate" "${TRY[@]}" "$lock" true 2>/dev/null || echo "Waiting for another check on $name to finish..."
    said=""
    while :; do
      if first_waiting; then
        [ -n "$said" ] || echo "Letting a landing's check go first on $name..."
        said=1
        sleep 2
        continue
      fi
      rm -f "$first/$id.yielded"
      "${HOLD[@]}" "$gate" /bin/bash "$0" after inside "$base" "$id" "$name" "$cmd"
      rc=$?
      [ -e "$first/$id.yielded" ] || exit "$rc"
      rm -f "$first/$id.yielded"
    done ;;
  after:inside)
    # The check lock, looked at every second rather than waited on, so a
    # landing's check that comes in meanwhile still goes first. The command
    # leaves a note as it starts, so its own exit 75 isn't taken for a busy lock.
    started="$first/$id.started"
    rm -f "$started"
    while :; do
      if first_waiting; then
        : >"$first/$id.yielded"
        exit 75
      fi
      "${TRY[@]}" "$lock" /bin/sh -c ': >"$1"; exec /bin/sh -c "$2"' sh "$started" "$cmd"
      rc=$?
      if [ -e "$started" ]; then
        rm -f "$started"
        exit "$rc"
      fi
      [ "$rc" = 75 ] || exit "$rc"
      sleep 1
    done ;;
  *) echo "host-turn.sh: first or after, then now or wait" >&2; exit 2 ;;
esac
