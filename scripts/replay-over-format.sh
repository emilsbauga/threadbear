#!/bin/sh
# Carries work across a whole-tree format commit (one listed in
# .git-blame-ignore-revs) without hand-resolving formatting: each commit is
# made again with its tree formatted as that commit was, so the only
# conflicts left are real ones. tb land does this by itself; this is for a
# branch by hand and for a fork bringing in Mike's release
# (docs/bringing-in-updates.md). The work is in runner/src/format-replay.ts,
# which says how; --help for the usage.
#
#   scripts/replay-over-format.sh [<onto>]              rebase onto main (or <onto>)
#   scripts/replay-over-format.sh --merge <commit> [-m <message>]
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
exec "${THREADBEAR_NODE:-node}" "$here/runner/src/format-replay.ts" "$@"
