#!/bin/bash
# Films the GPUI app for a clip (the "Things that just make sense in
# Threadbear" X posts, the site's clips): the scripted app on the mock runner,
# on Tinker Desk's desktop, recorded at 2x. Run it from the M5; everything
# that shows a window happens on Tinker Desk, never here.
#
#   desktop/scripts/film.sh start [--turns FILE] [--fixtures DIR]... [--live-page FILE] [--mock-env K=V]... [--size 1240x820]
#                                 [--appearance dark|light] [--no-build]
#   desktop/scripts/film.sh do '<json>'...        (dev-app.sh's commands)
#   desktop/scripts/film.sh dump | shot <file.png> | log [--mock]
#   desktop/scripts/film.sh record <out.mov> [--seconds N]
#   desktop/scripts/film.sh cut                   (ends a recording)
#   desktop/scripts/film.sh stop
#
# start   builds the app with the scripted control on the host (remote.sh),
#         copies over what dev-app.sh needs and the turns file
#         (MOCK_SCRIPTED_TURNS, the mock's made-up replies), and starts
#         `dev-app.sh start --film --mock` there through Desk Runner: a normal
#         window, in front and drawing every frame, with no test-copy label,
#         at 1240x820 and dark unless told otherwise. Then the stage
#         (film/stage.m) makes a 2x virtual display, 1600x1000 points, and
#         centres the window on it, so the video is Retina-sharp: Tinker
#         Desk's own screen is 1080p at 1x. While it's up macOS shows only the
#         virtual display there (its own screen goes dark); it comes back at
#         stop. The window is on its own there, so nothing covers it (a
#         covered GPUI window gets no frames).
# record  records the window with site/scripts/record-window.swift
#         (ScreenCaptureKit, no cursor, at the window's pixel size: 2480x1640
#         for 1240x820) until `cut` or --seconds (default 120), then copies
#         the .mov back here. Run it in the background and drive the app
#         while it records:
#
#           desktop/scripts/film.sh start --turns turns.json
#           desktop/scripts/film.sh do '{"cmd":"open","id":"demo_tidy_imports"}'
#           desktop/scripts/film.sh record /tmp/take1.mov &
#           desktop/scripts/film.sh do '{"cmd":"type","text":"..."}' '{"cmd":"send"}'
#           desktop/scripts/film.sh cut; wait
#           desktop/scripts/film.sh stop
#
# The app keeps every other safety dev-app.sh gives it: the mock's own data
# folder, never the real one, and a pasteboard of its own. dev-app.sh's
# --film refuses to start without THREADBEAR_FILM_HOST=1, which only this
# sets, on the host. FILM_HOST picks another Mac (default tinker-desk, in Mike's copy only) and
# FILM_DIR the folder there (default /Volumes/TinkerSSD/threadbear-film, as
# Tinker Desk's own disk is nearly full). When Desk Runner can't open the SSD
# (an unanswered macOS prompt there, below) and FILM_DIR isn't set, start
# films from ~/threadbear-film on the host's own disk instead and says so.
# start remembers the folder it picked (film-dir in this checkout's git
# folder), so the other commands use it without FILM_DIR; FILM_DIR on any
# command still wins.
#
# While it's filming it holds the host's build-and-measurement lock (the one
# remote.sh's runs and checks take, film/hold.pl), so the stage never swaps
# the screen under another thread's --desk run. Other threads' builds and
# checks there wait meanwhile, so stop as soon as the takes are done. The
# app quits after 20 minutes with no command, which ends the stage and frees
# the lock too.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# tinker-desk is Mike's own Mac: only his copy defaults to it. A fork's agent
# read the default and tried to ssh there (21 Nov 2026).
case "$(git -C "$root" remote get-url origin 2>/dev/null)" in
  *mikecann/threadbear*) host="${FILM_HOST:-tinker-desk}" ;;
  *) host="${FILM_HOST:-}" ;;
esac
key="$(printf '%s' "$root" | shasum | cut -c1-10)"
default_dir=/Volumes/TinkerSSD/threadbear-film
SSH=(ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=4 -o BatchMode=yes)
# The folder start picked when it isn't the default: "<host> <folder>
# [fallback]" in this checkout's own git folder (each worktree has its own,
# as each has its own key), so do, shot, record, cut and stop find a take on
# the host's own disk without FILM_DIR (23 Nov: it had to go on every call).
state="$(git -C "$root" rev-parse --absolute-git-dir 2>/dev/null)/film-dir" || state=""
remembered() {
  local h d rest
  [ -n "$state" ] && [ -f "$state" ] || return 0
  read -r h d rest <"$state" || true
  [ "$h" != "$host" ] || printf '%s\n' "$d${rest:+ $rest}"
}
remember() {
  [ -n "$state" ] || return 0
  if [ "$1" = "$default_dir" ]; then rm -f "$state"; else printf '%s %s%s\n' "$host" "$1" "${2:+ $2}" >"$state"; fi
}
# Sets the take's folder there, and with it what every command there starts
# with: dev-app.sh's state in the account's own temp folder, named outright
# so ssh's commands and Desk Runner's agree (ssh has no TMPDIR, Desk Runner
# the per-user one; not the SSD, whose root any account can write to, which
# dev-app.sh refuses), the build film.sh made, and the turns.
use_dir() {
  base="$1/$key"
  env_there="cd $base/checkout && export TMPDIR=\$(getconf DARWIN_USER_TEMP_DIR) THREADBEAR_FILM_HOST=1 DEV_APP_IDLE_QUIT_SECONDS=1200 TB_GPUI_BIN=$base/bin/threadbear-gpui; [ ! -f $base/turns.json ] || export MOCK_SCRIPTED_TURNS=$base/turns.json; [ ! -f $base/live-page.html ] || export TB_MOCK_LIVE_PAGES=$base/live-page.html; [ ! -f $base/mock.env ] || . $base/mock.env"
}
q() { printf '%q ' "$@"; }
there() { "${SSH[@]}" "$host" "$env_there; $1"; }
desk() { "${SSH[@]}" "$host" "~/.local/bin/desk $(q "$env_there; $1")"; }
devapp() { there "desktop/scripts/dev-app.sh $(q "$@") --id film"; }
die() { echo "film: $*" >&2; exit 1; }
[ -n "$host" ] || die "set FILM_HOST to an ssh host of yours (a Mac with a screen to film on); tinker-desk is Mike's own"
read -r last_dir last_how <<<"$(remembered)" || true
use_dir "${FILM_DIR:-${last_dir:-$default_dir}}"
# Whether Desk Runner there can make and open a file in a folder, with a time
# limit: ssh reads it while Desk Runner's every open there can sit forever.
# Without desk()'s cd into it, which nothing could time out.
desk_can_open() {
  "${SSH[@]}" "$host" "mkdir -p $1/bin $1/rec $1/fixtures" &&
    "${SSH[@]}" "$host" "~/.local/bin/desk $(q "perl -e 'alarm 15; exec @ARGV' /bin/sh -c ': > $1/.desk-probe && rm -f $1/.desk-probe'")" >/dev/null 2>&1
}
# Who has the host's screen: with fast user switching another account's
# session can be on the console while ours sits behind it, and then the
# stage's virtual display comes up 0x0 (19 Nov: an ADEMark run's ademark
# session had it, and start failed only after the whole build). Empty when
# it's ours, otherwise why not.
console_not_ours() {
  local who
  # The window server's list of sessions, not /dev/console's owner: that
  # stays on the last user to log in after a fast switch away (19 Nov it
  # said mikeysee while ademark's session had the screen).
  who="$("${SSH[@]}" "$host" 'p=$(mktemp) && ioreg -n Root -d1 -a >"$p" && i=0 on= && while u=$(plutil -extract IOConsoleUsers.$i.kCGSSessionUserNameKey raw -o - "$p" 2>/dev/null); do [ "$(plutil -extract IOConsoleUsers.$i.kCGSSessionOnConsoleKey raw -o - "$p" 2>/dev/null)" != true ] || on=$u; i=$((i + 1)); done; rm -f "$p"; echo "${on:-loginwindow} $(id -un)"')" || { echo "couldn't ask $host who has its screen"; return; }
  set -- $who
  [ "${1:-}" != "${2:-}" ] || return 0
  case "${1:-}" in
    ademark) echo "$host's screen is on the ademark user's session (an ADEMark run?); film again when it's back on ${2:-}" ;;
    root|loginwindow|"") echo "$host is at the login window, so no session has its screen; film again once ${2:-} is logged in there and on screen" ;;
    *) echo "$host's screen is on the ${1} user's session, not ${2:-}'s; film again when it's back on ${2:-}" ;;
  esac
}

cmd="${1:-help}"
[ $# -eq 0 ] || shift
case "$cmd" in
  start)
    turns="" size=1240x820 appearance=dark build=1 fixtures=() fix_src=() live_page="" mock_env=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --turns) turns="$2"; shift 2 ;;
        --fixtures) fixtures+=(--fixtures "$base/fixtures/$(basename "$2")"); fix_src+=("$2"); shift 2 ;;
        --size) size="$2"; shift 2 ;;
        --appearance) appearance="$2"; shift 2 ;;
        --no-build) build=0; shift ;;
        # A live page for the mock's demo_live_page thread (the livePages experiment).
        --live-page) live_page="$2"; shift 2 ;;
        # The mock's demo switches (TB_MOCK_RECIPES=1, TB_MOCK_NESTED=1...),
        # which the changelog's clips of an experiment need.
        --mock-env) [[ "$2" =~ ^[A-Z_][A-Z0-9_]*= ]] || die "--mock-env takes NAME=value"; mock_env+=("$2"); shift 2 ;;
        *) die "unknown start option $1" ;;
      esac
    done
    [ -z "$turns" ] || [ -f "$turns" ] || die "no turns file $turns"
    # Before anything slow: the stage needs our session on the screen.
    why="$(console_not_ours)"
    [ -z "$why" ] || die "$why"
    w="${size%x*}" h="${size#*x}"
    # The display has room round the window, so it's never pushed off an edge.
    stage_size="$(( w + 360 > 1600 ? w + 360 : 1600 ))x$(( h + 180 > 1000 ? h + 180 : 1000 ))"
    if "${SSH[@]}" "$host" "pgrep -f '[t]hreadbear-film/.*/stage ' >/dev/null && ! pgrep -f '[t]hreadbear-film/$key/stage ' >/dev/null"; then
      die "another checkout is filming on $host (one at a time, as there's one stage)"
    fi
    # A previous take's app and stage go first, from wherever it was, and
    # with them its hold on the lock, which the build below waits for.
    [ "$("${SSH[@]}" "$host" "[ -d $base/checkout ] && echo yes")" != yes ] || there "desktop/scripts/dev-app.sh stop --id film >/dev/null 2>&1; touch $base/stage.stop; for i in \$(seq 1 20); do pgrep -f '[t]hreadbear-film/$key/stage ' >/dev/null || break; sleep 0.5; done; pkill -f '^perl desktop/scripts/film/hold.pl $base ' || true; rm -f $base/stage.stop $base/stage.json $base/locked $base/go"
    last_base="$base"
    # Each take tries the SSD (or FILM_DIR) again, as the prompt may have
    # been answered since.
    use_dir "${FILM_DIR:-$default_dir}"
    # Desk Runner has to be able to open $base. On 19 Nov an unanswered
    # "would like to access files on a removable volume" prompt for another
    # app (bun, 18 Nov 19:23) had macOS hold every later removable-volume
    # request on Tinker Desk, Desk Runner's included, behind it, with the
    # screen asleep so nobody saw it, and start waited 20 minutes on a
    # hold.pl that never ran (23 Nov: ruby's). Checked first, so it fails in
    # seconds rather than after the build.
    how=""
    if ! desk_can_open "$base"; then
      ssd_base="$base"
      why="Desk Runner on $host can't open $base (gave up after 15 seconds). Most likely macOS has an unanswered \"would like to access files on a removable volume\" prompt on its screen, for Desk Runner or any other app, and every later request for that disk waits behind it. See it with ssh $host '~/.local/bin/desk \"screencapture -x /tmp/s.png\"' and copy /tmp/s.png back, then answer it on $host."
      [ -z "${FILM_DIR:-}" ] || die "$why Or leave FILM_DIR out, and film.sh films from $host's own disk"
      # Its own disk is small (about 47 GB free on Tinker Desk): only the
      # binaries, the scripts and the takes go there, never cargo's target.
      home="$("${SSH[@]}" "$host" 'printf %s "$HOME"')"
      use_dir "$home/threadbear-film"
      desk_can_open "$base" || die "$why Its own disk's $base didn't open either"
      how=fallback
      if [ "$build" = 0 ]; then
        "${SSH[@]}" "$host" "for b in threadbear-gpui threadbear-web-helper; do s=$ssd_base/bin/\$b d=$base/bin/\$b; if [ -f \$s ] && { [ ! -f \$d ] || [ \$s -nt \$d ]; }; then cp -p \$s \$d.new && mv \$d.new \$d; fi; done"
      fi
      echo "film: $why Meanwhile it films from $base on $host's own disk, and the other film.sh commands find it there." >&2
    elif [ "$last_how" = fallback ] && [ "$last_base" != "$base" ]; then
      # Back on the SSD: the copy on the small disk goes.
      "${SSH[@]}" "$host" "rm -rf $last_base"
    fi
    remember "${base%/"$key"}" "$how"
    [ "$build" = 1 ] || "${SSH[@]}" "$host" "[ -x $base/bin/threadbear-gpui ]" || die "no build in $base yet: film.sh start without --no-build"
    if [ "$build" = 1 ]; then
      echo "Building on $host..." >&2
      log="$(mktemp -t film-build)"
      if ! "$root/desktop/scripts/remote.sh" "$host" -- bash -c "cd desktop && nice cargo build -p threadbear-gpui --features automation && for b in threadbear-gpui threadbear-web-helper; do [ ! -f \"\$CARGO_TARGET_DIR/debug/\$b\" ] || { cp \"\$CARGO_TARGET_DIR/debug/\$b\" $base/bin/.\$b.new && mv $base/bin/.\$b.new $base/bin/\$b; }; done" >"$log" 2>&1; then
        tail -30 "$log" >&2
        die "the build failed; the whole log: $log"
      fi
      rm -f "$log"
    fi
    # What dev-app.sh needs there, and the recorder.
    (cd "$root" && rsync -rlpcR --delete -e "${SSH[*]}" --exclude node_modules \
      desktop/scripts runner/scripts/find-node.sh runner/src mock-runner site/scripts/record-window.swift "$host:$base/checkout/")
    "${SSH[@]}" "$host" "rm -f $base/live-page.html"
    if [ ${#mock_env[@]} -gt 0 ]; then printf 'export %q\n' "${mock_env[@]}" | "${SSH[@]}" "$host" "cat > $base/mock.env"; else "${SSH[@]}" "$host" "rm -f $base/mock.env"; fi
    [ -z "$live_page" ] || rsync -c -e "${SSH[*]}" "$live_page" "$host:$base/live-page.html"
    for f in "${fix_src[@]+"${fix_src[@]}"}"; do rsync -rlpc --delete -e "${SSH[*]}" "${f%/}/" "$host:$base/fixtures/$(basename "$f")/"; done
    if [ -n "$turns" ]; then scp -q "$turns" "$host:$base/turns.json"; else "${SSH[@]}" "$host" "rm -f $base/turns.json"; fi
    there "[ -d mock-runner/node_modules ] || (. runner/scripts/find-node.sh && n=\"\$(threadbear_find_node)\" && PATH=\"\${n%/*}:\$PATH\" npm ci --silent --prefix mock-runner)
      clang -fobjc-arc -O -framework AppKit -framework ApplicationServices -framework CoreGraphics -framework IOKit desktop/scripts/film/stage.m -o $base/stage"
    # The host's build-and-measurement lock first (film/hold.pl), so the app's
    # window and the stage never land in another thread's --desk run.
    desk "(perl desktop/scripts/film/hold.pl $base $base/stage $stage_size >$base/stage.log 2>&1 </dev/null &)"
    # Only the perl itself: the shell Desk Runner started it from has
    # "hold.pl <base>" in its command line too, and stays if perl never runs.
    holding="pgrep -f '^perl desktop/scripts/film/hold.pl $base ' >/dev/null"
    # Whether anyone holds the lock right now (a moment's try for it, let go
    # at once): if nobody does, hold.pl should have had it already.
    lock_free="perl -MFcntl=:flock -e 'open(my \$l, q(>>), \"\$ENV{HOME}/.cache/threadbear-perf.lock\") or exit 1; exit(flock(\$l, LOCK_EX|LOCK_NB) ? 0 : 1)'"
    said="" free=0
    until there "[ -f $base/locked ]"; do
      there "$holding" || { there "cat $base/stage.log" >&2; die "the lock holder stopped (above says why)"; }
      # Free for 30 seconds while hold.pl hasn't said it has it: it's stuck
      # on something else (opening $base, say), not waiting its turn.
      if there "$lock_free"; then free=$((free + 1)); else free=0; fi
      if [ "$free" -ge 6 ]; then
        there "pkill -f '^perl desktop/scripts/film/hold.pl $base ' || true; cat $base/stage.log 2>/dev/null || true" >&2
        die "hold.pl on $host hasn't taken the build-and-measurement lock in 30 seconds though nobody holds it, so it's stuck, not waiting (stopped it). Check Desk Runner can open $base: desk \"ls $base\" there should answer at once"
      fi
      # No holder file when nobody holds the lock: sed's failure would end
      # the script silently under set -e.
      note="$("${SSH[@]}" "$host" "sed -n 3p ~/.cache/threadbear-perf.lock.holder 2>/dev/null || true")"
      [ "$note" = "$said" ] || { echo "Waiting for $host's build-and-measurement lock, held by: ${note:-someone}" >&2; said="$note"; }
      sleep 5
    done
    if ! desk "desktop/scripts/dev-app.sh start --film --mock --id film --no-build --appearance $(q "$appearance") --size $(q "$size") ${fixtures[*]+${fixtures[*]}}"; then
      there "touch $base/stage.stop"
      die "the app didn't start"
    fi
    pid="$(there "cat \"\$(find \"\$TMPDIR\" -path '*/film/app.json' 2>/dev/null | head -1)\"" | sed -E 's/.*"app":([0-9]+).*/\1/')"
    [[ "$pid" =~ ^[0-9]+$ ]] || { there "touch $base/stage.stop"; die "couldn't find the app's pid"; }
    # Long enough for all the stage's own waits (making the display 20s, the
    # window on it 30s, moving it 10s), as an error line ends it at once.
    there "echo $pid > $base/go; for i in \$(seq 1 375); do [ -f $base/stage.json ] && break; grep -q '^error' $base/stage.log && break; sleep 0.2; done; cat $base/stage.log"
    if ! there "[ -f $base/stage.json ]"; then
      there "desktop/scripts/dev-app.sh stop --id film >/dev/null 2>&1; touch $base/stage.stop"
      # Its own words, in the message itself: on 19 Nov all that showed was
      # "film", and the reason sat in stage.log on the host.
      said_log="$(there "grep -v '^[[:space:]]*\$' $base/stage.log 2>/dev/null | tail -5" || true)"
      why="$(console_not_ours)"
      die "the stage didn't come up.${said_log:+ The stage said:
$said_log}${why:+
$why.}
The whole log: $host:$base/stage.log"
    fi
    devapp do '{"cmd":"focus"}' >/dev/null
    echo "Filming on $host: the app's up at $size $appearance on a 2x stage. Drive it with film.sh do, record with film.sh record."
    ;;
  do) devapp do "$@" ;;
  dump) devapp dump "$@" ;;
  log) devapp log "$@" ;;
  shot)
    out="${1:?shot needs a file}"
    devapp shot "$base/rec/shot.png" >/dev/null
    scp -q "$host:$base/rec/shot.png" "$out"
    echo "$out"
    ;;
  record)
    out="${1:?record needs a file, like take1.mov}"; shift
    seconds=120
    [ "${1:-}" != --seconds ] || seconds="$2"
    win="$(there "cat $base/stage.json" | sed -E 's/.*"window":([0-9]+).*/\1/')"
    [[ "$win" =~ ^[0-9]+$ ]] || die "nothing to record: film.sh start first"
    there "rm -f $base/rec/take.mov $base/rec/take.mov.stop"
    desk "swift site/scripts/record-window.swift $win $base/rec/take.mov $(q "$seconds")"
    scp -q "$host:$base/rec/take.mov" "$out"
    echo "$out"
    ;;
  cut) there "touch $base/rec/take.mov.stop" ;;
  stop)
    # The stage goes when the app does, and the lock with it.
    there "desktop/scripts/dev-app.sh stop --id film; touch $base/stage.stop; rm -rf $base/rec/*" || true
    ;;
  help|--help|-h) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed -E 's/^# ?//' ;;
  *) die "unknown command $cmd (--help lists them)" ;;
esac
