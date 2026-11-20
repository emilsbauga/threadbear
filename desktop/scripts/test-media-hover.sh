#!/bin/bash
# Run on a Mac check host, through desktop/scripts/remote.sh tinker-desk --desk.
# AppKit and Quick Look need that user's desktop session, but no window is shown.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/threadbear-hover.XXXXXX")"
trap 'rm -rf "$work"' EXIT
sources=("$root/desktop/gpui/native/media_views.m" "$root/desktop/gpui/tests/native/media_hover.m")
frameworks=(-framework AppKit -framework Foundation -framework AVFoundation -framework AVKit -framework PDFKit -framework CoreMedia -framework CoreVideo -framework QuickLookThumbnailing)
xcrun clang -fobjc-arc -Wno-deprecated-declarations "${sources[@]}" "${frameworks[@]}" -o "$work/hover"
"$work/hover"
xcrun clang -fobjc-arc -Wno-deprecated-declarations -DTB_LATE_CALLBACK_TEST '-DTB_VIDEO_WAIT_NS=(5*NSEC_PER_MSEC)' "${sources[@]}" "${frameworks[@]}" -o "$work/late"
"$work/late"
xcrun clang -fobjc-arc -Wno-deprecated-declarations -DTB_LATE_QUICKLOOK_TEST '-DTB_QUICKLOOK_WAIT_NS=(1000*NSEC_PER_MSEC)' "${sources[@]}" "${frameworks[@]}" -o "$work/late-quicklook"
"$work/late-quicklook"

# The pane deliberately has no hover deadline, including during package copies.
xcrun clang -fobjc-arc -Wno-deprecated-declarations '-DTB_QUICKLOOK_WAIT_NS=(10*NSEC_PER_MSEC)' "$root/desktop/gpui/tests/native/thumbnail_job.m" "${frameworks[@]}" -o "$work/jobs"
"$work/jobs"

# A film read through the pane's file source, which mustn't read it all to
# show a frame. Made with ffmpeg's software encoder, never the Mac's hardware
# one: a test hardware-encoding noise panicked the M5's kernel (17 Nov).
# Lossless noise so it's 30 MB, with its index at the end, the harder case.
ffmpeg -loglevel error -f lavfi -i "nullsrc=s=640x360:r=30:d=3,geq=lum='random(1)*255':cb=128:cr=128" -c:v libx264 -qp 0 -pix_fmt yuv420p "$work/noise.mp4"
xcrun clang -fobjc-arc -Wno-deprecated-declarations "$root/desktop/gpui/tests/native/file_source.m" "${frameworks[@]}" -o "$work/file-source"
"$work/file-source" "$work/noise.mp4"
