// Shared by the runner-facing and phone-facing functions: who may call what.
import { ConvexError } from 'convex/values';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { BOX_KEY_PREFIX, BOX_READS, callerFrom, FORBIDDEN, forbiddenMessage, isOwnerKey, mayCall, validRunnerId, type Caller } from './runnerAccess';

// A runner's word that Mike is at its Mac counts while it's still checking
// in; a Mac that's asleep or offline counts as away (devices.ts
// threadForPush, sync.ts sendStaleHeldPushes).
export const PRESENCE_FRESH_MS = 3 * 60_000;

// Whether Mike counts as at this runner's Mac now: it said so and is still
// checking in. One reading for every place that decides it (a push, holding
// one, draining held ones), so they can't disagree.
export async function presentAt(ctx: QueryCtx | MutationCtx, runnerId: string): Promise<boolean> {
  const r = await ctx.db
    .query('runners')
    .withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))
    .unique();
  return Boolean(r?.atMac) && Date.now() - (r?.lastSeenAt ?? 0) < PRESENCE_FRESH_MS;
}

// The runner's functions carry the key from its secrets/convex-key: the
// owner key (the deployment's RUNNER_KEY, set with `npx convex env set
// RUNNER_KEY <key>`) or a runner key (runnerKeys, `tb runner add`). Every
// function in sync.ts starts here under its own name, which
// runnerAccess.ts ACCESS sorts into owner only, its own runner's, or any
// runner's; what "its own" is for each, the function checks with the
// Caller this returns.
// A box key (boxes.ts, tbb_...) is looked up among boxes instead: it's one
// box's, for one runner and one thread (runnerAccess.ts BOX_CALLS).
// `housekeeping`: a box's call that makes no work (a heartbeat or a save's
// finish while its save holds it, sent with `held`), which doesn't mark its
// attempt as holding work (keyUsed). A box saying so falsely only takes its
// own thread's protection away.
export async function runnerAuth(ctx: QueryCtx | MutationCtx, key: string, fn: string, opts: { housekeeping?: boolean } = {}): Promise<Caller> {
  const owners = [process.env.RUNNER_KEY, process.env.RUNNER_KEY_NEXT];
  // The owner key needs no lookup; anything else may be a runner key or a box key.
  const other = Boolean(key) && !isOwnerKey(key, owners);
  const box = other && key.startsWith(BOX_KEY_PREFIX);
  const row = other && !box ? await runnerKeyRow(ctx, key) : null;
  const boxRow = box ? await boxKeyRow(ctx, key) : null;
  const c = callerFrom(key, owners, row, boxRow ? { ...boxRow, _id: boxRow._id as string } : null);
  if (!c) throw new ConvexError({ kind: 'auth', message: 'bad runner key' });
  if (!mayCall(c, fn)) throw forbidden(`call ${fn}: ${c.box ? "a box's key runs its one thread, and nothing else" : "only the main Mac's key (the deployment's RUNNER_KEY) can"}`);
  // A save isn't work (its SAVED says what it covers), and a duplicate one mustn't count as any.
  if (boxRow && !BOX_READS.has(fn) && fn !== 'boxSaved' && !opts.housekeeping) await keyUsed(ctx, boxRow);
  return c;
}

/**
 * Invariant W, where an attempt joins the boxes that may hold work newer
 * than its save: as soon as its key does anything that can make work (any
 * call it makes that can write: a heartbeat, a take, an append, an
 * upload), not only when its box is up by the machine's word. Every box
 * call comes through runnerAuth, so this is the one place. A query can't
 * write, and a query makes no work.
 */
async function keyUsed(ctx: QueryCtx | MutationCtx, row: { _id: unknown; keyAttempt?: number; workAttempts?: number[] }): Promise<void> {
  if (row.keyAttempt === undefined || row.workAttempts?.includes(row.keyAttempt)) return;
  await (ctx as MutationCtx).db.patch(row._id as never, { workAttempts: [...(row.workAttempts ?? []), row.keyAttempt] });
}

async function runnerKeyRow(ctx: QueryCtx | MutationCtx, key: string) {
  const hash = await sha256(key);
  return ctx.db
    .query('runnerKeys')
    .withIndex('by_hash', (q) => q.eq('keyHash', hash))
    .first();
}

async function boxKeyRow(ctx: QueryCtx | MutationCtx, key: string) {
  const hash = await sha256(key);
  return ctx.db
    .query('boxes')
    .withIndex('by_box_key', (q) => q.eq('boxKeyHash', hash))
    .first();
}

// A runner key reaching past its own runner. `what` finishes "This runner's
// key can't ...".
export function forbidden(what: string): ConvexError<{ kind: string; message: string }> {
  return new ConvexError({ kind: FORBIDDEN, message: forbiddenMessage(what) });
}

// A runner id that isn't one (runnerAccess.ts validRunnerId): refused as
// it arrives, before anything compares it.
export function checkRunnerId(runnerId: string): void {
  if (!validRunnerId(runnerId)) throw new ConvexError({ kind: 'badArgs', message: 'runnerId must be 1 to 64 letters, digits, - or _, and not "any"' });
}

// Throws unless the caller may act as `runnerId`. A runner key acts as its
// own runner only. The owner key acts as any runner but one with a live key
// of its own: that Mac should be using its key now, so an old copy of the
// owner key left on it can't go on acting for it.
export async function actAs(ctx: QueryCtx | MutationCtx, c: Caller, runnerId: string): Promise<void> {
  checkRunnerId(runnerId);
  // A box key acts as its box's runner alone, as a runner key does.
  if (!c.owner) {
    if (c.runnerId !== runnerId) throw forbidden(`act as runner ${runnerId}`);
    return;
  }
  if (await hasLiveKey(ctx, runnerId)) throw forbidden(`act as runner ${runnerId} with the main key, as that runner has a key of its own`);
}

export async function hasLiveKey(ctx: QueryCtx | MutationCtx, runnerId: string): Promise<boolean> {
  for await (const row of ctx.db.query('runnerKeys').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))) if (!row.revokedAt) return true;
  return false;
}

// A phone's token (tokens.ts) is checked by its SHA-256 hash; the plain
// token is never stored.
export async function checkPhoneToken(ctx: QueryCtx | MutationCtx, token: string): Promise<{ id: Id<'tokens'>; name: string; expiresAt: number }> {
  const hash = await sha256(token);
  const row = await ctx.db
    .query('tokens')
    .withIndex('by_hash', (q) => q.eq('hash', hash))
    .unique();
  if (!row || row.revokedAt || row.expiresAt < Date.now()) throw new ConvexError({ kind: 'auth', message: 'bad or expired phone token' });
  return { id: row._id, name: row.name, expiresAt: row.expiresAt };
}

// A page size a caller asked for, as a whole number from 1 to `max`. Convex's
// v.number() lets NaN and the infinities through, and Math.min/max/floor keep
// NaN, so a loop bounded by `out.length >= want` would never stop: anything
// that isn't a finite number is refused rather than clamped.
export function pageLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit)) throw new ConvexError({ kind: 'invalid', message: 'limit must be a number' });
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

// A message's or tool body's seq: a whole number from 0 to MAX_SEQ.
// v.number() takes NaN, the infinities, fractions and numbers past 2^53,
// and a runner key's bad seq would break the order of its thread and the
// event ids the main Mac's runner makes from it (seq times 8, plus a few,
// runner/src/relay.ts SCALE), so it's refused where it comes in (Daybreak,
// 15 Nov 2026). Seqs count a thread's events, so this is far past any.
export const MAX_SEQ = 2 ** 49;
export function isSeq(n: unknown): n is number {
  return Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= MAX_SEQ;
}

// shareRekey.ts's run (16 Nov 2026): started, and finished. A run whose
// start is older than SHARE_REKEY_STALE_MS and not finished is started
// again by the next heartbeat (sync.ts).
export const SHARE_REKEY_STARTED = 'share-rekey-2026-11-16';
export const SHARE_REKEY_DONE = 'share-rekey-2026-11-16-done';
export const SHARE_REKEY_STALE_MS = 2 * 60 * 60_000;

export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Someone has a Runners view open: the website's (phone:watchRunners) or the
// Mac app's runner details (sync:watchRunnersFromMac). Runners report their
// figures until this lapses (API 45, 46). Each viewer renews it every 30 s
// at most, so a closed view stops them within RUNNER_WATCH_MS.
export const RUNNER_WATCH_MS = 45_000;
export async function watchRunnersFor(ctx: MutationCtx): Promise<void> {
  const until = Date.now() + RUNNER_WATCH_MS;
  const row = await ctx.db.query('runnerWatch').first();
  if (row) await ctx.db.patch(row._id, { until });
  else await ctx.db.insert('runnerWatch', { until });
}

// Every runner's latest figures (runnerStats), `at` as an ISO string, for
// phone:runnerStats and sync:runnerStatsList alike.
export async function runnerStatsRows(ctx: QueryCtx) {
  const out = [];
  for await (const s of ctx.db.query('runnerStats')) {
    const { _id, _creationTime, at, ...rest } = s;
    out.push({ ...rest, at: new Date(at).toISOString() });
  }
  return out;
}

// Mike's runner order (the runnerOrder row, API 56): set from the phone's
// Settings (phone:setRunnerOrder) or the Mac's (sync:setRunnerOrder, the
// owner key only, API 58), one order for both. New threads that name no
// runner start on the first one online in it (phone.ts mainRunner).
export async function readRunnerOrder(ctx: QueryCtx): Promise<string[]> {
  return (await ctx.db.query('runnerOrder').first())?.runnerIds ?? [];
}

export async function saveRunnerOrder(ctx: MutationCtx, runnerIds: string[]): Promise<void> {
  if (runnerIds.length > 50 || runnerIds.some((id) => !id || id.length > 100)) throw new ConvexError({ kind: 'invalid', message: 'runnerIds must be at most 50 ids of 1 to 100 characters' });
  const ids = [...new Set(runnerIds)];
  const row = await ctx.db.query('runnerOrder').first();
  if (row) await ctx.db.patch(row._id, { runnerIds: ids });
  else await ctx.db.insert('runnerOrder', { runnerIds: ids });
}

// A repo's address with nothing in it that could be a password or token
// (runner/src/move-git.ts withoutCredentials, the same rule): what a move
// stores about a thread's repo is for knowing which repo it is, and the
// runner it goes to can read it. An older runner may still send one whole.
export function withoutCredentials(url: string): string {
  const s = url.trim();
  // scheme://[userinfo@]host/path: the whole user part goes, whatever the
  // scheme, and so do the query and fragment. Only ssh's conventional
  // `git` user stays (GitHub needs it to clone), never anything else in
  // that place, which may be a token (Daybreak 143, 16 Nov 2026).
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)?([^?#]*)(?:[?#].*)?$/i.exec(s);
  if (m) {
    const [, scheme, userinfo, rest] = m;
    const sshy = /^(?:ssh|git\+ssh|ssh\+git):\/\/$/i.test(scheme!);
    const user = userinfo?.slice(0, -1).split(':')[0];
    return `${scheme}${sshy && user === 'git' ? 'git@' : ''}${rest}`;
  }
  // user@host:path, git's scp form: as git reads it, the host ends at the
  // first `:` ahead of any slash, and everything before the last `@` ahead
  // of that goes, unless it's `git`. So an `@` in the path (`team@work/repo`,
  // `@scope/repo`) is the path's and can't hide the user. One with an `@`
  // and then a `:` after that first `:` (`user:token@host:path`, or a path
  // like `team@b:repo`) can't be told apart from a login, so the address
  // goes altogether rather than be guessed at (security review, 17 Nov 2026).
  const slash = s.indexOf('/');
  const before = slash < 0 ? s : s.slice(0, slash);
  const first = before.indexOf(':');
  if (first >= 0 && /@[^:]*:/.test(before.slice(first + 1))) return '';
  const at = first < 0 ? -1 : before.slice(0, first).lastIndexOf('@');
  if (at >= 0) return `${s.slice(0, at) === 'git' ? 'git@' : ''}${s.slice(at + 1)}`;
  // host:path with no user, or a folder: nothing in it is a login.
  return s;
}

// A thread's box on a virtual runner (docs/virtual-runners.md, decision 6):
// its runner counts as reachable, wherever a runner's being online is
// checked, in every state but these, as a message for it wakes or starts a
// box (boxHooks.ts wakeIfAsleep). A failed one too (the next message tries
// a new box), and an archived one with its save (it comes back from it).
// Its runner only heartbeats while its box is up.
export const BOX_UNREACHABLE: readonly string[] = ['destroying', 'expired'];
export function boxStateReachable(kind: string | undefined): boolean {
  return kind !== undefined && !BOX_UNREACHABLE.includes(kind);
}

/** The box row of a box's runner, or null for a machine's. */
export async function boxOfRunner(ctx: QueryCtx | MutationCtx, runner: { runnerId: string; box?: unknown }) {
  if (!runner.box) return null;
  return ctx.db
    .query('boxes')
    .withIndex('by_runnerId', (q) => q.eq('runnerId', runner.runnerId))
    .first();
}

/** The shape of a provider's machine id, as a box sends it (boxes.ts exchange, sync.ts heartbeat). */
export const MACHINE_ID = /^[A-Za-z0-9_-]{1,64}$/;
