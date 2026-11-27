// Mike's releases, for everyone's own copy of Threadbear
// (docs/setup-and-updates.md section 2.3).
//
// Everyone else's copy is a fork: `origin` is theirs and `upstream` is
// mikecann/threadbear. Their runner fetches upstream's release tags every
// six hours and says when there's a newer one than their main has, for the
// Updates panel's "new changes from Mike" and `tb updates`. Bringing it in
// is a thread they start (docs/bringing-in-updates.md); nothing here ever
// changes their main.
//
// Only tags signed with the key setup pinned (<home>/upstream-signers,
// copied from scripts/release-signers at setup) count. The pinned copy is
// the one that matters: a key changed in the repo, or a hijacked GitHub
// account, can't get code onto anyone's Mac this way. So the check is an
// SSH signature by that key and nothing else: the runner splits the tag
// itself and asks ssh-keygen, never `git verify-tag`, which hands a PGP or
// X.509 signature to gpg and the whole keyring whatever gpg.format says
// (Gautam's scan, 6 Nov 2026, F5).
//
// Tags are fetched into a folder of their own, outside the checkout, a
// few at a time and with a deadline (stageReleases), and only one that
// verifies is copied in, to refs/threadbear/upstream/; a release there is
// never moved to another object, so a tag swapped upstream after it was
// checked can't change what a bring-in thread merges (F31). Those threads
// are told the verified commit id, and merge that.
//
// Mike's own runner (runner.json `releases.publish`) makes the tags: once
// a day, if main has moved since the last one, it tags main's tip as
// release/YYYY-MM-DD, signed, and pushes the tag. Only a main it's safe to
// hand on: the runner it's running is main's, has been marked good and up
// for an hour, and main's tip is an hour old, so a commit that crashes
// the runner or is about to be followed by its fix isn't what goes out.
// And GitHub's checks have passed on that exact commit (ciVerdict), and
// each workflow that didn't run on it (its paths didn't change) passed on
// the last commit it did run on (earlierVerdict): the runner staying up
// says nothing about the apps building. release/2026-11-04
// to -06 went out not building on Xcode 26.6, and people installing it
// found out before Mike did (PR #1, Maroš's fork).
// When the tip is red, the newest older commit that passes the same checks
// goes out instead (newestGreen).
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import { IS_WINDOWS } from './platform.ts';
import { killGroup } from './proc.ts';
import { delegatePaths, readDelegateState, usableCert, REMIND_AHEAD_MS, RENEW_AHEAD_MS, renewDelegate, SIGN_MARGIN_MS, writeDelegateState } from './release-delegate.ts';
import { ADD_DELAY_MS, applyKeyChanges, certVerifyArgs, KeysBusy, keysIn, readWeeklyRevoked, revokedPath, REVOKED_FILE, keyFilesHash, KEYS_EXTENSION, signatureCert, signedWithCert, signerKey, SIGNERS_FILE, weeklyRevokedPath, withAuthorities } from './release-keys.ts';
import { changelogFor, type ReleaseChangelog } from './changelog.ts';
import { LISTING_GIT_CONFIG, parseConfigListBytes, repoProofConfig, settable, TRUSTED_SCOPES, untrustedGitEnv } from './safe-git.ts';

export const FETCH_INTERVAL_MS = 6 * 60 * 60_000;
// After a look that failed (no network yet after waking, GitHub down) the
// next one is this soon. Waiting the full six hours, a Mac that sleeps a lot
// missed releases for days (a fork's runner, 8 to 15 Nov), and the Updates
// panel took their commits for the copy's own.
export const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
export const PUBLISH_INTERVAL_MS = 60 * 60_000;
// The first look, a while after the runner starts: never in the way of a
// start that's about to be rolled back.
export const FIRST_LOOK_MS = 2 * 60_000;
// How long main's tip and the running release must have settled before
// Mike's runner tags it.
export const SETTLE_MS = 60 * 60_000;
export const TAG_PREFIX = 'release/';
// A runner from before 7 Nov fetched every tag here, unchecked; anything
// left is deleted (checkNow). Now they're staged outside the checkout, in
// STAGED_NS of a folder of their own (stageReleases).
const INCOMING_NS = 'refs/threadbear/upstream-incoming/';
const STAGED_NS = 'refs/incoming/';
// Upstream's main, staged beside the tags: a release counts only if its
// commit is on it (security review finding 3, 9 Nov 2026). A key used to
// sign a tag on a side branch, that never went through main, gets nowhere.
const STAGED_MAIN = 'refs/incoming-main/main';
// The releases that verified, copied from INCOMING_NS and never moved once
// there. Their own namespaces, so the fork's own tags are never touched.
export const UPSTREAM_REFS = 'refs/threadbear/upstream/';
const REF_NS = UPSTREAM_REFS;
const MAX_SUBJECTS = 50;
// What a release's name is after release/: the local date it was tagged
// (tagFor). Nothing else is ever looked at.
// A month 01-12 and a day 01-31: names like 2026-11-99 would otherwise sort
// above every real release in their month (Gemini's review, 25 Nov 2026).
export const RELEASE_NAME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// How far past today's date (UTC) a release's date can be: Mike's day can
// start well before the fork's.
const FUTURE_SLACK_MS = 2 * 24 * 60 * 60_000;
const MAX_ANSWERS = 10_000;
// The most tags one check reads that it hasn't read before.
const MAX_READS = 20;
// The most releases older than the newest kept that a check fetches, for
// their notes (notesSince reads nine).
const MAX_OLDER = 9;

// A release tag's message lists at most 200 subjects (publishOnce), a few
// tens of KB; a bigger tag object is turned down unread.
const MAX_TAG_BYTES = 1024 * 1024;

type Ref = { oid: string; type: string; size: number };

function readable(ref: Ref): boolean {
  return ref.type === 'tag' && ref.size > 0 && ref.size <= MAX_TAG_BYTES;
}

export type UpstreamRelease = {
  tag: string; // release/2026-10-30
  commit: string;
  date?: string; // the tag's date, ISO
  changes: number; // commits in it that main doesn't have, merges left out
  subjects: string[]; // their subject lines, newest first, at most 50
  // Commits in it Mike marked with an `Important:` trailer (a security or
  // data fix), saying why. They're covered by the tag's signature, as the
  // signed tag names the commit and so its whole history. bring-in.ts
  // starts a thread for these straight away rather than on its timer.
  important?: { commit: string; why: string }[];
  // Plain-words notes for people, from each release main doesn't have yet,
  // newest first. Each verified tag's commit subjects fill in when its
  // message has no plain-words notes.
  notes?: { tag: string; date?: string; lines: string[] }[];
  // The What's new page's cards for those releases, when upstream is a
  // repo with one and it could be read (changelog.ts). Not signed: only
  // something to look at, with the notes as the fallback.
  changelog?: ReleaseChangelog;
};

// runner.status's `upstream`, and RunnerUpdates' (docs/protocol.md).
export type UpstreamStatus = {
  // off: no upstream remote, upstream is this repo, or no pinned key;
  // idle: main has the newest release; available: it doesn't.
  state: 'off' | 'idle' | 'checking' | 'available' | 'failed';
  reason?: string;
  checkout?: string;
  checkedAt?: string;
  // The newest signed release, whether or not main has it.
  release?: UpstreamRelease;
  // Mike's runner: the last release tag it made, and when it next looks.
  published?: { tag: string; at: string };
  // Mike's runner: why main's tip isn't today's release yet, when it's
  // only GitHub's checks in the way (ciVerdict). Gone once it's tagged.
  held?: { commit: string; why: string; at: string };
  // Mike's runner with releases.delegate: until when the weekly key signs
  // (release-delegate.ts), and why the last try to renew it failed.
  weeklyKey?: { until?: string; error?: string };
};

// One GitHub Actions run of a workflow on a commit, as ciVerdict needs it.
// file: its workflow file (.github/workflows/x.yml); sha: the commit it ran on.
export type CiRun = { workflow: string; name: string; status: string; conclusion: string | null; attempt: number; file?: string; sha?: string };

// signingKey: a key file, as `git tag -s` takes it (user.signingkey): a
// plain private key (a fork of a fork, or Mike's before Touch ID), or a
// Secure Enclave key's handle (`ssh-keygen -K`), which asks for Touch ID
// on every signature (touchKey, publishOnce). signingProvider: the library
// such a key signs through, /usr/lib/ssh-keychain.dylib unless set.
// delegate: sign with a weekly key the signing key certifies, so a
// release needn't wait for a touch (release-delegate.ts).
export type PublishConfig = { publish: boolean; signingKey?: string; signingProvider?: string; delegate?: boolean };

// How long the release signature waits for Touch ID before giving up for
// this hour, and the library a Secure Enclave key signs through on macOS.
export const TOUCH_SIGN_TIMEOUT_MS = 90_000;
export const MAC_SK_PROVIDER = '/usr/lib/ssh-keychain.dylib';

// Whether a signing key asks for a touch: a security-key type (sk-…),
// read from the key's .pub (or the file itself, when it's the .pub).
export function touchKey(signingKey: string): boolean {
  for (const f of [signingKey.endsWith('.pub') ? signingKey : `${signingKey}.pub`]) {
    try {
      if (/^sk-/.test(fs.readFileSync(f, 'utf8').trim())) return true;
    } catch {
      // no .pub beside it: a plain key file
    }
  }
  return false;
}

export type UpstreamDeps = {
  home: string;
  // The repo this runner's release follows (release.json's checkout).
  checkout?: string;
  clock: Clock;
  log: Logger;
  publish?: PublishConfig;
  // Whether main's tip is what this runner runs, and it has been marked
  // good and up for SETTLE_MS (main.ts). Only asked when publishing.
  runningMainSettled?: () => boolean;
  // Whether Mike is at this Mac (presence.ts): a release signed with a
  // Touch ID key is only tried then, so the prompt never sits on an empty
  // desk. Only asked for such a key.
  atMac?: () => Promise<boolean>;
  // Mike's runner, with releases.delegate: starts the starred thread that
  // asks him to renew the weekly key, and whether a thread is still open.
  remind?: (r: { text: string; title: string; why: string }) => string;
  isOpen?: (threadId: string) => boolean;
  onChange?: () => void;
  // After every check that got as far as the releases, with what it found
  // (bring-in.ts decides from it whether to start a thread).
  onChecked?: (status: UpstreamStatus) => void;
  // Mike's runner: writes plain-words notes for a release from its
  // commits, for the tag message (main.ts asks Opus through the Claude pool), as "- "
  // lines. Nothing, or a failure, leaves them out; the release goes out anyway.
  writeNotes?: (commits: string) => Promise<string | undefined>;
  // Replaced in tests.
  git?: (cwd: string, args: string[], opts?: GitOptions) => Promise<string>;
  gitBytes?: (cwd: string, args: string[]) => Promise<Buffer>;
  // How long fetching from upstream may take (FETCH_TIMEOUT_MS), and how
  // much it may bring (STAGE_MAX_BYTES). Tests.
  fetchTimeoutMs?: number;
  stageMaxBytes?: number;
  // The Actions runs on a commit, from GitHub (githubRuns). Replaced in tests.
  ciRuns?: (repo: string, commit: string) => Promise<CiRun[]>;
  // One workflow's latest push runs on main, newest first, from GitHub
  // (githubWorkflowRuns). Replaced in tests.
  ciHistory?: (repo: string, file: string) => Promise<CiRun[]>;
  // The What's new page's cards for some release tags (changelogFor).
  // Replaced in tests.
  changelog?: (upstreamKey: string, tags: string[]) => Promise<ReleaseChangelog | undefined>;
  // Tests: upstream and origin are folders on this Mac, reached with git's
  // file protocol, which a real runner never fetches a release over
  // (fetchableUrl), and the upload-pack git runs for them (a hanging one).
  localRemotes?: boolean;
  uploadPack?: string;
};

// The push runs on one commit of a public GitHub repo ("owner/name"). No
// token: the repo's public, and an hourly look is far inside the 60 an
// hour GitHub allows without one.
export async function githubRuns(repo: string, commit: string): Promise<CiRun[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?head_sha=${commit}&event=push&per_page=100`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'threadbear-runner' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return ciRunsFrom(await res.json());
}

// A workflow's latest push runs on main (`file`, .github/workflows/x.yml),
// newest first: earlierVerdict looks back through them. One page is a day
// or two of a busy main, and a workflow quiet for longer than that has
// nothing on main since to have broken.
export async function githubWorkflowRuns(repo: string, file: string): Promise<CiRun[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(path.basename(file))}/runs?branch=main&event=push&per_page=${HISTORY_PAGE}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'threadbear-runner' },
    signal: AbortSignal.timeout(30_000),
  });
  // A workflow GitHub doesn't know (only just added, never run) has no verdict.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return ciRunsFrom(await res.json());
}

function ciRunsFrom(json: unknown): CiRun[] {
  const body = json as { workflow_runs?: { workflow_id: number; name: string; status: string; conclusion: string | null; run_attempt?: number; path?: string; head_sha?: string }[] };
  return (body.workflow_runs ?? []).map((r) => ({
    workflow: String(r.workflow_id),
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    attempt: r.run_attempt ?? 1,
    ...(r.path ? { file: r.path } : {}),
    ...(r.head_sha ? { sha: r.head_sha } : {}),
  }));
}

// Whether a commit's checks let it be a release: undefined when they do,
// or why not. Each workflow counts by its latest attempt, so a red run
// that's been re-run green passes. None at all holds it too: GitHub hasn't
// started them yet, or the commit isn't on GitHub.
export function ciVerdict(runs: CiRun[]): string | undefined {
  const latest = new Map<string, CiRun>();
  for (const r of runs) {
    const had = latest.get(r.workflow);
    if (!had || r.attempt > had.attempt) latest.set(r.workflow, r);
  }
  if (!latest.size) return "GitHub hasn't run its checks yet";
  const runsOf = [...latest.values()];
  const failed = runsOf.filter((r) => r.status === 'completed' && !['success', 'neutral', 'skipped'].includes(r.conclusion ?? ''));
  if (failed.length) return `${failed.map((r) => `"${r.name}"`).join(', ')} didn't pass on it`;
  if (runsOf.some((r) => r.status !== 'completed')) return "GitHub's checks are still running on it";
  return undefined;
}

// A run that says nothing about the commit it ran on (skipped). Not a
// cancelled one: a push that cancels the run before it has a run of its
// own, newer and on a commit the tip has, so one reached here was cancelled
// by hand, or by a push this Mac's main hasn't got, and its changes were
// never checked (Codex's reviews, 16 Nov).
const NO_VERDICT = new Set(['skipped', 'neutral', 'stale']);

// How many of a workflow's runs on main earlierVerdict is given.
export const HISTORY_PAGE = 100;
// How far back along main newestGreen looks for a green commit.
export const GREEN_LOOKBACK = 80;

// A workflow that didn't run on the tip, as its paths didn't change: what
// its last finished run on a commit the tip has says, from `history`
// (newest first, as githubWorkflowRuns gives them). Without this, a red run
// is passed over by the next push that doesn't touch its paths, and that
// tip goes out with the break: release/2026-11-15 was tagged on a commit
// only Android and the desktop app had run on. Undefined when it passed,
// or it has never run on main. A full page with none of its runs on a
// commit the tip has can't say, so that holds too (Codex's review, 16 Nov).
export function earlierVerdict(history: CiRun[], has: ReadonlySet<string>): string | undefined {
  for (const r of history) {
    if (!r.sha || !has.has(r.sha)) continue;
    const on = r.sha.slice(0, 8);
    if (r.status !== 'completed') return `"${r.name}" is still running on ${on}`;
    if (r.conclusion === 'cancelled') return `"${r.name}" was cancelled on ${on}, the last commit it ran on`;
    if (NO_VERDICT.has(r.conclusion ?? '')) continue;
    return r.conclusion === 'success' ? undefined : `"${r.name}" didn't pass on ${on}, the last commit it ran on`;
  }
  const name = history[0]?.name;
  return history.length >= HISTORY_PAGE ? `none of "${name}"'s last ${HISTORY_PAGE} runs on GitHub were on a commit main has here` : undefined;
}

export function signersPath(home: string): string {
  return path.join(home, 'upstream-signers');
}

// How long one git command may take before it's stopped: a fetch from a
// remote that answers slowly or never (Daybreak, 7 Nov 2026) held the
// release check, and every check after it, for good.
export const GIT_TIMEOUT_MS = 2 * 60_000;
export const FETCH_TIMEOUT_MS = 5 * 60_000;
const GIT_MAX_OUTPUT = 16 * 1024 * 1024;
// The most a release check may fetch before anything is verified: a few
// days' releases are a few MB, and a fork's checkout already has the rest.
export const STAGE_MAX_BYTES = 512 * 1024 * 1024;

// The bytes in a folder's files, everything below it.
function folderBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else
        try {
          total += fs.lstatSync(p).size;
        } catch {
          // gone in between
        }
    }
  };
  walk(dir);
  return total;
}

// input: what it reads on stdin. over: asked every half second while it
// runs; true stops it (stageReleases' size limit). The rest say what kind
// of release git it is (releaseGit, below): network 'remote' for one that
// talks to upstream or origin (https and ssh only), 'local' for one that
// fetches from a folder on this Mac (the check's own staging repo); owner
// for Mike's own publishing (his signing key, and his credential helpers and
// ssh for the push); files lets 'remote' reach a folder too (tests only:
// their remotes are folders).
export type GitOptions = { timeoutMs?: number; env?: Record<string, string>; input?: string; over?: () => string | undefined; network?: 'remote' | 'local'; owner?: boolean; files?: boolean };

export function gitAsync(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return runGit(cwd, args, opts).then((out) => out.toString('utf8').trim());
}

// git in its own process group, so a deadline stops what it started too
// (git-remote-https, ssh, upload-pack), with a cap on what it may print.
// GIT_TERMINAL_PROMPT=0: a fetch that wants a password fails rather than
// hanging the runner on a prompt nobody sees.
// A bare repo (the check's own staging folder) is named with --git-dir
// rather than found by looking from inside it: git refuses one it finds under
// safe.bareRepository=explicit, which Claude's desktop terminal sets in
// GIT_CONFIG_PARAMETERS, so every release check failed there (a fork's
// commit, 8 Nov 2026).
export function bareRepoArgs(cwd: string): string[] {
  const at = (name: string) => fs.existsSync(path.join(cwd, name));
  return !at('.git') && at('HEAD') && at('objects') && at('refs') ? ['--git-dir', path.resolve(cwd)] : [];
}

// Release git: what every git here runs as (Daybreak 179 and 180, 24 Nov
// 2026). The checkout's .git isn't something Threadbear made or can vouch
// for: a checkout from an archive or a shared drive brings its own, and a
// thread's worktree shares it, so its config, refs/replace/ and info/grafts
// are anyone's who could write there. The release check runs by itself, two
// minutes after the runner starts, so before any of this git ran the
// checkout's own core.sshCommand, credential helpers, a remote's uploadpack
// or remote helper, and its hooks, before a signature had been looked at;
// and read a release's commit through its replacement objects, so a release
// key file could come from a commit nobody signed. So:
// - none of the runner's GIT_ variables (they can add config or point git
//   elsewhere), and for anything but Mike's own publishing no system or
//   global config either, so nothing of anyone's config names a program;
// - the checkout's own config is read just before each command, and every
//   setting in it that would run something is switched off on the command
//   line, which beats it (safe-git.ts repoProofConfig, the same as a
//   thread's move: hooks, fsmonitor, filters, diff drivers, credential
//   helpers, ssh and askpass programs, protocols it allows), plus the
//   signing programs, showing signatures, and push's own signing and
//   submodules (RELEASE_CONFIG);
// - only https and ssh to a remote, only a folder for the local fetch, and
//   the remote's address passed as a URL (fetchableUrl), with git's own
//   upload-pack and receive-pack named, and a checkout whose config
//   rewrites an address or configures a remote named by one refused;
// - replacement objects, grafts and the commit-graph off, so an object id
//   is that object: a signed release's commit can't be read as another.
//   A checkout that has replacement refs or grafts isn't checked at all
//   (substitutes).
// Mike's own publishing (owner) keeps his system and global config, for his
// signing setup and his credential helper or ssh on the push to GitHub; the
// checkout's own config is switched off for it all the same.
const RELEASE_CONFIG: readonly string[] = [
  '-c', 'core.commitGraph=false',
  '-c', 'log.showSignature=false',
  '-c', 'core.alternateRefsCommand=true',
  '-c', 'core.pager=cat',
  '-c', 'push.gpgSign=false',
  '-c', 'push.recurseSubmodules=no',
  '-c', 'advice.graftFileDeprecated=false',
];
// The programs a release's git could run that are named by one setting each:
// the ssh command and the signing programs (only `git tag -s` on Mike's
// runner signs). Each is set every time, to the owner's own or git's default,
// whatever the checkout's config says, so it holds even if that config
// changes between the look at it and the command (Codex's review, 24 Nov
// 2026); credential helpers too (releaseGitConfig).
const PROGRAMS: { key: string; fallback: string }[] = [
  { key: 'core.sshcommand', fallback: 'ssh' },
  { key: 'gpg.program', fallback: 'gpg' },
  { key: 'gpg.openpgp.program', fallback: 'gpg' },
  { key: 'gpg.x509.program', fallback: 'gpgsm' },
  { key: 'gpg.ssh.program', fallback: 'ssh-keygen' },
  { key: 'gpg.ssh.defaultkeycommand', fallback: '' },
];
// git's own, by name, whatever a remote's settings say (a remote named by its
// URL is one too).
export const UPLOAD_PACK = '--upload-pack=git-upload-pack';
const RECEIVE_PACK = '--receive-pack=git-receive-pack';
// What the runner's environment keeps for release git: who commits (Mike's
// tag needs a tagger), and for owner, which of his config files git reads.
const KEEP_ENV = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/;
const OWNER_ENV = /^GIT_(CONFIG_(GLOBAL|SYSTEM|NOSYSTEM)|SSH_COMMAND)$/;

export function releaseGitEnv(opts: Pick<GitOptions, 'env' | 'owner'> = {}): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP_ENV.test(k) || (opts.owner && OWNER_ENV.test(k))));
  return {
    ...untrustedGitEnv(),
    ...kept,
    ...(opts.owner ? {} : { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    ...opts.env,
    // After the caller's, so nothing turns them back on.
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
  };
}

// The -c settings for release git in `cwd`, from its config as git reads it
// with `env`. Throws when it can't be read, or has a setting -c can't reach.
// What's switched off by name (a config hook's, a filter's) is what this
// look found: one the checkout's config gains between the look and the
// command isn't, as for a thread's move (safe-git.ts untrustedGit); the
// programs above are set whatever it says.
export async function releaseGitConfig(cwd: string, env: NodeJS.ProcessEnv, opts: Pick<GitOptions, 'network' | 'files'> = {}): Promise<string[]> {
  const listed = await new Promise<Buffer>((resolve, reject) => {
    execFile('git', [...LISTING_GIT_CONFIG, '-C', cwd, ...bareRepoArgs(cwd), 'config', '--list', '--show-scope', '-z'], { env, encoding: 'buffer', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(`couldn't read the checkout's git config: ${String(stderr).trim() || err.message}`)) : resolve(stdout),
    );
  });
  const entries = parseConfigListBytes(listed);
  // A remote's address is given to git as a URL (fetchableUrl), but the
  // checkout's config can still rewrite it (url.<x>.insteadOf and
  // pushInsteadOf), give it settings of its own under a remote named by
  // that URL (a push URL, a remote helper, a proxy: git looks a URL up as a
  // remote's name first; every address fetchableUrl gives has a colon), or
  // send https through a proxy of its choosing with certificates unchecked
  // (http.*, which -c can't reliably override, as a setting for a URL beats
  // one for all). Each sends upstream's fetch, or Mike's push with his
  // credentials, somewhere the configured address doesn't say, so a
  // checkout that has one isn't used for network git at all (Gemini's
  // reviews, 24 Nov 2026). The owner's own (global) settings are his.
  // files: tests, whose remotes are folders reached through an insteadOf.
  if (opts.network === 'remote' && !opts.files) {
    const redirect = entries.find((e) => !TRUSTED_SCOPES.has(e.scope) && (/^(url|http)\./.test(e.key) || /^remote\.[\s\S]*:[\s\S]*\.[^.]+$/.test(e.key)));
    if (redirect) throw new Error(`this checkout's own git config changes where or how git reaches a remote (${JSON.stringify(redirect.key.slice(0, 80))}), so release git won't reach one from it; remove that setting`);
  }
  const out = [...repoProofConfig(entries, opts.network === 'remote' ? 'remote' : opts.network === 'local' ? 'bundle' : undefined), ...RELEASE_CONFIG];
  // repoProofConfig lets a remote be a folder too (a thread's move needs
  // that); a release's never is.
  if (opts.network === 'remote' && !opts.files) out.push('-c', 'protocol.file.allow=never');
  const own = (match: (k: string) => boolean) => entries.filter((e) => match(e.key) && TRUSTED_SCOPES.has(e.scope));
  for (const p of PROGRAMS) out.push('-c', `${p.key}=${own((k) => k === p.key).pop()?.value ?? p.fallback}`);
  // An empty helper empties the list git has so far (any URL's too); then
  // the owner's own, in order.
  out.push('-c', 'credential.helper=');
  for (const e of own((k) => /^credential\.([\s\S]*\.)?helper$/.test(k))) out.push('-c', `${settable(e.key)}=${e.value}`);
  return out;
}

async function runGit(cwd: string, args: string[], opts: GitOptions): Promise<Buffer> {
  const env = releaseGitEnv(opts);
  const config = await releaseGitConfig(cwd, env, opts);
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...config, '-C', cwd, ...bareRepoArgs(cwd), ...args], {
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: !IS_WINDOWS,
      windowsHide: true,
      env,
    });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    let why = '';
    const stop = (reason: string) => {
      if (why) return;
      why = reason;
      // The group, or on Windows the process tree (proc.ts killGroup), so a
      // git helper that hangs goes with git; git alone if that can't be done.
      if (!killGroup(child.pid!, 'SIGKILL')) child.kill('SIGKILL');
    };
    const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
    const timer = setTimeout(() => stop(`timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    const watch = opts.over
      ? setInterval(() => {
          const why = opts.over!();
          if (why) stop(why);
        }, 500)
      : undefined;
    if (opts.input !== undefined) {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(opts.input);
    }
    child.stdout!.on('data', (d: Buffer) => {
      size += d.length;
      if (size > GIT_MAX_OUTPUT) stop('printed more than 16 MB');
      else out.push(d);
    });
    child.stderr!.on('data', (d: Buffer) => {
      if (err.length < 8192) err += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (watch) clearInterval(watch);
      reject(new Error(`git ${args.join(' ')} failed: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (watch) clearInterval(watch);
      // The reason first: a check's status keeps only the start of it.
      if (why) reject(new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} ${why} (git ${args.join(' ')})`));
      else if (code !== 0) reject(Object.assign(new Error(`git ${args.join(' ')} failed: ${err.trim() || `exit ${code ?? signal}`}`), { exitCode: code }));
      else resolve(Buffer.concat(out));
    });
  });
}

// Where a remote's releases are fetched from, rebuilt from its configured
// address (remote.<name>.url, as written, not as an insteadOf rewrites it):
// an https or ssh address of a plain host and path, or undefined. A local
// path, file://, ext:: or a remote helper's `x::` never is, and a user name
// and password in an https one are left out (Mike's repo is public). What's
// fetched is trusted only once its signature checks, so the address only
// says where to look; this keeps it from naming a program or another repo
// on this Mac. files: a folder too (tests only).
export function fetchableUrl(raw: string | undefined, opts: { files?: boolean } = {}): string | undefined {
  const u = (raw ?? '').trim();
  const HOST = '([A-Za-z0-9][A-Za-z0-9.-]*)';
  const WHERE = '(/[A-Za-z0-9._~/-]*)';
  let m = new RegExp(`^https://(?:[^@/\\s]*@)?${HOST}(:\\d{1,5})?${WHERE}$`).exec(u);
  if (m) return `https://${m[1]}${m[2] ?? ''}${m[3]}`;
  m = new RegExp(`^ssh://(?:([A-Za-z0-9_][A-Za-z0-9._-]*)@)?${HOST}(:\\d{1,5})?${WHERE}$`).exec(u);
  if (m) return `ssh://${m[1] ? `${m[1]}@` : ''}${m[2]}${m[3] ?? ''}${m[4]}`;
  m = new RegExp(`^([A-Za-z0-9_][A-Za-z0-9._-]*)@${HOST}:([A-Za-z0-9._~/][A-Za-z0-9._~/-]*)$`).exec(u);
  if (m) return `${m[1]}@${m[2]}:${m[3]}`;
  if (opts.files && path.isAbsolute(u) && !/[\0\n\r]/.test(u)) return u;
  return undefined;
}

// github.com/mikecann/threadbear, however the URL is written (https, ssh,
// with or without .git), so origin and upstream can be compared.
export function repoKey(url: string): string {
  return url
    .trim()
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

// `git log --format=%H%x1f<Important trailers>` as the commits that have one.
export function parseImportant(out: string): { commit: string; why: string }[] {
  return out
    .split('\n')
    .map((line) => line.split('\x1f'))
    .filter(([commit, why]) => commit && why?.trim())
    .map(([commit, why]) => ({ commit: commit.trim(), why: why.trim().slice(0, 200) }));
}

// A tag message's "What's new:" bullets. Release messages look like:
//
//   Threadbear 2026-11-06
//
//   Important: keeps API keys out of Convex      (only when there's one)
//
//   What's new:                                   (when notes were written)
//   - Searching projects finds goals and state again
//
//   Every change:
//   - Website: project search reaches goals and state again
export const NOTES_HEADING = "What's new:";
export const CHANGES_HEADING = 'Every change:';
const MAX_NOTE_LINES = 12;

export function parseNotes(message: string): string[] {
  const lines = message.split('\n');
  const at = lines.findIndex((l) => l.trim() === NOTES_HEADING);
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('- ')) break;
    const text = l.slice(2).trim();
    if (text) out.push(text.slice(0, 200));
  }
  return out.slice(0, MAX_NOTE_LINES);
}

// For Opus writing a release's notes (main.ts writeNotes). The
// readers use Threadbear on their own Mac and never see its code.
export const RELEASE_NOTES_SYSTEM = `You write the release notes for Threadbear, a Mac app for running AI coding agents in threads, with an iPhone app and a website. The reader uses Threadbear on their own Mac and wants to know what they'll notice in this release. You get its commit messages.

Write 2 to 8 lines, the most noticeable first, each starting "- ". Plain words, as if telling a friend: what they can now do or what works better. Under 15 words each. Fold several commits about one thing into one line. Leave out work they'd never notice (tests, docs, refactors, review rounds, internal speedups) unless it changes something they see. No file, function or code names, no jargon, no em dashes, no marketing words. Reply with only the lines. If nothing in it would be noticed, reply NONE.`;

// What the model wrote, as bullets: "- " lines only, nothing if it said NONE.
export function cleanNotes(text: string | undefined): string[] {
  if (!text || /^\s*NONE\s*$/i.test(text)) return [];
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*•] /.test(l))
    .map((l) => l.replace(/^[-*•] /, '').replace(/\s*—\s*/g, ', ').trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, MAX_NOTE_LINES);
}

// release/2026-10-30 for a local date.
export function tagFor(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${TAG_PREFIX}${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class Upstream {
  private st: UpstreamStatus = { state: 'off' };
  private timer: TimerHandle | undefined;
  private publishTimer: TimerHandle | undefined;
  private running: Promise<UpstreamStatus> | undefined;
  private stopped = false;
  // verified()'s answers, by signers file, object and name.
  private readonly answers = new Map<string, SignedTag | null>();
  // Reused if signing or pushing the same release needs another try.
  private noteDraft?: { key: string; lines: string[] };
  // The newest release that verified and is on upstream's main, for its key
  // list (keyChanges).
  private newestVerified?: SignedTag & { tag: string };
  private readonly git: (cwd: string, args: string[], opts?: GitOptions) => Promise<string>;
  // The release tags GitHub had at publishOnce's last look.
  private pushedTags = new Set<string>();
  // origin's URL at publishOnce's last look (fetchableUrl), for its fetches
  // and pushes.
  private origin?: string;
  private readonly deps: UpstreamDeps;

  private get fetchTimeoutMs(): number {
    return this.deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  }

  private get stageMaxBytes(): number {
    return this.deps.stageMaxBytes ?? STAGE_MAX_BYTES;
  }

  // Release git that talks to upstream or origin (releaseGit, above), and
  // its upload-pack: git's own.
  private remote(more: GitOptions = {}): GitOptions {
    return { network: 'remote', ...(this.deps.localRemotes ? { files: true } : {}), ...more };
  }

  private get uploadPack(): string {
    return this.deps.uploadPack ? `--upload-pack=${this.deps.uploadPack}` : UPLOAD_PACK;
  }

  private url(raw: string | undefined): string | undefined {
    return fetchableUrl(raw, { files: this.deps.localRemotes });
  }

  // Why release work can't trust what git reads in `checkout`, or
  // undefined: replacement refs (refs/replace/) or grafts (info/grafts),
  // which git uses to read one object in place of another. Release git
  // already ignores both (releaseGit), so this is the check saying so,
  // rather than reading a release past them (Daybreak 180, 24 Nov 2026).
  private async substitutes(checkout: string): Promise<string | undefined> {
    const replaced = await this.git(checkout, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/replace/']);
    if (replaced) return `this checkout has git replacement refs (${replaced.slice(0, 80)}), which could have git read other objects in place of a release's; remove them (git replace -d) and it checks again`;
    const common = path.resolve(checkout, await this.git(checkout, ['rev-parse', '--git-common-dir']));
    if (fs.existsSync(path.join(common, 'info', 'grafts'))) return `this checkout has git grafts (${path.join(common, 'info', 'grafts')}), which could have git read other history in place of a release's; remove that file and it checks again`;
    return undefined;
  }

  constructor(deps: UpstreamDeps) {
    this.deps = deps;
    this.git = deps.git ?? gitAsync;
    if (deps.checkout) this.st.checkout = deps.checkout;
  }

  status(): UpstreamStatus {
    return { ...this.st };
  }

  start(): void {
    if (!this.deps.checkout) {
      this.set({ state: 'off', reason: 'this runner runs from source, not a release' });
      return;
    }
    this.stopped = false;
    this.timer ??= this.deps.clock.setTimeout(() => this.tick(), FIRST_LOOK_MS);
    if (this.deps.publish?.publish) this.publishTimer ??= this.deps.clock.setTimeout(() => this.publishTick(), FIRST_LOOK_MS);
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.publishTimer?.cancel();
    this.timer = this.publishTimer = undefined;
  }

  private tick(): void {
    this.timer = undefined;
    void this.check()
      .catch(() => undefined)
      .then((s) => {
        const wait = !s || s.state === 'failed' ? RETRY_AFTER_FAILURE_MS : FETCH_INTERVAL_MS;
        if (!this.stopped) this.timer = this.deps.clock.setTimeout(() => this.tick(), wait);
      });
  }

  private publishTick(): void {
    this.publishTimer = undefined;
    void this.publishOnce()
      .catch((e) => this.deps.log.warn('could not tag a release', { error: String(e) }))
      .finally(() => {
        if (!this.stopped) this.publishTimer = this.deps.clock.setTimeout(() => this.publishTick(), PUBLISH_INTERVAL_MS);
      });
  }

  // Fetches upstream's release tags and works out what main is missing.
  // `tb updates check` and the timer share one check at a time.
  check(): Promise<UpstreamStatus> {
    this.running ??= this.checkNow().finally(() => (this.running = undefined));
    return this.running;
  }

  private async checkNow(): Promise<UpstreamStatus> {
    const checkout = this.deps.checkout;
    if (!checkout) return this.status();
    let urls: { origin?: string; upstream?: string };
    try {
      urls = await this.remotes(checkout);
    } catch (e) {
      this.deps.log.warn('could not check upstream for releases', { error: String(e) });
      return this.set({ state: 'failed', checkedAt: new Date(this.deps.clock.now()).toISOString(), reason: String((e as Error).message ?? e).slice(0, 300) });
    }
    if (!urls.upstream) return this.set({ state: 'off', reason: "this copy has no upstream remote (Mike's repo), so it has no releases to follow" });
    if (urls.origin && repoKey(urls.origin) === repoKey(urls.upstream)) return this.set({ state: 'off', reason: 'upstream is this repo' });
    const from = this.url(urls.upstream);
    if (!from) return this.set({ state: 'off', reason: "upstream's address (remote.upstream.url) isn't an https or ssh one, so releases aren't fetched from it" });
    const signers = signersPath(this.deps.home);
    if (!fs.existsSync(signers)) return this.set({ state: 'off', reason: `no release key pinned at ${signers}; run ./threadbear setup again` });
    this.set({ state: 'checking' });
    const checkedAt = new Date(this.deps.clock.now()).toISOString();
    try {
      const substituted = await this.substitutes(checkout);
      if (substituted) throw new Error(substituted);
      // Before the fetch, so an upstream that's gone (or made to fail)
      // can't keep an unverified ref there.
      await this.sweep(checkout, signers);
      // What a runner from before this kept unverified here goes: upstream's
      // tags are only ever staged outside the checkout now (stageReleases).
      for (const [name, ref] of await this.refs(checkout, INCOMING_NS)) await this.git(checkout, ['update-ref', '-d', INCOMING_NS + name, ref.oid]).catch(() => undefined);
      // A folder of this check's own, so two Upstreams (a runner handing
      // over to the next) never share one (Codex's review). One a runner
      // that was killed left behind goes after an hour.
      const parent = path.join(this.deps.home, 'runner', 'upstream-fetch');
      fs.mkdirSync(parent, { recursive: true });
      for (const old of fs.readdirSync(parent)) {
        const p = path.join(parent, old);
        try {
          // The real clock: it's compared with a file's time.
          if (Date.now() - fs.statSync(p).mtimeMs > 60 * 60_000) fs.rmSync(p, { recursive: true, force: true });
        } catch {
          // gone already
        }
      }
      const work = fs.mkdtempSync(path.join(parent, 'check-'));
      let release: UpstreamRelease | undefined;
      try {
        const staged = await this.stageReleases(checkout, signers, path.join(work, 'git'), from);
        // What this fork had before: older releases' revocations were read
        // when they were the newest (keyChanges).
        const keptBefore = [...(await this.refs(checkout, REF_NS)).keys()].filter((n) => RELEASE_NAME.test(n)).sort().at(-1) ?? '';
        await this.promote(checkout, signers, staged);
        // A release can change which keys count (keyChanges), and so can
        // another runner's check meanwhile (a handover): then what it found
        // is worked out again with the keys as they are now, so a release
        // whose own key was revoked isn't offered, until the keys stayed
        // the same through a whole look (Codex's reviews). An older
        // release that still counts takes its place.
        let settled = false;
        for (let look = 0; look < 3 && !settled; look++) {
          if (look) {
            await this.sweep(checkout, signers);
            await this.promote(checkout, signers, staged);
          }
          const keysBefore = this.signersHash(signers);
          this.newestVerified = undefined;
          release = await this.newestSigned(checkout, signers, staged);
          // Revocations in what was fetched count even when no release does.
          const changed = await this.keyChanges(checkout, signers, staged, keptBefore);
          settled = !changed && this.signersHash(signers) === keysBefore;
        }
        if (!settled) throw new Error('the release keys kept changing while the check ran; it looks again next time');
        // Another runner held the key lock, so revocations went unread: what
        // this check kept goes again and it fails, to read them next time,
        // rather than offer a release one of them may revoke (Codex's review).
        if (this.keysBusy) {
          for (const [name, ref] of await this.refs(checkout, REF_NS)) {
            if (name > keptBefore) await this.git(checkout, ['update-ref', '-d', REF_NS + name, ref.oid]).catch(() => undefined);
          }
          throw new Error('another runner was changing the release keys; it looks again next time');
        }
        for (const oid of this.lapsing) this.lapsed.add(oid);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
      if (!release) return this.set({ state: 'idle', checkedAt, reason: 'no signed releases yet' });
      const state = release.changes > 0 ? 'available' : 'idle';
      if (state === 'available') {
        const changelog = await this.changelogFor(from, release);
        if (changelog) release = { ...release, changelog };
      }
      if (state === 'available' && this.st.release?.tag !== release.tag) this.deps.log.info('a newer release from upstream', { tag: release.tag, changes: release.changes });
      const status = this.set({ state, checkedAt, release });
      try {
        this.deps.onChecked?.(status);
      } catch (e) {
        this.deps.log.warn('could not act on the release check', { error: String(e) });
      }
      return status;
    } catch (e) {
      this.deps.log.warn('could not check upstream for releases', { error: String(e) });
      return this.set({ state: 'failed', checkedAt, reason: String((e as Error).message ?? e).slice(0, 300) });
    }
  }

  // The page's cards for the releases main doesn't have. A failure only
  // leaves them out: the panel shows the notes instead.
  private async changelogFor(upstream: string, release: UpstreamRelease): Promise<ReleaseChangelog | undefined> {
    const tags = release.notes?.length ? release.notes.map((n) => n.tag) : [release.tag];
    try {
      return await (this.deps.changelog ?? changelogFor)(repoKey(upstream), tags);
    } catch (e) {
      this.deps.log.info('could not read the changelog page; the notes stand in', { error: String(e) });
      return undefined;
    }
  }

  // Each remote's address as configured (the first, as git fetches from),
  // not as an insteadOf in the checkout's config rewrites it.
  private async remotes(checkout: string): Promise<{ origin?: string; upstream?: string }> {
    const get = (name: string) => this.configuredUrl(checkout, name);
    const [origin, upstream] = await Promise.all([get('origin'), get('upstream')]);
    return { origin, upstream };
  }

  // Undefined when there's none (git config's exit 1), or more than one:
  // git fetches from the first and `config --get` reads the last, so the
  // address checked and the one used could differ (Gemini's review).
  // Anything else that stops git (a config it won't run with) throws.
  private configuredUrl(checkout: string, name: string): Promise<string | undefined> {
    return this.git(checkout, ['config', '--get-all', `remote.${name}.url`]).then(
      (out) => {
        const urls = out.split('\n').map((u) => u.trim()).filter(Boolean);
        return urls.length === 1 ? urls[0] : undefined;
      },
      (e: unknown) => {
        if ((e as { exitCode?: unknown }).exitCode === 1) return undefined;
        throw e;
      },
    );
  }

  // Fetches a bounded few of upstream's release tags into a folder of their
  // own, where the check reads and verifies them; the checkout gets only a
  // release that verified (promote). It fetched every release/* tag
  // upstream had, with all their history, straight into the checkout and
  // with no deadline, so a hijacked upstream could hold the check or fill
  // the disk before a signature was looked at (Daybreak, 7 Nov 2026).
  //
  // 1. ls-remote lists upstream's release/* tags: names and object ids,
  //    nothing fetched (a deadline and an output cap, as every git here).
  // 2. The candidates, by promote's rules (f7ec0661): date names no later
  //    than a couple of days from now, newest first, at most MAX_READS from
  //    the newest release kept here on, and the newest few older than it,
  //    which only the notes read (notesSince). A tag already found unsigned
  //    is passed over, so a flood of them can't keep a real one out for long.
  // 3. Those are fetched with their objects going to the folder (git's own
  //    quarantine, GIT_OBJECT_DIRECTORY), not the checkout's, and no ref of
  //    the checkout's changes. The folder is a bare repo whose objects fall
  //    back on the checkout's, so only what's new comes over the network,
  //    and each candidate is a ref there, refs/incoming/<date>.
  // checkNow deletes the folder when the check ends, whatever happened, so
  // what didn't verify, and a fetch cut short, leaves nothing behind.
  // Weekly keys' tags whose week ended before this fork saw them (promote).
  // Set aside only once a check has read their revocations (checkNow),
  // so a revocation in one can't be passed over with it (Gemini's review).
  private lapsed = new Set<string>();
  private lapsing = new Set<string>();
  private keysBusy = false;
  private async stageReleases(checkout: string, signers: string, work: string, from: string): Promise<string | undefined> {
    // Each check's own (checkNow): none left from one that failed.
    this.lapsing.clear();
    this.keysBusy = false;
    const listed = await this.git(checkout, ['ls-remote', this.uploadPack, from, 'refs/heads/main', `refs/tags/${TAG_PREFIX}*`], this.remote({ timeoutMs: this.fetchTimeoutMs }));
    // Upstream's main: no main, no release can count (STAGED_MAIN).
    const mainOid = listed.split('\n').map((l) => l.split('\t')).find(([oid, ref]) => ref === 'refs/heads/main' && oid && OBJECT_ID.test(oid))?.[0];
    if (!mainOid) return undefined;
    // A tag object is listed twice, the second time peeled (name^{}): a
    // name without that points straight at a commit, which is never a
    // signed release, so it's left out unfetched (promote's rule).
    const listedOids = new Map<string, string>();
    const peeled = new Set<string>();
    for (const line of listed.split('\n')) {
      const [oid, ref] = line.split('\t');
      if (!oid || !OBJECT_ID.test(oid) || !ref?.startsWith(`refs/tags/${TAG_PREFIX}`)) continue;
      const name = ref.slice(`refs/tags/${TAG_PREFIX}`.length);
      if (name.endsWith('^{}')) peeled.add(name.slice(0, -3));
      else if (RELEASE_NAME.test(name)) listedOids.set(name, oid);
    }
    const offered = new Map([...listedOids].filter(([name]) => peeled.has(name)));
    // Upstream's main first, into the folder, so a release kept here whose
    // commit isn't on it goes before the newest kept one sets where the
    // candidates start: a signed side-branch tag an older runner kept, dated
    // after every real release, held them all out (Codex's review).
    const objects = path.resolve(checkout, await this.git(checkout, ['rev-parse', '--git-path', 'objects']));
    const format = await this.git(checkout, ['rev-parse', '--show-object-format']).catch(() => 'sha1');
    // No template: nothing of anyone's goes in it (hooks, config).
    await this.git(path.dirname(work), ['init', '-q', '--bare', '--template=', `--object-format=${format}`, work]);
    fs.mkdirSync(path.join(work, 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(work, 'objects', 'info', 'alternates'), `${objects}\n`);
    await this.fetchStaged(checkout, work, objects, ['refs/heads/main'], from);
    if (!(await this.git(work, ['cat-file', '-e', `${mainOid}^{commit}`]).then(() => true, () => false))) return undefined;
    await this.git(work, ['update-ref', STAGED_MAIN, mainOid]);
    for (const [name, ref] of await this.refs(checkout, REF_NS)) {
      if (await this.onUpstreamMain(work, `${ref.oid}^{commit}`)) continue;
      this.deps.log.warn("removed a kept upstream release whose commit isn't on upstream's main", { tag: TAG_PREFIX + name });
      await this.git(checkout, ['update-ref', '-d', REF_NS + name, ref.oid]).catch(() => undefined);
    }
    const kept = await this.refs(checkout, REF_NS);
    const newest = [...kept.keys()].filter((n) => RELEASE_NAME.test(n)).sort().at(-1) ?? '';
    const latest = new Date(this.deps.clock.now() + FUTURE_SLACK_MS).toISOString().slice(0, 10);
    const pinned = this.signersHash(signers);
    const unsigned = (name: string) => this.answers.get(`${pinned} ${offered.get(name)} ${TAG_PREFIX}${name}`) === null || this.lapsed.has(offered.get(name)!);
    const names = [...offered.keys()].filter((n) => n <= latest && !unsigned(n)).sort().reverse();
    const candidates = [...names.filter((n) => n >= newest).slice(0, MAX_READS), ...names.filter((n) => n < newest).slice(0, MAX_OLDER)];
    if (candidates.length) await this.fetchStaged(checkout, work, objects, candidates.map((n) => `refs/tags/${TAG_PREFIX}${n}`), from);
    // The ids ls-remote named, where they came (a tag moved in between
    // isn't there, and waits for the next check).
    const updates: string[] = [];
    for (const name of candidates) {
      const oid = offered.get(name)!;
      if (await this.git(work, ['cat-file', '-e', oid]).then(() => true, () => false)) updates.push(`create ${STAGED_NS}${name} ${oid}`);
    }
    if (updates.length) await this.git(work, ['update-ref', '--stdin'], { input: updates.join('\n') + '\n' });
    return work;
  }

  // Fetches `refs` from upstream into the staging folder's objects, with
  // no ref of the checkout's changed, bounded in size and time.
  private async fetchStaged(checkout: string, work: string, objects: string, refs: string[], from: string): Promise<void> {
    await this.git(
      checkout,
      // One pack, never loose objects (unpackLimit), so its size is what's
      // in objects/pack, watched as it comes: over the limit, it's stopped.
      // No pruning: fetch.prune or fetch.pruneTags in someone's config
      // would add refs/tags/*:refs/tags/* and change the checkout's tags
      // (Codex's review).
      ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'fetch.writeCommitGraph=false', '-c', 'fetch.unpackLimit=1', '-c', 'transfer.unpackLimit=1',
        'fetch', '-q', '--no-tags', '--no-prune', '--no-prune-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', this.uploadPack, from,
        ...refs],
      this.remote({
        timeoutMs: this.fetchTimeoutMs,
        env: { GIT_OBJECT_DIRECTORY: path.join(work, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects },
        over: () => (folderBytes(path.join(work, 'objects')) > this.stageMaxBytes ? `fetched more than ${Math.round(this.stageMaxBytes / 1024 / 1024)} MB` : undefined),
      }),
    );
    if (folderBytes(path.join(work, 'objects')) > this.stageMaxBytes) throw new Error(`git fetch from upstream fetched more than ${Math.round(this.stageMaxBytes / 1024 / 1024)} MB`);
  }

  // Copies a staged release's objects into the checkout (no ref changes).
  private async bringIn(checkout: string, work: string, name: string): Promise<void> {
    await this.git(checkout, ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '-q', '--no-tags', '--no-prune', '--no-prune-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', UPLOAD_PACK, work, `${STAGED_NS}${name}`], { network: 'local' });
  }



  // Takes out anything in REF_NS that doesn't verify: a runner from before
  // this check fetched straight into it, unverified, and so can a
  // rolled-back one. Whatever the name, so nothing is in the way of a
  // release's (refs/threadbear/upstream/2026-11-06/x blocks 2026-11-06).
  private async sweep(checkout: string, signers: string): Promise<void> {
    for (const [name, ref] of await this.refs(checkout, REF_NS)) {
      if (await this.verified(checkout, ref, TAG_PREFIX + name, signers)) continue;
      this.deps.log.warn('removed an upstream release ref that is not signed with the pinned key', { tag: TAG_PREFIX + name });
      await this.git(checkout, ['update-ref', '-d', REF_NS + name, ref.oid]).catch(() => undefined);
    }
  }

  // Copies the newest fetched tag that verifies into REF_NS. Upstream can
  // push any number of tags, so what it can make the runner read is
  // bounded: only names Mike's runner makes (a date, tagFor), no later
  // than a couple of days from now and no earlier than the newest release
  // kept; only tag objects (a tag pointing straight at a commit is turned
  // down without a read); newest first, stopping at the first that
  // verifies; and at most MAX_READS tags read per check. A name already
  // kept keeps its object: a different tag served later under it is a
  // re-tag nobody should merge, so it's said in the log and left out.
  // The tags are the ones stageReleases fetched to `staged`, read there;
  // only the one kept comes into the checkout.
  private async promote(checkout: string, signers: string, staged: string | undefined): Promise<void> {
    if (!staged) return;
    const kept = await this.refs(checkout, REF_NS);
    const newest = [...kept.keys()].filter((n) => RELEASE_NAME.test(n)).sort().at(-1) ?? '';
    const latest = new Date(this.deps.clock.now() + FUTURE_SLACK_MS).toISOString().slice(0, 10);
    const incoming = [...(await this.refs(staged, STAGED_NS))]
      // Not a tag object goes through verified() too, unread, so it's
      // remembered and stageReleases passes it over next time: a server
      // can list a commit as a tag (Codex's review).
      .filter(([name, ref]) => RELEASE_NAME.test(name) && name >= newest && name <= latest && kept.get(name)?.oid !== ref.oid)
      .sort(([a], [b]) => (a < b ? 1 : -1));
    let reads = 0;
    for (const [name, ref] of incoming) {
      const tag = TAG_PREFIX + name;
      if (!this.answered(ref, tag, signers) && ++reads > MAX_READS) {
        this.deps.log.warn('more upstream release tags than one check reads; the rest wait for the next', { from: tag });
        break;
      }
      const signed = await this.verified(staged, ref, tag, signers);
      if (!signed) {
        this.deps.log.warn('skipped an upstream release tag that is not signed with the pinned key', { tag });
        continue;
      }
      // A weekly key's release is taken only while its certificate is good
      // by this clock, not just when the tag says it was made: a weekly key
      // that leaked can't get a release taken after its week, however the
      // tags upstream are arranged (Codex's reviews, 25 Nov 2026). Once
      // kept, it stays (sweep checks it at its own time).
      const cert = signatureCert(signed.signature);
      const now = this.deps.clock.now();
      if (cert && (now < cert.validAfter || now >= cert.validBefore)) {
        this.deps.log.warn("skipped a weekly key's release whose certificate isn't good now", { tag });
        // One whose week is over never will be: passed over from now on, so
        // a run of them can't hold every check's places (Codex's and
        // Gemini's reviews).
        if (now >= cert.validBefore) this.lapsing.add(ref.oid);
        continue;
      }
      if (!(await this.onUpstreamMain(staged, signed.commit))) {
        this.deps.log.warn("skipped a signed upstream release whose commit isn't on upstream's main", { tag, commit: signed.commit });
        continue;
      }
      const have = kept.get(name);
      if (have) {
        this.deps.log.warn('upstream serves a different tag under a release name already verified here; keeping the one verified first', { tag, kept: have.oid, offered: ref.oid });
        continue;
      }
      // Only if the name is still free (a ref that turned up in between
      // isn't overwritten). A clash with another ref's name fails this one
      // copy, not the whole check.
      const ok = await this.bringIn(checkout, staged, name)
        .then(() => this.git(checkout, ['update-ref', REF_NS + name, ref.oid, '']))
        .then(() => true)
        .catch((e) => (this.deps.log.warn('could not keep a verified release', { tag, error: String(e) }), false));
      // The newest is the one that counts; older ones needn't be read.
      if (ok) break;
    }
  }

  // What the newest accepted release's commit says about the release keys
  // (release-keys.ts): a key announced in its scripts/release-signers waits
  // a week and then counts, one in scripts/release-keys-revoked stops
  // counting at once. Read from the commit the signature covers.
  // Whether the keys that count changed.
  private async keyChanges(checkout: string, signers: string, staged?: string, keptBefore = ''): Promise<boolean> {
    const newest = this.newestVerified;
    // The revocations in every other release this check fetched that's on
    // upstream's main too: a newer one signed by a key that's since been
    // revoked mustn't hide the release revoking it (Codex's review, 25 Nov
    // 2026). Revoking only ever takes keys away, so an older release's
    // can't do harm; announcing is the newest's alone.
    const keptOid = newest ? await this.git(checkout, ['rev-parse', '--verify', '--quiet', REF_NS + newest.tag.slice(TAG_PREFIX.length)]).catch(() => '') : '';
    const others = staged ? await this.otherReleases(staged, signers, keptOid, keptBefore) : [];
    let change: ReturnType<typeof applyKeyChanges> = { added: [], revoked: [], waiting: [], refused: [] };
    for (const [signed, cwd, onlyRevoke] of [...others.map((o) => [o, staged!, true] as const), ...(newest ? [[newest, checkout, false] as const] : [])]) {
      // An older release revoked something: look again before the newest
      // says anything, as it may be signed by what was just revoked
      // (Gemini's review, 25 Nov 2026). checkNow sweeps and picks again.
      if (!onlyRevoke && change.revoked.length) break;
      const cert = signatureCert(signed.signature);
      if (cert && readWeeklyRevoked(this.deps.home).includes(cert.key)) continue;
      const signer = signerKey(signed.signature);
      if (!signer) continue;
      // Read object by object, each checked against its id (committedFile).
      const [announced, revoke] = await Promise.all([this.committedFile(cwd, signed.commit, SIGNERS_FILE), this.committedFile(cwd, signed.commit, REVOKED_FILE)]);
      try {
        const c = applyKeyChanges({ home: this.deps.home, signers, signer, announced: keysIn(announced), revoke: keysIn(revoke), tag: signed.tag, now: this.deps.clock.now(), onlyRevoke });
        change = { added: [...change.added, ...c.added], revoked: [...change.revoked, ...c.revoked], waiting: onlyRevoke ? change.waiting : c.waiting, refused: [...change.refused, ...c.refused] };
      } catch (e) {
        // Another runner is at it; the next check reads the release again.
        if (e instanceof KeysBusy) {
          this.keysBusy = true;
          return false;
        }
        throw e;
      }
    }
    const signed = { tag: newest?.tag ?? others.at(-1)?.tag ?? '' };
    for (const k of change.revoked) this.deps.log.warn('a release revoked a release key; it no longer counts', { key: k.slice(0, 60), tag: signed.tag });
    for (const k of change.added) this.deps.log.warn('a new release key now counts, announced a week ago by a pinned key', { key: k.slice(0, 60), tag: signed.tag });
    for (const k of change.refused) this.deps.log.warn("a release tried to revoke a key it can't (only that key or a newer one can)", { key: k.slice(0, 60), tag: signed.tag });
    if (change.waiting.length) this.deps.log.info('a new release key is waiting out its week before it counts', { keys: change.waiting.map((k) => k.slice(0, 60)), tag: signed.tag });
    return change.added.length > 0 || change.revoked.length > 0;
  }

  // The fetched releases other than the tag object `except` (the one kept),
  // named no earlier than `after` (the newest this fork had), that verify
  // and are on upstream's main, oldest first: all of them, as what a check
  // stages is bounded already. By object, not name: a same
  // day's release that replaced a bad one counts too (Gemini's review).
  private async otherReleases(staged: string, signers: string, except: string, after: string): Promise<(SignedTag & { tag: string })[]> {
    const names = [...(await this.refs(staged, STAGED_NS))].filter(([n, ref]) => RELEASE_NAME.test(n) && n >= after && ref.oid !== except).sort(([x], [y]) => (x < y ? 1 : -1));
    const out: (SignedTag & { tag: string })[] = [];
    for (const [n, ref] of names) {
      const signed = await this.verified(staged, ref, TAG_PREFIX + n, signers);
      if (signed && (await this.onUpstreamMain(staged, signed.commit))) out.unshift({ ...signed, tag: TAG_PREFIX + n });
    }
    return out;
  }

  // `file` (a/b/c) as the commit `rev` names has it, read object by object
  // (commit, trees, blob), each one's bytes hashed and checked against its
  // id: so what's read is what the id names whatever the checkout's objects
  // say (Daybreak 180: a signature covers a commit id, and git reads an id
  // through whatever's on disk for it). '' when the commit or the file isn't
  // there (or is a link); throws when an object isn't what its id says.
  private async committedFile(cwd: string, rev: string, file: string): Promise<string> {
    const read = this.deps.gitBytes ?? gitBytes;
    const commit = OBJECT_ID.test(rev) ? rev : await this.git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).catch(() => '');
    if (!commit) return '';
    // An object the commit or a tree names that can't be read, or isn't
    // what its id says, fails the read: taken as no file, a revocation
    // whose blob went missing would just not happen (Codex's review).
    const object = async (type: 'commit' | 'tree' | 'blob', oid: string): Promise<Buffer> => {
      const body = await read(cwd, ['cat-file', type, oid]).catch((e: unknown) => {
        throw new Error(`the ${type} ${oid.slice(0, 12)} can't be read from this checkout's objects, so the release's ${file} can't be (${String(e).slice(0, 120)})`);
      });
      if (!objectIs(type, oid, body)) throw new Error(`the ${type} ${oid.slice(0, 12)} in this checkout's objects isn't the one its id names, so the release's ${file} can't be read`);
      return body;
    };
    const tree = /^tree ([0-9a-f]{40}|[0-9a-f]{64})\n/.exec((await object('commit', commit)).toString('latin1'))?.[1];
    if (!tree) throw new Error(`the commit ${commit.slice(0, 12)} names no tree`);
    let oid = tree;
    const parts = file.split('/');
    for (let i = 0; i < parts.length; i++) {
      const entry = treeEntry(await object('tree', oid), parts[i]!, oid.length / 2);
      const last = i === parts.length - 1;
      // Not there (or a link, or a folder where a file should be): no file.
      if (!entry || !(last ? /^100(644|755)$/.test(entry.mode) : entry.mode === '40000')) return '';
      oid = entry.oid;
    }
    return (await object('blob', oid)).toString('utf8');
  }

  // Whether `commit` is on upstream's main as this check staged it.
  private async onUpstreamMain(staged: string, commit: string): Promise<boolean> {
    if (!(await this.git(staged, ['rev-parse', '--verify', '--quiet', STAGED_MAIN]).then(() => true, () => false))) return false;
    return this.isAncestor(staged, commit, STAGED_MAIN);
  }

  // name (after the namespace) -> the object the ref points at, and its type.
  private async refs(checkout: string, ns: string): Promise<Map<string, Ref>> {
    const out = await this.git(checkout, ['for-each-ref', '--format=%(objectname) %(objecttype) %(objectsize) %(refname)', ns]);
    const map = new Map<string, Ref>();
    for (const line of out.split('\n')) {
      const [oid, type, size, ...rest] = line.split(' ');
      const refname = rest.join(' ');
      if (oid && type && refname.startsWith(ns)) map.set(refname.slice(ns.length), { oid, type, size: Number(size) });
    }
    return map;
  }

  // The newest release in REF_NS that verifies against the pinned key and
  // names itself what it's kept as (so an old signed tag pushed under a
  // newer name can't pass for the newer release), with what main doesn't
  // have. Each is checked again here, by its object id, and the commit is
  // the one its signed text names.
  private async newestSigned(checkout: string, signers: string, staged: string | undefined): Promise<UpstreamRelease | undefined> {
    const refs = [...(await this.refs(checkout, REF_NS))].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));
    for (const [name, ref] of refs) {
      const tag = TAG_PREFIX + name;
      const signed = await this.verified(checkout, ref, tag, signers);
      // Only a ref that turned up since promote took out the rest.
      if (!signed) continue;
      const { commit, date } = signed;
      // Kept by a runner from before this, or upstream's main has moved
      // away from it since: a release only counts while it's on main.
      if (!staged || !(await this.onUpstreamMain(staged, commit))) continue;
      this.newestVerified = { ...signed, tag };
      const range = `refs/heads/main..${commit}`;
      const [count, log, trailers] = await Promise.all([
        this.git(checkout, ['rev-list', '--count', '--no-merges', range]),
        this.git(checkout, ['log', '--no-merges', `--max-count=${MAX_SUBJECTS}`, '--format=%s', range]),
        // One line per commit: its id, then any Important: trailer's text.
        this.git(checkout, ['log', '--no-merges', '--format=%H%x1f%(trailers:key=Important,valueonly,separator=%x20)', range]),
      ]);
      const important = parseImportant(trailers);
      const changes = Number(count) || 0;
      const notes = changes > 0 ? await this.notesSince(checkout, { ...signed, name }, signers, staged) : [];
      return { tag, commit, ...(date ? { date } : {}), changes, subjects: log.split('\n').filter(Boolean), ...(important.length ? { important } : {}), ...(notes.length ? { notes } : {}) };
    }
    return undefined;
  }

  // The notes of each signed release main doesn't have, newest first,
  // stopping at the first one main already has (at most 10). Only the
  // newest is kept in REF_NS (promote), so older ones are read from the
  // staged tags (stageReleases), each verified against the pinned key the
  // same way, and the text comes from the verified bytes, never from a ref
  // git could move. Their history is only in `staged` (whose objects fall
  // back on the checkout's), so that's where it's compared with main's.
  private async notesSince(checkout: string, newest: SignedTag & { name: string }, signers: string, staged: string | undefined): Promise<{ tag: string; date?: string; lines: string[] }[]> {
    const main = await this.git(checkout, ['rev-parse', 'refs/heads/main']);
    const older = [...(staged ? await this.refs(staged, STAGED_NS) : [])]
      .filter(([name]) => RELEASE_NAME.test(name) && name < newest.name)
      .sort(([x], [y]) => (x < y ? 1 : -1))
      .slice(0, 9);
    const out: { tag: string; date?: string; lines: string[] }[] = [];
    const add = (name: string, signed: SignedTag) => {
      const message = signed.payload.toString('utf8');
      const notes = parseNotes(message);
      // A failed model call, or a tag from before notes existed, still
      // describes that release instead of disappearing behind older notes.
      const lines = notes.length ? notes : message.split('\n').filter((l) => l.startsWith('- ')).slice(0, 5).map((l) => l.slice(2).trim().slice(0, 200)).filter(Boolean);
      // The date too, so the app can head each one with its day where the
      // reader is, not Mike's (the name is his day).
      if (lines.length) out.push({ tag: TAG_PREFIX + name, ...(signed.date ? { date: signed.date } : {}), lines });
    };
    add(newest.name, newest);
    for (const [name, ref] of older) {
      const signed = await this.verified(staged!, ref, TAG_PREFIX + name, signers);
      if (!signed || !(await this.isAncestor(staged!, signed.commit, newest.commit))) continue;
      if (await this.isAncestor(staged!, signed.commit, main)) break;
      add(name, signed);
    }
    return out;
  }

  // The tag object `oid`, if it is signed by the pinned key as `tag`.
  // Throws when ssh-keygen can't be run at all, so the check fails and says
  // why rather than calling every release unsigned (and taking them out).
  // An object's bytes never change, so each answer is kept (for the
  // pinned file as it is now): a check reads only tags it hasn't seen.
  // Only answers are kept: git or ssh-keygen failing to run throws, so the
  // check fails and says why, and the tag is read again next time.
  private async verified(checkout: string, ref: Ref, tag: string, signers: string): Promise<SignedTag | undefined> {
    // Not a tag object (a commit or anything else), or one far bigger than
    // any Mike's runner makes, is just not signed: never read.
    const key = this.answerKey(ref, tag, signers);
    if (!readable(ref)) {
      // Remembered too, so stageReleases passes over it next time: twenty
      // oversized tags newer than a real release held every check's places
      // (Codex's review).
      if (ref.type && ref.size > 0) this.remember(key, null);
      return undefined;
    }
    if (this.answers.has(key)) return this.answers.get(key) ?? undefined;
    const raw = await (this.deps.gitBytes ?? gitBytes)(checkout, ['cat-file', 'tag', ref.oid]);
    const split = splitSignedTag(raw, tag);
    let signed = split && (await sshVerified(split, signers, revokedPath(this.deps.home))) ? split : undefined;
    // A weekly key's release must have the key files its authority vouched
    // for (KEYS_EXTENSION); an object that can't be read fails it for now.
    let forNow = false;
    if (signed && !(await this.keysVouched(checkout, signed).catch(() => ((forNow = true), false)))) signed = undefined;
    // A weekly key's tag dated ahead of this clock fails only for now too.
    // Every other failure is remembered, so tags that will never verify
    // don't hold every check's places (Codex's and Gemini's reviews).
    if (!signed && split && signedWithCert(split.signature)) {
      const name = /\ntag ([^\n]+)\n/.exec(split.payload.toString('latin1'))?.[1] ?? '';
      if (!certVerifyArgs(name, split.date) && certVerifyArgs(name, split.date, Date.parse('9999-12-31T00:00:00Z'))) forNow = true;
    }
    if (!forNow) this.remember(key, signed ?? null);
    return signed;
  }

  // Whether a release has the key files its signature vouches for: always
  // for the release key's own; for a weekly key's, those whose hash its
  // certificate carries.
  private async keysVouched(cwd: string, signed: SignedTag): Promise<boolean> {
    if (!signedWithCert(signed.signature)) return true;
    const want = signatureCert(signed.signature)?.keys;
    if (!want) return false;
    const [s, r] = await Promise.all([this.committedFile(cwd, signed.commit, SIGNERS_FILE), this.committedFile(cwd, signed.commit, REVOKED_FILE)]);
    return keyFilesHash(s, r) === want;
  }

  private remember(key: string, answer: SignedTag | null): void {
    if (this.answers.size >= MAX_ANSWERS) this.answers.delete(this.answers.keys().next().value!);
    this.answers.set(key, answer);
  }

  private answered(ref: Ref, tag: string, signers: string): boolean {
    return !readable(ref) || this.answers.has(this.answerKey(ref, tag, signers));
  }

  private answerKey(ref: Ref, tag: string, signers: string): string {
    return `${this.signersHash(signers)} ${ref.oid} ${tag}`;
  }

  // The pinned keys and the revoked ones: an answer holds for both as they are.
  private signersHash(signers: string): string {
    const revoked = (() => {
      try {
        return fs.readFileSync(revokedPath(this.deps.home));
      } catch {
        return Buffer.alloc(0);
      }
    })();
    let weekly = Buffer.alloc(0);
    try {
      weekly = fs.readFileSync(weeklyRevokedPath(this.deps.home));
    } catch {
      // none revoked
    }
    return createHash('sha256').update(fs.readFileSync(signers)).update('\0').update(revoked).update('\0').update(weekly).digest('hex');
  }

  // Mike's runner: tags main's tip as today's release when it's moved since
  // the last one and has settled (above). Returns the tag it made.
  // `now` is Mike asking for it (`tb updates publish`): it doesn't wait for
  // main or the runner to sit still for an hour, and asks for Touch ID
  // straight away, as he's at the Mac to ask. GitHub's checks still decide
  // which commit goes: the tip if it's green, or else the newest one that
  // is (newestGreen). Added 25 Nov 2026, when a busy main kept a signed
  // release from going out for three days.
  publishOnce(opts: { now?: boolean } = {}): Promise<string | undefined> {
    // The hourly look and Mike's ask never tag at once.
    const run = (this.publishing ?? Promise.resolve()).catch(() => undefined).then(() => this.publishNow(opts));
    this.publishing = run;
    return run;
  }

  private publishing?: Promise<unknown>;

  private async publishNow({ now: asked = false }: { now?: boolean }): Promise<string | undefined> {
    const { checkout, publish } = this.deps;
    if (!checkout || !publish?.publish) return undefined;
    if (!publish.signingKey || !fs.existsSync(publish.signingKey)) {
      this.deps.log.warn('releases.publish is on but releases.signingKey is missing', { signingKey: publish.signingKey });
      return undefined;
    }
    this.renewMissed = false;
    if (publish.delegate && touchKey(publish.signingKey)) {
      await this.keepDelegate(checkout, asked).catch((e: unknown) => {
        this.deps.log.warn('could not look after the weekly release key', { error: String(e).slice(0, 200) });
        this.set({ ...this.st, weeklyKey: { ...this.st.weeklyKey, error: String((e as Error).message ?? e).slice(0, 200) } });
      });
    }
    if (!asked && !(this.deps.runningMainSettled?.() ?? false)) return undefined;
    const now = this.deps.clock.now();
    const tip = await this.git(checkout, ['rev-parse', 'refs/heads/main']);
    const committed = Number(await this.git(checkout, ['log', '-1', '--format=%ct', tip])) * 1000;
    if (!asked && now - committed < SETTLE_MS) return undefined;
    // What it tags and signs is read as its ids name it, or not at all.
    const substituted = await this.substitutes(checkout);
    if (substituted) {
      this.hold({ commit: tip, why: substituted, at: new Date(now).toISOString() });
      return undefined;
    }
    // origin's address as configured, given to git as a URL (fetchableUrl).
    const origin = this.url(await this.configuredUrl(checkout, 'origin'));
    if (!origin) {
      this.hold({ commit: tip, why: "origin's address (remote.origin.url) isn't an https or ssh one, so releases aren't pushed to it", at: new Date(now).toISOString() });
      return undefined;
    }
    this.origin = origin;
    // Tags made on another Mac, or by hand, count too.
    try {
      await this.git(checkout, ['fetch', '-q', '--no-tags', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', this.uploadPack, origin, `+refs/tags/${TAG_PREFIX}*:refs/tags/${TAG_PREFIX}*`], this.remote({ owner: true, timeoutMs: this.fetchTimeoutMs }));
    } catch (e) {
      // Said where it's seen (a checkout whose config release git won't
      // run with), as well as logged.
      this.hold({ commit: tip, why: `couldn't fetch the release tags from origin: ${String((e as Error).message ?? e).slice(0, 200)}`, at: new Date(now).toISOString() });
      throw e;
    }
    const tag = tagFor(new Date(now));
    // Only tags GitHub has are releases: one made here and never pushed (its
    // push failed, or it didn't verify and couldn't be deleted, perhaps
    // before a restart) would otherwise pass for today's, then the last.
    const pushed = new Set((await this.git(checkout, ['ls-remote', '--refs', this.uploadPack, origin, `refs/tags/${TAG_PREFIX}*`], this.remote({ owner: true, timeoutMs: this.fetchTimeoutMs })))
      .split('\n').map((l) => l.split('\t')[1]?.slice('refs/tags/'.length)).filter(Boolean));
    const local = (await this.git(checkout, ['tag', '--list', '--sort=-refname', `${TAG_PREFIX}*`])).split('\n').filter(Boolean);
    // Named as forks take them (RELEASE_NAME): a release/latest isn't one.
    const tags = local.filter((t) => pushed.has(t) && RELEASE_NAME.test(t.slice(TAG_PREFIX.length)));
    this.pushedTags = new Set(tags);
    if (tags.includes(tag)) return this.hold(undefined);
    if (local.includes(tag)) {
      const oid = await this.git(checkout, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).catch(() => '');
      if (oid && !(await this.dropTag(checkout, tag, oid))) {
        this.hold({ commit: tip, why: `today's tag ${tag} was made here but never pushed, and it can't be deleted (git tag -d ${tag})`, at: new Date(now).toISOString() });
        return undefined;
      }
    }
    const last = tags[0];
    // Nothing new since the last release: unless it was a weekly key's and
    // that key's week ends within SIGN_MARGIN_MS, when the same commit goes
    // out again under today's name, so a fork that missed it still has one
    // it can take (Codex's and Gemini's reviews).
    // Only main's tip itself, never one behind it (a tag made on another
    // Mac): that would take forks back (Gemini's review).
    if (last && (await this.isAncestor(checkout, tip, last))) {
      const same = tip === (await this.git(checkout, ['rev-parse', `refs/tags/${last}^{commit}`]).catch(() => ''));
      if (!same || !(await this.lastLapsing(checkout, last, now))) return this.hold(undefined);
    }
    const why = await this.checksSay(checkout, tip);
    // The tip held by a red check: the newest settled commit since the last
    // release that's green on everything goes out instead (newestGreen).
    // Not the last release's commit again while main is red: that would trust
    // a tag nobody checked here, and could take today's name from a commit
    // about to go green (Codex's and Gemini's reviews, 25 Nov 2026).
    const target = !why ? tip : this.lastSaid ? await this.newestGreen(checkout, tip, last, now, asked ? 0 : SETTLE_MS).catch(() => undefined) : undefined;
    if (why && !target) {
      this.hold({ commit: tip, why, at: new Date(now).toISOString() });
      return undefined;
    }
    if (why) this.deps.log.info('main is held, so the newest commit green on everything goes out', { tip, commit: target, why });
    this.hold(undefined);
    return this.tagRelease(checkout, target!, last, tag, now, asked);
  }

  // Tags `tip` as today's release `tag`, signed, and pushes it.
  private async tagRelease(checkout: string, tip: string, last: string | undefined, tag: string, now: number, asked = false): Promise<string | undefined> {
    const { publish } = this.deps;
    if (!publish?.signingKey) return undefined;

    const range = last ? `${last}..${tip}` : tip;
    const subjects = (await this.git(checkout, ['log', '--no-merges', '--format=- %s', range, '--max-count=200'])).trim();
    // Important commits lead the message, so the release says so wherever
    // it's read (forks find them from the commits' trailers themselves).
    const important = parseImportant(await this.git(checkout, ['log', '--no-merges', '--format=%H%x1f%(trailers:key=Important,valueonly,separator=%x20)', last ? `${last}..${tip}` : tip, '--max-count=200']));
    const lead = important.length ? [...new Set(important.map((i) => i.why))].map((w) => `Important: ${w}`).join('\n') + '\n\n' : '';
    const notes = await this.notesFor(checkout, range);
    const whatsNew = notes.length ? `${NOTES_HEADING}\n${notes.map((n) => `- ${n}`).join('\n')}\n\n` : '';
    const message = `Threadbear ${tag.slice(TAG_PREFIX.length)}\n\n${lead}${whatsNew}${CHANGES_HEADING}\n${subjects}\n`;
    const file = path.join(this.deps.home, 'runner', 'release-tag-message.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, message);
    // A Secure Enclave key asks for Touch ID on every signature (security
    // review finding 3, 9 Nov 2026): tried only while Mike is at the Mac,
    // given TOUCH_SIGN_TIMEOUT_MS, and held for the next hourly look if he
    // doesn't touch it. Nothing waits on it but this look.
    // Or the weekly key, when it has time left and the last release has
    // the check that takes it, so forks on that release already do.
    // Mike asking (tb updates publish) doesn't wait: the release key signs.
    const maybe = await this.weeklyKey(checkout, tip, last, tag, now);
    if (maybe === 'later' && !asked) {
      this.hold({ commit: tip, why: "waiting for UTC's day to be today's, so the weekly key can sign it", at: new Date(now).toISOString() });
      return undefined;
    }
    const weekly = maybe === 'later' ? undefined : maybe;
    const touch = !weekly && touchKey(publish.signingKey);
    if (touch && !asked && !(await (this.deps.atMac?.() ?? Promise.resolve(false)))) {
      this.hold({ commit: tip, why: 'waiting for you at the Mac to sign it with Touch ID', at: new Date(now).toISOString() });
      return undefined;
    }
    // Touch ID was just asked for, to renew the weekly key, and not given:
    // not straight away again for the release.
    if (touch && this.renewMissed) {
      this.hold({ commit: tip, why: "Touch ID wasn't given to renew the weekly key; it asks again next hour", at: new Date(now).toISOString() });
      return undefined;
    }
    try {
      // A weekly key's tag is dated by the same clock that named it: forks
      // check the certificate at that time, on that day (certVerifyArgs).
      await this.git(checkout, ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${weekly ?? publish.signingKey}`, 'tag', '-s', '-F', file, tag, tip],
        weekly ? { owner: true, env: { SSH_AUTH_SOCK: '', GIT_COMMITTER_DATE: `${Math.floor(now / 1000)} +0000` } } : touch ? { owner: true, timeoutMs: TOUCH_SIGN_TIMEOUT_MS, env: { SSH_SK_PROVIDER: publish.signingProvider ?? MAC_SK_PROVIDER } } : { owner: true });
    } catch (e) {
      if (!touch) throw e;
      await this.git(checkout, ['tag', '-d', tag]).catch(() => undefined);
      this.hold({ commit: tip, why: `Touch ID wasn't given for its signature (it waits ${Math.round(TOUCH_SIGN_TIMEOUT_MS / 1000)} s); it asks again next hour`, at: new Date(now).toISOString() });
      this.deps.log.info('release signature not given; asking again next hour', { tag, error: String(e).slice(0, 200) });
      return undefined;
    }
    // Checked as a fork checks it before it goes anywhere: on 19 Nov 2026
    // the Secure Enclave handed back a signature with nothing in it (empty
    // r and s), git called that signed, and release/2026-11-19 went out
    // verifying nowhere. The object checked is the one pushed, by its id.
    const oid = await this.git(checkout, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).catch(() => '');
    const bad = !oid ? 'the tag was not there to check' : await this.selfCheck(checkout, tag, oid, tip, last, now).catch((e: unknown) => `ssh-keygen couldn't check it (${String(e).slice(0, 120)})`);
    if (bad) {
      const dropped = !oid || (await this.dropTag(checkout, tag, oid));
      this.hold({ commit: tip, why: `its signature didn't verify, so it wasn't pushed: ${bad}${dropped ? '' : ` (its local tag couldn't be deleted yet; the next look tries again)`}`, at: new Date(now).toISOString() });
      this.deps.log.warn('release signature does not verify; not pushed', { tag, commit: tip, why: bad, tagDeleted: dropped });
      return undefined;
    }
    this.hold(undefined);
    try {
      await this.git(checkout, ['push', '-q', '--no-recurse-submodules', RECEIVE_PACK, this.origin!, `${oid}:refs/tags/${tag}`], this.remote({ owner: true, timeoutMs: this.fetchTimeoutMs }));
    } catch (e) {
      // Taken back, so the next look tries the push again.
      await this.dropTag(checkout, tag, oid);
      throw e;
    }
    this.deps.log.info('tagged a release', { tag, commit: tip });
    this.set({ ...this.st, published: { tag, at: new Date(now).toISOString() } });
    return tag;
  }

  // The weekly key's certificate file to sign with (release-delegate.ts),
  // or undefined to sign with the release key itself.
  // Not for a release whose key files its certificate doesn't vouch for
  // (a key change since it was made): then it's renewed, with a touch.
  // Nor while this Mac's day isn't UTC's (Perth's first eight hours): forks
  // take a weekly key's tag only on the UTC day its name says.
  // 'later' then, when the weekly key could otherwise sign.
  private async weeklyKey(checkout: string, tip: string, last: string | undefined, tag: string, now: number): Promise<string | 'later' | undefined> {
    const { publish, home } = this.deps;
    if (!publish?.delegate || !publish.signingKey || !last) return undefined;
    const utcDay = tag === `${TAG_PREFIX}${new Date(now).toISOString().slice(0, 10)}`;
    const read = (rev: string, file: string) => this.committedFile(checkout, rev, file).catch(() => undefined);
    const [signersAt, revoked, forks] = await Promise.all([read(tip, SIGNERS_FILE), read(tip, REVOKED_FILE), read(`refs/tags/${last}`, 'runner/src/release-keys.ts')]);
    if (signersAt === undefined || revoked === undefined || !forks?.includes(KEYS_EXTENSION)) return undefined;
    const cert = usableCert(home, publish.signingKey, signersAt, revoked);
    if (!cert || cert.validAfter > now || cert.validBefore - now < SIGN_MARGIN_MS) return undefined;
    return utcDay ? delegatePaths(home).cert : 'later';
  }

  // Renews the weekly key when it's near its end and Mike is at the Mac
  // (or asked, with tb updates publish), at most once an hour; and when
  // it's nearer still, starts a starred thread so he can't miss it.
  private lastRenewTry = 0;
  private renewMissed = false;
  private async keepDelegate(checkout: string, asked: boolean): Promise<void> {
    const { publish, home, clock, log } = this.deps;
    if (!publish?.signingKey) return;
    const now = clock.now();
    const [signers, revoked] = await Promise.all([this.committedFile(checkout, 'refs/heads/main', SIGNERS_FILE), this.committedFile(checkout, 'refs/heads/main', REVOKED_FILE)]);
    const had = usableCert(home, publish.signingKey, signers, revoked);
    let left = (had?.validBefore ?? 0) - now;
    let error: string | undefined;
    if (left < RENEW_AHEAD_MS && (asked || now - this.lastRenewTry >= 60 * 60_000) && (asked || (await (this.deps.atMac?.() ?? Promise.resolve(false))))) {
      this.lastRenewTry = now;
      try {
        const c = await renewDelegate({ home, signingKey: publish.signingKey, provider: publish.signingProvider ?? MAC_SK_PROVIDER, signers, revoked, now, timeoutMs: TOUCH_SIGN_TIMEOUT_MS });
        left = c.validBefore - now;
        log.info('renewed the weekly release key', { until: new Date(c.validBefore).toISOString() });
      } catch (e) {
        error = String((e as Error).message ?? e).slice(0, 200);
        this.renewMissed = true;
        log.info('the weekly release key was not renewed', { error });
      }
    }
    this.set({ ...this.st, weeklyKey: { ...(left > 0 ? { until: new Date(now + left).toISOString() } : {}), ...(error ? { error } : {}) } });
    if (left >= REMIND_AHEAD_MS || !this.deps.remind) return;
    const state = readDelegateState(home);
    if (state.remindThread && this.deps.isOpen?.(state.remindThread)) return;
    const until = left > 0 ? `runs out ${new Date(now + left).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : 'has run out';
    const id = this.deps.remind({
      title: 'Renew the release signing key',
      why: 'the weekly key that signs releases needs your Touch ID',
      text: `The weekly key that signs Threadbear's daily releases ${until}, and the Mac hasn't caught Mike there to renew it. Until it's renewed, each release waits for his Touch ID.

Don't run anything yet: the renewal pops up a Touch ID prompt that only works while he's at the Mac. End your turn with one ask: "Renew the release signing key now? Press Touch ID when it pops up", options "Renew now" and "Later". When he says to, run \`tb updates publish\` (it renews the key first, then puts out today's release if one is due) and tell him in a line whether it worked; if the key was renewed, archive this thread.`,
    });
    writeDelegateState(home, { remindThread: id });
    log.info('started a thread to renew the weekly release key', { threadId: id });
  }

  // Whether the release `last` was signed by a weekly key whose week ends
  // within SIGN_MARGIN_MS (or has), on Mike's runner with releases.delegate.
  private async lastLapsing(checkout: string, last: string, now: number): Promise<boolean> {
    if (!this.deps.publish?.delegate) return false;
    const raw = await (this.deps.gitBytes ?? gitBytes)(checkout, ['cat-file', 'tag', `refs/tags/${last}`]).catch(() => undefined);
    const cert = raw ? signatureCert(splitSignedTag(raw, last)?.signature ?? '') : undefined;
    return Boolean(cert && cert.validBefore - now < SIGN_MARGIN_MS);
  }

  // Deletes the local tag if it's still `oid`. One left behind isn't on
  // GitHub, so the next look doesn't count it and tries again (publishOnce).
  private async dropTag(checkout: string, tag: string, oid: string): Promise<boolean> {
    for (let i = 0; i < 2; i++) {
      if (await this.git(checkout, ['update-ref', '-d', `refs/tags/${tag}`, oid]).then(() => true, () => false)) return true;
    }
    this.deps.log.error('could not delete an unpushed release tag', { tag, oid });
    return false;
  }

  // Why the tag object `oid` wouldn't count as `tag` for a fork, or
  // undefined if it would: the same size limit, split and ssh-keygen check
  // as verified(), on the commit it was made for. The keys are what forks
  // hold: those in release-signers at the commit, and at the newest release
  // a day older than ADD_DELAY_MS (the wait before an announced key counts),
  // or the oldest release when none is; revoked are those the last
  // release revoked, as a release that revokes its own key must still go
  // out for forks to take the revocation in.
  private async selfCheck(checkout: string, tag: string, oid: string, tip: string, last: string | undefined, now: number): Promise<string | undefined> {
    const size = Number(await this.git(checkout, ['cat-file', '-s', oid]));
    if (!(size > 0 && size <= MAX_TAG_BYTES)) return `the tag is ${size} bytes, more than forks read`;
    const raw = await (this.deps.gitBytes ?? gitBytes)(checkout, ['cat-file', 'tag', oid]);
    const split = splitSignedTag(raw, tag);
    if (!split) return 'the tag is not one SSH-signed release tag';
    if (split.commit !== tip) return `the tag names ${split.commit.slice(0, 8)}, not ${tip.slice(0, 8)}`;
    if (!(await this.keysVouched(checkout, split))) return "its weekly key's certificate doesn't vouch for the key files at that commit";
    const signers = await this.committedFile(checkout, tip, SIGNERS_FILE);
    if (!keysIn(signers).length) return `${SIGNERS_FILE} has no keys at that commit`;
    const signer = signerKey(split.signature);
    const settled = await this.settledRelease(checkout, now);
    if (settled && signer && !keysIn(await this.committedFile(checkout, `refs/tags/${settled}`, SIGNERS_FILE)).includes(signer)) {
      return `its key wasn't in ${SIGNERS_FILE} at ${settled}, so forks don't take it yet`;
    }
    const revoked = last ? keysIn(await this.committedFile(checkout, `refs/tags/${last}`, REVOKED_FILE)) : [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-release-self-'));
    try {
      const signersFile = path.join(dir, 'signers');
      const revokedFile = path.join(dir, 'revoked');
      fs.writeFileSync(signersFile, signers.endsWith('\n') ? signers : `${signers}\n`);
      if (revoked.length) fs.writeFileSync(revokedFile, revoked.join('\n') + '\n');
      return (await sshVerified(split, signersFile, revoked.length ? revokedFile : undefined)) ? undefined : `ssh-keygen says it isn't good for any key in ${SIGNERS_FILE}`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // The newest release tag dated a day more than ADD_DELAY_MS ago (forks
  // look every six hours, and a Mac sleeps), or else the oldest there is.
  private async settledRelease(checkout: string, now: number): Promise<string | undefined> {
    const lines = (await this.git(checkout, ['for-each-ref', '--sort=-taggerdate', '--format=%(refname:lstrip=2)%09%(taggerdate:unix)', `refs/tags/${TAG_PREFIX}*`])).split('\n');
    let oldest: string | undefined;
    for (const line of lines) {
      const [name, at] = line.split('\t');
      if (!name || !(Number(at) > 0) || !this.pushedTags.has(name)) continue;
      if (Number(at) * 1000 <= now - ADD_DELAY_MS - 24 * 60 * 60_000) return name;
      oldest = name;
    }
    // None that old: the first release's keys are the ones forks pinned.
    return oldest;
  }

  // Plain-words notes for a release, from its commits' subjects and bodies.
  private async notesFor(checkout: string, range: string): Promise<string[]> {
    if (!this.deps.writeNotes) return [];
    // The full log keys a draft to the exact input, even if a tag moved.
    const log = await this.git(checkout, ['log', '--no-merges', '--format=%s%n%b%x1e', range, '--max-count=200']);
    const key = createHash('sha256').update(log).digest('hex');
    if (this.noteDraft?.key === key) return this.noteDraft.lines;
    let lines: string[] = [];
    try {
      // Each commit's body cut short, so a busy day's last commits still fit.
      const commits = log.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => (c.length > 600 ? `${c.slice(0, 600)}…` : c));
      lines = cleanNotes(await this.deps.writeNotes(commits.join('\n---\n').slice(0, 60_000)));
    } catch (e) {
      this.deps.log.warn('could not write release notes; tagging without them', { error: String(e) });
    }
    // Signing or pushing can fail. Retry those without paying for the same
    // notes again; a failed model call is cached as the subject fallback.
    this.noteDraft = { key, lines };
    return lines;
  }

  // GitHub only runs its checks on a main that's been pushed, and nothing
  // else pushes it: tb land never does, and on 7 Nov the first gated
  // release sat behind a main three commits ahead of GitHub's. So a main
  // that has settled here goes up first (fast-forward only), and its
  // checks are looked at on the next hourly look. Returns why it's held.
  private async pushMain(checkout: string, tip: string): Promise<string | undefined> {
    await this.git(checkout, ['fetch', '-q', '--no-tags', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', this.uploadPack, this.origin!, '+refs/heads/main:refs/remotes/origin/main'], this.remote({ owner: true, timeoutMs: this.fetchTimeoutMs }));
    const theirs = await this.git(checkout, ['rev-parse', 'refs/remotes/origin/main']).catch(() => '');
    if (theirs === tip || (theirs && (await this.isAncestor(checkout, tip, theirs)))) return undefined;
    if (theirs && !(await this.isAncestor(checkout, theirs, tip))) return "main here and GitHub's main have gone different ways";
    await this.git(checkout, ['push', '-q', '--no-recurse-submodules', RECEIVE_PACK, this.origin!, `${tip}:refs/heads/main`], this.remote({ owner: true, timeoutMs: this.fetchTimeoutMs }));
    this.deps.log.info('pushed main for its checks', { commit: tip });
    return 'just pushed main to GitHub, so its checks have only started';
  }

  // Why GitHub's checks hold this commit back, or undefined when they
  // don't. A main with no workflows has nothing to wait for. One that has
  // them waits for them, and is held when they can't be read: a release
  // that can wait a day is better than one that doesn't build.
  private async checksSay(checkout: string, tip: string): Promise<string | undefined> {
    this.lastSaid = false;
    const workflows = (await this.git(checkout, ['ls-tree', '--name-only', tip, '.github/workflows/'])).split('\n').filter((f) => /\.ya?ml$/.test(f));
    if (!workflows.length) return undefined;
    // The URL as configured, not as an insteadOf rewrites it for fetching.
    const key = repoKey(this.origin ?? '');
    if (!key.startsWith('github.com/')) return "origin isn't on GitHub, so its checks can't be read";
    const pushed = await this.pushMain(checkout, tip);
    if (pushed) return pushed;
    const repo = key.slice('github.com/'.length);
    try {
      const runs = await (this.deps.ciRuns ?? githubRuns)(repo, tip);
      const said = ciVerdict(runs);
      this.lastSaid = Boolean(said);
      if (said) return said;
      const ran = new Set(runs.map((r) => r.file));
      const quiet = workflows.filter((f) => !ran.has(f));
      if (!quiet.length) return undefined;
      // Every commit the tip has, however far back: a workflow whose paths
      // nothing touches (the frozen Swift app's) can go thousands of
      // commits without a run.
      const has = new Set((await this.git(checkout, ['rev-list', tip])).split('\n').filter(Boolean));
      const held: string[] = [];
      for (const file of quiet) {
        const why = earlierVerdict(await (this.deps.ciHistory ?? githubWorkflowRuns)(repo, file), has);
        if (why) held.push(why);
      }
      this.lastSaid = held.length > 0;
      return held.length ? held.join('; ') : undefined;
    } catch (e) {
      return `couldn't read GitHub's checks (${String(e)})`;
    }
  }

  // Whether checksSay's last answer came from GitHub's runs (a red, running
  // or cancelled check), not from main being just pushed, gone another way,
  // or GitHub not answering: only then is an older commit looked for.
  private lastSaid = false;

  // The newest commit since `last` (main's first-parent line, the tip left
  // out) that is as safe to hand on as a green tip: an hour old, the head of
  // a push GitHub ran checks on, and every workflow in it green by the same
  // rule as the tip's (earlierVerdict: its run on that commit, or for one
  // its paths didn't set off, its last finished run on a commit it has).
  // A commit inside a push isn't one: nothing ran on its changes alone.
  // Without this one red push held every release: none went out from 16 to
  // 19 Nov while Windows failed on main, with green commits in between.
  // It's the same bar the Xcode 26 lesson set (release/2026-11-04 to -06
  // went out unchecked), only on an older commit. One GitHub request a
  // workflow, as the hourly look's are counted (60 an hour without a token).
  private async newestGreen(checkout: string, tip: string, last: string | undefined, now: number, settle = SETTLE_MS): Promise<string | undefined> {
    const key = repoKey(this.origin ?? '');
    if (!key.startsWith('github.com/')) return undefined;
    const repo = key.slice('github.com/'.length);
    const line = (await this.git(checkout, ['log', '--first-parent', `--max-count=${GREEN_LOOKBACK}`, '--format=%H %ct', tip, ...(last ? [`^${last}`] : [])]))
      .split('\n')
      .map((l) => l.trim().split(' '))
      .filter((p): p is [string, string] => p.length === 2 && p[0] !== tip)
      .filter(([, ct]) => now - Number(ct) * 1000 >= settle);
    if (!line.length) return undefined;
    const histories = new Map<string, CiRun[]>();
    const historyOf = async (file: string) => {
      let h = histories.get(file);
      if (!h) histories.set(file, (h = await (this.deps.ciHistory ?? githubWorkflowRuns)(repo, file)));
      return h;
    };
    const tipHas = new Set((await this.git(checkout, ['rev-list', tip])).split('\n').filter(Boolean));
    const files = (await this.git(checkout, ['ls-tree', '--name-only', tip, '.github/workflows/'])).split('\n').filter((f) => /\.ya?ml$/.test(f));
    for (const f of files) await historyOf(f);
    const ranOn = new Set([...histories.values()].flat().map((r) => r.sha).filter(Boolean));
    for (const [sha] of line) {
      if (!ranOn.has(sha)) continue;
      const mine = (await this.git(checkout, ['ls-tree', '--name-only', sha, '.github/workflows/'])).split('\n').filter((f) => /\.ya?ml$/.test(f));
      const after = new Set((await this.git(checkout, ['rev-list', `${sha}..${tip}`])).split('\n').filter(Boolean));
      const has = new Set([...tipHas].filter((c) => !after.has(c)));
      let green = true;
      for (const f of mine) {
        if (earlierVerdict(await historyOf(f), has)) {
          green = false;
          break;
        }
      }
      if (green) return sha;
    }
    return undefined;
  }

  // Says (or stops saying) why today's release is waiting, logging only a
  // change, as this runs every hour.
  private hold(held: UpstreamStatus['held']): undefined {
    const was = this.st.held;
    if (held && (was?.commit !== held.commit || was.why !== held.why)) this.deps.log.info('holding back a release', { commit: held.commit, why: held.why });
    if (!held && !was) return undefined;
    this.set({ ...this.st, held });
    return undefined;
  }

  private async isAncestor(checkout: string, a: string, b: string): Promise<boolean> {
    try {
      await this.git(checkout, ['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch {
      return false;
    }
  }

  private set(next: UpstreamStatus): UpstreamStatus {
    // published and held belong to publishOnce: a check's state leaves them
    // be (held goes only when publishOnce sets it, to undefined).
    const keep = {
      ...(this.deps.checkout ? { checkout: this.deps.checkout } : {}),
      ...(this.st.published && !next.published ? { published: this.st.published } : {}),
      ...(this.st.held && !('held' in next) ? { held: this.st.held } : {}),
      ...(this.st.weeklyKey && !('weeklyKey' in next) ? { weeklyKey: this.st.weeklyKey } : {}),
    };
    // A failed or in-progress check keeps the last release it knew of.
    const release = next.release ?? (next.state === 'checking' || next.state === 'failed' ? this.st.release : undefined);
    const st: UpstreamStatus = { ...next, ...keep, ...(release ? { release } : {}) };
    const changed = JSON.stringify(st) !== JSON.stringify(this.st);
    this.st = st;
    if (changed) this.deps.onChange?.();
    return this.status();
  }
}

export type SignedTag = { payload: Buffer; signature: string; commit: string; date?: string };

// A tag object's raw bytes, as `git cat-file tag` gives them: exact, as the
// signature covers every byte.
export function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  return runGit(cwd, args, {});
}

const SSH_BEGIN = '-----BEGIN SSH SIGNATURE-----\n';
const SSH_BLOCK = /^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]{1,76}\n){1,64}-----END SSH SIGNATURE-----\n$/;
const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// A release tag split into the text it signs and its signature, or
// undefined unless it is exactly what Mike's runner makes: the four tag
// headers in git's order (object, a commit, `tag` naming this release,
// tagger), a message, and one SSH signature at the end. Any other armor
// (PGP, X.509, a second block) fails, so there's nothing for git or gpg to
// pick a different verifier from. Armor counts where git looks for it, at
// the start of a line. publishOnce prefixes notes and commit subjects
// with "- ", so text mentioning armor cannot introduce a signature block.
export function splitSignedTag(raw: Buffer, tag: string): SignedTag | undefined {
  // latin1 keeps one char per byte, so offsets are byte offsets.
  const text = raw.toString('latin1');
  const lines = text.split('\n');
  if (lines.filter((l) => l.startsWith('-----BEGIN ')).length !== 1 || lines.filter((l) => l.startsWith('-----END ')).length !== 1) return undefined;
  const at = text.indexOf('\n' + SSH_BEGIN);
  if (at < 0) return undefined;
  const signature = text.slice(at + 1);
  if (!SSH_BLOCK.test(signature)) return undefined;
  const payload = text.slice(0, at + 1);
  const headEnd = payload.indexOf('\n\n');
  const head = (headEnd < 0 ? payload.slice(0, -1) : payload.slice(0, headEnd)).split('\n');
  if (head.length !== 4) return undefined;
  const [object, type, name, tagger] = head;
  const commit = object.startsWith('object ') ? object.slice('object '.length) : '';
  if (!OBJECT_ID.test(commit) || type !== 'type commit' || name !== `tag ${tag}` || !tagger.startsWith('tagger ')) return undefined;
  const when = / (\d{1,12}) [+-]\d{4}$/.exec(tagger);
  const date = when ? new Date(Number(when[1]) * 1000).toISOString() : undefined;
  return { payload: Buffer.from(payload, 'latin1'), signature, commit, ...(date ? { date } : {}) };
}

// Whether `body` is the git object `oid` of `type`: its id is the hash of
// "<type> <size>\0" and its bytes (SHA-1, or SHA-256 for a 64-digit id).
export function objectIs(type: string, oid: string, body: Buffer): boolean {
  if (!OBJECT_ID.test(oid)) return false;
  return createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`${type} ${body.length}\0`).update(body).digest('hex') === oid;
}

// The entry `name` in a tree object's bytes: "<mode> <name>\0<id bytes>",
// one after another.
export function treeEntry(tree: Buffer, name: string, idBytes: number): { mode: string; oid: string } | undefined {
  const want = Buffer.from(name, 'utf8');
  let i = 0;
  while (i < tree.length) {
    const sp = tree.indexOf(0x20, i);
    const nul = sp < 0 ? -1 : tree.indexOf(0, sp + 1);
    if (nul < 0 || nul + 1 + idBytes > tree.length) return undefined;
    if (tree.subarray(sp + 1, nul).equals(want)) return { mode: tree.toString('latin1', i, sp), oid: tree.subarray(nul + 1, nul + 1 + idBytes).toString('hex') };
    i = nul + 1 + idBytes;
  }
  return undefined;
}

// A release tag, kept as REF_NS<name> or a release/<name> tag, if it's
// what sweep and newestSigned would believe: a tag object no bigger than
// Mike's runner makes, signed by the pinned key as release/<name>. For
// readers outside a check (tb checkup), as a ref may have turned up since
// the last sweep. Read with replacement objects off, as a refs/replace/
// entry could put other bytes in its place. Undefined for anything else,
// with no key pinned, or when ssh-keygen can't be run.
export async function verifiedRelease(checkout: string, home: string, name: string, ref: { oid: string; type: string; size: number }): Promise<SignedTag | undefined> {
  const signers = signersPath(home);
  if (!RELEASE_NAME.test(name) || !readable(ref) || !fs.existsSync(signers)) return undefined;
  try {
    const raw = await runGit(checkout, ['cat-file', 'tag', ref.oid], { env: { GIT_NO_REPLACE_OBJECTS: '1' } });
    const split = splitSignedTag(raw, TAG_PREFIX + name);
    if (!split || !(await sshVerified(split, signers, revokedPath(home)))) return undefined;
    if (signedWithCert(split.signature)) {
      const file = (f: string) => runGit(checkout, ['cat-file', 'blob', `${split.commit}:${f}`], { env: { GIT_NO_REPLACE_OBJECTS: '1' } }).then((b) => b.toString('utf8'), () => '');
      const [s, r] = await Promise.all([file(SIGNERS_FILE), file(REVOKED_FILE)]);
      if (keyFilesHash(s, r) !== signatureCert(split.signature)?.keys) return undefined;
    }
    return split;
  } catch {
    return undefined;
  }
}

// Whether ssh-keygen finds the signature good for the `git` namespace, by a
// key in the pinned allowed-signers file (what `git verify-tag` does for an
// SSH signature, without git choosing the verifier).
async function sshVerified(signed: SignedTag, signers: string, revoked?: string): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-release-sig-'));
  try {
    const sig = path.join(dir, 'tag.sig');
    fs.writeFileSync(sig, signed.signature, { mode: 0o600 });
    // A weekly key's certificate (release-keys.ts, "Releases signed by a
    // weekly key"): checked at the time the tag was made, which has to be
    // the day its name says; the pinned keys count as its authority too.
    let when: string[] = [];
    let allowed = signers;
    if (signedWithCert(signed.signature)) {
      const cert = signatureCert(signed.signature);
      if (!cert) return false;
      const name = /\ntag ([^\n]+)\n/.exec(signed.payload.toString('latin1'))?.[1] ?? '';
      const args = certVerifyArgs(name, signed.date);
      if (!args) return false;
      when = args;
      // A revoked weekly key, by the key it certifies only (never the
      // authority's, as ssh-keygen's -r would: Codex's and Gemini's reviews).
      const weekly = revoked ? `${revoked}-weekly` : undefined;
      if (weekly && fs.existsSync(weekly) && keysIn(fs.readFileSync(weekly, 'utf8')).includes(cert.key)) return false;
      allowed = path.join(dir, 'signers');
      fs.writeFileSync(allowed, withAuthorities(fs.readFileSync(signers, 'utf8')), { mode: 0o600 });
    }
    const found = await run('ssh-keygen', ['-Y', 'find-principals', '-f', allowed, '-s', sig, ...when]);
    if (found.code !== 0) return false;
    for (const principal of found.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      // A revoked key is refused even if it were still in the pinned file.
      const r = revoked && fs.existsSync(revoked) && fs.statSync(revoked).size > 0 ? ['-r', revoked] : [];
      const v = await run('ssh-keygen', ['-Y', 'verify', '-f', allowed, '-I', principal, '-n', 'git', '-s', sig, ...r, ...when], signed.payload);
      if (v.code === 0) return true;
    }
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Its exit code and output; rejects if it couldn't be started or was
// killed (not there, or hung), which is no answer about the signature.
function run(cmd: string, args: string[], input?: Buffer): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 60_000 });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.on('error', (e) => reject(new Error(`${cmd} could not run: ${e.message}`)));
    child.on('close', (code, signal) => (code === null ? reject(new Error(`${cmd} was stopped (${signal})`)) : resolve({ code, stdout })));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}
