#!/bin/bash
# The web runtime's pinned archive (CEF's minimal Mac build), for the
# @web-runtime behaviour specs: they install from it rather than downloading
# 135 MB per scenario, and without it they're skipped, which cucumber counts
# as passing (features/support/web-runtime.ts).
#
#   desktop/scripts/web-runtime-archive.sh --key     the archive's name and SHA-256, for a cache key
#   desktop/scripts/web-runtime-archive.sh <dir>     downloads it into <dir> unless it's there, checks
#                                                    its SHA-256 either way, and prints its path
#
# The name and hash come from ARCHIVES in desktop/core/src/web_runtime.rs,
# the pin the app itself checks, for this Mac's processor. Desktop CI keeps
# the archive in the Actions cache (desktop.yml).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
pins="$here/../core/src/web_runtime.rs"
case "$(uname -m)" in
  arm64) platform=macosarm64 ;;
  x86_64) platform=macosx64 ;;
  *) echo "No web runtime for $(uname -m)." >&2; exit 2 ;;
esac

# The file and sha256 lines after this platform's entry.
read -r file sha256 < <(awk -v p="platform: \"$platform\"" '
  index($0, p) { found = 1 }
  found && /file:/ { sub(/.*file: "/, ""); sub(/".*/, ""); file = $0 }
  found && /sha256:/ { sub(/.*sha256: "/, ""); sub(/".*/, ""); print file, $0; exit }
' "$pins")
[[ "$file" == cef_binary_*.tar.bz2 && "$sha256" =~ ^[0-9a-f]{64}$ ]] || { echo "Couldn't read the $platform pin from $pins." >&2; exit 1; }

if [[ "${1:-}" == --key ]]; then
  echo "$file-$sha256"
  exit 0
fi
dir="${1:?give a folder to keep the archive in, or --key}"
mkdir -p "$dir"
archive="$dir/$file"
if [[ ! -f "$archive" ]]; then
  # Spotify's CDN, as the app downloads it (web_runtime.rs, Archive::url).
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$archive.part" "https://cef-builds.spotifycdn.com/${file//+/%2B}"
  mv "$archive.part" "$archive"
fi
got="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
if [[ "$got" != "$sha256" ]]; then
  rm -f "$archive"
  echo "$file didn't match its pinned SHA-256 (got $got), so it was thrown away." >&2
  exit 1
fi
echo "$archive"
