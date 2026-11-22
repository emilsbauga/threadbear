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
//   own, and every log line's details, stay out. The rest is a count;
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
import { atomicWriteFileSync } from './fsutil.ts';
import { scrubText } from './redaction.ts';
import { repoKey, TAG_PREFIX } from './upstream.ts';
import type { PatchInfo } from './protocol.ts';

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

export type Checkup = {
  release?: { tag: string; date?: string };
  previous?: { tag: string; date?: string };
  sinceDays: number;
  errors: { message: string; count: number }[];
  otherErrors: number;
  updateFailing: boolean;
  patches: { id: string; error: string }[];
  otherPatchesFailing: number;
  note?: string;
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

// ERROR lines since `since`, counted by message, most first. `known` says
// whether a message is one of Mike's (in his release's code); the rest are
// only counted.
export function countErrors(lines: string[], since: number, known: (message: string) => boolean): { errors: { message: string; count: number }[]; otherErrors: number } {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const p = parseLogLine(line);
    if (!p || p.level !== 'ERROR' || p.at < since || !p.message) continue;
    counts.set(p.message, (counts.get(p.message) ?? 0) + 1);
  }
  const errors: { message: string; count: number }[] = [];
  let otherErrors = 0;
  for (const [message, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    if (errors.length < MAX_LISTED && known(message)) errors.push({ message, count });
    else otherErrors += count;
  }
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

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
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
    for (const e of c.errors) lines.push(`- ${e.count}x ${e.message}`);
    if (c.otherErrors) lines.push(`- ${plural(c.otherErrors, 'other', 'others')} (not from Threadbear's own code, so not listed)`);
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

function git(cwd: string, args: string[]): string | undefined {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function tagDate(cwd: string, tag: string): string | undefined {
  return git(cwd, ['for-each-ref', '--format=%(creatordate:iso-strict)', `refs/tags/${tag}`]) || undefined;
}

function newestRelease(cwd: string, rev: string): string | undefined {
  return git(cwd, ['describe', '--tags', '--abbrev=0', '--match', `${TAG_PREFIX}*`, rev]);
}

// The release main has now, and the one it had before: main's reflog,
// back to where the newest release wasn't in it yet.
export function releasesOnMain(cwd: string): { release?: { tag: string; date?: string }; previous?: { tag: string; date?: string } } {
  const now = newestRelease(cwd, 'main');
  if (!now) return {};
  const release = { tag: now, date: tagDate(cwd, now) };
  for (let i = 1; i <= 50; i++) {
    if (!git(cwd, ['rev-parse', '--verify', '--quiet', `main@{${i}}`])) break;
    const then = newestRelease(cwd, `main@{${i}}`);
    if (then && then !== now) return { release, previous: { tag: then, date: tagDate(cwd, then) } };
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
};

export function buildCheckup(i: CheckupInputs): Checkup {
  const { release, previous } = releasesOnMain(i.checkout);
  const last = readState(i.home).lastAt;
  const since = last ? Date.parse(last) : i.now - FIRST_LOOK_DAYS * DAY_MS;
  const sinceDays = Math.max(1, Math.round((i.now - since) / DAY_MS));
  const tag = release?.tag;
  const cache = new Map<string, boolean>();
  const known = (message: string) => {
    if (!tag) return false;
    if (!cache.has(message)) cache.set(message, spawnSync('git', ['-C', i.checkout, 'grep', '-q', '-F', '-e', message, tag, '--', 'runner/src'], { encoding: 'utf8' }).status === 0);
    return cache.get(message)!;
  };
  const inRelease = (file: string) => {
    if (!tag) return false;
    const rel = path.relative(i.checkout, file);
    return !rel.startsWith('..') && !path.isAbsolute(rel) && git(i.checkout, ['cat-file', '-e', `${tag}:${rel.split(path.sep).join('/')}`]) !== undefined;
  };
  const note = i.note?.trim().replace(/\s+/g, ' ').slice(0, MAX_NOTE);
  return { release, previous, sinceDays, ...countErrors(i.logLines, since, known), updateFailing: i.updateFailing, ...failingPatches(i.patches, inRelease), ...(note ? { note } : {}) };
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
