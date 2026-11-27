// Use this Mac's Claude logins on another runner (docs/protocol/settings.md,
// Accounts, "This Mac's logins on another runner"). Each runner has only the
// logins someone signed in to on that machine, and on 26 Nov 2026 Bruce
// stalled on its one login while the M5 had others with room. A year-long
// token (year-token.ts) works on any machine, so the main Mac can hand its
// tokens to a runner Mike switches on in the Runners panel.
//
// Convex carries them, but only ever sealed: the receiving runner answers a
// `logins.sealKey` call with the public half of its secrets key (secrets.ts),
// and the main Mac seals each login to it before a `logins.share` call. Both
// calls are the owner key's alone (convex/relay.ts CALLS, `from: "mac"`).
//
// Two halves here: what the main Mac sends (`shareable`, `sealLogins`,
// `LoginSharer`), and what the other runner does with it (`openShared`,
// `applyShared`). A token is never in a log line, an error, an answer or a
// test's output: errors name the login by its email, never its contents.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sealBytes } from './secrets.ts';
import { TOKEN_FILE, readYearToken, rememberToken } from './year-token.ts';
import { atomicWriteFileSync, renameWithRetry } from './fsutil.ts';
import type { Account, Pool } from './protocol.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';

/** The file in a login folder that says it came from the main Mac, and for which email. */
export const MARKER_FILE = 'threadbear-shared.json';
/** What a shared login links back to in that runner's own claude-main folder. */
export const SHARED_LINKS = ['CLAUDE.md', 'settings.json', 'skills'] as const;
/** At most this many go in one share (convex/relay.ts SHARED_LOGINS_MAX). */
export const MAX_SHARED = 20;
/**
 * A sealed box's base64 is at most this long (convex/relay.ts
 * SHARED_BOX_MAX): 20 of them stay under the backend's 64 KB of args. A
 * token and a trimmed profile come to about 1.3 KB.
 */
export const MAX_BOX = 2800;
/** What's kept of a login's oauthAccount: short plain values, at most this much JSON. */
const PROFILE_MAX = 1200;
/** How often the main Mac looks again while a switch is on, and retries one that failed. */
export const RECHECK_MS = 10 * 60_000;
const REMOVED_DIR = '.removed';
const TOKEN_SHAPE = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/;
const EMAIL_SHAPE = /^[^\s@]{1,100}@[^\s@]{1,100}$/;

/** What each sealed box is bound to: the runner it's for and the login's email. */
export function sealInfo(runnerId: string, email: string): string {
  return `threadbear shared login v1 ${runnerId} ${email.toLowerCase()}`;
}

/** One login as it travels, sealed: never written anywhere but its new folder. */
export type SharedLogin = { email: string; token: string; madeAt?: string; oauthAccount: Record<string, unknown> };
export type SealedLogin = { email: string; box: string };
export type ShareState = 'added' | 'updated' | 'same' | 'adopted' | 'here' | 'failed';
export type ShareResult = { email: string; state: ShareState; accountId?: string; message?: string };
export type ShareAnswer = { logins: ShareResult[]; removed: { email: string; accountId: string }[] };

// ------------------------------------------------------------ the main Mac's side

/**
 * The logins this Mac shares: Claude, with a year-long token and an email,
 * no note (accountNotes: "Convex work only" keeps claude-2 here), a plan
 * that hasn't lapsed, and not only in pools tied to folders (a work pool).
 * Hidden logins never reach this list (discoverAccounts drops them).
 */
export function shareable(accounts: Account[], pools: Pool[]): Account[] {
  const onlyFolderPools = (id: string) => {
    const mine = pools.filter((p) => p.accountIds.includes(id));
    return mine.length > 0 && mine.every((p) => (p.folders?.length ?? 0) > 0);
  };
  const seen = new Set<string>();
  return accounts.filter((a) => {
    if (a.provider !== 'claude' || !a.yearToken || !a.email || a.note || a.planEnded || onlyFolderPools(a.id)) return false;
    const email = a.email.toLowerCase();
    if (seen.has(email) || !EMAIL_SHAPE.test(email)) return false;
    seen.add(email);
    return true;
  });
}

/** A .claude.json's oauthAccount, or undefined. Nothing else in it is kept. */
export function readOauthAccount(claudeJson: string): Record<string, unknown> | undefined {
  try {
    const o = (JSON.parse(fs.readFileSync(claudeJson, 'utf8')) as { oauthAccount?: unknown }).oauthAccount;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// Only short strings, numbers and booleans, and no more than PROFILE_MAX of
// them: what the CLI reads the account from, small enough that 20 sealed
// logins fit in one command.
export function trimProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let size = 2;
  for (const [k, v] of Object.entries(profile)) {
    const plain = (typeof v === 'string' && v.length <= 200) || typeof v === 'number' || typeof v === 'boolean' || v === null;
    if (!plain || k.length > 60) continue;
    const add = Buffer.byteLength(JSON.stringify(k)) + Buffer.byteLength(JSON.stringify(v)) + 2;
    if (size + add > PROFILE_MAX) continue;
    out[k] = v;
    size += add;
  }
  return out;
}

/**
 * Each login's token and profile, read now. `claudeMainJson` is where
 * claude-main's .claude.json is (beside ~/.claude, not in it).
 */
export function gatherLogins(accounts: Account[], claudeMainJson: string): SharedLogin[] {
  const out: SharedLogin[] = [];
  for (const a of accounts.slice(0, MAX_SHARED)) {
    const t = readYearToken(a.configDir);
    if (!t || !a.email) continue;
    const json = a.id === 'claude-main' ? claudeMainJson : path.join(a.configDir, '.claude.json');
    // The email first, so trimming never drops it.
    const { emailAddress: _e, ...rest } = readOauthAccount(json) ?? {};
    const oauthAccount = trimProfile({ emailAddress: a.email, ...rest });
    out.push({ email: a.email.toLowerCase(), token: t.token, ...(t.madeAt ? { madeAt: t.madeAt } : {}), oauthAccount });
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

/** What was sent, as a digest: kept on disk to know when to send again. Never the tokens. */
export function digestOf(logins: SharedLogin[]): string {
  const h = crypto.createHash('sha256').update('threadbear shared logins v1');
  for (const l of logins) h.update('\0').update(JSON.stringify([l.email, l.token, l.madeAt ?? '', l.oauthAccount]));
  return h.digest('hex');
}

/** Each login sealed to that runner's key (secrets.ts sealBytes), bound to its id and the email. */
export function sealLogins(runnerId: string, key: string, logins: SharedLogin[]): SealedLogin[] {
  if (Buffer.from(key, 'base64').length !== 32) throw new Error("That runner's sealing key isn't one.");
  return logins.map((l) => {
    const plain = Buffer.from(JSON.stringify({ token: l.token, ...(l.madeAt ? { madeAt: l.madeAt } : {}), oauthAccount: l.oauthAccount }), 'utf8');
    let box = sealBytes(key, plain, sealInfo(runnerId, l.email)).toString('base64');
    plain.fill(0);
    // Still too big: the email alone as its profile, rather than hold up the rest.
    if (box.length > MAX_BOX) {
      const bare = Buffer.from(JSON.stringify({ token: l.token, ...(l.madeAt ? { madeAt: l.madeAt } : {}), oauthAccount: { emailAddress: l.email } }), 'utf8');
      box = sealBytes(key, bare, sealInfo(runnerId, l.email)).toString('base64');
      bare.fill(0);
    }
    return { email: l.email, box };
  });
}

// ------------------------------------------------------------ the other runner's side

/**
 * One sealed login opened with this runner's private key (`open`, the
 * secrets store's openBytes). Every failure says the same, naming only the
 * email: the plaintext holds the token, so no parse error may quote it.
 */
export function openShared(open: (sealed: Buffer, info: string) => Buffer, selfId: string, entry: { email: unknown; box: unknown }): SharedLogin {
  const email = typeof entry.email === 'string' ? entry.email.toLowerCase() : '';
  const fail = () => new Error(`The login for ${EMAIL_SHAPE.test(email) ? email : 'an unknown email'} couldn't be opened here.`);
  if (!EMAIL_SHAPE.test(email) || typeof entry.box !== 'string' || entry.box.length > MAX_BOX) throw fail();
  let plain: Buffer;
  try {
    plain = open(Buffer.from(entry.box, 'base64'), sealInfo(selfId, email));
  } catch {
    throw fail();
  }
  let v: unknown;
  try {
    v = JSON.parse(plain.toString('utf8'));
  } catch {
    throw fail();
  } finally {
    plain.fill(0);
  }
  const o = (v && typeof v === 'object' ? v : {}) as { token?: unknown; madeAt?: unknown; oauthAccount?: unknown };
  if (typeof o.token !== 'string' || !TOKEN_SHAPE.test(o.token)) throw fail();
  // Known to the scrubber before anything else can print it.
  rememberToken(o.token);
  const profile = trimProfile(o.oauthAccount && typeof o.oauthAccount === 'object' && !Array.isArray(o.oauthAccount) ? (o.oauthAccount as Record<string, unknown>) : {});
  if (typeof profile.emailAddress === 'string' && profile.emailAddress.toLowerCase() !== email) throw fail();
  profile.emailAddress = email;
  const made = typeof o.madeAt === 'string' && Number.isFinite(Date.parse(o.madeAt)) ? new Date(o.madeAt).toISOString() : undefined;
  return { email, token: o.token, ...(made ? { madeAt: made } : {}), oauthAccount: profile };
}

/** Where a runner keeps its logins, and claude-main's own files a shared login links to. */
export type ShareLayout = {
  accountsDir: string;
  tokenStatsAccountsDir?: string;
  claudeMainDir: string;
  claudeMainJson: string;
  platform?: NodeJS.Platform;
  // Windows: the folder made this user's only (win-acl.ts) before the token goes in.
  makePrivate?: (dir: string) => Promise<string | undefined>;
  now?: () => Date;
};

type Marker = { email: string; sharedAt?: string };

function readMarker(dir: string): Marker | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8')) as { email?: unknown; sharedAt?: unknown };
    return typeof m.email === 'string' && m.email ? { email: m.email.toLowerCase(), ...(typeof m.sharedAt === 'string' ? { sharedAt: m.sharedAt } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

function listNames(dir: string | undefined): string[] {
  if (!dir) return [];
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** A folder itself, not a link or junction to one. */
function realFolder(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The login folders this runner got from the main Mac, by email. */
export function sharedFolders(accountsDir: string): Map<string, { id: string; dir: string }> {
  const out = new Map<string, { id: string; dir: string }>();
  for (const name of listNames(accountsDir).sort()) {
    if (!/^claude-\d+$/.test(name)) continue;
    const dir = path.join(accountsDir, name);
    // A real folder only: one that's a link (or a Windows junction) leads
    // somewhere this never made, which a renewal or removal mustn't touch.
    const m = realFolder(dir) ? readMarker(dir) : undefined;
    if (m && !out.has(m.email)) out.set(m.email, { id: name, dir });
  }
  return out;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function writeToken(dir: string, l: SharedLogin): void {
  atomicWriteFileSync(path.join(dir, TOKEN_FILE), JSON.stringify({ token: l.token, ...(l.madeAt ? { madeAt: l.madeAt } : {}) }) + '\n', 0o600);
}

function writeMarker(dir: string, email: string, now: Date): void {
  atomicWriteFileSync(path.join(dir, MARKER_FILE), JSON.stringify({ email, sharedAt: now.toISOString() }) + '\n', 0o600);
}

// That runner's own .claude.json with this login's profile in it: the CLI
// reads the account from there (accounts.ts readLoginProfile reads the
// email). An API key the runner's own login keeps there is left out.
function claudeJsonFor(layout: ShareLayout, l: SharedLogin): string {
  let base: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(layout.claudeMainJson, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
  } catch {
    base = {};
  }
  const { oauthAccount: _o, primaryApiKey: _k, ...rest } = base;
  return JSON.stringify({ ...rest, oauthAccount: l.oauthAccount }, null, 2) + '\n';
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Links CLAUDE.md, settings.json and skills to claude-main's, where it has
// them. Never over a file of the login's own. On Windows a folder is linked
// as a junction (no Developer Mode needed); a file that can't be linked is
// left out and said.
function linkShared(layout: ShareLayout, dir: string): string[] {
  const said: string[] = [];
  const win = (layout.platform ?? process.platform) === 'win32';
  for (const name of SHARED_LINKS) {
    const target = path.join(layout.claudeMainDir, name);
    const link = path.join(dir, name);
    if (!fs.existsSync(target)) continue;
    if (isLink(link)) {
      if (fs.readlinkSync(link) === target || path.resolve(fs.readlinkSync(link)) === path.resolve(target)) continue;
      if (fs.existsSync(link)) continue;
      fs.unlinkSync(link);
    } else if (fs.existsSync(link)) continue;
    const folder = fs.statSync(target).isDirectory();
    try {
      fs.symlinkSync(target, link, win ? (folder ? 'junction' : 'file') : undefined);
    } catch (e) {
      said.push(`${name} isn't shared with claude-main here (${(e as NodeJS.ErrnoException).code ?? 'no link'}${win ? ': Windows needs Developer Mode to link a file' : ''})`);
    }
  }
  return said;
}

function nextId(layout: ShareLayout): string {
  const taken = new Set([...listNames(layout.accountsDir), ...listNames(layout.tokenStatsAccountsDir)].map((n) => n.toLowerCase()));
  let n = 1;
  while (taken.has(`claude-${n}`)) n++;
  return `claude-${n}`;
}

async function addLogin(layout: ShareLayout, l: SharedLogin, now: Date): Promise<{ accountId: string; said: string[] }> {
  fs.mkdirSync(layout.accountsDir, { recursive: true, mode: 0o700 });
  const id = nextId(layout);
  const temp = path.join(layout.accountsDir, `.${id}.partial-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(temp, { mode: 0o700 });
  try {
    const problem = await layout.makePrivate?.(temp);
    if (problem) throw new Error(`Couldn't make ${id}'s folder private: ${problem}`);
    // The marker first, so a folder that's here at all is one this made.
    writeMarker(temp, l.email, now);
    writeToken(temp, l);
    atomicWriteFileSync(path.join(temp, '.claude.json'), claudeJsonFor(layout, l), 0o600);
    const said = linkShared(layout, temp);
    const final = path.join(layout.accountsDir, id);
    if (fs.existsSync(final)) throw new Error(`${id} appeared while it was being made; try again.`);
    renameWithRetry(temp, final);
    return { accountId: id, said };
  } catch (e) {
    fs.rmSync(path.join(temp, TOKEN_FILE), { force: true });
    fs.rmSync(temp, { recursive: true, force: true });
    throw e;
  }
}

// A login folder that goes: its token first, then the folder set aside
// (its sessions stay, for threads that ran on it), out of discovery's sight.
// Moved first, so a folder Windows holds open stays a whole login rather
// than one with no token; then its token goes from where it is now.
function removeLogin(layout: ShareLayout, id: string, dir: string, now: Date): void {
  if (!realFolder(dir)) throw new Error(`${id} isn't a folder of its own here.`);
  const aside = path.join(layout.accountsDir, REMOVED_DIR);
  fs.mkdirSync(aside, { recursive: true, mode: 0o700 });
  const to = path.join(aside, `${id}-${now.toISOString().replace(/[:.]/g, '-')}`);
  renameWithRetry(dir, to);
  dropTokenFiles(to);
}

// The login's own .claude.json with this profile, if it differs; the rest
// of the file as it is.
function updateProfile(dir: string, l: SharedLogin): boolean {
  const file = path.join(dir, '.claude.json');
  let json: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    json = {};
  }
  const was = (json.oauthAccount && typeof json.oauthAccount === 'object' ? json.oauthAccount : {}) as Record<string, unknown>;
  const changed = Object.entries(l.oauthAccount).some(([k, v]) => was[k] !== v);
  if (!changed) return false;
  atomicWriteFileSync(file, JSON.stringify({ ...json, oauthAccount: { ...was, ...l.oauthAccount } }, null, 2) + '\n', 0o600);
  return true;
}

// A real folder directly in `parent`, by where it really is: a link or
// junction there to a folder elsewhere (Token Stats', say) isn't.
function ownFolderIn(child: string, parent: string): boolean {
  if (!realFolder(child)) return false;
  try {
    return path.dirname(fs.realpathSync(child)) === fs.realpathSync(parent);
  } catch {
    return false;
  }
}

// A login folder's token, and any copy a write cut short left beside it
// (atomicWriteFileSync's `.threadbear-token.json.<pid>.<hex>.tmp`).
function dropTokenFiles(dir: string): void {
  fs.rmSync(path.join(dir, TOKEN_FILE), { force: true });
  for (const name of listNames(dir)) if (name.startsWith(`.${TOKEN_FILE}.`) && name.endsWith('.tmp')) fs.rmSync(path.join(dir, name), { force: true });
}

// Folders set aside by a removal that stopped before its token went.
function clearRemoved(accountsDir: string): void {
  const aside = path.join(accountsDir, REMOVED_DIR);
  if (!realFolder(aside)) return;
  for (const name of listNames(aside)) {
    const dir = path.join(aside, name);
    // Only one this set aside: named for its login, with its marker.
    if (/^claude-\d+-/.test(name) && realFolder(dir) && readMarker(dir)) dropTokenFiles(dir);
  }
}

// Abandoned by a runner that stopped partway through making one (addLogin):
// its token goes, then the folder. Applies run one at a time, so none is
// being made now.
function clearPartials(accountsDir: string): void {
  for (const name of listNames(accountsDir)) {
    if (!/^\.claude-\d+\.partial-/.test(name)) continue;
    const dir = path.join(accountsDir, name);
    if (!realFolder(dir)) continue;
    dropTokenFiles(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Makes this runner's shared logins exactly `wanted`: each set up, renewed
 * or taken on, and every marked folder whose email isn't wanted removed.
 * `failed` are emails asked for whose box didn't open: their folders stay.
 * `existing` is this runner's Claude logins as discovered now.
 */
export async function applyShared(layout: ShareLayout, wanted: SharedLogin[], failed: { email: string; message: string }[], existing: Account[]): Promise<ShareAnswer> {
  const now = (layout.now ?? (() => new Date()))();
  clearPartials(layout.accountsDir);
  clearRemoved(layout.accountsDir);
  const mine = sharedFolders(layout.accountsDir);
  // Windows: a folder's access list made this user's only before a token goes in.
  const privately = async (dir: string, id: string) => {
    const problem = await layout.makePrivate?.(dir);
    if (problem) throw new Error(`Couldn't make ${id}'s folder private: ${problem}`);
  };
  const logins: ShareResult[] = [];
  const asked = new Set<string>();
  for (const f of failed) {
    asked.add(f.email);
    logins.push({ email: f.email, state: 'failed', message: f.message });
  }
  for (const l of wanted) {
    if (asked.has(l.email)) continue;
    asked.add(l.email);
    try {
      const had = mine.get(l.email);
      if (had) {
        const now0 = readYearToken(had.dir);
        const same = now0 !== undefined && sameToken(now0.token, l.token) && (now0.madeAt ?? '') === (l.madeAt ?? '');
        // Made private when it was made or taken on; its links (a junction
        // to skills) would fail the Windows helper's check now.
        if (!same) writeToken(had.dir, l);
        for (const name of listNames(had.dir)) if (name.startsWith(`.${TOKEN_FILE}.`) && name.endsWith('.tmp')) fs.rmSync(path.join(had.dir, name), { force: true });
        const profile = updateProfile(had.dir, l);
        const said = linkShared(layout, had.dir);
        logins.push({ email: l.email, state: same && !profile ? 'same' : 'updated', accountId: had.id, ...(said.length ? { message: said.join('; ') } : {}) });
        continue;
      }
      const same = existing.filter((a) => a.provider === 'claude' && a.email?.toLowerCase() === l.email);
      if (same.length) {
        // A folder Mike copied this very token into by hand (the 26 Nov
        // recipe) is this Mac's login already: taken on, so renewals and
        // the switch reach it. Any other was signed in here: left alone.
        const copied = same.find((a) => {
          const theirs = readYearToken(a.configDir);
          return theirs !== undefined && sameToken(theirs.token, l.token) && ownFolderIn(a.configDir, layout.accountsDir);
        });
        // On Windows the helper refuses a folder holding links (a copied
        // folder's skills junction, say): then it's left as it is, as one
        // signed in here would be.
        const unsafe = copied ? await privately(copied.configDir, copied.id).then(() => undefined, (e: Error) => e.message) : undefined;
        if (copied && unsafe) {
          logins.push({ email: l.email, state: 'here', accountId: copied.id, message: `Left as it is: ${unsafe}` });
        } else if (copied) {
          writeMarker(copied.configDir, l.email, now);
          if ((readYearToken(copied.configDir)?.madeAt ?? '') !== (l.madeAt ?? '')) writeToken(copied.configDir, l);
          logins.push({ email: l.email, state: 'adopted', accountId: copied.id });
        } else {
          logins.push({ email: l.email, state: 'here', accountId: same[0]!.id });
        }
        continue;
      }
      const made = await addLogin(layout, l, now);
      logins.push({ email: l.email, state: 'added', accountId: made.accountId, ...(made.said.length ? { message: made.said.join('; ') } : {}) });
    } catch (e) {
      logins.push({ email: l.email, state: 'failed', message: `Couldn't set up ${l.email}: ${(e as Error).message}` });
    }
  }
  const removed: ShareAnswer['removed'] = [];
  for (const [email, { id, dir }] of mine) {
    if (asked.has(email)) continue;
    try {
      removeLogin(layout, id, dir, now);
      removed.push({ email, accountId: id });
    } catch (e) {
      logins.push({ email, state: 'failed', accountId: id, message: `Couldn't remove ${id}: ${(e as Error).message}` });
    }
  }
  return { logins, removed };
}

// ------------------------------------------------------------ the switches, on the main Mac

export type ShareRowState = 'off' | 'sending' | 'ok' | 'waiting' | 'failed';
/** runners.sharedLogins's row for one runner. */
export type ShareRow = { runnerId: string; on: boolean; state: ShareRowState; at?: string; message?: string; logins?: ShareResult[] };

// `digest`: what last landed; `tried`: what was last sent, landed or not.
// `unlisted`: emails that runner removed but its shared-logins list still
// has, kept until the list is put right.
// `listed`: emails this put on that runner's list, so a removal whose answer
// never came back still comes off it.
type Saved = { on: boolean; digest?: string; tried?: string; state: ShareRowState; at?: string; message?: string; logins?: ShareResult[]; unlisted?: string[]; listed?: string[] };
type SavedFile = { runners: Record<string, Saved> };
const ROW_STATES: readonly ShareRowState[] = ['off', 'sending', 'ok', 'waiting', 'failed'];

export type SharerDeps = {
  file: string; // <data dir>/login-share.json
  accounts: () => Account[];
  pools: () => Pool[];
  claudeMainJson: string;
  // Why this runner can't share now (not the owner key, sync off, an older
  // backend), or undefined when it can.
  blocked: () => string | undefined;
  // Another runner by id, from the sidebar's list (live while the app is
  // open): undefined if it doesn't know it.
  runner: (runnerId: string) => { name: string; online: boolean; box?: boolean; self?: boolean } | undefined;
  // The runners heard from in the last few minutes, asked of the backend
  // now: the timer's word, as the sidebar's list stops updating while no
  // app is open. Undefined when it can't be asked.
  online?: () => Promise<Set<string> | undefined>;
  // Whether the backend has a row for that runner at all, asked now; undefined
  // when it can't be asked. The sidebar's list is empty for a while after a
  // start, so its not knowing one proves nothing.
  known?: (runnerId: string) => Promise<boolean | undefined>;
  sealKey: (runnerId: string) => Promise<string>;
  share: (runnerId: string, logins: SealedLogin[]) => Promise<ShareAnswer>;
  // That runner's shared-logins list (Runner keys, "Shared logins"): these
  // emails added and those taken out, the rest as it was.
  setShared?: (runnerId: string, add: string[], remove: string[]) => Promise<void>;
  clock: Clock;
  log: Logger;
};

/**
 * The Runners panel's switches and their sends. One send per runner at a
 * time; asked for meanwhile, one more goes after it.
 */
export class LoginSharer {
  private saved: SavedFile;
  private going = new Map<string, Promise<ShareRow>>();
  private next = new Map<string, Promise<ShareRow>>();
  private timer: TimerHandle | undefined;
  private stopped = false;
  private checking: Promise<void> | undefined;
  private deps: SharerDeps;

  constructor(deps: SharerDeps) {
    this.deps = deps;
    this.saved = this.load();
  }

  private load(): SavedFile {
    try {
      const v = JSON.parse(fs.readFileSync(this.deps.file, 'utf8')) as { runners?: unknown };
      const runners: Record<string, Saved> = {};
      if (v.runners && typeof v.runners === 'object') {
        for (const [id, r] of Object.entries(v.runners as Record<string, Partial<Saved>>)) {
          if (!r || typeof r !== 'object' || typeof r.on !== 'boolean') continue;
          const state = ROW_STATES.includes(r.state as ShareRowState) && r.state !== 'sending' ? (r.state as ShareRowState) : 'waiting';
          runners[id] = { on: r.on, state, ...(typeof r.digest === 'string' ? { digest: r.digest } : {}), ...(typeof r.tried === 'string' ? { tried: r.tried } : {}), ...(typeof r.at === 'string' ? { at: r.at } : {}), ...(typeof r.message === 'string' ? { message: r.message } : {}), ...(Array.isArray(r.logins) ? { logins: r.logins } : {}), ...(Array.isArray(r.unlisted) ? { unlisted: r.unlisted.filter((e): e is string => typeof e === 'string') } : {}), ...(Array.isArray(r.listed) ? { listed: r.listed.filter((e): e is string => typeof e === 'string') } : {}) };
        }
      }
      return { runners };
    } catch {
      return { runners: {} };
    }
  }

  // `strict`: a switch flipped is kept before anything is sent, or not at
  // all, so a restart can't bring back a switch Mike turned off.
  private save(strict = false): void {
    try {
      atomicWriteFileSync(this.deps.file, JSON.stringify(this.saved, null, 2) + '\n', 0o600);
    } catch (e) {
      if (strict) throw new Error(`Couldn't save the switch: ${(e as Error).message}`);
      this.deps.log.warn("couldn't save the shared logins' switches", { error: String(e) });
    }
  }

  // `sending` while a send is going, unless it's that send's own answer.
  private row(runnerId: string, live = true): ShareRow {
    const s = this.saved.runners[runnerId];
    if (!s) return { runnerId, on: false, state: 'off' };
    return { runnerId, on: s.on, state: live && this.going.has(runnerId) ? 'sending' : s.state, ...(s.at ? { at: s.at } : {}), ...(s.message ? { message: s.message } : {}), ...(s.logins ? { logins: s.logins } : {}) };
  }

  /** Why this runner can't share (the app hides the switch), or undefined. */
  blocked(): string | undefined {
    return this.deps.blocked();
  }

  /** runners.sharedLogins: every runner with its switch on, or still being turned off. */
  list(): ShareRow[] {
    if (this.deps.blocked()) return [];
    return Object.keys(this.saved.runners).map((id) => this.row(id));
  }

  /** runners.shareLogins: sets the switch and answers once its first send has landed or failed. */
  async set(runnerId: string, on: boolean): Promise<ShareRow> {
    if (this.stopped) throw new Error('This runner is handing over to a new one; try again in a moment.');
    const why = this.deps.blocked();
    if (why) throw new Error(why);
    let r = this.deps.runner(runnerId);
    if (!r) {
      const known = await this.deps.known?.(runnerId).catch(() => undefined);
      if (this.stopped) throw new Error('This runner is handing over to a new one; try again in a moment.');
      // One the backend no longer has (its key revoked and its rows gone):
      // nothing to reach, so off just forgets it.
      if (known === false && !on && this.saved.runners[runnerId]) {
        const was = this.saved.runners[runnerId];
        delete this.saved.runners[runnerId];
        try {
          this.save(true);
        } catch (e) {
          this.saved.runners[runnerId] = was;
          throw e;
        }
        return this.row(runnerId);
      }
      // Known, but not in the sidebar's list yet (just after a start): off
      // is kept as if it were offline, for the timer to send; on waits for
      // the list, which says whether it's a box.
      if (known && !on) r = { name: runnerId, online: false };
    }
    if (!r || r.self) throw new Error("That isn't another of your runners.");
    if (r.box) throw new Error("A virtual runner's box runs on its own cloud token, not this Mac's logins.");
    const was = this.saved.runners[runnerId];
    if (!on && !was) return this.row(runnerId);
    // A switch flipped means a send, whatever went before. Emails still to
    // come off that runner's list stay owed.
    this.saved.runners[runnerId] = { on, state: 'waiting', ...(was?.logins ? { logins: was.logins } : {}), ...(was?.unlisted?.length ? { unlisted: was.unlisted } : {}), ...(was?.listed?.length ? { listed: was.listed } : {}) };
    try {
      this.save(true);
    } catch (e) {
      if (was) this.saved.runners[runnerId] = was;
      else delete this.saved.runners[runnerId];
      throw e;
    }
    // Offline: nothing queued to wait in the backend; the timer sends what's
    // true then once it's back.
    if (!r.online) {
      const s = this.saved.runners[runnerId]!;
      Object.assign(s, { at: new Date(this.deps.clock.now()).toISOString(), message: `${r.name} is offline: this goes when it's back.` });
      this.save();
      return this.row(runnerId);
    }
    return this.send(runnerId);
  }

  private wanted(): string {
    return digestOf(gatherLogins(shareable(this.deps.accounts(), this.deps.pools()), this.deps.claudeMainJson));
  }

  /**
   * Sends to each runner whose logins differ from what was last sent; with
   * `retry` (the timer), also to each whose last send didn't land. Only to
   * runners that are online: the timer finds the rest when they're back.
   */
  async check(retry = false): Promise<void> {
    if (this.stopped || this.deps.blocked() || !Object.keys(this.saved.runners).length) return;
    let wanted: string | undefined;
    const due: string[] = [];
    for (const [id, s] of Object.entries(this.saved.runners)) {
      if (this.going.has(id)) continue;
      const now = s.on ? (wanted ??= this.wanted()) : '';
      if (retry ? s.state !== 'ok' || s.digest !== now : s.tried !== now) due.push(id);
    }
    if (!due.length) return;
    const fresh = await this.deps.online?.().catch(() => undefined);
    for (const id of due) {
      const online = fresh ? fresh.has(id) : this.deps.runner(id)?.online === true;
      if (online && !this.stopped) void this.send(id).catch(() => undefined);
    }
  }

  /** Once every send going (and one asked for after it) has finished: for tests and a clean stop. */
  async idle(): Promise<void> {
    await this.checking;
    while (this.going.size || this.next.size) await Promise.allSettled([...this.going.values(), ...this.next.values()]);
  }

  start(): void {
    const tick = () => {
      this.timer = this.deps.clock.setTimeout(() => {
        if (this.stopped) return;
        this.checking = this.check(true).catch(() => undefined);
        tick();
      }, RECHECK_MS);
    };
    tick();
  }

  /** Stopped: handing over, or the runner stopping. */
  isStopped(): boolean {
    return this.stopped;
  }

  // Stopped (the runner stopping, or handing over to a new release): no
  // more sends, and no switch flipped here, so two never write the file.
  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
  }

  private send(runnerId: string): Promise<ShareRow> {
    if (this.stopped) return Promise.resolve(this.row(runnerId, false));
    const going = this.going.get(runnerId);
    if (going) {
      let next = this.next.get(runnerId);
      if (!next) {
        next = going.then(
          () => undefined,
          () => undefined,
        ).then(() => {
          this.next.delete(runnerId);
          return this.send(runnerId);
        });
        this.next.set(runnerId, next);
      }
      return next;
    }
    const p = this.sendOnce(runnerId).finally(() => this.going.delete(runnerId));
    this.going.set(runnerId, p);
    return p;
  }

  private async sendOnce(runnerId: string): Promise<ShareRow> {
    const s = this.saved.runners[runnerId];
    if (!s) return this.row(runnerId);
    const on = s.on;
    const name = this.deps.runner(runnerId)?.name ?? runnerId;
    const finish = (patch: Partial<Saved>): ShareRow => {
      const cur = this.saved.runners[runnerId];
      // Gone, or flipped while this went: the send after it says.
      if (!cur || cur.on !== on) return this.row(runnerId, false);
      // Stopped meanwhile: the new runner has the file now.
      if (this.stopped) return this.row(runnerId, false);
      // Turned off and done: nothing left to keep.
      if (!on && patch.state === 'ok') delete this.saved.runners[runnerId];
      else {
        delete cur.message;
        Object.assign(cur, { at: new Date(this.deps.clock.now()).toISOString() }, patch);
      }
      this.save();
      return this.row(runnerId, false);
    };
    let digest = '';
    try {
      const logins = on ? gatherLogins(shareable(this.deps.accounts(), this.deps.pools()), this.deps.claudeMainJson) : [];
      digest = on ? digestOf(logins) : '';
      s.tried = digest;
      const key = logins.length ? await this.deps.sealKey(runnerId) : undefined;
      // Handed over meanwhile: the new runner sends from here on.
      if (this.stopped) return this.row(runnerId, false);
      const sealed = key ? sealLogins(runnerId, key, logins) : [];
      // That runner's word, checked: only emails this sent go on its list
      // (Gemini's review: a runner key could otherwise name any login).
      const answer = cleanAnswer(await this.deps.share(runnerId, sealed), new Set(logins.map((l) => l.email)));
      const there = answer.logins.filter((l) => ['added', 'updated', 'same', 'adopted'].includes(l.state)).map((l) => l.email);
      // Removed now, or before and still on the list: kept until it's put right.
      // Off its list: what it removed now, what an earlier update missed,
      // and what this listed before that isn't there now (a removal whose
      // answer was lost), unless it failed there and may still be.
      const failedThere = new Set(answer.logins.filter((l) => l.state === 'failed').map((l) => l.email));
      const cur0 = this.saved.runners[runnerId];
      const remove = [...new Set([...answer.removed.map((r) => r.email), ...(cur0?.unlisted ?? []), ...(cur0?.listed ?? []).filter((e) => !failedThere.has(e))])].filter((e) => !there.includes(e));
      if (this.stopped) return this.row(runnerId, false);
      // Owed before it's granted: a crash after the grant still knows to take it off.
      // Not saved, not granted: the send fails and is tried again.
      if (cur0 && there.some((e) => !cur0.listed?.includes(e))) {
        cur0.listed = [...new Set([...(cur0.listed ?? []), ...there])];
        this.save(true);
      }
      let listNote: string | undefined;
      try {
        await this.deps.setShared?.(runnerId, there, remove);
        const cur = this.saved.runners[runnerId];
        if (cur) {
          delete cur.unlisted;
          const listed = [...new Set([...(cur.listed ?? []), ...there])].filter((e) => !remove.includes(e));
          if (listed.length) cur.listed = listed;
          else delete cur.listed;
        }
      } catch (e) {
        const cur = this.saved.runners[runnerId];
        if (cur) cur.unlisted = remove;
        listNote = `Couldn't update ${name}'s shared logins list: ${(e as Error).message}`;
      }
      const failed = answer.logins.filter((l) => l.state === 'failed');
      this.deps.log.info('shared logins sent', { runnerId, on, logins: answer.logins.map((l) => `${l.email} ${l.state}`), removed: answer.removed.map((r) => r.accountId) });
      const message = [...failed.map((f) => f.message ?? `${f.email} failed.`), ...(listNote ? [listNote] : [])].join(' ');
      return finish({ state: failed.length || listNote ? 'failed' : 'ok', logins: answer.logins, ...(failed.length ? {} : { digest }), ...(message ? { message } : {}) });
    } catch (e) {
      const text = (e as Error)?.message ?? String(e);
      const offline = /is offline|hasn't answered yet/.test(text);
      this.deps.log.warn("couldn't send shared logins", { runnerId, on, error: text });
      return finish({ state: offline ? 'waiting' : 'failed', message: offline ? `${name} is offline: they go when it's back.` : text });
    }
  }
}

const STATES: readonly ShareState[] = ['added', 'updated', 'same', 'adopted', 'here', 'failed'];
const short = (x: unknown, n: number) => (typeof x === 'string' ? x.slice(0, n) : undefined);

/**
 * A share's answer as the other runner gave it, checked: each line an email
 * this sent and a state it knows, and removed ones only emails (any: taking
 * a login off its own list only takes from it).
 */
export function cleanAnswer(raw: unknown, sent: Set<string>): ShareAnswer {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { logins?: unknown; removed?: unknown };
  const logins: ShareResult[] = [];
  for (const l of Array.isArray(o.logins) ? o.logins.slice(0, MAX_SHARED * 2) : []) {
    const x = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    const email = typeof x.email === 'string' ? x.email.toLowerCase() : '';
    // A failure is let through for any email (a removal there that didn't
    // go, on switch-off), so it's tried again; anything else only for one sent.
    if (!STATES.includes(x.state as ShareState) || (x.state !== 'failed' ? !sent.has(email) : !EMAIL_SHAPE.test(email))) continue;
    const accountId = typeof x.accountId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x.accountId) ? x.accountId : undefined;
    const message = short(x.message, 400);
    logins.push({ email, state: x.state as ShareState, ...(accountId ? { accountId } : {}), ...(message ? { message } : {}) });
  }
  const removed: ShareAnswer['removed'] = [];
  for (const r of Array.isArray(o.removed) ? o.removed.slice(0, MAX_SHARED * 2) : []) {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const email = typeof x.email === 'string' ? x.email.toLowerCase() : '';
    if (EMAIL_SHAPE.test(email) && typeof x.accountId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x.accountId)) removed.push({ email, accountId: x.accountId });
  }
  return { logins, removed };
}

/** The shared-logins list with these emails added and those taken out, or undefined when it's the same. */
export function mergedList(current: { provider: string; email: string }[], add: string[], remove: string[]): { provider: string; email: string }[] | undefined {
  const key = (p: string, e: string) => `${p.toLowerCase()}:${e.toLowerCase()}`;
  const gone = new Set(remove.map((e) => key('claude', e)));
  const out = current.filter((l) => !gone.has(key(l.provider, l.email)));
  const have = new Set(out.map((l) => key(l.provider, l.email)));
  for (const e of add) if (!have.has(key('claude', e))) out.push({ provider: 'claude', email: e.toLowerCase() }), have.add(key('claude', e));
  const same = out.length === current.length && out.every((l, i) => key(l.provider, l.email) === key(current[i]!.provider, current[i]!.email));
  return same ? undefined : out;
}
