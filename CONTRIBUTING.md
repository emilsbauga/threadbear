# Contributing to Threadbear

Thanks heaps for wanting to help! Threadbear is my own app that I use all day,
and I'm one person, so here's how I take changes. Please read it before you put
hours into a PR.

**Fixes and small polish are welcome as PRs.** I merge with rebase, so the
commits stay yours. Main moves fast though, about 150 commits a day, so by the
time I get to a PR it often doesn't apply any more. Then I write it again on
main by hand, with you as co-author on the commit (a `Co-Authored-By:` line),
and the [What's new page](https://threadbear.mikecann.app/changelog) credits
the people changes came from. So if your PR gets closed, have a look on main
first: it may well be there.

**For a new feature, or anything big, open an issue first** and say what you'd
like to build. I keep Threadbear to the things I actually use day to day, so I
say no to some good ideas, and I'd much rather do that before you've written
thousands of lines than after. If it's a yes, it lands as an experiment, off by
default: a file of its own in [runner/src/experiments/](runner/src/experiments/)
(copy one that's there) and an `experimentOn` check where it starts. I try it
for a while, then it becomes standard or comes out.

When you open a PR:

- One change per PR. Five features in one is five decisions, and I can't take
  some and leave the others.
- Rebase it on the latest main just before you open it.
- Run the checks: `./check.sh --quick`, or at least the test file for what you
  changed (`node --test test/unit/<name>.test.ts` in `runner/`). CI on a
  PR from a fork waits until I approve the run, so don't count on it
  catching things first.
- Keep the docs true: [docs/guide.md](docs/guide.md) when it changes what
  someone sees or does, [docs/on-your-mac.md](docs/on-your-mac.md) when it adds
  a file, a timer, something it reads or a network call, and
  [docs/forking.md](docs/forking.md) when it adds or moves a feature.
- Desktop app changes go in `desktop/`, the GPUI app. The Swift app in `app/`
  and `dock/` is frozen and isn't taking changes.
- Leave out your own planning files, like a `prds/` folder.

A few of the repo's own checks catch most people out:

- A new request about a thread (`THREAD_METHODS` in `runner/src/rpc.ts`) needs
  a row in `runner/src/parity.ts` saying where it works: from another Mac, on
  the phone and on the website. Then run `npm run parity-docs` in `runner/`.
- Changing an agent tool's name, description or arguments, or the instructions
  every thread's agent gets, changes `runner/context-budget.json`. Run
  `npm run context-budget` in `runner/` and commit it, and keep it as small as
  you can: I'd rather agents' context shrank than grew.
- A backend change the runner or the phone relies on takes the next API number
  (`convex/version.ts` and `BACKEND_API_VERSION` in `runner/src/sync.ts`).
  Numbers get taken often, so check main's latest just before you open the PR.
- An experiment needs `npm run experiment-docs` in `runner/`, with
  `docs/experiments.md` committed alongside.

A commit on your fork isn't something I take as an offer, as you haven't asked
for it to go anywhere. If you'd like something brought in, open a PR.

Found a security problem? Please don't open an issue or a PR for it: see
[SECURITY.md](SECURITY.md).

[AGENTS.md](AGENTS.md) has the rest of the rules, and it's what your agent
should read first.
