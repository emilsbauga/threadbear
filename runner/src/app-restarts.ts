import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from './clock.ts';
import type { Logger } from './log.ts';
import type { Runner } from './runner.ts';
import type { PermissionMode } from './protocol.ts';
import { ceilingMode } from './access.ts';

// Telling a thread when the Mac app has restarted onto a new build
// (docs/protocol/updates.md, "App restarts"). An agent that changed the app asks
// Mike to Restart to Update and ends its turn; the app says `hello` with
// its build when it comes back, and each thread waiting for that gets a
// note and a message, so it can check its change in the running app.
//
// Two apps say so: the Swift Mac app (`mac`, its tree app/'s and dock/'s) and
// the GPUI app (`desktop`, desktop/'s), each followed on its own, so one of
// them reconnecting on the build it had doesn't count as the other restarting.

export type AppBuild = { commit: string; short: string; tree: string };
export type AppKind = 'mac' | 'desktop';

// `due`: the app has come back on this build, but the thread was on a
// draining runner then; it hears once it comes across (adopted).
// `fromTree`/`fromShort` are the Swift app's, from before there were two.
type Watch = {
  threadId: string;
  text?: string;
  // `text` is the thread's agent's own words, sent back to it later: the
  // most access it may have then (runner/ceiling.ts). One from before
  // ceilings is bound at the thread's mode as the runner starts
  // (bindOldCeilings); one bound to nothing counts as Ask.
  ceiling?: PermissionMode;
  requestedAt: string;
  fromTree?: string;
  fromShort?: string;
  fromDesktopTree?: string;
  fromDesktopShort?: string;
  due?: AppBuild;
  dueApp?: AppKind;
  // The commit the app has to contain, in the thread's repo: main's HEAD
  // when it asked, or the commit it named. An app swapping in a build it
  // staged before the thread landed is a different tree but hasn't got the
  // change (2f98f449, 17 Nov), so that keeps it waiting.
  // `trees`: that commit's tree of each app's folders, as its hello's
  // `tree` says it: a build of a later commit with the same app folders
  // (main moved on with only runner changes before the thread asked) has
  // the change too, and may be the only build that comes (Codex, 18 Nov).
  want?: { commit: string; short: string; repo: string; trees?: Partial<Record<AppKind, string>> };
};
type SavedState = { build?: AppBuild; desktopBuild?: AppBuild; watching: Watch[] };

// After a day the request has likely been forgotten: only the note.
export const MAX_AGE_MS = 24 * 60 * 60_000;

export function appRestartsPath(home: string): string {
  return path.join(home, 'app-restart.json');
}

// end_turn asks that tell Mike to restart the app onto an update count as
// asking to hear about it, so the agent needn't remember the tool.
export function asksForAppRestart(asks: { action?: unknown; why?: unknown; where?: unknown }[] | undefined): boolean {
  return (asks ?? []).some((a) => /restart to update/i.test(`${a.action ?? ''} ${a.why ?? ''} ${a.where ?? ''}`));
}

// The two questions asked of git, swappable in tests. `resolve` gives a
// full commit id or undefined; `contains` says whether `commit` has
// `ancestor` in its history, or undefined when git can't tell (a commit it
// doesn't know, no repo), or 'busy' when git didn't answer in time. Neither
// wakes the thread: an unconfirmed build is the false news this is here to
// stop (Codex's and Gemini's review, 19 Nov). The watch still ends after a
// day at most, like any other. `tree` gives
// the trees of `dirs` at `commit`, joined with + as the apps' builds do
// (app/build-app.sh, desktop/scripts/make-bundle.sh).
export type RestartGit = {
  resolve(repo: string, rev: string): string | undefined;
  contains(repo: string, ancestor: string, commit: string): boolean | 'busy' | undefined;
  tree?(repo: string, commit: string, dirs: string[]): string | undefined;
};

// The folders each app's `tree` is made from.
const APP_DIRS: Record<AppKind, string[]> = { mac: ['app', 'dock'], desktop: ['desktop'] };

export const realGit: RestartGit = {
  resolve(repo, rev) {
    try {
      return execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
    } catch {
      return undefined;
    }
  },
  contains(repo, ancestor, commit) {
    try {
      execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', ancestor, commit], { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch (e) {
      const err = e as { status?: number | null; signal?: string | null; code?: string };
      if (err.status === 1) return false;
      return err.signal || err.code === 'ETIMEDOUT' ? 'busy' : undefined;
    }
  },
  tree(repo, commit, dirs) {
    try {
      // Not --verify: it takes one revision, and the Swift app's is two.
      const out = execFileSync('git', ['-C', repo, 'rev-parse', ...dirs.map((d) => `${commit}:${d}`)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = out.split('\n').filter(Boolean);
      return lines.length === dirs.length ? lines.join('+') : undefined;
    } catch {
      return undefined;
    }
  },
};

// `away`: whether a draining runner still has the thread (handover.ts's
// Peers), so it isn't here yet but will be. `appRepo`: the Threadbear
// checkout the apps are built from (release.ts's ownCheckout). A thread
// asking from another folder (~/dev/me/misc) named a Threadbear commit
// its own folder doesn't have, and the wait fell back to any new build,
// telling it the app had restarted onto one without it (42071b05, 19 Nov).
type Deps = { runner: Pick<Runner, 'get' | 'note' | 'send' | 'has'>; home: string; clock: Clock; log: Logger; away?: (threadId: string) => boolean; git?: RestartGit; appRepo?: string };

const appName = (app: AppKind) => (app === 'desktop' ? 'Threadbear GPUI app' : 'Threadbear app');

export class AppRestarts {
  private deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  // Sends a message to the thread when either app next comes back on a build
  // other than the one it's running now. Asking again replaces the request.
  // `running` names each app's build, the GPUI app's first: with both
  // connected, `build` alone was the frozen Swift app's (13 Nov).
  // `commit`: what the new build must contain, by default main's HEAD in
  // the thread's folder (a thread's worktree shares its refs).
  watch(threadId: string, text?: string, commit?: string, ceiling?: PermissionMode): { build?: AppBuild; running?: string; waitingFor?: string } {
    const state = this.read();
    state.watching = state.watching.filter((w) => w.threadId !== threadId);
    let want: Watch['want'];
    try {
      want = this.wanted(threadId, commit);
    } catch (e) {
      // Asking again replaces the request, even one that can't be armed:
      // else an earlier commit's wait stays set behind the refusal.
      this.write(state);
      throw e;
    }
    state.watching.push({
      threadId,
      ...(text?.trim() ? { text: text.trim(), ceiling: ceilingMode(ceiling ?? 'ask') } : {}),
      requestedAt: new Date(this.deps.clock.now()).toISOString(),
      ...(state.build ? { fromTree: state.build.tree, fromShort: state.build.short } : {}),
      ...(state.desktopBuild ? { fromDesktopTree: state.desktopBuild.tree, fromDesktopShort: state.desktopBuild.short } : {}),
      ...(want ? { want } : {}),
    });
    this.write(state);
    const build = state.desktopBuild ?? state.build;
    const running = [state.desktopBuild && `the GPUI app on ${state.desktopBuild.short}`, state.build && `the Swift app on ${state.build.short}`].filter(Boolean).join(', ');
    return { ...(build ? { build } : {}), ...(running ? { running } : {}), ...(want ? { waitingFor: want.short } : {}) };
  }

  // Main's HEAD is looked for in the apps' own checkout first, then the
  // thread's folder (a dev runner, or one with no checkout to hand). A named
  // commit is looked for the other way round, so `HEAD` from a thread's
  // worktree is its own, not the main checkout's (Gemini's review). A named
  // commit found in neither is refused rather than waiting for any build.
  private wanted(threadId: string, commit?: string): Watch['want'] {
    const git = this.deps.git ?? realGit;
    let cwd: string | undefined;
    try {
      cwd = this.deps.runner.get(threadId).cwd;
    } catch {
      cwd = undefined;
    }
    const named = commit?.trim();
    const repos = [...new Set((named ? [cwd, this.deps.appRepo] : [this.deps.appRepo, cwd]).filter((r): r is string => !!r))];
    let repo: string | undefined;
    let full: string | undefined;
    for (const r of repos) {
      full = named ? git.resolve(r, named) : (git.resolve(r, 'refs/heads/main') ?? git.resolve(r, 'refs/heads/master'));
      if (full) {
        repo = r;
        break;
      }
    }
    if (!full || !repo) {
      if (named) throw new Error(`Can't find commit ${named} in ${repos.join(' or ') || 'any repo'}, so can't tell which build has it. Name a commit in the Threadbear repo the app is built from, or leave commit out to wait for its main.`);
      return undefined;
    }
    const trees: Partial<Record<AppKind, string>> = {};
    for (const app of ['mac', 'desktop'] as const) {
      const t = git.tree?.(repo, full, APP_DIRS[app]);
      if (t) trees[app] = t;
    }
    return { commit: full, short: full.slice(0, 9), repo, ...(Object.keys(trees).length ? { trees } : {}) };
  }

  // Watches with words from before ceilings (22 Nov 2026), bound at each
  // thread's saved mode as this runner starts, as schedules from before
  // are (schedules.ts, "Ceilings").
  bindOldCeilings(modeOf: (threadId: string) => PermissionMode | undefined): void {
    const state = this.read();
    let changed = false;
    for (const w of state.watching) {
      if (!w.text || w.ceiling !== undefined) continue;
      w.ceiling = ceilingMode(modeOf(w.threadId) ?? 'ask');
      changed = true;
    }
    if (changed) this.write(state);
  }

  isWatching(threadId: string): boolean {
    return this.read().watching.some((w) => w.threadId === threadId);
  }

  // The commit a waiting thread wants in the app, for its summary's
  // `awaitingApp` (the Updates panel lists it, with whether the build on its
  // way has it). {} when there's no commit to look for; undefined when it
  // isn't waiting, or asked over a day ago (it won't carry on by itself).
  // Read for every summary, so the file is read again only once it changes.
  waitingFor(threadId: string): { commit?: string; short?: string } | undefined {
    const w = this.cached().watching.find((x) => x.threadId === threadId);
    if (!w || !(this.deps.clock.now() - Date.parse(w.requestedAt) < MAX_AGE_MS)) return undefined;
    return w.want ? { commit: w.want.commit, short: w.want.short } : {};
  }

  private cache?: { stamp: string; state: SavedState };

  private cached(): SavedState {
    let stamp = '';
    try {
      const st = fs.statSync(appRestartsPath(this.deps.home));
      stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return { watching: [] };
    }
    if (this.cache?.stamp !== stamp) this.cache = { stamp, state: this.read() };
    return this.cache.state;
  }

  // An app's `hello`, with the build it's running.
  appHello(build: AppBuild, app: AppKind = 'mac'): void {
    const state = this.read();
    const { runner, log, away } = this.deps;
    const git = this.deps.git ?? realGit;
    const now: Watch[] = [];
    const kept: Watch[] = [];
    const older: Watch[] = [];
    // One git question per wanted commit, however many threads wait on it.
    const asked = new Map<string, boolean | 'busy' | undefined>();
    const has = (want: NonNullable<Watch['want']>) => {
      if (want.trees?.[app] === build.tree) return true;
      const key = `${want.repo}\0${want.commit}`;
      if (!asked.has(key)) {
        let answer = git.contains(want.repo, want.commit, build.commit);
        // The thread's folder may not know the build (a fork's own
        // checkout, a worktree since removed): the apps' checkout may.
        const { appRepo } = this.deps;
        if (answer === undefined && appRepo && appRepo !== want.repo) answer = git.contains(appRepo, want.commit, build.commit);
        asked.set(key, answer);
      }
      return asked.get(key);
    };
    for (const watch of state.watching) {
      // This app on another build than the one a handed-over thread was
      // due to hear about (rolled back, or a newer one): that's no longer
      // news. If this one is, it's set again below.
      const stale = watch.due && (watch.dueApp ?? 'mac') === app && watch.due.tree !== build.tree;
      const { due: _d, dueApp: _a, ...rest } = watch;
      const w: Watch = stale ? rest : watch;
      const known = app === 'desktop' ? w.fromDesktopTree : w.fromTree;
      const other = app === 'desktop' ? w.fromTree : w.fromDesktopTree;
      // A build of an app the watch had no build of counts only when it
      // knew neither app's: else the request was about the other one (and
      // the GPUI app's first hello with a build isn't a restart).
      const counts = known !== undefined ? known !== build.tree : other === undefined;
      if (!counts) kept.push(w);
      // Git too slow to say: unchanged, so the next hello asks again.
      else if (w.want && has(w.want) === 'busy') kept.push(w);
      // A new build, but one without the commit it's waiting for, or one
      // git can't place: keep waiting, from this build, so a reconnect on
      // it isn't news again.
      else if (w.want && has(w.want) !== true) {
        const moved = app === 'desktop' ? { fromDesktopTree: build.tree, fromDesktopShort: build.short } : { fromTree: build.tree, fromShort: build.short };
        kept.push({ ...w, ...moved });
        if (runner.has(w.threadId)) older.push(w);
      } else if (runner.has(w.threadId)) now.push(w);
      // Finishing a turn on the old runner after a handover: told when it
      // comes across (THREADBEAR-5).
      else if (away?.(w.threadId)) kept.push({ ...w, due: build, dueApp: app });
      else log.info('dropped an app restart watch for a thread that has gone', { threadId: w.threadId });
    }
    if (app === 'desktop') state.desktopBuild = build;
    else state.build = build;
    state.watching = kept;
    this.write(state);
    for (const w of older) {
      try {
        const why = has(w.want!) === false ? `which doesn't have ${w.want!.short} yet` : `and git can't tell whether that has ${w.want!.short}`;
        runner.note(w.threadId, `${appName(app)} restarted onto ${build.short}, ${why}. Still waiting.`);
      } catch (e) {
        log.warn('could not note an older app build', { threadId: w.threadId, error: String(e) });
      }
    }
    for (const w of now) this.tell(w, build, app);
  }

  // A thread a draining runner has handed over: if the app came back
  // while it was over there, it hears now.
  adopted(threadId: string): void {
    const state = this.read();
    const w = state.watching.find((x) => x.threadId === threadId && x.due);
    if (!w?.due) return;
    state.watching = state.watching.filter((x) => x !== w);
    this.write(state);
    this.tell(w, w.due, w.dueApp ?? 'mac');
  }

  private tell(w: Watch, build: AppBuild, app: AppKind): void {
    const { runner, log, clock } = this.deps;
    try {
      const thread = runner.get(w.threadId);
      const age = clock.now() - Date.parse(w.requestedAt);
      const why = thread.archivedAt
        ? 'this thread is archived'
        : !(age < MAX_AGE_MS)
          ? 'the request is more than a day old'
          : undefined;
      const fromShort = app === 'desktop' ? w.fromDesktopShort : w.fromShort;
      let note = `${appName(app)} restarted: ${fromShort ?? 'an earlier build'} to ${build.short}`;
      if (why) note += `\n\nNot carrying on by itself: ${why}.`;
      runner.note(w.threadId, note);
      if (why) return;
      const head = `The ${appName(app)} has restarted onto ${build.short} (${build.commit}), as you asked to hear.`;
      runner.send(w.threadId, w.text ? `${head}\n\n${w.text}` : `${head} Check your change in the running app.`, [], { origin: 'runner', wakeReason: `The ${appName(app)} restarted onto ${build.short}`, ...(w.text ? { ceiling: ceilingMode(w.ceiling ?? 'ask') } : {}) });
      log.info('told a thread the app restarted', { threadId: w.threadId, build: build.short, app });
    } catch (e) {
      log.warn('could not tell a thread the app restarted', { threadId: w.threadId, error: String(e) });
    }
  }

  private read(): SavedState {
    try {
      const saved = JSON.parse(fs.readFileSync(appRestartsPath(this.deps.home), 'utf8')) as Partial<SavedState>;
      return {
        ...(saved.build ? { build: saved.build } : {}),
        ...(saved.desktopBuild ? { desktopBuild: saved.desktopBuild } : {}),
        watching: Array.isArray(saved.watching) ? saved.watching : [],
      };
    } catch {
      return { watching: [] };
    }
  }

  private write(state: SavedState): void {
    const file = appRestartsPath(this.deps.home);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }
}
