#!/bin/bash
# For a thread started outside this repo (like ~/dev/me/misc), which gets
# no worktree from the runner: borrows one of the spares the runner keeps
# for new threads (docs/thread-worktrees.md, "Reusing worktrees"), with its
# Swift build caches, so the app builds in under a minute rather than the
# 5 to 10 a fresh `git worktree add` takes. With no spare it makes a new
# slot, which becomes one when it's given back.
#
#   ./borrow-worktree.sh              prints the worktree's path: on a new
#                                     thread/borrow-<slot>-<time> branch from
#                                     main, set up, yours till you give it back.
#                                     Commit there and `tb land` it (tb land
#                                     only lands a thread/ branch).
#   ./borrow-worktree.sh --give-back DIR
#                                     once everything in it is on main: back
#                                     in the pool for the next thread, and its
#                                     borrow branch deleted
#
# A borrow nobody gives back is taken back by the runner once it's safe
# (runner/src/borrows.ts): clean, everything on main, nothing running in
# it, and its borrower gone (the thread archived, the script that took it
# ended) or, with none recorded, unused for a day. On 17 Nov 25 slots sat
# on borrow branches never given back, all 50 were taken, and sync-main
# couldn't borrow one. So the borrower is written beside git's own files:
# the thread (THREADBEAR_THREAD_ID) and its runner's data dir and, for a script that gives it back
# itself, its process (THREADBEAR_BORROW_PID), and whether what's in it is
# scratch the runner may throw away once that process has gone
# (THREADBEAR_BORROW_SCRATCH=1; sync-main's is).
#
# Taking a spare is a rename of git's lock file, the same as the runner's
# (claimSpare in runner/src/worktrees.ts), so only one of two at once wins
# and a thread and the runner never take the same one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN="$(git -C "$ROOT" worktree list --porcelain | awk '
  /^worktree / { path = substr($0, 10) }
  /^branch refs\/heads\/main$/ && !found { print path; found = 1 }
')"
[ -n "$MAIN" ] || { echo "No checkout of this repo has main checked out." >&2; exit 1; }
THREADS="$(dirname "$MAIN")/$(basename "$MAIN")-threads"
SPARE="threadbear spare"
# The patch's worktree.keep (.threadbear/patches/checks.ts).
KEEP=(-e /app/.build -e /dock/.build)

if [ "${1:-}" = "--give-back" ]; then
  dir="${2:?--give-back needs the folder to give back}"
  # Only a borrow still out: given back twice, the slot may be another
  # thread's by now, and locking it would hand its folder to the next one.
  if [ -e "$(git -C "$dir" rev-parse --absolute-git-dir)/locked" ]; then
    echo "$dir is already a spare." >&2
    exit 1
  fi
  # Untracked files too: a slot given back twice may be another borrow's
  # now, and the next taker's git clean would lose its new files.
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    echo "$dir has uncommitted or untracked files; commit and land them, or remove them, first." >&2
    exit 1
  fi
  current="$(git -C "$dir" symbolic-ref -q --short HEAD || true)"
  case "$current" in
    thread/borrow-*|"") ;;
    *) echo "$dir is on $current, not a borrowed branch: it's someone else's now, so it wasn't given back." >&2; exit 1 ;;
  esac
  # Landed means on main, or on it by patch: a group check in `tb land`
  # rebases the branch again before main moves, so what's on main can be the
  # same changes under new ids (17 Nov, slot-32). `git cherry` marks each
  # commit of HEAD's that main has no equal of with "+".
  if ! git -C "$dir" merge-base --is-ancestor HEAD main; then
    unlanded="$(git -C "$dir" cherry main HEAD)" || { echo "Couldn't compare $dir with main." >&2; exit 1; }
    if printf '%s\n' "$unlanded" | grep -q '^+'; then
      echo "$dir has commits that aren't on main; land them first." >&2
      exit 1
    fi
  fi
  branch="$(git -C "$dir" symbolic-ref -q --short HEAD || true)"
  git -C "$dir" checkout -q --detach
  rm -f "$(git -C "$dir" rev-parse --absolute-git-dir)/threadbear-borrow"
  # Only the branch this script made; it's all on main, or on it by patch
  # (checked above).
  case "$branch" in thread/borrow-*) git -C "$MAIN" branch -q -D "$branch" ;; esac
  git -C "$MAIN" worktree lock --reason "$SPARE" "$dir"
  echo "$dir is a spare again."
  exit 0
fi

# A thread/ branch of its own, as a runner-made worktree has, so `tb land`
# takes it (landTargetFromGit in runner/src/worktrees.ts). The time keeps
# it from meeting a branch an earlier borrow never gave back.
borrow_branch() { echo "thread/borrow-$(basename "$1")-$(date +%Y%m%d-%H%M%S)"; }

claimed=""
for dir in $(git -C "$MAIN" worktree list --porcelain | awk -v RS= -v d="$THREADS/" '
  /\nlocked threadbear spare/ { sub(/^worktree /, ""); sub(/\n.*/, ""); if (index($0, d) == 1) print }'); do
  # One that can't be read is skipped, as the runner does.
  admin="$(git -C "$dir" rev-parse --absolute-git-dir 2>/dev/null)" || continue
  lock="$admin/locked"
  # The renamed file stays, touched first, until it's set up below: the runner's
  # borrow sweep counts it as the folder in use, so it doesn't take the
  # detached, unlocked folder back meanwhile (runner/src/borrows.ts).
  touch -c "$lock" 2>/dev/null || true
  if mv "$lock" "$lock.claimed-$$" 2>/dev/null; then
    claim="$lock.claimed-$$"
    # Not one with changes to tracked files: a spare never has them, so
    # someone is working there, and the reset below would take their work
    # (21 Nov). It stays unlocked, out of the pool, as the runner leaves one.
    if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no 2>/dev/null || echo unreadable)" ]; then
      echo "Passed over $dir: it has changes to tracked files, so someone is working there." >&2
      continue
    fi
    claimed="$dir"
    break
  fi
done

if [ -n "$claimed" ]; then
  git -C "$claimed" reset -q --hard
  git -C "$claimed" clean -ffdxq "${KEEP[@]}"
  git -C "$claimed" checkout -q -b "$(borrow_branch "$claimed")" main
  rm -f "$claim"
else
  mkdir -p "$THREADS"
  # The first free slot number. No cap on the number: on 17 Nov a cap of 50
  # was reached with every slot taken, and the borrow failed. A failed add
  # (another borrower took that number first) tries the next, a few times.
  # Paths git still has registered count as taken even with their folder
  # gone: git refuses to add one there.
  registered="$(git -C "$MAIN" worktree list --porcelain | sed -n 's/^worktree //p')"
  n=1
  tries=0
  while :; do
    claimed="$THREADS/slot-$n"
    if [ ! -e "$claimed" ] && ! printf '%s\n' "$registered" | grep -qxF "$claimed"; then
      err="$(git -C "$MAIN" worktree add -q -b "$(borrow_branch "$claimed")" "$claimed" main 2>&1)" && break
      tries=$((tries + 1))
      [ "$tries" -lt 5 ] || { echo "Couldn't make a worktree in $THREADS: $err" >&2; exit 1; }
    fi
    n=$((n + 1))
  done
fi
{
  echo "thread=${THREADBEAR_THREAD_ID:-}"
  echo "home=${THREADBEAR_RUNNER_HOME:-}"
  echo "branch=$(git -C "$claimed" symbolic-ref -q --short HEAD)"
  echo "pid=${THREADBEAR_BORROW_PID:-}"
  echo "scratch=${THREADBEAR_BORROW_SCRATCH:-}"
  echo "at=$(date +%s)"
} >"$(git -C "$claimed" rev-parse --absolute-git-dir)/threadbear-borrow"

"$claimed/worktree-setup.sh" >&2
echo "$claimed"
