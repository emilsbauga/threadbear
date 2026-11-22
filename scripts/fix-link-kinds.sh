#!/bin/bash
# Before rsync copies a checkout over an older copy of it: where a path has
# become a link, or stopped being one, takes the old one out of the copy, so
# rsync makes it anew. macOS's rsync (openrsync) can't do that itself: it
# won't swap a folder for a link while the folder holds what it leaves out
# (a node_modules), and it writes a file into the old link instead of in its
# place, through a loop when the link now points back (21 Nov 2026, when the
# Swift app's art and Pele moved to shared/ and app/ began linking to them,
# and the iPhone kit's linked Swift files became real; every checkout's copy
# on the check hosts had the old layout).
#
#   fix-link-kinds.sh <copy> [<link>...]   the paths that are links in what's
#                                          being copied, from its top
#   fix-link-kinds.sh --links <checkout>   prints those, one a line, for the
#                                          other form
#
# The copy is left alone where it already matches. Never follows a link, and
# leaves node_modules, .build, target and .git alone (rsync leaves them out).
# Run on a host it's sent as text (`bash -c "$(cat fix-link-kinds.sh)" _
# <copy> <link>...`), so it needs nothing there.
set -uo pipefail
prune=(\( -name node_modules -o -name .build -o -name target -o -name .git \) -prune -o)
if [ "${1:-}" = --links ]; then
  cd "${2:?usage: fix-link-kinds.sh --links <checkout>}" || exit 1
  find . "${prune[@]}" -type l -print | sed 's|^\./||'
  exit 0
fi
copy="${1:?usage: fix-link-kinds.sh <copy> [<link>...]}"
shift
cd "$copy" 2>/dev/null || exit 0
# A link here that isn't one in the checkout. First, so the loop below never
# reaches through an old link to a folder (it would delete what's there).
find . "${prune[@]}" -type l -print | sed 's|^\./||' | while IFS= read -r p; do
  keep=0
  for l in "$@"; do
    if [ "$l" = "$p" ]; then keep=1; break; fi
  done
  [ "$keep" = 1 ] || rm -f -- "$p"
done
# A path that's a link in the checkout and something else here.
for p in "$@"; do
  if [ -e "$p" ] && [ ! -L "$p" ]; then rm -rf -- "$p"; fi
done
exit 0
