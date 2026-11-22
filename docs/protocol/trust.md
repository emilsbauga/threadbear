# Runner protocol: Trusting a folder's patches and hooks

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

### Trusting a folder's patches

A patch file is code. Importing it runs it, and its hooks, live state
functions and worktree `setup` then run by themselves, so without a gate
opening a thread in a repo someone else wrote would run that repo's code
before you'd said a word. The runner only imports a project's patch file
(`src/patch-trust.ts`) once that version of it is trusted, the way VS
Code and Claude Code ask before running a folder's code. Until then it's
in `patches` with `untrusted` and `hash`, and gives nothing: no actions,
panels or hooks, no live functions, and no worktree for new threads.

- On Windows, for now, a trusted patch runs nothing by itself: its
  actions run when clicked, but its hooks, worktree `setup` and `teardown`
  are dropped as it loads, and a live function's `sh` refuses every
  command. The patch's `liveError` says so. Following a script there still
  has gaps a repo written against it could use (`clicksOnly` in
  `src/platform.ts`). Home patches and Threadbear's own, which load
  without a hash, are as on a Mac. A schedule's check in a repo's folder
  (outside Threadbear's own checkout) doesn't run there either, approved
  or not: the run goes ahead without it and says why. The rule is read
  once as the runner starts.
- Trust is kept per folder (the one holding `.threadbear/`) as the
  SHA-256 hashes of the patch files trusted there, in `patch-trust.json`
  in the data dir. `untrusted` is `"new"` when nothing from that folder
  is trusted and `"changed"` when an earlier version was: a pull brought
  a new one, and it's asked about again.
- A git worktree counts as its main checkout, so a thread's worktree of
  a trusted repo isn't asked about. Only one git made: its `.git` file and
  the repo's record of it must name each other, so a folder can't claim
  to be a worktree of a trusted repo. The `.git` must be a plain file
  (a symlink to another worktree's, from a zip say, makes no worktree),
  and the record must name that very entry, `<folder>/.git`.
- A patch file a Claude thread's agent writes with an Edit or Write call
  on Full access, inside the thread's own folder, is trusted as that edit
  left it: the agent can run anything in the folder already. Not in Ask
  or Auto, where it couldn't: there the write waits for Mike like any
  other, and the edit asks first (below, "Agent writes that run as
  code"). The mode is the one the call went through on, recorded with
  it, not the thread's when the result comes, so switching to Full access
  after approving an edit in Ask doesn't trust it. Only the thread
  folder's own patches (its `.threadbear/patches`) and files inside that
  folder count: another project's patch, a tool patch, or a repo's under
  a thread in a folder above it (`~`, `~/dev`) waits too.
  Only an edit the CLI says it made counts, when its
  successful result comes in, never the diff shown to approve one, so a
  denied or failed edit trusts nothing. And only the bytes it wrote: the
  hash of the file rebuilt from the result (a Write's content, an Edit
  applied to the original text it reports), which the file must still
  have, in the same read the trust hash is made from. A file written
  over after that (a command run straight after the edit) isn't
  covered, and one the result can't be rebuilt for waits. An Edit or
  MultiEdit vouches only for what it changed: the rest of the file is
  the text it started from (the result's original), so it counts only
  when that was bytes trusted before (a version of a trusted patch or
  helper, or another such edit's), or when there was no file or an empty
  one. A Write is all the agent's. So a one-line Edit to a cloned repo's
  patch, or to a helper a pull changed, trusts nothing. Nor does one
  edit vouch for files it didn't write: the patch is trusted only when
  every other file its hash covers (its helpers, the scripts it names)
  is bytes that were part of a version trusted while the runner has run,
  or another such edit's. A patch Codex writes waits for Mike: its
  result doesn't say what bytes it wrote, so a command could have
  replaced the file before the runner read it. One written another way,
  like a shell heredoc or a `git pull`, waits.
- Always trusted: `~/.threadbear/patches` and Threadbear's own checkout
  (the release's `checkout`, else the one the runner runs from).
- `patches.trust` trusts what the app showed, by hash. Clients show a
  waiting patch with a way to read its file and trust it.
- A runner's first start with this (no `patch-trust.json` yet) trusts
  the patch files of every thread's folder and every project's as they
  are, since it was already running them.

The hash covers the patch file and the local files it imports, and
theirs in turn (specifiers starting `./`, `../` or `/`), so a pull that
changes only a helper is asked about too, and `helpers` lists them so the
app can say what else would run. It also covers any existing file the
patch or a helper names in a path starting `./` or `../`, anywhere in its
text, from the patch's own folder or the folder holding `.threadbear/`
(where commands run), each place that has it: the script a worktree
`setup`, `check`, hook or action `run` calls, so a pull that changes only
that script asks again. What a named script runs in turn is followed
and hashed too (below, "What a script runs"), and a named file that
isn't there yet changes the hash when it turns up. The hash is SHA-256
over the JSON of `["threadbear-patch-3", <the patch file's SHA-256>,
[[<path from the patch's folder>, <its SHA-256 or "missing">], ...]]`,
sorted by path, for every patch, helpers or not: JSON quotes each
string, so no two sets of files read the same. (Version 2 joined
`<path> <hash>` lines with newlines, and a folder named
`lib.sh <hash>\nz` could stand in for two files: Gautam's scan, 6 Nov.)
A patch that reaches a file whose path holds a newline or another
control character isn't loaded at all (below).

**Only code is hashed.** A file the patch, a helper or a script merely
names (a string, an argument, `$(cat VERSION)`, `< data.txt` into
anything but a shell) goes in the hash only if it looks runnable: an extension of `.sh`, `.bash`,
`.zsh`, `.ksh`, `.command`, `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`,
`.cts`, `.tsx`, `.jsx`, `.py`, `.rb` or `.pl`, the executable bit, or a
`#!` first line; a missing one counts only with one of those
extensions, or with no extension in a command's place (`./bin/tool`).
Anything else (`./state.json`, `.cache/state.json` by the repo's
absolute path, notes, pictures, folders) is data and isn't, so a patch
that writes its own state file isn't asked about again after every
run. What something runs, sources or loads is hashed whatever it looks
like: an import, a file `sh`, `bash`, `node` or `bun` is given
(`sh ./x.json`), a `source`d file, the `package.json`, `.npmrc` and
the like a package script runs from, a Makefile. The limit: a hashed
script's behaviour can still depend on the data files it reads, which
can change without asking. Trusting a script trusts what it does with
its data, so a script that runs what a data file says (`sh -c "$(cat
cmd.txt)"`) still fails closed, as below. A command that runs by itself
(a `setup` or hook) must still be one hashed script, so naming a data
file there refuses the patch as before. Packages (`node:fs`, anything
npm installed in `node_modules`) aren't followed: they're the folder's
dependencies. A package the repo commits is its own code, though (below,
"Committed node_modules").

A patch whose code can't all be seen isn't loaded at all, trusted or not,
and has `error` (not `untrusted`) saying why, as a stored hash can't vouch
for code it didn't cover: one that loads code by a name worked out as it
runs (`import(name)`, `` import(`./${x}`) ``, `require('./a' + b)`, any
`createRequire`, `node:module`, `node:vm`, `node:worker_threads`,
`node:inspector`, `node:repl`, `eval`, `Function`, a `data:` or `#`
specifier, in any case, or any other URL scheme), or that reaches code
made from a string or bytes by another route (`globalThis.eval`,
`window['Function']`, any `.constructor` such as `(() => {}).constructor`,
`const { eval: run } = globalThis`, `Reflect.get` with anything but a
plain harmless name or `Reflect` handed on, `getOwnPropertyDescriptors`,
`process.binding`, `node:test`, `{ __proto__: f }`, `WebAssembly`, or
`process`, `globalThis` and the like used as values, as in
`Object.entries(process)`), in the patch file or a helper, one the runner
can't parse, or one that reaches more than 100 local files. Loads are read
from the parsed syntax (oxc), so comments and strings don't count either way. `patches.trust` can't trust it; changing it to plain
imports can. An agent's Edit or Write to a helper carries on the trusted
patches that import it, as it does for the patch file (only with the
helper as that edit left it, and an Edit only of the helper as it was
trusted); it doesn't trust a patch that's still waiting. A trust file
from an earlier version (`version: 1` or `2`) is
read as it is, but its patch hashes are kept apart (`legacy:` in front,
written back as version 3) so none can match a version 3 one, and every
patch it trusted is asked about again (`"changed"`), once: nothing is
carried over, as an old hash can't tell apart the file sets it was
fooled by. (An old helper-less hash is the file's own SHA-256, so an old
patch whose text was a version 3 hash's JSON would otherwise match the
patch that JSON names.) Each trusted version of a patch is a module graph
of its own: the patch, its helpers and the packages its repo commits are
imported at their own paths with that version's id as the query
(`?tb=<id>`, from the patch's path and hash), with their import edges kept
under those URLs, so a new version loads its own helpers at once and no
version is ever handed another's helper or follows another's edges, a
late `import()` included (Daybreak 131, 15 Nov 2026). Node keeps CommonJS
by path whatever the query, so a trusted patch's graph refuses a CommonJS
file (a `.cjs`, or a `.js` with `require` and `module.exports`); one
written with `import` and `export` (`.ts`, `.js`, `.mjs`) loads, and a
bare import of a package the repo commits loads only while the
`package.json` Node resolved it by is this version's, byte for byte.

What's imported is what was hashed. The hash is made from one read of
each file, and a trusted patch and its helpers are imported from those
bytes (`src/verified-imports.ts`, Node's module hooks), never read from
the folder again, so a command that rewrites one between the check and
the import changes nothing that runs. Imports are told apart by how
they're written: a local one (`./`, `../`, `/`, `file:`) loads the very
file the hash followed it to, from the hashed bytes, whatever a symlink
points at by then (into `node_modules` too), and one the hash didn't
follow refuses the patch; a bare one (a package, `node:fs`) resolves
as Node resolves it, unhashed, as packages are the folder's dependencies,
and must land in a builtin or in that package's own folder in a
`node_modules` (`node_modules/zod/...`), else it refuses the patch. Node resolves a bare name through the nearest
`package.json`'s own `name` and `exports` before `node_modules` (so a
patch importing its own package's name is refused outright), so a
pull that renamed the repo's package `zod` sent `import 'zod'` to one of
the repo's scripts (Gautam's scan, 6 Nov); a workspace package (a link
in `node_modules` to `packages/x`, which Node follows) is a file of the
repo's that nothing hashed in the same way, so it refuses the patch too.
`#` imports are refused for the same reason (above).

**Committed node_modules.** A repo can commit its own
`node_modules/zod` (`git add -f` gets past `.gitignore`), and `import
'zod'` from a trusted patch then ran whatever a later pull put there,
unasked. So files git tracks under any `node_modules` folder of the
repo, submodules included (inactive ones too, as their files are on
disk), are the repo's own code: once the patch, a helper, or a script one
of its commands runs has any bare import that isn't a builtin, every one
of them is hashed with the patch and followed for its own imports like a
helper, and the patch's imports of them are served from those bytes.
All of them, not only the named package's folder: Node also finds
`node_modules/payload.js` for `require('payload')`, a package a pull adds
later, or one in a parent folder, and an installed package may import a
committed one, and on a Mac `node_modules` finds a committed
`NODE_MODULES` too. Packages npm installed (untracked, ignored) aren't
hashed, so an install never asks again (Mike's call, 7 Nov). A package
manager finds them without any import naming one, so `npm run`, `yarn x`,
`npm install`, `npm rebuild`, `npx x`, `npx -c x`, `node --import x` (a `#`
mapping or a URL there can't be followed) and a package's
`node_modules/.bin` put on `PATH` by hand count as a bare import does, once a
`node_modules` is on the way up from where they run. An install's and a
rebuild's lifecycle scripts run from a committed package's own folder, so
they're followed from there, past `node_modules` too, and a file committed
under `.bin` is followed as what runs, as a shell would. A workspace or `file:` package isn't
under `node_modules` at all: npm links it there, so its files are the
repo's. A script a command runs that has any bare import hashes and follows
every such package linked into a `node_modules` on the way up, not only one
it names, as an installed package may import one (and a package script or
`npx` running its bin follows that), each file of it but its own
`node_modules`, up to 300, as its `package.json` decides which an import
loads. One holding a link or a native addon can't be followed, nor a
committed or linked package whose `exports`, `main`, `module` or `bin`, or a
bare import itself (`wsp/payload`, or `payload` for a file of that name in
`node_modules`), names a file that isn't
JavaScript, or a pattern that doesn't end in it, and nor can a script that
`require`s a file of the repo's by a name that isn't JavaScript or JSON:
Node runs any of those as CommonJS, and what it loads wouldn't be followed.
Nor can a script that imports its own package by name, where the
nearest `package.json` has that `name` and an `exports`: that `package.json`
is noticed, not hashed, as an install writes it, so a pull that renames the
repo's package shows the next time the patch is looked at or a chip pressed.
(A patch's own import of one is refused, above.) The index files git keeps (each
submodule's too, and each submodule's `.git`, so checking one out later
shows) are watched, so a pull that starts tracking `node_modules/zod`
over an installed copy asks again, and the module hook
refuses a committed file under `node_modules` that a patch's import
reaches but the hash didn't cover. When git can't say what it tracks (it
fails, or the folder isn't a git checkout but has a `node_modules`, which
could be from npm or from the zip), a link the repo commits under
`node_modules`, a committed native addon (`.node`), or more than 100
committed files under `node_modules`, the patch isn't loaded at all
(`error`). git runs with `core.fsmonitor` off, so a folder's own
`.git/config` can't make that run anything; so does every other git the
runner runs in a thread's folder (the Claude settings check's listing of
skills, worktrees, moves), all through `runner/src/safe-git.ts`. A move's
git goes further (`untrustedGit`, below under "Moving a thread", Git). A cached hash holds only while every file it was
made from has the same inode, size, mode, mtime and ctime (a write
can't put ctime back), every path to one still leads to the same real
file, and nothing that was missing has turned up. A hook or `setup`
runs its script from the folder, so the patch is hashed afresh just
before it runs, and it's skipped with a `system.note` if that isn't the
version that was trusted.

So trust covers the bytes of the patch and the code it names, checked
right before they run. What a trusted script does as it runs (the files
it reads, copies or generates, like `cp ./payload.txt ./stage.sh && sh
./stage.sh`) is trusted with it, and a change another process makes
while it runs isn't caught: the same as running a shell script you've
reviewed.

A new thread's worktree `setup` runs only when the worktree's own copy of
the patch, with the files it names as they are there, is a trusted
version, and it's that copy's `setup` that runs: the worktree is main's
commit, which can differ from the main checkout that was trusted.
Otherwise the setup is skipped with a `system.note` saying why, and the
thread starts in the worktree anyway. A worktree's `teardown` is read the
same way, from the worktree's copy as the thread's branch has it when the
thread is archived or deleted: a teardown changed on the branch (a commit,
a pull) is a version nobody trusted, so it doesn't run, and a
`system.note` (a notice, for a deleted thread) says so.

**Commands that run by themselves.** A project patch's worktree `setup`
and `teardown` and its hooks run without anyone pressing anything, so the hash has to
cover what they run, and it can only see a path written in the patch.
So each must be one script and plain words: a `./` or `../` path from
the folder holding `.threadbear/` (for a patch file that's a link into
another folder, the one holding the link, where its commands run, and
where what its scripts run is followed from too), to an existing file inside the repo
(the git toplevel) that the hash covered, then arguments made only of
letters, digits and `_ @ % + = : , . / -`. Anything a shell would work
out first (`cd scripts && ./setup.sh`, `FOO=1 ./x`, `sh -c`, `bash x.sh`,
`npm run x`, `npx tsc`, pipes, `;`, `$(...)`, quotes, globs, a path
worked out in code) could run a file the hash never saw, so the patch
isn't loaded at all, trusted or not: its `error` starts `Not run:`,
names the command and says to put the steps in a script. The runner then
runs the script by its absolute path (a hook's `exec`), every word
quoted, from the folder holding `.threadbear/` (`cd '<folder>' &&
'<script>' ...`), so it's the hashed file that runs, and the folder its
own relative paths were followed from: a hook in a thread in a subfolder
runs the patch folder's `./scripts/x.sh` from the patch folder, not the
subfolder's. Home's patches and Threadbear's own checkout are trusted
whatever they hold, so their commands run as written.

**What a script runs.** A trusted `./setup.sh` that runs `./helper.sh`
must not run a changed helper unasked, so from every script a patch
names, the runner follows what it can run or read in the repo and hashes
it with the patch (`runner/src/script-trust.ts`), up to 300 files and 12
scripts deep:

- Shell scripts (by `#!` or `.sh`/`.bash`/`.zsh`), read with a small
  shell lexer: a command that's a path (`./helper.sh`,
  `"$(dirname "$0")/x.sh"`, `${0%/*}/x`, `"$DIR/x"` after
  `DIR="$(cd "$(dirname "$0")" && pwd)"` or `$(git rev-parse
  --show-toplevel)`), `source`/`.`, `sh`/`bash`/`zsh` with a file or a
  literal `-c`, `node`/`bun`/`deno`/`tsx` with a file, what `env`,
  `exec`, `nice`, `nohup`, `timeout`, `taskpolicy`, `xargs`,
  `find -exec` and the like run, `trap` with literal code, and the
  `$(...)`s in words, assignments and unquoted here-docs. A `cd` to a
  path it can work out is followed, so later relative paths resolve.
- Package scripts by a literal name: `npm run x`, `npm test`,
  `yarn x`, `pnpm x`, `bun run x` hash the nearest `package.json` and
  follow that script (and its `pre`/`post`) as shell from the package's
  folder, a program in it that `node_modules/.bin` leads to a file of the
  repo's included; `npm ci`/`install` (any package manager) follows the
  lifecycle scripts (`preinstall`, `postinstall`, `prepare`...) of the
  package, its workspaces and its `file:` dependencies; `npx x`/`bunx x`
  hash `package.json`. `.npmrc`, `.yarnrc(.yml)`, `bunfig.toml`,
  `.pnpmfile.cjs` and `pnpm-workspace.yaml` beside it are hashed, and
  code they load followed. They're read a line at a time (a multiline
  regex over the whole file was quadratic in a run of blank lines, so
  a few MB of newlines held the runner before anyone was asked: Gautam's
  scan, 6 Nov), each once per hash, and one over 1 MB fails closed, as
  does a quoted path with an escape that can't be read or a YAML value
  that isn't a plain path (a tag, anchor, alias, block, or a flow value
  with a path in it). A plugin's `- path:` counts, and so does Yarn
  Classic's `yarn-path ./x.cjs`.
- `make`: the Makefile (and literal `include`s) is hashed and every
  recipe line followed as shell, `$(MAKE)` as `make`, read a line at a
  time, and one over 1 MB fails closed. `-f`/`-C` count however they're
  written (`-fx.mk`, `-sf x.mk`, `--file=x.mk`), and `-f -` (the Makefile
  from make's input) fails closed, as does an `include` of one; every
  `-f` is read, a rule's recipe after `;` is followed, a comment is only
  a comment, `-I` folders are searched for includes, each `-C` goes on
  from the one before, and `.RECIPEPREFIX` and `X != cmd` fail closed as
  `SHELL` does. A shell script
  over 1 MB fails closed too, and so does any file over 32 MB a patch
  reaches (its hash can't be made). A path into the repo by another
  name (`/tmp` for `/private/tmp`) counts as the repo's.
- JavaScript and TypeScript: imports, as for patch files (a package
  the repo commits too, "Committed node_modules" above), and every
  plain string that's the path of a file of the repo's that looks
  runnable (`spawnSync('bash', ['scripts/x.sh'])`).
- A file redirected into a shell or `source`/`.` (`bash ... < ./steps.txt`), whatever it
  looks like: a flag that makes the shell read commands from its input
  would run it.
- Any other file of the repo's a script names (an argument, `< file`,
  a `./` path anywhere in its text) is hashed if it looks runnable
  (above, "Only code is hashed").

It holds what a script writes against what it runs: a file it (or a
script it reaches) writes and also runs, sources, loads or hashes as code
can't be followed, as the bytes that will run were never hashed (`cp
payload.dat run.sh; sh run.sh`, `cat x > run.sh`, `tee`, `mv`, `dd of=`,
`sed -i`, `curl -o`, `${dest:-run.sh}`'s default; a folder copied over
one's folder counts), in any order, and so can't a write to somewhere
worked out as it runs or named by the data once it runs anything at all:
a path from a `$(...)`, `read`, a loop or what a script was handed that
was, a pattern or brace the shell expands, `find -exec ... {}`, `xargs`, a
link the check makes (`ln`), `tar x`, `unzip`, `patch`, `curl -O`, `git
checkout`, `pull`, `reset --hard` and the like. A variable's value is
followed through what sets it, across the scripts a check reaches: one
set to a known path counts as a write to that path, and one set from
something worked out as it runs (`export 'x=..'`, `printf -v`,
`${x:=..}`, `let`) as a write anywhere. What follows a step it can't
follow is still read for what it writes, and written files are matched
by inode too, so a link made before counts. A schedule's check that's
known to write a file it then runs can't be approved, an owner's
included; one that writes somewhere it can't tell is one it can't follow,
like `python3 x.py`. A file in the temp folder from a plain `$(mktemp)`,
and a variable nothing it follows sets (the runner's own, like
`$THREADBEAR_CHECK_STATE`, or a positional handed only those), aren't the
repo's to steer, though the path one makes if it's empty
(`"${UNSET}run.sh"`) still counts. What a program on PATH writes by its
own rules beyond those isn't known (below), and nor is what a JavaScript
or other language's script writes.

What it can't follow, it doesn't guess at: `eval`, `alias`, `bash -c` or
`trap` with code worked out as it runs, `$(cat "$f")` or `$(< "$f")`, a
shell, `node` or `bun` reading its program from a pipe or a here-doc
(`curl ... | sh`), `node --env-file`, a `$'...'` with an escape in a
command or file's place, more than 8 wrappers deep, or from a path that's its input or a file it has
open (`sh /dev/stdin < ./steps.txt`, `node -`, `bash -s` after
`--rcfile`, a `#!` with `-s`, `-c` or `-i`, `/dev/fd/N`, `/proc/self/fd/N`,
`/dev/tty`, or anything outside the repo that isn't a plain file), a
command in a variable or a pattern (`$CMD`,
`"$f"` in a loop, `./s/*.sh`), `source "$1"`, relative paths after a
`cd` to somewhere worked out as it runs, `npm run "$x"`, `npx "$x"`,
workspace-wide runs (`-w`, `--filter`, `-r`), `node -e`, `--require`
of a module worked out as it runs, a file that isn't there yet
(`./build/out.sh`), another language (`python3 x.py`, a `#!` that isn't a
shell or Node), an awk program that runs commands, `$(shell ...)` or
`SHELL` or `.SHELLFLAGS` set in a Makefile (after `export` or
`override`, or for a target), and setting `PATH` to a folder in the repo,
`BASH_ENV`, `NODE_OPTIONS` that loads code and the like. (An empty `PATH`
entry, a leading or trailing `:` or `::`, is the current folder, so that's in
the repo too; a package's `node_modules/.bin` is followed instead.) A worktree
`setup` or hook that names such a script fails closed: the patch isn't
loaded, trusted or not, and its `error` starts `Not run:` with the file,
line and what it couldn't follow. So does an action whose command reaches
one, though it runs only when pressed ("Commands a patch writes" below).

Programs on PATH and installed packages aren't followed: what one
loads from the repo by its own rules (a test runner's tests, a linter's
config, `npx bddgen`'s config) is the folder's to change, as
`node_modules` is for patch files. So a script should run only tools
it's fine to run on the repo as it is then.

**Commands a patch writes.** An action's `run` isn't held to the
one-script rule: it runs only when someone presses its chip, which shows
the command. But what it runs is hashed however it names it, not only
past a `./` path: every string in the patch and its helpers (an
action's `run`, `sh("node scripts/stats.mjs")` in a live function, the
fixed parts of a template) is followed as a shell command from the
folder holding `.threadbear/`, as above, and every file of the repo's it
runs or loads goes in the hash (a data file it only names doesn't), so `node scripts/deploy.mjs` asks again when
only `scripts/deploy.mjs` or one of its imports changes (Daybreak
verify-fix, 5 Nov). A trusted-by-hash patch's command actions run from
the folder holding `.threadbear/` (the action's `folder`), where they
were followed from. Each is followed again as the patch loads, and one
the hash can't vouch for refuses the whole patch, its `error` starting
`Not run: its action`: one worked out in code (`'node ' + f`) that reaches
a file the hash didn't cover, or one that can't be followed all the way
(`eval`, `python3 x.py`, a script that isn't there yet, a dynamic import
in a script it runs), as the follow stops at the first of those and what
comes after was never seen (Daybreak, 7 Nov). A string in a patch that
isn't an action's command can't stop anything: it may not be a command at
all. Pressing the chip checks again: the patch is hashed afresh as the
action starts, and must still be the version trusted, with the command
reaching only files that covers, from the folder it runs in (for a tool
patch, its own folder too), as a script runs from the folder and not from
the bytes that were hashed. Otherwise `actions.run` fails with `Didn't run
<title>: ...` and nothing runs, and the patch is looked at again, so it
shows waiting in Patches. Home's patches and Threadbear's own checkout
aren't hashed, so theirs run as written. Nor is
`check` held to the one-script rule, which runs when `tb land` does (the
Land chip, or an agent that could run anything anyway); it's followed
the same way. A live function (`items`, `when`, `badge`, `summary`) is
the patch's own code, hashed with it, and `sh` runs what that code says,
but by itself, every few seconds, so a trusted-by-hash patch's `sh` is
held as a hook is, short of the one-script rule (its commands are worked
out in code by design). It runs from the folder holding `.threadbear/`,
where the hash followed commands from, whichever folder the thread is in
(a tool patch's from the folder it applies in, as before). Just before
it runs, the patch is hashed afresh and must still be the version
trusted, and the command, followed as above (for a tool patch, from its
own folder too), may reach only files the hash covered, no script patch
trust can't follow, and nothing it can't follow itself. A function that
has returned, thrown or timed out can't run another. The command must
also keep to the short list of shell (below). Otherwise it isn't run: `sh`
rejects, as for a failed command, with `Not run:` and why, so a `when`
hides its item, a `badge` gives none, a list panel shows the note and
the patch's `liveError` says so. They ran in the thread's folder, so a
badge's `./tools/count.sh` in a thread in `web/` ran `web/tools/count.sh`,
which nothing had hashed (Gautam's scan, 6 Nov).

**The short list of shell.** A live function's command, and a folder's
Claude Code hooks and settings commands, run by themselves, and the
follower above looks for the shell tricks it knows: every review round
found one it didn't (here-docs, `$'\142ash'`, `sh /dev/stdin`, `env -S`,
a `}` that zsh reads as the end of a group). So those commands are also
parsed into a small grammar and held to an explicit list of programs, and
anything outside it isn't run (`src/shell-allowlist.ts`; Mike's call,
7 Nov, narrowed the same day after an outside review). A fork whose
patches run something else adds it to the list there. On the list:

- Grammar, for both: simple commands of literal words, `'...'` and `"..."`
  strings, `\x`, `$NAME`, `${NAME}`, `$?`, `$!`, `$#`, `$$`, `$0`-`$9`,
  `$@`, `$*`, `~` and `~/x`, and `$(...)` whose commands are on the list
  too; pipes, `&&`, `||`, `;` and new lines; `{ ...; }`, `( ... )` and `!`
  before a pipeline; `name=value` on its own, for a lower-case name that
  isn't in the environment or one of zsh's own (`path`, `fpath`...).
  A lone `{` or `}` anywhere but opening or closing a group is refused,
  after a redirect or as a redirect's target too, as zsh and bash read it
  differently.
- Redirects, for both, in every script too: `>` and `>>` only to
  `/dev/null`, written just so, and `N>&M`. Nothing writes a file. `<`
  takes a literal path in a hook, and only `/dev/null` in a live command.
- Program names are compared in lower case, by the name they run as (a
  path's last part, which must be what the path resolves to), so `GIT`,
  `/usr/bin/git` and `git` are held to the same, and a link named `cat` to
  `/bin/sh` is refused. A builtin or reserved word in another case or by a
  path (`CD`, `/usr/bin/cd`, `IF`) isn't the shell's own, so it's refused.
- `&`, for a live command only: when its shell exits or times out, its
  whole process group gets SIGTERM, then SIGKILL 2 s later if any of it is
  still there (`runCommand`'s `killGroup`). A program that leaves the group
  (`setsid`, `setpgid`, a daemon that forks away) isn't reached; nothing on
  the live list does that (`ssh -f` isn't on it,
  and a fetch's automatic gc is off, below).

**A live command** runs only what Mike's patches run (as of 7 Nov), each
in the forms they use, and every word literal: known as it's checked, not
split. There is no fallback for other installed programs.

| Program | Forms |
|---|---|
| builtins | `echo`, `true`, `exit <n>`, `test -f\|-d\|-e <path>`, `kill [-signal] <pid>` where the pid is `$!` or a variable only ever set from it |
| `cat` | `<path>...` |
| `grep` | `[-c] <pattern>`; the pattern may be worked out as it runs if it's a quoted word starting with literal text that isn't `-` (`"adb-$s"`), so it can't be an option |
| `sleep` | `<seconds>` |
| `dns-sd` | `-B <type> <domain>` |
| `ssh` | `-o ConnectTimeout=<n>`, `-o BatchMode=yes`, `<host>`, then what runs there: read as shell and held to plain commands and pipes of `launchctl list`, `df -h <path>...`, `memory_pressure -Q`, `tail -1`, `readlink <path>`, `echo` |
| `git` | `fetch [-q] <remote> [<ref>]`, `merge-base --is-ancestor <rev> <rev>`, `rev-list --count <rev or range>`, `branch [-a] [--no-merged <rev>] [--sort=...] [--format=...]` (no operand, as one makes a branch; only the format atoms cannvas uses, not `%(signature)`) |
| `gh` | `pr list [--state ...] [--limit <n>] [--json <fields>]` |
| `npx convex` | `data <table> [--component <name>] [--prod] [--format ...] [--limit <n>]`, `run [--prod] stats:overview` or `adminStats:overview`; `convex` must be in `node_modules/.bin` and lead to the convex package, so npx never fetches or is pointed at something else, and not beside an `.npmrc` with a key outside a short list that only say where packages come from |
| `tandem` | `waiting [--json] <path>...` |
| `stocks` | `balance`, `positions` |
| `node` | `<file> <words>`, no options: a file of the repo's, followed and hashed, or `~/dev/me/poddle/scripts/asc-status.mjs <digits>` (below) |
| a file of the repo's | by its path, a shell script or JavaScript, hashed and followed; what a script runs is held to this same list (it may also use `if`, `while`, `until`, `for`, `case`, comments and `set -e` and the like), and its `#!` must be a shell run plainly |

A live command that runs a file of the repo's may run beside it only what
changes nothing (`echo`, `true`, `exit`, `kill`, `test`, `cat`, `grep`,
`sleep`, `dns-sd`), or it could change that file first.

`git` and `gh` (which runs git) run only in a repo whose own config, its
`.git/config`, a worktree's config and what they include, keeps to settings
that add nothing git runs: the repository format, remotes reached over
`https` or `ssh` whose fetch fills remote-tracking refs or tags, branches,
`user.name` and the like. Any other (`core.hooksPath`, `core.fsmonitor`,
`core.sshCommand`, `include.path`, `filter.*`, `diff.*`, `alias.*`,
`protocol.*`, `url.*`, `remote.*.vcs`, `gpg.*`...) and they aren't run.
That's checked as each command starts, so every live command also runs
with git settings in its environment (`GIT_CONFIG_COUNT`, which needs git
2.31; an older git isn't run), which beat the repo's own whatever it says
by then: `core.fsmonitor=`, `core.hooksPath=/dev/null`,
`safe.bareRepository=explicit`, only the `https` and `ssh` protocols, no
submodule fetches, no saved cookies, no alternates command, no automatic gc,
your own `core.sshCommand` (or `ssh`), every credential helper turned off and
your own (system, global) put back after, and no askpass program or prompt.
Filters and diff drivers can't be turned off by name, but the repo's own are
refused above, and none of those git commands reads the working tree or makes
a diff, so your own (git-lfs) don't run either.

A script outside the repo runs only if it's on the list above and nobody
but you or root could have written it, or a live command's chip hides.
From the path as written, each folder it passes through must be yours or
root's and not writable by its group or others (a sticky one like `/tmp`
aside, where only an entry's owner can rename it); each link, followed as
the system does, yours or root's; the file yours or root's, a plain file,
and not writable by its group or others; and the whole path must resolve,
with no `.` or `..` as written. On macOS, `ls -led` must show no access
list entry that allows anyone else to write, add to or delete from any of
them (a deny entry, as macOS puts on your home folder, is fine). On Linux an
access list's mask is the group bits, so the mode covers it; on anything else
it's refused. What that script imports isn't checked, so it's held to where
it is. If the check fails, Walkies' and StashIt's App Store chips (which run
`node ~/dev/me/poddle/scripts/asc-status.mjs`) hide. Threadbear's own
`app-store.ts` isn't held to any of this, as Threadbear's own patches aren't.

**A Claude Code hook** (or settings command) has a fuller list, as its text
is fixed by the hash rather than built as it runs, but no `&`:

- The same grammar and redirects; in a script it runs (and a package script)
  also `if`, `while`, `until`, `for ... in`, `case`, comments, `set -e`, `-u`,
  `-x`, `-o pipefail` and zsh's `setopt` of those. A script's `#!` must be a
  shell run plainly (`-e`, `-u`, `-x` at most). A `cd` to a known folder must
  be able to work now; one through a link, or based on `${BASH_SOURCE[0]}` or
  a sourced file's `$0`, which differ between shells, loses track of where it
  is, so a relative path after it is refused.
- Builtins: `cd`, `echo`, `printf` (a number format only with plain numbers,
  as zsh's reads them as arithmetic), `true`, `false`, `:`, `test`/`[`
  (numbers compared only when they're plain), `exit`, `return`, `shift`,
  `break`, `continue` (a plain number), `read -r`, `wait` and `kill` (`$!`, a
  variable only ever set from it, a plain number or `%1`), `pwd`, `which`,
  `type`, `command -v`, and `.`/`source` of a file of the repo's by a path
  (`./lib.sh`), followed as part of the same shell.
- A file of the repo's (a shell script or JavaScript, followed, and hashed);
  `sh`, `bash`, `zsh`, `dash` or `ksh` with a script, and `node`, `bun` or
  `tsx` with a file (`node` with `--no-warnings` and the like at most; `bun`
  and `tsx` not beside a `bunfig.toml` or a `tsconfig.json` with `paths`, and
  `bun` not beside a `.env` that sets `NODE_OPTIONS` and the like); `npm run
  x`, `npm test`, `pnpm run x`, `yarn run x` and `bun run x` for a script
  that's in `package.json`, followed (with `pre` and `post`) as a script with
  the package's `node_modules/.bin` first on PATH, and not beside an `.npmrc`
  with a key outside that short list, a `.pnpmfile.cjs`, or a Yarn `yarnPath`
  or plugin; `env`, `nohup`, `nice` and `timeout` only around a script of the
  repo's.
- A script outside the repo, run by an interpreter or by its path, only if
  nobody else could have written it, as above, and not a package's own program
  (a path through `node_modules`, as `npm-cli.js exec x` runs what it's told).
- Otherwise only programs that load no code from the folder, run nothing
  they're handed and write no file, every word literal (`HOOK_PROGRAMS`):
  `cat`, `head`, `tail`, `ls`, `date`, `sleep`, `say` (`-v` and `-r` only, as
  `-o` writes), `afplay`, `jq`, `grep`, `tr`, `wc`, `cut`, `uniq` (one file, as
  a second is written), `basename`, `dirname`, `realpath`, `readlink`, `stat`,
  `pbcopy`, `pbpaste`, `whoami`, `hostname`, `uname`, `tput`, `notify-send`,
  `logger`. `find` with literal words and none of `-exec`, `-execdir`, `-ok`,
  `-okdir`, `-delete`, `-fprint`, `-fprintf`, `-fls`. `awk` with a literal
  program with no `system`, `getline`, `|`, `>`, `@` or `ENVIRON`, and only
  `-F` and `-v`. Not `tee`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `chmod`,
  `mktemp`, `curl`, `wget`, `sed`, `sort`, `git`, `gh`, `ssh`, `npx` or `bunx`.

Refused, for both: here-docs and here-strings, process substitution,
backticks, `$((...))`, `[[`, `((`, globs and brace expansion outside a
`case` pattern, `~user`, zsh's `=cmd`, `$x[1]` and `$x:h`, `${x:-...}`
and every other `${...}` form, an unquoted `#`, `^` or `!` in a word, `&>`,
`>|`, `|&`, `&|`, a redirect with no command, functions, `alias`, `eval`,
`exec`, `trap`, `export`, `VAR=x cmd`, any other builtin of bash or zsh
(`emulate`, `zmodload`, `r`...), a command named by a variable whose value
isn't known, and a word worked out as it runs anywhere a program's words are
checked. Mike's own live commands all keep to it (as of 7 Nov), except
walkies-arrow's older Pixel check, which still runs perl and was already
hidden.

#### What changed

A patch asked about again says what changed since the version last
trusted in its folder (`src/patch-changes.ts`), in `PatchInfo.changes`:
the files whose bytes differ (`changed`), that its hash now covers and
didn't (`added`: a new helper, or one Threadbear now follows) or no longer
covers (`removed`); for each, the commits since then that touched it and
whether what's on disk is committed; and the lines, for a changed file
both of whose versions could be checked against their hashes (the old
side read with `git cat-file` from the commit trusted then, or HEAD's,
only when it hashes to what was trusted; the new side only when it still
hashes to what the ask is for). A folder whose only patch hashes are from
before version 3 gets `{ recheck: true }`: its trust is from before the
6 Nov change to how patches are checked, so nothing says whether this
patch was trusted before (the hashes are per folder) or what changed. The thread's note names
the files too. When git takes more than five seconds, the rest are named
without commits or lines, and git isn't asked again for a minute. A file
outside the folder, or a symlink, gets no commits or "not committed", as
git can't speak for its bytes; a diff line over 1000 characters is cut
with a note saying so, never silently.

Each trusted version (when, its files by SHA-256, the repo's HEAD) is kept
in `patch-trust-versions.json` beside the trust file, the last five a
patch; a version trusted before this was kept goes in the next time it's
seen trusted. It only describes: nothing in it trusts anything, and a
missing or unreadable one only means the ask says less. Commit subjects,
paths and lines are the repo's text, shown as plain lines with control and
direction characters replaced, so they say who wrote a change only as
far as git can be believed: the lines are what to read.

### Trusting a folder's Claude Code hooks

The runner starts Claude in a thread's folder with that folder's own
settings, `.claude/settings.json` and `.claude/settings.local.json`, and
its `.mcp.json` (the folder's, and those of the folders above it, up to
home), and Claude loads the agents, skills and commands in `.claude/agents`,
`.claude/skills` and `.claude/commands` of the folder and the folders above
it (up to home), and a skill in `.claude/skills` anywhere under the folder
once the agent works on a file beside it (CLI 2.1.318). Some of what they
hold is a command Claude runs by itself: `hooks` (a SessionStart hook runs
as the CLI starts), `statusLine`, `subagentStatusLine`, `fileSuggestion`,
`apiKeyHelper`, `proxyAuthHelper`, `awsCredentialExport`, `awsAuthRefresh`,
`gcpAuthRefresh`, `otelHeadersHelper`, `extraKnownMarketplaces` (and its
alias `additionalMarketplaces`), an MCP server with a `command` or a
`headersHelper`, and the `hooks` and `mcpServers` in an agent's, skill's
or command's frontmatter. The settings' `env` counts too, as a whole:
nothing in it runs, but any variable can send Claude's traffic and the
user's login elsewhere (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`,
`HTTPS_PROXY`, `CLAUDE_CODE_USE_BEDROCK` and its endpoint, `OTEL_*`
exporters) or load code (`NODE_OPTIONS`, `PATH`). In a thread that asks
before tools run (Ask or Auto), so do the parts that let tools run without
asking, as Claude applies them before the runner's approval card: the
settings' `permissions` (allow rules, `additionalDirectories`,
`defaultMode`, anything but `deny`, `ask`,
`blockReadsOutsideWorkingDirectories` and `disableBypassPermissionsMode`,
which only narrow), `sandbox` (turning it on lets sandboxed Bash run
unasked), a skill's or command's `allowed-tools` and an agent's
`permissionMode`. In Full they grant nothing more, so they don't count
there. Claude Code in a terminal asks before trusting a folder; the SDK
never does, so the runner asks instead (`src/claude-trust.ts`), with
patch trust's store and rules.

- On Windows, for now, a folder whose settings have any of those starts
  Claude without them whatever's been trusted, as one that can't be
  checked does, with nothing to trust (`clicksOnly` in `src/platform.ts`;
  "Trusting a folder's patches" says why).
- A folder whose settings have none of those (a model, plugins switched
  on, deny rules; allow rules in a Full thread) asks nothing, and nothing
  changes. Nor does home, whose `.claude/settings.json` is the user's own;
  a thread there starts with the user and local settings only
  (`settingSources: ["user", "local"]`, home named as an extra directory
  for its CLAUDE.md), as the project source would have Claude pick up the
  `.claude/skills` of any folder under home as the agent works there.
  Frontmatter is read as top-level keys at the left margin.
- Otherwise the hash covers those parts, by file, and every file inside
  the repo that they reach: each word in them that is a file there, with
  a `/` or without (`node hook.mjs`, a server's `"args": ["server.js"]`,
  `NODE_OPTIONS=--require ./x.js`, an allow rule's
  `Bash(./scripts/x.sh:*)`), and what each command runs in turn, followed
  as patch trust follows a patch's commands (`src/script-trust.ts`:
  imports, shell scripts, `npm run`, `make`). Each command (a hook's,
  `statusLine`'s, a helper's, an MCP server's) is also held to the short
  list of shell a live patch command is ("The short list of shell",
  under "Trusting a folder's patches"), without `&`; both must pass.
  Settings with commands and
  no `env` or grants hash as they did before those counted, so trusting
  them holds. It's kept in `patch-trust.json` in the folder's list, as `claude:<hash>`,
  under the same folder key, so a worktree counts as its main checkout and
  Threadbear's own checkout is always trusted.
- What the hash can't cover can't be trusted, whatever's stored: a
  command that runs code it can't follow (`python -m x`, `node .`, `curl
  ... | sh`, a command in a variable, a dynamic `import()` in a script it
  runs), a package run by name (`npx`, `bunx`, `pnpm dlx`, `npm exec`), a
  test runner finding its own tests (`node --test`, `bun test`), an MCP
  server that sets its own `cwd` (its files are followed from the folder), a
  program on PATH, anywhere in what a command runs, that may load or run code from
  the folder by its own rules (a formatter, a test runner, a build tool,
  `git`, which an alias or `core.hooksPath` makes run anything) rather
  than a script, a shell, a JS runner, a package script, a function the
  script defines or a program known to do neither (`echo`, `say`,
  `afplay`, `jq` and the like, `INERT_PROGRAMS` in `src/script-trust.ts`,
  which the short list narrows to ones that write nothing), a
  file or folder in the repo named in an environment variable, or any
  named there by a relative path (`PATH=./bin`, `PYTHONPATH=.`,
  `BASH_ENV=./startup` or `BASH_ENV=startup`, `NODE_OPTIONS=--require
  ./x.js`: whatever reads the variable loads it from wherever it runs),
  `--preserve-symlinks` for Node, a settings file that isn't
  plain JSON, `hooks` or `mcpServers` frontmatter that isn't YAML in the
  one shape read line by line (block mappings and lists, each nested
  deeper than its key, with one-line plain or unescaped quoted values or
  one-line `[a, b]` lists: no block scalars, escapes, anchors, tags,
  comments, flow mappings or quoted keys), other frontmatter that can't be
  read key by key, more than 300 files, or more than 20,000 folders to
  look through for agents, skills and commands (nested skills, outside
  git, or through a link to a folder). Nor can an allow rule (or `allowed-tools`) that covers
  Threadbear's own tools (`mcp__threadbear...`, `mcp__*`, `*`, or
  bypassing permissions: `defaultMode` or an agent's `permissionMode`), in
  a thread that asks first. JavaScript a hook reaches that runs commands
  itself (`child_process`, `Bun.spawn`) is one too: what it runs isn't
  followed.
- While that version isn't trusted, a Claude thread's `patches` has
  `{ id: "claude-settings", source: "claude", file, untrusted, hash,
  helpers?, grants? }`: `file` is the first file with something that runs,
  `helpers` the other files and the scripts, `grants` (a thread that asks
  first) what they'd let run without asking, in words ("Allows Bash
  without asking (.claude/settings.json)"). One that can't be trusted is
  `{ id: "claude-settings", source: "claude", file, error }` instead, with
  no hash to trust. Codex threads don't get it.
- A Claude session starts without the folder's project and local
  settings (`settingSources: ["user"]`), and gets back, as flag settings
  (the SDK's `settings`), only what can't run anything or widen access,
  merged as Claude merges them: the narrowing `permissions` above,
  `model`, `effortLevel`, `alwaysThinkingEnabled`, `outputStyle`,
  `language`, `attribution`, `includeCoAuthoredBy`,
  `includeGitInstructions`, `respectGitignore`, `cleanupPeriodDays`,
  `enabledPlugins`, `deniedMcpServers`, `disabledMcpjsonServers`,
  `claudeMdExcludes` and `skillOverrides`. Flag settings sit above project
  ones, and Claude takes some keys from them that it ignores from a repo
  (`processWrapper`, `autoMemoryDirectory`, `sandbox` paths), so the copy
  is a list of what's kept, not of what's dropped. The folder is named as
  an extra directory with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`,
  which brings its CLAUDE.md back without its settings. What doesn't
  come: the folder's `.claude/skills`, `agents` and `commands`, CLAUDE.md
  files above the folder, and `.mcp.json` servers. The thread gets a
  `system.note` saying so, once per version.
- `patches.trust` with that `file` and `hash` trusts it. Trusting the
  version a thread that asks first was shown also trusts what it runs for
  a Full thread there. A session that started without them is replaced by
  a fresh one (resuming the same conversation) at the next message, as is
  one that started with them when a new version arrives that isn't
  trusted, or when the thread leaves Full and the folder's grants aren't
  trusted. A CLI's own turns between messages keep what it started with,
  except that a session started in Full with grants that aren't trusted
  for a thread that asks first (`heldGrants`) sends every tool call to the
  approval check, past the CLI's allow rules, from the moment the thread
  leaves Full (a PreToolUse hook answering `ask`).
- What a command reaches is hashed up to the top of the repo, or of the
  outer repo when an `.mcp.json` or `.claude` folder above the thread's
  folder is in one (a thread in a submodule).
- An agent's Edit or Write to one of the settings files trusts them as it
  leaves them; to a script they name, only when an earlier version was
  trusted, as with a patch's helpers. Either only with the file as that
  edit left it, and every other file the settings' hash covers bytes
  trusted before or another such edit's, as for patch files. The same
  rules as there: only on Full access, only a file inside the thread's
  folder, and an Edit only of a file that was trusted bytes (or none).

**Agent writes that run as code** (`src/code-writes.ts`). Outside Full
access, permission to edit a file isn't permission to run it, so an Edit,
MultiEdit or Write by a Claude thread in Ask or Auto, or a Codex patch
outside Full access, of a file Threadbear runs by itself always asks: a patch file anywhere (`.threadbear/patches`,
home's included, which is trusted whatever it holds), anything under
`~/.threadbear`, a file a patch the runner has hashed covers (a helper, a
script it names, one it names that isn't there yet), `.claude/settings*.json`
(home's too), an `.mcp.json`, a script the thread folder's Claude settings
name, the runner's own data dir (`patch-trust.json` is the trust itself),
every file a schedule's check on this runner reaches from its folder (the
check's scripts, what they run in turn, absolute and linked ones, one it
names that isn't there yet; a check still running though its schedule was changed or deleted since,
here or in the runner handing over (its running marker says what and where;
an older release's that doesn't makes every edit ask until it ends),
paused and finished schedules too, as Resume and
Run now run them again unasked; read afresh at each edit, so a new or changed
check counts at once, and a check that runs something it can't follow makes
every edit in its repo ask): its approval is a digest taken just before the
shell opens them, so an edit after that would run unattended (Daybreak 126),
every Claude login's user settings (`settings*.json` and `.claude.json` in
its config folder, and `~/.claude.json`, by their names whether they're
there yet or not, and what a link from them points at) and the paths their commands and the thread folder's
settings' name, there yet or not, from the login's folder or the thread's
(where hooks run), with what each command reaches as a shell runs it (the
script, quoted names included, and what it imports or runs in turn), and
for patches that load without trust (home's, Threadbear's own checkout's)
what each is a link to, imports and names, absolute or `~/` paths in it,
and what each command it runs reaches (its scripts outside the folder too)
from where its commands run: the thread's folder, or for a patch from a folder
of one of the thread's projects, that folder, as its hooks run there at the end
of the thread's turns. Its commands are what reaches somewhere a command runs
(`src/patch-commands.ts`): a call to the `sh` its live functions and `items`
are handed (as `sh(...)`, `ctx.sh(...)`, taken out as `{ sh }` or handed to a
helper in the same file), an object's `run`, `setup`, `check` or `teardown`,
and node:child_process's `exec`, `execFile`, `spawn` and `fork` (their `Sync`
forms and `promisify` too). Each is worked out from the code as far as it
plainly can be: strings, templates, `+`, constants declared once with `const`,
`path.join` and the like, `import.meta.dirname` and `.url`, `fileURLToPath`,
`homedir()`, a one-line helper (`quote(s)`), `[...].join(' ')` and both sides of
`a ? b : c`. Anything else is a value worked out as it runs, followed as an
unset shell variable: fine as a plain argument (`gh pr view ${n}`), and
something it can't follow where it picks what runs (`node ${script}`,
`${bin} --help`, `sh -c ${x}`). One command it can't follow (a script that
isn't there yet included, as the follow stops there) makes every edit ask. A
file it can't read that way (one that imports a package or a Node module that
could run something, like `node:cluster`, or passes `sh` or a child_process
function around, takes a property by a computed name, has a getter, or uses
`require` or `import()`) is read as before, and so is every other file of
that patch, as well as exactly. A default export whose actions, hooks or
worktree aren't written out as objects in it (built from JSON, or a list
changed after it's made) makes every edit ask, as its commands could be
anything. A child_process call runs
from the runner's own folder unless its `cwd` says otherwise, and is followed
from there. Read as before means: every string in it as a command it
might run, except for strings found only in place in the patch file's own
`export default { ... }` as its `icon`, `appliesTo` or `worktree.keep`, or an
action's, panel's or hook's `title`, `note`, `icon`, `on`, `tell`, `prompt`,
`url` or `edited`, and plain web addresses with nothing a shell would split or
expand. How a patch quotes a value it splices into a command is its own
business, then and now: what's checked is which files it runs. When a patch
makes every edit ask, the thread says so (a `system.note`, once per patch and
command, the first time an edit asks for it) and the patch's entry in
Patches has `editsAsk`: which file, the line and command, why, and what to
change. A patch's `worktree` setup or check doesn't count either: setup runs what's committed, in a new
worktree, and the check when a land is asked for, so neither runs what an agent
just wrote until it has got past a step that's asked about. Land itself runs
nothing else from the branch on this Mac: a format command in the branch's
`.git-blame-ignore-revs` runs only when main's list has the same command,
paths and config, with config the branch didn't change, and stops the land
before anything runs otherwise; a branch adding a command to main's list,
or changing a config file one runs with, lands only with `tb land
--allow-format <id>` for exactly what's shown (docs/thread-worktrees.md). Its `teardown`
does count, as it runs in the worktree as the agent left it. A repo's setup has to
keep that true: `worktree-setup.sh` won't `npm install` in the main checkout while
it has uncommitted changes. A patch using `this` or a getter gets none of this. A settings hook that can't be followed all
the way doesn't: those are the user's own hooks, so what they load by a
name worked out as they run, or from outside the repo they're followed
in, isn't guarded. What such a hook runs by name (`npm test`, a tool on PATH)
is the folder's own code, run as its owner set it up, and isn't followed.
Names are matched as written and as the disk has them (through symlinks,
a link to a file not there yet included, and without case, as macOS names
a file either way). The runner's PreToolUse hook answers `ask` for these,
which reaches the approval card whatever an "Always allow" rule, the
user's own allow rules or Auto's classifier would have said. The card's
`title` ends "(Threadbear runs this file as code)", or "(Threadbear can't tell
whether this file runs as code)" when only the catch-all above made it ask, and
its `options` have no
`allowAlways`, and an `allowAlways` answer counts as `allow` once (Codex:
the thread's file-change rule is passed over for it, and isn't added). What
it writes still isn't trusted (above): Mike trusts it in Patches. On Full
access none of this changes anything.

**Built in**, from the folder alone:

| patch | when | panel |
|---|---|---|
| `convex` | a folder with `convex/` and a `package.json` or `convex.json` beside it (a bare folder called `convex` isn't enough) | `convex.dashboard`, a `url` panel: `https://dashboard.convex.dev/d/<name>` for the `CONVEX_DEPLOYMENT` in `.env.local` (then `.env`), `http://127.0.0.1:6790` for an anonymous local deployment, the dashboard's front page with no deployment yet. A cloud deployment's panel also has `convex`, with the deployment's URL from the `.env.local` (then `.env`) line ending `CONVEX_URL` (`CONVEX_URL`, `VITE_CONVEX_URL`, ...). Only those lines of the file are read, and a file over 64 KB is skipped as if it weren't there |
| `xcode` | a folder with an `.xcodeproj` or `.xcworkspace` | `xcode.simulator`, an `image` panel drawn by `panels.render` |
| `worktree` | a thread with a worktree of its own (see Worktrees) | no panel: the action `worktree.land`, "Land", which runs `tb land` |

A client shows what it can: a `url` panel in a web view, an `image` panel
by asking `panels.render` now and then while it's on screen, a `list`
panel the same way (when it's shown and every 15 seconds while it is),
and an unknown `kind` as a page if it has a `url`.
