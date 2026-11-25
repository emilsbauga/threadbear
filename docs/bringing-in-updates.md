# Bringing in Mike's updates (for an agent)

You're an agent in a thread started by Bring Them In (the app's Updates
panel, From Mike), by the runner on its timer (`runner/src/bring-in.ts`:
every 5 days by default, or straight away for an important release), or
someone asked you to bring in Mike's latest release. A thread the runner
started works out the merge without checking anything out, tells them what
the release brings and asks, and runs nothing from it until they say go
(section 2). It runs on the
install's default mode (`defaults.permissionMode` in `runner.json`, full
access when it isn't set), so on Ask before edits, on Codex's Auto (which
asks before edits and runs commands in a read-only sandbox), or when
Claude's Auto check stops a step, that step waits for them on a card
first: carry on with what you can and say what's waiting. If they say they don't want
these threads, or want them less often, change `releases.bringIn` in
`runner.json` (a number of days, `"important"` or `"off"`).
A thread started by Let's Discuss uses section 1 to talk the release
through first, and goes on to section 2 only once they say to.
This copy of Threadbear is their fork of `mikecann/threadbear`: `origin` is
theirs and `upstream` is Mike's. Their `main` has their own changes on it,
and your job is to add Mike's release to it without losing any of theirs.
docs/setup-and-updates.md section 2.3 explains the thinking behind it.

## 1. See what's coming

- `tb updates` names the newest release (`release/YYYY-MM-DD`), its
  commit id, and what's in it that main doesn't have. `tb updates check`
  fetches first. The runner only lists releases signed with the key setup
  pinned, and the commit id is the one the signature was checked for.
  Merge that commit id (it's in the message that started this thread
  too), never `upstream/main` (Mike's main can be halfway through
  something) and never anything under `refs/threadbear/upstream-incoming/`,
  which is where an older runner put what upstream served before it was
  checked. If `tb updates` no
  longer lists the release, or names a different commit for it, stop and
  say so rather than merging anything.
- Mike's changes: `git --no-replace-objects log --no-show-signature --no-merges main..<commit>`
  (`--no-replace-objects` on every git command that reads the release, so
  it's read as its id names it; section 4 says why). His commit
  messages say why, not just what.
- Their changes since they last brought a release in:
  `git --no-replace-objects log --no-show-signature --no-merges <commit>..main`. This is what you must keep.

## 2. Look at the merge without checking anything out

Nothing from the release runs until they say go (security review finding
3, 9 Nov 2026): not its checks, not `npm ci` or its install scripts, not a
build or a test. Don't even check its files out yet. Threadbear loads a
patch, a hook or a Claude setting from this checkout's worktrees as soon
as it's on disk, so merging into the worktree would already run the
release's own code. Work out the merge in git's objects instead:

```sh
scripts/merge-preview.sh <commit>
```

It works the merge out in a throwaway repo with none of anyone's git
config, so no merge driver, diff or textconv program this repo or this
Mac names can run on the release's files. It prints the merged tree, the
files that clash, if any, and what git said about them, then what the
release changes (it needs git 2.40 or later; with an older one, read the
changes with the commands below and leave the clashes to section 4). Read
Mike's changes against main with no external diff or textconv program:

```sh
git --no-replace-objects diff --no-ext-diff --no-textconv main...<commit>
git --no-replace-objects log --no-show-signature --no-merges --no-ext-diff --no-textconv main..<commit>
```

and for each clash, both sides' commits, so you can say how you'd settle
it (section 4).

Then settle the clashes before you ask, so a go goes straight to the
checks (Ville Lahdenvuo-Malta, 22 Nov 2026: about 5 minutes of a 35-minute
bring-in was settling clashes after go). Run the preview again with a new
folder of this thread's own, outside every checkout (even when it merges
cleanly: the merge after go uses that folder):

```sh
scripts/merge-preview.sh --prepare "${TMPDIR:-/tmp}/tb-bring-in-<thread id>" <commit>
```

It writes each clashing file, with git's conflict markers, under that
folder's `files/`. Settle each one there with Edit, as section 4 says,
until none has a marker left. That folder isn't a worktree, so nothing in
it is loaded or run, and you run nothing on its files: only edit them. A
file deleted or moved on one side has no copy there; settle it after go.
A release with a format commit keeps nothing there (its clashes are
settled after go, by replay-over-format.sh). If one clash needs the owner
to choose, settle the rest and ask about that one with the go.

## 3. Tell them, and ask

Tell them in a few lines what Mike's release brings, which of their own
changes clash with it and how you settled each (in the prepared folder,
section 2), and anything they'd need
to do themselves (a change to `runner/launcher/` only takes effect after
`runner/scripts/install-runner.sh`, which they run from a terminal). If
the release looks halfway through something (a feature half there, a
commit that says it's temporary, tests skipped), say so. A release often
adds checks that read the code (a security fix's source tests), and their
own changes can fail one even where the merge is clean. Say that if a
check the release added or changed (it's in `git --no-replace-objects diff --no-ext-diff --no-textconv main...<commit>`)
fails on their code, you'll change their code the way it asks, never the
check, and show them the diff when you land, so one go covers it. Then
ask whether to go ahead. Nothing from it has run, and nothing has changed
but git's objects.

## 4. Once they say go: merge, settle clashes, check

Threads in this repo get a worktree of their own (docs/thread-worktrees.md),
so main doesn't move until you land. With the prepared folder (section 2),
its clashes settled, merge there with:

```sh
scripts/merge-prepared.sh "${TMPDIR:-/tmp}/tb-bring-in-<thread id>" -m "Bring in Mike's release <date>"
```

It catches the branch up to the main the preview used, merges, and puts
the settled files in. If main has moved on since, or a settled file still
has markers, it changes nothing and says so: run the preview with
`--prepare` again and settle only what's new. If git clashes in a file the
preview didn't settle, it stops with the merge unfinished and names it:
settle that in the worktree and `git commit --no-edit`.

It merges the commit as its id names it: git's replacement objects and
grafts (`refs/replace/`, `.git/info/grafts`) can have git read a different,
unsigned commit in place of the one the signature covers, so the preview,
this and `replay-over-format.sh --merge` refuse a checkout that has either,
and read with both off, and with the commit-graph off, a file git reads a
commit's tree from in place of the commit (Daybreak, 24 Nov 2026). If one refuses, say so and
ask before removing them (`git replace -d <id>`, or that file). Without a
prepared folder (git older than 2.40, which the preview needs), check
`git for-each-ref refs/replace/` prints nothing and `.git/info/grafts`
isn't there, then merge with both off:

```sh
GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null git -c core.commitGraph=false merge --no-ff -m "Bring in Mike's release <date>" <commit>
```

Always a merge, never a rebase or a cherry-pick: Mike's commits have to
keep their ids, or the runner never sees this copy as up to date with his
release again. `tb land` knows not to rebase a branch with a merge on it.

If the release has a format commit this copy doesn't (one listed in its
`.git-blame-ignore-revs` under `# format-subject:`, like "Format desktop/'s
Rust with cargo fmt --all, nothing else"), merge with this instead of the
`git merge` above:

```sh
scripts/replay-over-format.sh --merge <commit> -m "Bring in Mike's release <date>"
```

It merges the commit before the format commit first (an ordinary merge, so
any clash there is a real one), then the format commit itself with this
copy's tree run through the same formatter as the result, then the release:
none of the formatting clashes, and Mike's commits keep their ids. A clash
it stops at is sorted out as below, then `git commit` and run it again. It
needs the formatter the list names (`cargo fmt` from rustup for the Rust
one; rustup fetches the pinned toolchain itself). The split of
docs/protocol.md into docs/protocol/ is one too (`# format-tool:`, run by
node): your edits to the single file land in the file their section went
to. A copy of the script older than the split doesn't know that kind
and would leave the split as a conflict, so run the release's own copy. If
this checkout doesn't have the script yet, the same, reading it from the
release's commit as its id names it (stop if `git for-each-ref
refs/replace/` prints anything or `.git/info/grafts` is there: section 4):

```sh
git --no-replace-objects -c core.commitGraph=false show <commit>:runner/src/format-replay.ts > "${TMPDIR:-/tmp}/format-replay.ts"
node "${TMPDIR:-/tmp}/format-replay.ts" --merge <commit> -m "Bring in Mike's release <date>"
```

Your own branches made before it then land across it by themselves:
`tb land` formats their commits the same way on the way.

Where git can't merge, or where the merge is clean but the result doesn't
make sense, work out what each side was for, from both sides' commit
messages and diffs, and write code that does both:

- If Mike's change now does what theirs did, keep Mike's and drop theirs,
  and say so.
- If theirs changed something Mike has since moved or rewritten, put their
  change back onto Mike's new code rather than keeping the old shape.
- If you can't do both, stop and ask them which they'd rather have, with
  what each does.
- If both sides used the same backend API numbers (`API_VERSION` in
  `convex/version.ts`, `BACKEND_API_VERSION` in `runner/src/sync.ts`), keep
  Mike's: phones from the App Store and every runner on his backend go by
  them. Move this copy's own after his last, in both files and anything that
  checks for its old numbers.
- A lint failure listing many old problems in one file is ESLint's
  suppressions: one over a file's count in `eslint-suppressions.json` shows
  every one of that rule there. Fix the new one; don't hand-edit the file.

Their patches (`.threadbear/patches/`, `~/.threadbear/patches/`) and
settings (`runner.json`) aren't part of the merge. Check they still work
against Mike's changes (docs/protocol/patches.md, "Patches", says what a patch can
use), and fix them if not.

Then `./check.sh --all` runs every check (several minutes; up to ten for
the app in a folder that has never built it). All of it must pass before
you land.

## 5. Land

If the checks passed and every clash went the way you told them, `tb land`.
A change to their code for a check the release added or changed, as
section 3 said, needs no second ask: show them its diff once it's landed.
Ask again first, saying what and why, if a check that was there before
the release failed, if the fix would mean changing a check rather than
their code, if anything else failed, or if you had to rework something
you hadn't told them about. The runner, the backend and the app
then update themselves from main, as they do for any change.

If something goes wrong afterwards, `git revert -m 1 <merge commit>` on
main takes the whole release back out in one go.

## 6. Offer to push it

`tb land` doesn't push (unless they've listed the repo in runner.json's
`pushAfterLanding`), so their own copy on GitHub (`origin`) is still on
the old main: if this Mac went, the merge and anything of theirs not yet
pushed would go with it. Once it's landed, if `git log origin/main..main`
lists anything, say so and ask whether to push it. Run `git push origin
main` only when they say yes. GitHub refuses a push that changes
`.github/workflows/` (most releases do) from an HTTPS login without the
`workflow` scope, which the GitHub CLI doesn't ask for by default. If
`origin` pushes over HTTPS, look at `gh auth status` before you ask, and if
its scopes lack `workflow`, ask them to run `gh auth refresh -h github.com
-s workflow` in a Terminal (or push over SSH, where scopes don't apply).
If `origin` isn't on GitHub, or they'd rather keep main to this Mac, leave
it.

## 7. Offer Mike a check-up

Once it's landed (or once they've said not to land it), run `tb checkup`,
with `--text "..."` for one or two plain sentences of your own on what went
wrong, if anything: a clash with their changes and how it settled, a check
that failed, a patch you had to fix. Leave out anything about their own
work (project names, what their changes are for, file paths of theirs). It
drafts a short report for Mike from facts the code picks: which release
came in and how far behind main was, how often each of Threadbear's own
runner errors came up since the last check-up, how long `tb land`'s checks
took (how many, typical and slowest, the slowest steps), whether the runner's build
of main is failing, and which of Mike's patches won't load. It names only
what's in Mike's code; anything of theirs is just a count, and the draft is
scrubbed of secrets and their home folder.

Put the draft in your reply as it is, and ask with a card whether to send
it: it goes as a comment on a public Discussion on Mike's GitHub repo,
under their own GitHub login, so Mike can see what's going wrong in other
people's copies and fix it. Answers: Send (`tb checkup --post`), Skip
(`tb checkup --skip`), and Never ask (set `"releases": { "checkup": false }`
in `runner.json`, then `tb checkup --skip`). If they want it worded
differently, run `tb checkup` again with a new `--text` and show it again:
`--post` sends exactly the last draft they saw. If `--post` says gh isn't
signed in, give them the draft to paste and the link it prints. If it says
Mike hasn't opened the Discussion yet, or `tb checkup` says check-ups are
off here, skip this section and say nothing about it.
