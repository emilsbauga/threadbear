#!/usr/bin/env bash
# F-Droid takes only free software, so the fdroid build must carry no
# Firebase, Play services or ML Kit code (docs/android-native.md,
# "Flavours"). This looks for their classes in an APK's dex files by their
# type names, and fails if there's any, so Google code can't creep back in
# through a new dependency. CI runs it on every push (.github/workflows/android.yml).
#   ./check-fdroid-apk.sh app/build/outputs/apk/fdroid/release/app-fdroid-release-unsigned.apk
set -euo pipefail
apk="${1:?usage: check-fdroid-apk.sh <apk>}"
[ -f "$apk" ] || { echo "No APK at $apk." >&2; exit 2; }
# The check must see dex: an APK with none would pass by finding nothing.
listing=$(unzip -Z1 "$apk")
grep -qx 'classes.dex' <<<"$listing" || { echo "No classes.dex in $apk." >&2; exit 2; }
found=$(unzip -p "$apk" 'classes*.dex' | LC_ALL=C grep -a -o -E 'Lcom/google/(firebase|android/gms|mlkit)/[A-Za-z0-9_/$]*;' | sort -u || true)
if [ -n "$found" ]; then
  echo "The fdroid APK has Google code F-Droid won't take ($(printf '%s\n' "$found" | wc -l | tr -d ' ') classes), for example:" >&2
  sed -n 1,10p <<<"$found" >&2
  echo "Find what brought it in with: ./gradlew :app:dependencies --configuration fdroidReleaseRuntimeClasspath" >&2
  exit 1
fi
echo "No Firebase, Play services or ML Kit classes in $apk."
