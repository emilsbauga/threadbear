// `tb checkup`: a short report a fork's Bring Them In thread offers to send
// Mike once a release has landed (docs/bringing-in-updates.md, section 7).
// Before this, Mike only heard about trouble in other people's copies when
// someone messaged him (Mike, 19 Nov 2026, picked over telemetry and
// agent-written issues).
//
// What keeps it safe to post on a public page:
// - code builds the report from a fixed set of facts, so the agent can't
//   wander into their logs, projects or paths. The one free-text part is
//   the agent's --text note, which they read on the card first;
// - a runner error is listed by its message only when that message is in
//   the code of Mike's release (git grep at the tag), so anything of their
//   own, and every log line's free-form details, stay out. Safe causes come
//   only from fixed allowlists (error classes, OS errno codes, integer
//   reinstall exit codes) or values verified against Mike's release (RPC
//   method names, runner/src/ stack frames). Fork-only crashes and RPC
//   methods are counted as "other", never named;
// - a patch is named only when it's one of Mike's (built in, or a file in
//   the release); theirs are a count;
// - the draft goes through redaction.ts and has the home folder taken out;
// - nothing posts until `tb checkup --post`, which the doc says to run only
//   after they said Send on a card, and it posts the draft file they saw,
//   once per release, with their own GitHub login (gh).
// Off with runner.json `releases.checkup: false` (their Never ask), and
// never in Mike's own copy.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errorExitsPath } from './error-exits.ts';
import { atomicWriteFileSync } from './fsutil.ts';
import { LAND_TIMES_FILE } from './land-queue.ts';
import type { PatchInfo } from './protocol.ts';
import { scrubText } from './redaction.ts';
import { readState as readReleaseState } from './release.ts';
import { LISTING_GIT_CONFIG, untrustedGitEnv } from './safe-git.ts';
import { errorKind } from './sentry.ts';
import { RELEASE_NAME, repoKey, signersPath, TAG_PREFIX, UPSTREAM_REFS, verifiedRelease, type SignedTag } from './upstream.ts';

export const CHECKUPS_REPO = 'mikecann/threadbear';
// The pinned Discussion check-ups go to, as comments
// (https://github.com/mikecann/threadbear/discussions/85). Undefined in a
// fork that takes this out: --post then says there's nowhere to send it,
// and the doc's step is skipped.
export const CHECKUPS_DISCUSSION: number | undefined = 85;

const MIKES_REPO = 'github.com/mikecann/threadbear';
const DAY_MS = 86_400_000;
// How far back the first check-up looks, with no earlier one to start from.
const FIRST_LOOK_DAYS = 14;
const MAX_LISTED = 10;
const MAX_NOTE = 600;
// Errors of the same bucket within this gap count as one burst, so a single
// outage or full-disk storm doesn't look like hundreds of separate bugs.
export const BURST_GAP_MS = 15 * 60_000;
const GIB = 1024 ** 3;
const LOW_DISK_BYTES = 10 * GIB;

// Strict shapes for tokens verified against Mike's release before printing:
// single-line, no spaces or quotes, so git grep can never match a substring
// of one line and let the rest through.
const METHOD_NAME = /^[a-z][a-zA-Z0-9._-]{0,59}$/;
const SRC_FILE = /^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,80}\.[cm]?[jt]s$/;

export type ErrorSummary = {
  message: string;
  count: number;
  // Safe cause token(s) from allowlists / release-verified identifiers (e.g.
  // "ENOSPC", "threads.send, TypeError", "exit 1").
  cause?: string;
  // Present when multiple occurrences collapsed into fewer bursts (a storm).
  bursts?: number;
  // Duration in seconds when all occurrences happened in a single burst.
  spanSeconds?: number;
};

export type RunnerHealth = {
  rolledBack?: boolean;
  restartGuardTripped?: boolean;
  // Only set when free space is under 10 GiB (rounded to 0.1 GiB).
  lowDiskGb?: number;
};

export type Checkup = {
  release?: { tag: string; date?: string; rev?: string };
  previous?: { tag: string; date?: string; rev?: string };
  sinceDays: number;
  errors: ErrorSummary[];
  otherErrors: number;
  updateFailing: boolean;
  patches: { id: string; error: string }[];
  otherPatchesFailing: number;
  checks?: LandingChecks;
  health?: RunnerHealth;
  note?: string;
};

// How long `tb land`'s checks took here, from the log each one leaves
// (worktrees.ts, LAND_TIMES_FILE). Mike asked to keep a close eye on this
// after Ville's took 20 to 45 minutes a landing on a Mac with no check host
// (22 Nov). Step names only when they're check.sh's in Mike's release; host
// names never, just whether a check host ran it.
export type LandingChecks = {
  count: number;
  failed: number;
  medianSeconds: number;
  slowestSeconds: number;
  medianWaitSeconds?: number;
  onCheckHost: number;
  steps: { name: string; medianSeconds: number }[];
};

type State = { lastAt?: string; posted?: { tag: string; at: string; url?: string }[]; draft?: { tag: string; file: string } };

function stateFile(home: string): string {
  return path.join(home, 'runner', 'checkup.json');
}

export function readState(home: string): State {
  try {
    return JSON.parse(fs.readFileSync(stateFile(home), 'utf8')) as State;
  } catch {
    return {};
  }
}

function writeState(home: string, s: State): void {
  fs.mkdirSync(path.dirname(stateFile(home)), { recursive: true });
  atomicWriteFileSync(stateFile(home), JSON.stringify(s, null, 2) + '\n');
}

// A runner log line's level and message, without the JSON of details the
// logger puts after it (log.ts).
export function parseLogLine(line: string): { at: number; level: string; message: string } | undefined {
  const m = /^(\S+) (ERROR|WARN|INFO|DEBUG) (.*)$/.exec(line);
  if (!m) return undefined;
  const at = Date.parse(m[1]);
  if (Number.isNaN(at)) return undefined;
  const cut = m[3].indexOf(' {');
  return { at, level: m[2], message: (cut >= 0 ? m[3].slice(0, cut) : m[3]).trim() };
}

type LogExtra = {
  error?: string;
  method?: string;
  code?: number;
};

function parseLogExtra(line: string): LogExtra | undefined {
  const m = /^\S+ (?:ERROR|WARN|INFO|DEBUG) (.*)$/.exec(line);
  if (!m) return undefined;
  const cut = m[1].indexOf(' {');
  if (cut < 0) return undefined;
  try {
    const raw = JSON.parse(m[1].slice(cut + 1)) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const out: LogExtra = {};
    if (typeof raw.error === 'string') out.error = raw.error;
    if (typeof raw.method === 'string') out.method = raw.method;
    if (typeof raw.code === 'number' && Number.isInteger(raw.code)) out.code = raw.code;
    return out;
  } catch {
    return undefined;
  }
}

// Safe error cause from sentry.ts's fixed allowlist (error classes and OS
// errno codes). Plain "Error" carries no extra signal so it's omitted, and
// "Error (ENOSPC)" shortens to "ENOSPC".
export function safeErrorCause(errorText: string | undefined): string | undefined {
  if (!errorText) return undefined;
  const kind = errorKind(errorText);
  if (kind === 'Error') return undefined;
  const plainErrno = /^Error \((E[A-Z0-9]{2,15})\)$/.exec(kind);
  return plainErrno ? plainErrno[1] : kind;
}

// First runner `src/<file>` frame from a logged JS stack trace (skipping line
// 0 so error message text cannot spoof a frame, and skipping node_modules).
// Always checked against Mike's release before naming.
export function topStackSourceFile(errorText: string | undefined): string | undefined {
  if (!errorText) return undefined;
  const lines = errorText.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s+at\s+/.test(line)) continue;
    if (/node_modules[\\/]/.test(line)) continue;
    const m = /(?:^|[\\/])src[\\/]([a-zA-Z0-9][a-zA-Z0-9_.\\/-]{0,80}\.[cm]?[jt]s)(?::\d+:\d+)?(?:\)|\s*$)/.exec(line);
    if (!m) continue;
    const rel = m[1].replace(/\\/g, '/');
    if (rel.includes('..') || !SRC_FILE.test(rel)) continue;
    return rel;
  }
  return undefined;
}

// Matches sentry.ts's non-bug filter: provider limits and offline network
// retries aren't Threadbear bugs.
function isNonBug(message: string, extra: LogExtra | undefined): boolean {
  if (message === 'model call failed') return true;
  if (message === 'convex sync failed; will retry' && /fetch failed/i.test(extra?.error ?? '')) return true;
  return false;
}

export type CountErrorCheckers = {
  // Whether an RPC method name exists in Mike's release code.
  knownMethod?: (method: string) => boolean;
  // Whether a runner/src/<rel> path exists in Mike's release tree.
  knownSourceFile?: (rel: string) => boolean;
};

// ERROR lines since `since`, grouped by message + safe cause, collapsing
// storms into bursts. `known` says whether a message is one of Mike's (in
// his release's code); fork-only messages, fork-only RPC methods and crashes
// whose top runner/src/ frame isn't in Mike's release are only counted.
export function countErrors(
  lines: string[],
  since: number,
  known: (message: string) => boolean,
  checkers: CountErrorCheckers = {},
): { errors: ErrorSummary[]; otherErrors: number } {
  type Bucket = { message: string; cause?: string; times: number[] };
  const buckets = new Map<string, Bucket>();
  let otherErrors = 0;

  for (const line of lines) {
    const p = parseLogLine(line);
    if (!p || p.level !== 'ERROR' || p.at < since || !p.message) continue;
    const extra = parseLogExtra(line);
    if (isNonBug(p.message, extra)) continue;
    if (!known(p.message)) {
      otherErrors++;
      continue;
    }

    let message = p.message;
    const parts: string[] = [];

    if (p.message === 'request failed' && extra?.method && checkers.knownMethod) {
      if (!METHOD_NAME.test(extra.method) || !checkers.knownMethod(extra.method)) {
        otherErrors++;
        continue;
      }
      parts.push(extra.method);
    }

    if ((p.message === 'unhandled rejection' || p.message === 'uncaught exception') && checkers.knownSourceFile) {
      const file = topStackSourceFile(extra?.error);
      if (file) {
        if (!checkers.knownSourceFile(file)) {
          otherErrors++;
          continue;
        }
        message = `${p.message} in ${file}`;
      }
    }

    if (p.message === 'reinstall finished' && extra?.code !== undefined && extra.code >= -999 && extra.code <= 999) {
      parts.push(`exit ${extra.code}`);
    }

    const cause = safeErrorCause(extra?.error);
    if (cause) parts.push(cause);

    const detail = parts.length ? parts.join(', ') : undefined;
    const key = detail ? `${message}\0${detail}` : message;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { message, ...(detail ? { cause: detail } : {}), times: [] };
      buckets.set(key, bucket);
    }
    bucket.times.push(p.at);
  }

  const summarized: ErrorSummary[] = [...buckets.values()].map((b) => {
    b.times.sort((a, z) => a - z);
    let bursts = 1;
    for (let i = 1; i < b.times.length; i++) {
      if (b.times[i] - b.times[i - 1] > BURST_GAP_MS) bursts++;
    }
    const count = b.times.length;
    const collapsed = bursts < count;
    const spanSeconds = collapsed && bursts === 1 ? Math.round((b.times[count - 1] - b.times[0]) / 1000) : undefined;
    return {
      message: b.message,
      count,
      ...(b.cause ? { cause: b.cause } : {}),
      ...(collapsed ? { bursts } : {}),
      ...(spanSeconds ? { spanSeconds } : {}),
    };
  });

  // Sort by distinct incidents first (so a single storm doesn't bury recurring
  // bugs), then by total count, then alphabetically.
  summarized.sort((a, b) => {
    const aInc = a.bursts ?? a.count;
    const bInc = b.bursts ?? b.count;
    if (bInc !== aInc) return bInc - aInc;
    if (b.count !== a.count) return b.count - a.count;
    return a.message.localeCompare(b.message);
  });

  const errors = summarized.slice(0, MAX_LISTED);
  for (const extra of summarized.slice(MAX_LISTED)) otherErrors += extra.count;
  return { errors, otherErrors };
}

// Patches that failed to load in this thread's folder: Mike's by name (built
// in, or a file the release has), theirs as a count.
export function failingPatches(patches: PatchInfo[], inRelease: (file: string) => boolean): { patches: { id: string; error: string }[]; otherPatchesFailing: number } {
  const out: { id: string; error: string }[] = [];
  let other = 0;
  for (const p of patches) {
    const error = p.error ?? p.liveError;
    if (!error) continue;
    if (p.source === 'builtin' || (p.source === 'project' && p.file && inRelease(p.file))) out.push({ id: p.id, error: error.split('\n')[0].slice(0, 200) });
    else other++;
  }
  return { patches: out, otherPatchesFailing: other };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// What a check.sh step's name looks like ("desktop core tests"). Anything
// else (a newline in it would let git grep match one line of it alone and
// post the rest, Codex's review) is never named.
const STEP_NAME = /^[a-z0-9][a-z0-9 .+-]{0,59}$/i;

// The landing checks since `since`, from the times log's lines.
export function landingChecks(lines: string[], since: number, knownStep: (name: string) => boolean): LandingChecks | undefined {
  type Line = { at?: string; ok?: boolean; dryRun?: boolean; seconds?: number; waitedSeconds?: number; host?: string; steps?: { name?: string; status?: string; seconds?: number }[] };
  const runs: Line[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as Line;
      if (e && typeof e === 'object' && !e.dryRun && typeof e.seconds === 'number' && Number.isFinite(e.seconds) && typeof e.at === 'string' && Date.parse(e.at) >= since) runs.push(e);
    } catch {
      // A line cut short.
    }
  }
  if (!runs.length) return undefined;
  const secs = runs.map((r) => r.seconds!);
  const waits = runs.map((r) => r.waitedSeconds).filter((w): w is number => typeof w === 'number');
  const byStep = new Map<string, number[]>();
  for (const r of runs) {
    // A line of any shape is skipped, never the whole check-up (Codex's review).
    for (const st of Array.isArray(r.steps) ? r.steps : []) {
      if (!st || typeof st !== 'object' || st.status === 'skip' || typeof st.seconds !== 'number' || typeof st.name !== 'string' || !STEP_NAME.test(st.name)) continue;
      byStep.set(st.name, [...(byStep.get(st.name) ?? []), st.seconds]);
    }
  }
  const steps = [...byStep]
    .filter(([name]) => knownStep(name))
    .map(([name, xs]) => ({ name, medianSeconds: median(xs) }))
    .sort((a, b) => b.medianSeconds - a.medianSeconds)
    .slice(0, 4);
  return {
    count: runs.length,
    failed: runs.filter((r) => !r.ok).length,
    medianSeconds: median(secs),
    slowestSeconds: Math.max(...secs),
    ...(waits.length ? { medianWaitSeconds: median(waits) } : {}),
    onCheckHost: runs.filter((r) => r.host).length,
    steps,
  };
}

function readRunnerHealth(home: string, since: number, freeBytesOverride?: number | null): RunnerHealth | undefined {
  const health: RunnerHealth = {};

  const rolledAt = readReleaseState(home)?.rolledBack?.at;
  if (typeof rolledAt === 'string' && Date.parse(rolledAt) >= since) {
    health.rolledBack = true;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(errorExitsPath(home), 'utf8')) as { tripped?: { at?: string; lastErrorAt?: string } };
    const tAt = raw?.tripped?.lastErrorAt ?? raw?.tripped?.at;
    if (typeof tAt === 'string' && Date.parse(tAt) >= since) {
      health.restartGuardTripped = true;
    }
  } catch {
    // No error-exits file or unreadable.
  }

  let free: number | undefined;
  if (freeBytesOverride !== undefined) {
    free = freeBytesOverride ?? undefined;
  } else {
    try {
      const s = fs.statfsSync(home);
      free = s.bavail * s.bsize;
    } catch {
      free = undefined;
    }
  }
  if (free !== undefined && Number.isFinite(free) && free >= 0 && free < LOW_DISK_BYTES) {
    health.lowDiskGb = Math.round((free / GIB) * 10) / 10;
  }

  return Object.keys(health).length ? health : undefined;
}

function duration(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatErrorLine(e: ErrorSummary): string {
  const cause = e.cause ? ` (${e.cause})` : '';
  let burst = '';
  if (e.bursts && e.bursts < e.count) {
    if (e.bursts === 1) {
      burst = e.spanSeconds && e.spanSeconds >= 60 ? `, 1 burst over ${duration(e.spanSeconds)}` : ', 1 burst';
    } else {
      burst = `, ${e.bursts} bursts`;
    }
  }
  return `- ${e.count}x ${e.message}${cause}${burst}`;
}

// The report as posted, markdown. Facts first, the agent's note last.
export function formatCheckup(c: Checkup): string {
  const lines: string[] = [];
  const rel = c.release ? `\`${c.release.tag}\`` : 'an unknown release';
  if (c.previous && c.release) {
    const gap = c.previous.date && c.release.date ? Math.round((Date.parse(c.release.date) - Date.parse(c.previous.date)) / DAY_MS) : undefined;
    lines.push(`Brought in ${rel} from \`${c.previous.tag}\`${gap !== undefined ? ` (${plural(gap, 'day', 'days')} behind)` : ''}.`);
  } else {
    lines.push(`Brought in ${rel}.`);
  }
  const span = `in the last ${plural(c.sinceDays, 'day', 'days')}`;
  if (!c.errors.length && !c.otherErrors) lines.push(`Runner errors ${span}: none.`);
  else {
    lines.push(`Runner errors ${span}:`);
    for (const e of c.errors) lines.push(formatErrorLine(e));
    if (c.otherErrors) lines.push(`- ${plural(c.otherErrors, 'other', 'others')} (not from Threadbear's own code, so not listed)`);
  }
  if (c.health?.rolledBack) lines.push(`A runner release rolled back after crashing ${span}.`);
  if (c.health?.restartGuardTripped) lines.push(`The error-restart guard tripped ${span}.`);
  if (c.health?.lowDiskGb !== undefined) lines.push(`Disk space is low right now (${c.health.lowDiskGb} GB free).`);
  if (c.checks) {
    const k = c.checks;
    const where = k.onCheckHost === k.count ? 'all on a check host' : k.onCheckHost ? `${k.onCheckHost} on a check host, ${k.count - k.onCheckHost} on their Mac` : 'all on their Mac, no check host';
    lines.push(`Landing checks ${span}: ${k.count}${k.failed ? ` (${k.failed} failed)` : ''}, ${where}. Typical ${duration(k.medianSeconds)}, slowest ${duration(k.slowestSeconds)}${k.medianWaitSeconds ? `, typical wait for the lock ${duration(k.medianWaitSeconds)}` : ''}.`);
    if (k.steps.length) lines.push(`Slowest steps (typical): ${k.steps.map((st) => `${st.name} ${duration(st.medianSeconds)}`).join(', ')}.`);
  }
  if (c.updateFailing) lines.push("The runner's own build of main is failing right now.");
  for (const p of c.patches) lines.push(`Patch \`${p.id}\` won't load: ${p.error}`);
  if (c.otherPatchesFailing) lines.push(`${plural(c.otherPatchesFailing, 'patch of their own', 'patches of their own')} won't load.`);
  if (c.note) lines.push('', `From their agent: ${c.note}`);
  return lines.join('\n');
}

// What goes out: the redaction rules, then this Mac's home folder and user
// name taken out, in case a note or an error carried a path.
export function scrubForPosting(text: string, home = os.homedir(), user = os.userInfo().username): string {
  let out = scrubText(text);
  if (home && home.length > 1) out = out.split(home).join('~');
  if (user && user.length > 2) out = out.replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '<user>');
  return out;
}

// Replacement objects off: a refs/replace/ entry would have a release's
// commit read as a fork's own, and its messages pass for Mike's (Codex's
// review, 22 Nov).
// Grafts and the commit-graph off too, and no fetching or hooks, as for the
// release check itself (Gemini's review of Daybreak 180, 24 Nov 2026).
const GIT_ENV = { ...untrustedGitEnv(), GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null', GIT_NO_LAZY_FETCH: '1' };
const GIT_CONFIG = [...LISTING_GIT_CONFIG, '-c', 'core.commitGraph=false', '-c', 'advice.graftFileDeprecated=false'];

function git(cwd: string, args: string[]): string | undefined {
  const r = spawnSync('git', [...GIT_CONFIG, '-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

type Release = { tag: string; date?: string; rev: string };
type Ref = { oid: string; type: string; size: number };
type Known = Release & { kept: boolean; name: string; ref: Ref };

// Mike's releases this copy has: tags fetched the usual way
// (refs/tags/release/*), and the ones the runner checked and kept under
// refs/threadbear/upstream/<date> (upstream.ts). Only reading tags, a fork
// whose newer releases were only there named one from 16 Nov when it had
// brought in 21 Nov's (discussions/85, 21 Nov). Newest first, by name (a
// date: newer names nothing else).
function knownReleases(cwd: string): Known[] {
  const out = git(cwd, ['for-each-ref', '--format=%(refname)%09%(*objectname)%09%(objectname)%09%(objecttype)%09%(objectsize)%09%(creatordate:iso-strict)', `refs/tags/${TAG_PREFIX}`, UPSTREAM_REFS]) ?? '';
  // Every one, not one per name: a tag of the fork's own with a release's
  // name mustn't hide the kept release (Codex's review). The kept one comes
  // first for the same name.
  const all: Known[] = [];
  for (const line of out.split('\n')) {
    const [ref, peeled, oid, type, size, date] = line.split('\t');
    if (!ref || !oid) continue;
    const kept = ref.startsWith(UPSTREAM_REFS);
    const name = ref.slice(kept ? UPSTREAM_REFS.length : `refs/tags/${TAG_PREFIX}`.length);
    if (!RELEASE_NAME.test(name)) continue;
    all.push({ tag: TAG_PREFIX + name, name, rev: peeled || oid, kept, ref: { oid, type: type ?? '', size: Number(size) }, ...(date ? { date } : {}) });
  }
  return all.sort((a, b) => (a.tag !== b.tag ? (a.tag < b.tag ? 1 : -1) : Number(b.kept) - Number(a.kept)));
}

function contains(cwd: string, rev: string, release: Release): boolean {
  return spawnSync('git', [...GIT_CONFIG, '-C', cwd, 'merge-base', '--is-ancestor', release.rev, rev], { env: GIT_ENV }).status === 0;
}

// The release main has now, and the one it had before: main's reflog,
// back to where the newest release wasn't in it yet.
// With a key pinned (in `home`), a tag or kept ref counts only if it
// verifies against it as what it's named, as the release check does, and
// its code is read at the commit the signature names: nothing stops a ref
// turning up between checks, and a tag of the fork's own on main would
// have its private messages pass for Mike's on a public page (Codex's and
// Gemini's reviews, 22 Nov). With none, the release check is off and has
// kept nothing, so only tags count, as before.
export async function releasesOnMain(cwd: string, home?: string): Promise<{ release?: Release; previous?: Release }> {
  const all = knownReleases(cwd);
  const pinned = !!home && fs.existsSync(signersPath(home));
  const answers = new Map<Known, Promise<SignedTag | undefined>>();
  const believed = async (r: Known): Promise<Release | undefined> => {
    if (!pinned) return r.kept ? undefined : { tag: r.tag, rev: r.rev, ...(r.date ? { date: r.date } : {}) };
    if (!answers.has(r)) answers.set(r, verifiedRelease(cwd, home, r.name, r.ref));
    const signed = await answers.get(r)!;
    return signed && { tag: r.tag, rev: signed.commit, ...(signed.date ? { date: signed.date } : {}) };
  };
  const newest = async (rev: string): Promise<Release | undefined> => {
    for (const r of all) {
      if (!contains(cwd, rev, r)) continue;
      const ok = await believed(r);
      if (ok) return ok;
    }
    return undefined;
  };
  const release = await newest('main');
  if (!release) return {};
  for (let i = 1; i <= 50; i++) {
    const then = `main@{${i}}`;
    if (!git(cwd, ['rev-parse', '--verify', '--quiet', then])) break;
    if (contains(cwd, then, release)) continue;
    const previous = await newest(then);
    return previous ? { release, previous } : { release };
  }
  return { release };
}

export type CheckupInputs = {
  home: string;
  checkout: string;
  logLines: string[];
  patches: PatchInfo[];
  updateFailing: boolean;
  note?: string;
  now: number;
  // The times log's lines; read from the checkout's git folder when left out.
  landTimes?: string[];
  // Free disk bytes on `home`'s volume; read with statfsSync when left out.
  // Pass null in tests to disable disk probing.
  freeBytes?: number | null;
};

function readLandTimes(checkout: string): string[] {
  const common = git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return [];
  try {
    return fs.readFileSync(path.join(common, LAND_TIMES_FILE), 'utf8').trimEnd().split('\n');
  } catch {
    return [];
  }
}

export async function buildCheckup(i: CheckupInputs): Promise<Checkup> {
  const { release, previous } = await releasesOnMain(i.checkout, i.home);
  const last = readState(i.home).lastAt;
  const since = last ? Date.parse(last) : i.now - FIRST_LOOK_DAYS * DAY_MS;
  const sinceDays = Math.max(1, Math.round((i.now - since) / DAY_MS));
  const tag = release?.rev;
  const msgCache = new Map<string, boolean>();
  const known = (message: string) => {
    if (!tag) return false;
    if (!msgCache.has(message)) msgCache.set(message, spawnSync('git', [...GIT_CONFIG, '-C', i.checkout, 'grep', '-q', '-F', '-e', message, tag, '--', 'runner/src'], { encoding: 'utf8', env: GIT_ENV }).status === 0);
    return msgCache.get(message)!;
  };
  const methodCache = new Map<string, boolean>();
  const knownMethod = (method: string) => {
    if (!tag || !METHOD_NAME.test(method)) return false;
    if (!methodCache.has(method)) {
      methodCache.set(method, spawnSync('git', [...GIT_CONFIG, '-C', i.checkout, 'grep', '-q', '-F', '-e', `'${method}'`, '-e', `"${method}"`, tag, '--', 'runner/src'], { encoding: 'utf8', env: GIT_ENV }).status === 0);
    }
    return methodCache.get(method)!;
  };
  const srcFileCache = new Map<string, boolean>();
  const knownSourceFile = (rel: string) => {
    if (!tag || rel.includes('..') || !SRC_FILE.test(rel)) return false;
    if (!srcFileCache.has(rel)) {
      srcFileCache.set(rel, git(i.checkout, ['cat-file', '-e', `${tag}:runner/src/${rel}`]) !== undefined);
    }
    return srcFileCache.get(rel)!;
  };
  const inRelease = (file: string) => {
    if (!tag) return false;
    const rel = path.relative(i.checkout, file);
    return !rel.startsWith('..') && !path.isAbsolute(rel) && git(i.checkout, ['cat-file', '-e', `${tag}:${rel.split(path.sep).join('/')}`]) !== undefined;
  };
  const note = i.note?.trim().replace(/\s+/g, ' ').slice(0, MAX_NOTE);
  const stepKnown = (name: string) => !!tag && spawnSync('git', [...GIT_CONFIG, '-C', i.checkout, 'grep', '-q', '-F', '-e', `"${name}"`, tag, '--', 'check.sh'], { encoding: 'utf8', env: GIT_ENV }).status === 0;
  const checks = landingChecks(i.landTimes ?? readLandTimes(i.checkout), since, stepKnown);
  const health = readRunnerHealth(i.home, since, i.freeBytes);
  return {
    release,
    previous,
    sinceDays,
    ...countErrors(i.logLines, since, known, { knownMethod, knownSourceFile }),
    updateFailing: i.updateFailing,
    ...failingPatches(i.patches, inRelease),
    ...(checks ? { checks } : {}),
    ...(health ? { health } : {}),
    ...(note ? { note } : {}),
  };
}

// Why this copy doesn't do check-ups, or undefined when it does.
export function checkupOff(checkout: string, runnerJson: { releases?: { checkup?: boolean } }): string | undefined {
  if (runnerJson.releases?.checkup === false) return 'Check-ups are off here (runner.json `releases.checkup: false`).';
  const origin = git(checkout, ['remote', 'get-url', 'origin']);
  if (origin && repoKey(origin) === MIKES_REPO) return "This is Mike's own copy: check-ups are for other people's.";
  return undefined;
}

// Writes the draft --post will send and returns it.
export function saveDraft(home: string, c: Checkup): { text: string; file: string } {
  const text = scrubForPosting(formatCheckup(c));
  const file = path.join(home, 'runner', 'checkup-draft.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, text + '\n');
  writeState(home, { ...readState(home), draft: { tag: c.release?.tag ?? '', file } });
  return { text, file };
}

type Gh = (args: string[]) => { ok: boolean; out: string };

const realGh: Gh = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.status === 0 ? r.stdout : r.stderr || r.error?.message || '').trim() };
};

// Posts the saved draft as a comment on the check-ups Discussion, once per
// release. Returns what to print and the exit code.
export function postDraft(home: string, now: number, gh: Gh = realGh, discussion = CHECKUPS_DISCUSSION): { code: number; message: string } {
  const s = readState(home);
  if (!s.draft || !fs.existsSync(s.draft.file)) return { code: 1, message: 'No draft to send: run tb checkup first and show it to them.' };
  if (s.posted?.some((p) => p.tag === s.draft!.tag)) return { code: 1, message: `A check-up for ${s.draft.tag} was already sent from here.` };
  const page = `https://github.com/${CHECKUPS_REPO}/discussions${discussion ? `/${discussion}` : ''}`;
  if (!discussion) return { code: 1, message: "Mike hasn't opened the check-ups Discussion yet, so there's nowhere to send it. Skip this step." };
  // Scrubbed again: the file could have been edited since.
  const body = scrubForPosting(fs.readFileSync(s.draft.file, 'utf8').trim());
  const [owner, name] = CHECKUPS_REPO.split('/');
  const id = gh(['api', 'graphql', '-f', 'query=query($o:String!,$n:String!,$d:Int!){repository(owner:$o,name:$n){discussion(number:$d){id}}}', '-f', `o=${owner}`, '-f', `n=${name}`, '-F', `d=${discussion}`, '--jq', '.data.repository.discussion.id']);
  if (!id.ok || !id.out) return { code: 1, message: `Couldn't reach the Discussion with gh (${id.out || 'no answer'}). Is gh signed in (gh auth status)? Otherwise copy the draft (${s.draft.file}) and paste it as a comment at ${page}.` };
  const r = gh(['api', 'graphql', '-f', 'query=mutation($id:ID!,$b:String!){addDiscussionComment(input:{discussionId:$id,body:$b}){comment{url}}}', '-f', `id=${id.out}`, '-f', `b=${body}`, '--jq', '.data.addDiscussionComment.comment.url']);
  if (!r.ok) return { code: 1, message: `gh couldn't post it (${r.out}). Copy the draft (${s.draft.file}) and paste it as a comment at ${page}.` };
  const at = new Date(now).toISOString();
  writeState(home, { lastAt: at, posted: [...(s.posted ?? []), { tag: s.draft.tag, at, ...(r.out ? { url: r.out } : {}) }].slice(-20) });
  return { code: 0, message: `Sent: ${r.out || page}` };
}

// A check-up they skipped still starts the next one's count from now.
export function skipped(home: string, now: number): void {
  const s = readState(home);
  writeState(home, { ...s, lastAt: new Date(now).toISOString(), draft: undefined });
}
