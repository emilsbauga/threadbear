#!/bin/bash
# Screenshots of the desktop app on Linux with no screen: a virtual X display
# (Xvfb), the debug build, and the mock runner (or a runner's data dir), so
# an agent on a server can see what it built.
#
#   scripts/shot.sh OUT_DIR [--home DIR] [--click X,Y | --type TEXT | --key KEY]...
#                   [--wait S] [--record S]
#
# Without --home it starts the mock runner (mock-runner/) in a temp
# dir. Each step (--click at window coordinates, --type some text, --key
# a key such as Return) runs in order and takes another shot
# (OUT_DIR/1.png, 2.png ...; 0.png is before any). --wait is how long to
# wait for the window (30 s). --record S also films the window from just
# after 0.png, through the steps, for S seconds in all, to OUT_DIR/clip.mp4
# (needs ffmpeg), for motion when no Mac's screen is free. Build first:
# `cargo build -p threadbear-gpui`; the binary is looked for in cargo's
# target folder ($CARGO_TARGET_DIR under remote.sh), or set
# THREADBEAR_DESKTOP_BIN. Needs Xvfb, xdotool, imagemagick, Mesa's software
# Vulkan (llvmpipe) and dbus-run-session.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$1"; shift
home=""; steps=(); wait=30; record=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home) home="$2"; shift 2 ;;
    --click) steps+=("click:$2"); shift 2 ;;
    --type) steps+=("type:$2"); shift 2 ;;
    --key) steps+=("key:$2"); shift 2 ;;
    --wait) wait="$2"; shift 2 ;;
    --record) record="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
bin="${THREADBEAR_DESKTOP_BIN:-${CARGO_TARGET_DIR:-$here/target}/debug/threadbear-gpui}"
[ -x "$bin" ] || { echo "no app at $bin: cargo build -p threadbear-gpui first, or set THREADBEAR_DESKTOP_BIN" >&2; exit 1; }
[ -z "$record" ] || command -v ffmpeg >/dev/null || { echo "--record needs ffmpeg (sudo apt-get install -y ffmpeg)" >&2; exit 1; }
mkdir -p "$out"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/tb-desktop-shot-XXXX")"
pids=()
bus=""
# The whole group for the bus: dbus-run-session dies on a signal without
# stopping its daemon, and that and its portals would outlive every run.
cleanup() {
  [ -z "$bus" ] || kill -- "-$bus" 2>/dev/null || true
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$tmp"
}
trap cleanup EXIT

if [ -z "$home" ]; then
  home="$tmp/home"
  node "$here/../mock-runner/server.mjs" --data-dir "$home" --port 0 --quiet --ready-file "$tmp/ready" > "$tmp/mock.log" 2>&1 &
  pids+=($!)
  for _ in $(seq 100); do [ -f "$tmp/ready" ] && break; sleep 0.1; done
  [ -f "$tmp/ready" ] || { echo "the mock runner didn't start:" >&2; cat "$tmp/mock.log" >&2; exit 1; }
fi

display=":$((90 + RANDOM % 100))"
Xvfb "$display" -screen 0 1400x900x24 > "$tmp/xvfb.log" 2>&1 &
pids+=($!)
sleep 1
# The app asks a session bus for desktop settings and portals, and a server
# doesn't have one, so it gets its own.
DISPLAY="$display" THREADBEAR_HOME="$home" NO_AT_BRIDGE=1 LIBGL_ALWAYS_SOFTWARE=1 setsid dbus-run-session -- \
  "$bin" > "$tmp/app.log" 2>&1 &
bus=$!
# By its X class: the title is the open thread's ("New thread"), so the
# old search for a title starting Threadbear never found it (19 Nov).
wid=""
for _ in $(seq $((wait * 2))); do
  wid="$(DISPLAY="$display" xdotool search --onlyvisible --class '^threadbear$' 2>/dev/null | head -1 || true)"
  [ -n "$wid" ] && break
  sleep 0.5
done
[ -n "$wid" ] || { echo "no window after ${wait}s; the app said:" >&2; cat "$tmp/app.log" >&2; exit 1; }
# Mapped isn't drawn: give the first frames and the mock's threads a moment.
sleep 3
DISPLAY="$display" import -window "$wid" "$out/0.png"
rec=""
if [ -n "$record" ]; then
  eval "$(DISPLAY="$display" xdotool getwindowgeometry --shell "$wid")"
  # x264 wants even sizes.
  ffmpeg -loglevel error -y -f x11grab -framerate 30 -video_size "$((WIDTH / 2 * 2))x$((HEIGHT / 2 * 2))" \
    -i "$display+$X,$Y" -t "$record" -c:v libx264 -preset veryfast -pix_fmt yuv420p "$out/clip.mp4" \
    < /dev/null > "$tmp/ffmpeg.log" 2>&1 &
  rec=$!
  pids+=("$rec")
  sleep 0.5
fi
n=0
for step in "${steps[@]}"; do
  n=$((n + 1))
  arg="${step#*:}"
  case "$step" in
    click:*) DISPLAY="$display" xdotool mousemove --window "$wid" "${arg%,*}" "${arg#*,}" click 1 ;;
    type:*) DISPLAY="$display" xdotool type --delay 20 -- "$arg" ;;
    key:*) DISPLAY="$display" xdotool key "$arg" ;;
  esac
  sleep 2
  DISPLAY="$display" import -window "$wid" "$out/$n.png"
done
if [ -n "$rec" ]; then
  wait "$rec" || { echo "the recording failed:" >&2; cat "$tmp/ffmpeg.log" >&2; exit 1; }
fi
echo "shots in $out"
