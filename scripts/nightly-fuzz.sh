#!/bin/bash
# Tinker Desk's nightly bug hunt (Mike asked on 18 Nov 2026, after a fuzzing
# experiment: ~/dev/me/misc/threadbear-fuzz on his Mac). From about 11pm to
# 6am it takes turns on the host with everything else, about 10 minutes a
# round, rotating the three tools in features/README.md ("Hunting bugs on
# purpose"): stress rounds under a slow runner, a free model using the app,
# and a random walk with a misbehaving runner. Each night's findings go to
# nights/<date>/ with a summary.json, which a morning job on Mike's Mac reads
# and turns into fix threads (~/dev/me/misc/schedules/threadbear-bug-hunt).
#
#   scripts/nightly-fuzz.sh --install     on Tinker Desk: the LaunchAgent and OpenCode
#   scripts/nightly-fuzz.sh --uninstall   takes both away again, and the nights
#   scripts/nightly-fuzz.sh run [--minutes N]   a night now (N minutes, or until 6am)
#
# Everything lives in ~/.cache/threadbear-check/nightly, as the host is also
# where clean installs of Threadbear get tried: its own copy of main (src/,
# fetched with the read-only deploy key), OpenCode with its config and data
# kept inside opencode/ and on nobody's PATH, and nights/. No sign-ins: the
# free model needs none.
#
# Making way: every round goes through remote.sh's "local" host with --try,
# so it starts only when no check, build or measurement holds the host or is
# waiting for it, and a busy host means trying again in a few minutes. No
# round starts while Poddle's 3am phone tests run (their own lock is never
# taken here), nor in the ten minutes before they start.
set -uo pipefail
base="$HOME/.cache/threadbear-check/nightly"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
label=app.mikecann.threadbear-nightly-fuzz
plist="$HOME/Library/LaunchAgents/$label.plist"
oc_home="$base/opencode"

case "${1:-}" in
  --install)
    mkdir -p "$base/nights" "$oc_home/bin" "$HOME/Library/LaunchAgents"
    [ -x "$oc_home/bin/opencode" ] || { echo "Put OpenCode's binary at $oc_home/bin/opencode first (copied from a Mac that has it)." >&2; exit 1; }
    # Through Desk Runner (~/.local/bin/desk), not straight from launchd: on
    # macOS 27 a process launchd starts can't write in the folders remote.sh's
    # runs made there ("Operation not permitted", 18 Nov), while Desk Runner
    # and ssh sessions can. Fetch main, then run the copy just fetched. The fetch happens here, not
    # in the script, as bash reads a script while it runs it. A failed fetch
    # (no network) runs last night's copy.
    cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string><string>$HOME/.local/bin/desk</string>
    <string>export SHELL=/bin/zsh; cd "$base/src" &amp;&amp; { git fetch -q origin main &amp;&amp; git reset -q --hard FETCH_HEAD; exec /bin/bash scripts/nightly-fuzz.sh run; }</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>23</integer><key>Minute</key><integer>0</integer></dict>
  <key>EnvironmentVariables</key><dict><key>SHELL</key><string>/bin/zsh</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>$base/launchd.log</string>
  <key>StandardErrorPath</key><string>$base/launchd.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    echo "Installed $label: nightly at 23:00, runs in $base."
    exit 0 ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$plist"
    rm -rf "$base"
    echo "Removed $label and $base."
    exit 0 ;;
  run) shift ;;
  *) echo "usage: $0 --install | --uninstall | run [--minutes N]" >&2; exit 2 ;;
esac

minutes=""
[ "${1:-}" != --minutes ] || minutes="${2:?--minutes needs a number}"

# One night at a time.
if [ -z "${NIGHTLY_FUZZ_LOCKED:-}" ]; then
  mkdir -p "$base"
  NIGHTLY_FUZZ_LOCKED=1 exec /usr/bin/lockf -t 0 "$base/.running" /bin/bash "$0" run "$@"
fi

now() { date +%s; }
night="$(date +%F)"
out="$base/nights/$night"
[ -z "$minutes" ] || out="$base/nights/$night-try-$(date +%H%M)"
mkdir -p "$out"
log="$out/night.log"
exec >>"$log" 2>&1
say() { echo "$(date '+%H:%M:%S') $*"; }

if [ -n "$minutes" ]; then
  stop=$(( $(now) + minutes * 60 ))
else
  # 6am tomorrow, or today when started after midnight.
  if [ "$(date +%H)" -lt 12 ]; then stop="$(date -j -v6H -v0M -v0S +%s)"; else stop="$(date -j -v+1d -v6H -v0M -v0S +%s)"; fi
fi
say "night $night from $(git -C "$root" log -1 --format='%h %s' 2>/dev/null | cut -c1-80), until $(date -r "$stop" '+%H:%M')"

. "$root/runner/scripts/find-node.sh"
NODE="$(threadbear_find_node)" || { say "no node"; exit 1; }

# Old nights go after two weeks.
find "$base/nights" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null

poddle_busy() {
  pgrep -f e2e-remote-worker.mjs >/dev/null 2>&1 && return 0
  # Ten minutes before its 3am start: a round then would still be going.
  local hm; hm="$(date +%H%M)"
  [ "$hm" -ge 0250 ] && [ "$hm" -lt 0300 ]
}

# The free model through OpenCode, kept inside opencode/ (XDG folders and all),
# so nothing outside it knows OpenCode is there.
oc_env=(OPENCODE_BIN="$oc_home/bin/opencode" XDG_CONFIG_HOME="$oc_home/config" XDG_DATA_HOME="$oc_home/data"
  XDG_CACHE_HOME="$oc_home/cache" XDG_STATE_HOME="$oc_home/state" OPENCODE_DISABLE_AUTOUPDATE=1)
# OpenCode's free models come and go (GLM 5.3 Flash, the experiment's most
# careful, was withdrawn on 18 Nov, hours after it), so a list: one that says
# it's deprecated or gone is dropped for the night and the next one used.
read -r -a models <<<"${NIGHTLY_FUZZ_MODELS:-deepseek-v4.1-flash-free mimo-v2.6-flash-free minimax-m3.1-flash-free}"
model_i=0
areas=("Sidebar and inbox" "Thread header" "Transcript row kinds" "Composer" "Cards in the composer" "Highlights"
  "Rich content" "Patches panels" "File previews" "Projects, Librarian" "Settings" "Navigation, shortcuts")
conds=(slow slow+dark slow+narrow slow+wide slow+motion order)
agent_backoff_until=0
# OpenCode 2 leaves a background service behind even with --standalone, so
# it's stopped after every model round and when the night ends.
stop_opencode() { pkill -f "$oc_home/bin/opencode" 2>/dev/null || true; }
# A round runs in its own process group (see the cap below), so the night
# ending early has to stop it itself.
pid=""
trap 'stop_opencode; [ -z "$pid" ] || kill -TERM -- "-$pid" 2>/dev/null' EXIT

# NIGHTLY_FUZZ_START=3 starts the rotation at the monkey, for a try.
n=${NIGHTLY_FUZZ_START:-0}; stress_n=0; agent_n=0; busy_waits=0; fast_fails=0
while [ "$(now)" -lt "$stop" ]; do
  if poddle_busy; then say "Poddle's tests are on: waiting"; sleep 300; continue; fi
  left=$(( (stop - $(now)) / 60 ))
  [ "$left" -ge 4 ] || break
  # About 7 minutes of work, so with the build and setup a round is about 10.
  round_min=$(( left < 8 ? left - 1 : 7 ))
  # stress, agent, stress, monkey, ...
  case $(( n % 4 )) in
    0|2) kind=stress ;;
    1) kind=agent ;;
    3) kind=monkey ;;
  esac
  if [ "$kind" = agent ] && { [ "$(now)" -lt "$agent_backoff_until" ] || [ "$model_i" -ge "${#models[@]}" ]; }; then kind=monkey; fi
  dir="$out/$(printf '%03d' "$n")-$kind"
  case "$kind" in
    stress)
      cond="${conds[$(( stress_n % ${#conds[@]} ))]}"
      shard="$(( stress_n % 8 + 1 ))/8"
      what="$cond $shard"
      cmd=(node features/tools/stress.mjs --cond "$cond" --shard "$shard" --minutes "$round_min" --out "$dir") ;;
    agent)
      # Two areas, a fresh app each: one session tends to stop at its token cap in about 3 minutes.
      area="${areas[$(( agent_n % ${#areas[@]} ))]}"; area2="${areas[$(( (agent_n + 1) % ${#areas[@]} ))]}"
      what="$area; $area2 (${models[$model_i]})"
      cmd=(env "${oc_env[@]}" FUZZ_OUT="$dir" features/tools/fuzz-agent-desk.sh "opencode:${models[$model_i]}" "$round_min" "$area" "$area2") ;;
    monkey)
      what="mock-weight 40"
      cmd=(env FUZZ_OUT="$dir" features/tools/fuzz-monkey.sh "$(( $(now) % 100000 ))" "$round_min" --mock-weight 40) ;;
  esac
  say "round $n: $kind ${cmd[*]:0:12}"
  started=$(now)
  rc=0
  # NIGHTLY_FUZZ_QUEUE=1 waits in line instead, for a daytime try (the host's
  # busy all day, so a run that always gives way may never get a turn).
  try=--try; [ "${NIGHTLY_FUZZ_QUEUE:-}" != 1 ] || try=""
  # A round that hangs is stopped rather than left to take the night: on
  # 18 Nov round 0's remote.sh sat in one mkdir from 23:00 until it was
  # killed at 07:31, so the whole night was one empty round. A healthy round
  # is its minutes plus a build (25 at most so far), so 40 over is a hang.
  # set -m gives the round its own process group, so the stop reaches all of it.
  cap=$(( (round_min + 40) * 60 ))
  set -m
  THREADBEAR_REMOTE_TRACE=1 bash "$root/desktop/scripts/remote.sh" local --desk $try -- "${cmd[@]}" >"$dir.log" 2>&1 </dev/null &
  pid=$!
  set +m
  while kill -0 "$pid" 2>/dev/null; do
    if [ $(( $(now) - started )) -ge "$cap" ]; then
      say "round $n: $kind still going after $(( cap / 60 )) min: stopping it (hung)"
      # Where it sticks, in its log before it's stopped: each process of the
      # round with its state (U is stuck in the kernel, as 18 Nov's mkdir was)
      # and what it was running; remote.sh's timed lines above say the step.
      { echo "--- hung: the round's processes as it was stopped"
        ps -A -o pid=,pgid=,ppid=,stat=,etime=,command= | awk -v g="$pid" '$2 == g'
      } >>"$dir.log" 2>&1 || true
      kill -TERM -- "-$pid" 2>/dev/null; sleep 30; kill -KILL -- "-$pid" 2>/dev/null
      break
    fi
    sleep 15
  done
  wait "$pid" || rc=$?
  pid=""
  if [ "$rc" = 75 ]; then
    # Someone else's turn: give it back and try again shortly.
    rm -f "$dir.log"; busy_waits=$((busy_waits + 1))
    sleep 180; continue
  fi
  say "round $n: $kind ended $rc after $(( ($(now) - started) / 60 )) min"
  # A round that fails at once is a broken setup, not a finding: three in a
  # row end the night rather than spin until 6am (18 Nov's first launchd try
  # ran 28 empty rounds in a minute).
  if [ "$rc" != 0 ] && [ $(( $(now) - started )) -lt 60 ]; then
    fast_fails=$((fast_fails + 1))
    if [ "$fast_fails" -ge 3 ]; then say "three rounds failed at once: stopping (see $dir.log)"; break; fi
    sleep 60
  else
    fast_fails=0
  fi
  printf '{"n":%d,"kind":"%s","what":"%s","rc":%d,"started":%d,"ended":%d,"dir":"%s"}\n' "$n" "$kind" "$what" "$rc" "$started" "$(now)" "$dir" >>"$out/rounds.jsonl"
  case "$kind" in
    stress) stress_n=$((stress_n + 1)) ;;
    agent)
      agent_n=$((agent_n + 2))
      stop_opencode
      # The free tier saying no: an hour of the other two instead.
      if grep -rqsE 'ModelDeprecated|has been deprecated|[Mm]odel not found' "$dir" "$dir.log"; then
        say "${models[$model_i]} is gone: trying the next free model"; model_i=$((model_i + 1))
      elif grep -rqsE 'FreeUsageLimit|rate.?limit|429' "$dir" "$dir.log"; then agent_backoff_until=$(( $(now) + 3600 )); say "free model limited: an hour without it"; fi ;;
  esac
  n=$((n + 1))
  "$NODE" "$root/scripts/nightly-fuzz-summary.mjs" "$out" "$busy_waits" || say "summary failed"
done
"$NODE" "$root/scripts/nightly-fuzz-summary.mjs" "$out" "$busy_waits" --done || say "summary failed"
say "night over: $(( n - ${NIGHTLY_FUZZ_START:-0} )) rounds, $busy_waits waits for a busy host"
