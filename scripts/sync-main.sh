#!/bin/bash
# Brings GitHub's main and this Mac's together, and pushes, with tb land's
# lock held the whole time (docs/thread-worktrees.md, "Syncing main with
# GitHub"). Main here moves by tb land; GitHub's by pushes and merged PRs.
#
#   scripts/sync-main.sh     from any checkout of this repo
#
# - Only GitHub has moved: main fast-forwards to it.
# - Only this Mac has: main is pushed.
# - Both have: this Mac's commits are rebased onto GitHub's in a borrowed
#   worktree, ./check.sh --quick runs on that (a combination nobody has
#   checked yet), and only if it passes does main move to it and get
#   pushed. A conflict or a failed check leaves main as it was.
#
# Never rebase main in its own checkout instead: a rebase there leaves
# HEAD detached until it ends, and a landing in the meantime would move
# that rather than main (tb land now refuses while one's in progress, but
# it then has to wait for you).
set -euo pipefail
die() { echo "$*" >&2; exit 1; }
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
MAIN="$(git -C "$(dirname "$SELF")" worktree list --porcelain | awk '
  /^worktree / { path = substr($0, 10) }
  /^branch refs\/heads\/main$/ && !found { print path; found = 1 }
')"
[ -n "$MAIN" ] || die "No checkout of this repo has main checked out."
LOCK="$(git -C "$MAIN" rev-parse --path-format=absolute --git-common-dir)/threadbear-land.lock"

# This Mac's main only ahead of GitHub's (the usual case: landings since
# the last push): push it straight away, without the lock. A push moves
# only GitHub's main, never this one, and is a fast-forward or refused, so
# it can't race a landing. With landings queued, waiting for the lock took
# over 30 minutes (13 Nov), and GitHub's main lagged all that time. The
# commit pushed is the one read here, even if a landing moves main since.
if [ "${THREADBEAR_SYNC_LOCKED:-}" != 1 ]; then
  git -C "$MAIN" fetch -q origin main
  here="$(git -C "$MAIN" rev-parse refs/heads/main)"
  there="$(git -C "$MAIN" rev-parse refs/remotes/origin/main)"
  if [ "$here" = "$there" ]; then
    echo "main is the same here and on GitHub."
    exit 0
  fi
  if git -C "$MAIN" merge-base --is-ancestor "$there" "$here"; then
    # Refused if GitHub moved meanwhile; then it goes the long way, below.
    if git -C "$MAIN" push -q origin "$here:refs/heads/main"; then
      echo "Pushed main to GitHub ($(git -C "$MAIN" rev-list --count "$there..$here") commits)."
      exit 0
    fi
    git -C "$MAIN" fetch -q origin main
  fi
fi

# Everything below runs under the landing lock, in one process: GitHub's
# has moved too, so this Mac's main may have to.
if [ "${THREADBEAR_SYNC_LOCKED:-}" != 1 ]; then
  # With landings going, waiting for the lock may never end (17 Nov: over an
  # hour, as lockf isn't a fair queue and landings kept coming). When this
  # repo is in runner.json's pushAfterLanding, the landing that holds the
  # lock merges GitHub's in, checks it and pushes once it has landed
  # (worktrees.ts, pushMain), so there's nothing to wait for. Only with a
  # landing in the queue that says it will push (a dry run never does), and not when a
  # landing's merge of this same GitHub main already failed: then it won't
  # try again for hours, so this waits and tries itself.
  # -k: without it lockf deletes the lock file, and a landing already
  # waiting on that file would hold a lock nobody else sees (Codex, 17 Nov).
  if [ "$(uname)" = Darwin ]; then busy() { ! /usr/bin/lockf -k -t 0 "$LOCK" true 2>/dev/null; }; else busy() { ! flock -n "$LOCK" true; }; fi
  if busy && node -e '
    const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
    const [main, common, github] = process.argv.slice(1);
    const home = process.env.THREADBEAR_HOME || process.env.THREADBEAR_DATA_DIR || path.join(process.env.HOME, "Library/Application Support/Threadbear");
    const repo = (d) => { try { return fs.realpathSync(execFileSync("git", ["-C", d, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch { return path.resolve(d); } };
    const json = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return undefined; } };
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
    const list = json(path.join(home, "runner.json"))?.pushAfterLanding;
    const want = repo(main);
    const on = Array.isArray(list) && list.some((d) => typeof d === "string" && d && repo(d.replace(/^~(?=\/|$)/, process.env.HOME)) === want);
    const q = path.join(common, "threadbear-land-queue");
    let names = []; try { names = fs.readdirSync(q).filter((n) => n.endsWith(".json")); } catch {}
    const landing = names.some((n) => { const e = json(path.join(q, n)); return e && e.push === true && Number.isInteger(e.pid) && !e.result && !e.refused && alive(e.pid); });
    const failed = json(path.join(common, "threadbear-land-push.json"))?.github === github;
    process.exit(on && landing && !failed ? 0 : 1);
  ' "$MAIN" "$(dirname "$LOCK")" "$(git -C "$MAIN" rev-parse refs/remotes/origin/main)"; then
    echo "GitHub's main and this one have both moved, and a landing is going: when it lands it merges GitHub's in, checks that and pushes (pushAfterLanding in runner.json). Nothing to do here; tb land's output says how it went."
    exit 0
  fi
  echo "Taking the landing lock (a landing in progress finishes first)..."
  if [ "$(uname)" = Darwin ]; then
    exec /usr/bin/lockf -k "$LOCK" /usr/bin/env THREADBEAR_SYNC_LOCKED=1 "$SELF" "$@"
  else
    exec flock -x "$LOCK" env THREADBEAR_SYNC_LOCKED=1 "$SELF" "$@"
  fi
fi

cd "$MAIN"
[ "$(git symbolic-ref -q HEAD || true)" = refs/heads/main ] || die "$MAIN isn't on main; nothing synced."
GITDIR="$(git rev-parse --absolute-git-dir)"
for f in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD sequencer BISECT_LOG; do
  [ -e "$GITDIR/$f" ] && die "$MAIN has something half done ($GITDIR/$f); finish or abort it first. Nothing synced."
done

git fetch -q origin main
here="$(git rev-parse main)"
there="$(git rev-parse origin/main)"
if [ "$here" = "$there" ]; then
  echo "main is the same here and on GitHub."
  exit 0
fi
if git merge-base --is-ancestor main origin/main; then
  git merge -q --ff-only origin/main
  echo "main fast-forwarded to GitHub's ($(git log --oneline "$here..main" | wc -l | tr -d ' ') commits)."
  exit 0
fi
if git merge-base --is-ancestor origin/main main; then
  git push -q origin main:main
  echo "Pushed main to GitHub ($(git log --oneline "$there..main" | wc -l | tr -d ' ') commits)."
  exit 0
fi

echo "main and GitHub's have both moved; checking this Mac's commits on top of GitHub's in a borrowed worktree..."
# Given back however this ends: a failure, a stop (the traps below turn
# INT, TERM and HUP into an exit, so the EXIT trap runs), or success. Only
# SIGKILL gets past that, so the borrow names this process and says what's
# in it is scratch: once the process has gone, the runner aborts what was
# half done there and takes it back (runner/src/borrows.ts). On 17 Nov a
# killed run's borrow was among the 25 never given back.
wt=""
wt_admin=""
borrowed=""
give_back() {
  [ -n "$wt" ] || return 0
  # Only while it's still this run's borrow, checked before anything
  # changes there: given back by hand meanwhile, it may be someone else's
  # now (or a link to one), and an abort or a reset would take their work.
  # Its branch is the borrow's, or the one its rebase is on.
  local admin on
  admin="$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null || true)"
  on="$(cat "$admin/rebase-merge/head-name" "$admin/rebase-apply/head-name" 2>/dev/null | head -1 || true)"
  [ -n "$on" ] || on="$(git -C "$wt" symbolic-ref -q HEAD 2>/dev/null || true)"
  if [ -L "$wt" ] || [ "$admin" != "$wt_admin" ] || [ "$on" != "refs/heads/$borrowed" ]; then
    echo "$wt isn't this run's borrow any more, so it was left as it is." >&2
    return 0
  fi
  git -C "$wt" rebase --abort >/dev/null 2>&1 || true
  git -C "$wt" merge --abort >/dev/null 2>&1 || true
  git -C "$wt" reset -q --hard main >/dev/null 2>&1 || true
  # Untracked files the check left (not ignored ones: the build caches stay
  # for the next borrower), which --give-back would refuse.
  git -C "$wt" clean -fdq >/dev/null 2>&1 || true
  "$MAIN/borrow-worktree.sh" --give-back "$wt" >/dev/null 2>&1 || echo "Couldn't give $wt back; run $MAIN/borrow-worktree.sh --give-back $wt" >&2
}
trap give_back EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# Failing here has to fail the script: on 17 Nov every slot was taken, and
# the run's caller read its output as a push.
wt="$(THREADBEAR_BORROW_PID=$$ THREADBEAR_BORROW_SCRATCH=1 "$MAIN/borrow-worktree.sh" | tail -1)" || wt=""
[ -n "$wt" ] && [ -d "$wt" ] || { wt=""; die "Couldn't borrow a worktree to check in, so main wasn't moved or pushed."; }
wt_admin="$(git -C "$wt" rev-parse --absolute-git-dir)"
borrowed="$(git -C "$wt" symbolic-ref -q --short HEAD || true)"
case "$borrowed" in thread/borrow-*) ;; *) wt=""; die "The borrowed worktree isn't on a borrow branch, so main wasn't moved or pushed." ;; esac
git -C "$wt" reset -q --hard main
# A merge on this Mac's side (a release brought in) would be flattened by a
# rebase, losing what only the merge holds, so GitHub's is merged in then.
if [ -n "$(git rev-list --merges origin/main..main)" ]; then
  join=(merge -q --no-edit origin/main)
else
  join=(rebase -q origin/main)
fi
if ! git -C "$wt" "${join[@]}"; then
  files="$(git -C "$wt" diff --name-only --diff-filter=U)"
  die "This Mac's commits conflict with GitHub's in:
$files
Nothing synced. Bring them together by hand in a worktree of your own, check, then land that."
fi
(cd "$wt" && ./check.sh --quick) || die "The check failed on this Mac's commits over GitHub's, so main wasn't touched."
new="$(git -C "$wt" rev-parse HEAD)"
# Under the lock no landing moves main, but something by hand could have
# switched the checkout or started a rebase during the check: asked again.
[ "$(git symbolic-ref -q HEAD || true)" = refs/heads/main ] || die "$MAIN isn't on main any more; nothing synced."
for f in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD sequencer BISECT_LOG; do
  [ -e "$GITDIR/$f" ] && die "$MAIN has something half done ($GITDIR/$f); nothing synced."
done
[ "$(git rev-parse main)" = "$here" ] || die "main moved while this ran; nothing synced."
# reset --keep keeps unstaged changes but not what's staged: refuse those.
git diff --cached --quiet || die "$MAIN has staged changes, which moving main would unstage; commit or unstage them. Nothing synced."
git reset -q --keep "$new" || die "main's checkout has changes in files this would change; nothing synced."
[ "$(git rev-parse main)" = "$new" ] && [ "$(git reflog -1 --format=%H refs/heads/main)" = "$new" ] &&
  [ "$(git symbolic-ref -q HEAD || true)" = refs/heads/main ] || die "main didn't end up at the checked $new; look at git reflog in $MAIN. Not pushed."
git push -q origin main:main
echo "main is now GitHub's with this Mac's $(git log --oneline "$there..main" | wc -l | tr -d ' ') commits on top, checked and pushed."
