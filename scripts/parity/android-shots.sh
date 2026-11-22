#!/bin/bash
# The Android app's part of the parity run (scripts/parity/run.sh): builds
# the app (android-native/, a debug build, which alone takes a pairing
# from a launch: AppModel.pairForParity), boots a headless emulator of its
# own, pairs it with the run's throwaway backend through `adb reverse`,
# opens each scenario's thread, waits until its accessibility tree shows
# the words the scenario must show (or 25 s) and saves a picture
# (android-shots.mjs). Writes android.json: each scenario's file and the
# words it didn't show. The emulator is shut down afterwards.
#
# Mike's setup only, like the rest of the run: the SDK, a JDK and the
# emulator live in THREADBEAR_PARITY_ANDROID (Tinker Desk's
# /Volumes/TinkerSSD/android-parity: jdk/, sdk/ with emulator,
# platform-tools and system-images;android-36;default;arm64-v8a). Without
# one it says so and stops, and the run reports Android as not set up.
#
#   scripts/parity/android-shots.sh <convex url> <seed.json> <out dir>
set -euo pipefail
URL=$1 SEED=$2 OUT=$3
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
AND=${THREADBEAR_PARITY_ANDROID:-/Volumes/TinkerSSD/android-parity}
IMAGE="system-images;android-36;default;arm64-v8a"
[ -x "$AND/sdk/emulator/emulator" ] && [ -d "$AND/sdk/system-images/android-36" ] && [ -x "$AND/jdk/Contents/Home/bin/java" ] \
  || { echo "no Android SDK, emulator and JDK in $AND (THREADBEAR_PARITY_ANDROID)" >&2; exit 1; }
export JAVA_HOME="$AND/jdk/Contents/Home" ANDROID_HOME="$AND/sdk" ANDROID_SDK_ROOT="$AND/sdk"
export ANDROID_AVD_HOME="$AND/avd" ANDROID_EMULATOR_HOME="$AND" GRADLE_USER_HOME="$AND/gradle"
ADB="$AND/sdk/platform-tools/adb"
mkdir -p "$OUT" "$ANDROID_AVD_HOME"

echo "building the app" >&2
(cd "$ROOT/android-native" && /usr/sbin/taskpolicy -b ./build.sh :app:assembleFdroidDebug -q) >&2
APK="$ROOT/android-native/app/build/outputs/apk/fdroid/debug/app-fdroid-debug.apk"

# One phone, made once: 2 GB, so Tinker Desk's 16 keep room for the
# simulator and the Mac app beside it.
if [ ! -f "$ANDROID_AVD_HOME/tb-parity.ini" ]; then
  echo no | "$AND/sdk/cmdline-tools/latest/bin/avdmanager" -s create avd -n tb-parity -k "$IMAGE" -d pixel_7 >&2
  printf 'hw.ramSize=2048\nvm.heapSize=256\nhw.keyboard=yes\ndisk.dataPartition.size=4G\n' >> "$ANDROID_AVD_HOME/tb-parity.avd/config.ini"
fi
PORT=5584
SERIAL="emulator-$PORT"
"$ADB" start-server >/dev/null 2>&1 || true
emu=""
cleanup() {
  "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true
  [ -n "$emu" ] && { sleep 3; kill "$emu" 2>/dev/null || true; wait "$emu" 2>/dev/null || true; }
}
trap cleanup EXIT
"$AND/sdk/emulator/emulator" -avd tb-parity -port $PORT -no-window -no-audio -no-boot-anim -no-snapshot -wipe-data \
  -memory 2048 -gpu swiftshader_indirect > "$OUT/android-emulator.log" 2>&1 &
emu=$!
echo "booting the emulator" >&2
booted=""
for _ in $(seq 1 120); do
  [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && { booted=1; break; }
  kill -0 "$emu" 2>/dev/null || break
  sleep 2
done
[ -n "$booted" ] || { echo "the emulator didn't boot:" >&2; tail -20 "$OUT/android-emulator.log" >&2; exit 1; }
rm -f "$OUT/android-emulator.log"
a() { "$ADB" -s "$SERIAL" "$@"; }
a shell cmd uimode night yes >/dev/null
for s in window_animation_scale transition_animation_scale animator_duration_scale; do a shell settings put global $s 0; done
a install -r -g "$APK" >/dev/null
# The backend on this Mac's loopback is the emulator's loopback too.
port=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.urlparse(sys.argv[1]).port)' "$URL")
a reverse tcp:$port tcp:$port >/dev/null
node "$ROOT/scripts/parity/android-shots.mjs" "$ADB" "$SERIAL" "$URL" "$SEED" "$OUT" > "$OUT/android.json"
