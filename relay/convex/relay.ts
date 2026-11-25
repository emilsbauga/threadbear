// The relay's records: installs and the daily counts (schema.ts).
import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { MAX_REASONS, reasonKey } from './reasons';
import { countVersions, storedVersion } from './versions';

// Per install, so one runaway backend can't flood anyone's phone or Apple.
export const SENDS_PER_HOUR = 120;
// Registrations a day for one checked deployment. It only registers again
// when it lost its install, so this only stops a backend stuck in a loop;
// nobody else can use it up, as only the deployment passes the check.
export const REGISTRATIONS_PER_DEPLOYMENT_PER_DAY = 20;

// Relay-wide limits (Daybreak 144, 16 Nov 2026). The check in verify.ts
// proves a caller runs the deployment it names, not that it runs
// Threadbear, and anyone can make Convex deployments, so each new one is
// another 120 sends an hour and another row. These bound what a pile of
// made-up deployments can take, without touching installs that are
// already here: a deployment registering again never counts as new, and
// an install's own allowance only shrinks while it's new or sending to
// tokens that aren't real. Sized well above real use (16 Nov: 69 installs
// active in a week, at most 11 registrations a day, 450 to 750 sends a
// day in all).
//
// Deployments seen for the first time, relay-wide, each UTC day.
export const NEW_INSTALLS_PER_DAY = 100;
// An install this young shares one hourly pool with every other young one.
export const NEW_INSTALL_MS = 7 * 86_400_000;
export const NEW_INSTALL_SENDS_PER_HOUR = 600;
// All sends in an hour, relay-wide (about 200 times a busy hour on 16 Nov).
// Past it, every install still gets RESERVED_SENDS_PER_HOUR of its own, so
// a pile of installs a week old or more can't take the relay from real
// backends, nor push the bill past this plus that floor each.
export const ALL_SENDS_PER_HOUR = 6_000;
export const RESERVED_SENDS_PER_HOUR = 10;
// Sends a device token was to blame for (tokenFault) an install may make in
// an hour. A real backend drops a token Apple or Firebase calls gone, so it
// makes a few; made-up tokens make nothing else.
export const BAD_TOKEN_SENDS_PER_HOUR = 20;
// An install not seen (no send, no registration) for this long loses its
// key (crons.ts). A backend from 5 Nov 2026 just registers again when
// /send answers 401 (convex/push.ts), so only an abandoned one loses
// anything. Its row stays, keyless, for EXPIRED_KEEP_MS, so that backend
// still counts as known when it comes back: made-up deployments using up
// the day's new installs can't keep it out, and it isn't young again.
export const IDLE_INSTALL_MS = 90 * 86_400_000;
export const EXPIRED_KEEP_MS = 365 * 86_400_000;

// A failed send the device token was to blame for, by Apple's or
// Firebase's reason word: a bad, wrong-app, other-project or unregistered
// token. Not the relay's own trouble (a revoked key, Google refusing the
// relay's sign-in, a timeout), which mustn't use up a real backend's
// allowance. By reason, as a status alone mixes the two (Google answers a
// bad sign-in with 400 too).
const TOKEN_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered', 'ExpiredToken', 'UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH']);
export const tokenFault = (status: number | undefined, reason: string | undefined) => (reason !== undefined ? TOKEN_REASONS.has(reason) : status === 410);

// The UTC hour, "2026-11-16T09": every hourly count (an install's and the
// relay's) uses the same windows.
const hourOf = (ms: number) => new Date(ms).toISOString().slice(0, 13);

export const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// For a deployment that passed the check (http.ts, verify.ts): one install
// per deployment, so registering again gives the same install a new key
// and the old key stops working. Its hourly send count carries over.
export const registerVerified = internalMutation({
  args: { deployment: v.string(), version: v.optional(v.string()) },
  returns: v.object({ installId: v.string(), installKey: v.string() }),
  handler: async (ctx, { deployment, version }) => {
    const today = day();
    const existing = await ctx.db
      .query('installs')
      .withIndex('by_deployment', (q) => q.eq('deployment', deployment))
      .first();
    const registeredToday = existing?.registeredDay === today ? (existing.registeredToday ?? 0) : 0;
    if (registeredToday >= REGISTRATIONS_PER_DEPLOYMENT_PER_DAY) throw new ConvexError({ kind: 'busy', message: 'this deployment registered too often today; try again tomorrow' });
    const now = Date.now();
    // A deployment the relay hasn't seen (or forgot, crons.ts) is a new
    // install, and those are capped relay-wide; one it knows never is, so
    // nobody can lock an existing backend out by making deployments.
    if (!existing) await countNewInstall(ctx, today);
    const installKey = 'k_' + randomHex(24);
    const fields = { keyHash: await sha256(installKey), lastSeenAt: now, ...(version !== undefined ? { version: storedVersion(version) } : {}), deployment, registeredDay: today, registeredToday: registeredToday + 1 };
    let installId: string;
    if (existing) {
      installId = existing.installId;
      // An expired one (crons.ts) gets its key back, as the same install.
      await ctx.db.patch(existing._id, { ...fields, expiredAt: undefined });
    } else {
      installId = 'i_' + randomHex(12);
      await ctx.db.insert('installs', { installId, createdAt: now, hourStart: now, hourSends: 0, ...fields });
    }
    await countRegistration(ctx, today);
    return { installId, installKey };
  },
});

// Asked by /register before it calls a deployment back: whether a
// registration for it could succeed now (registerVerified still checks).
// Read-only, as it runs before the call-back says who's asking: it mustn't
// use up anything of the deployment's. The call-back itself is charged to
// startCheck's budget, which is the relay's, not the deployment's.
export const mayRegister = internalQuery({
  args: { deployment: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { deployment }) => {
    const today = day();
    const existing = await ctx.db
      .query('installs')
      .withIndex('by_deployment', (q) => q.eq('deployment', deployment))
      .first();
    if (existing) return (existing.registeredDay === today ? (existing.registeredToday ?? 0) : 0) < REGISTRATIONS_PER_DEPLOYMENT_PER_DAY;
    const counts = await ctx.db
      .query('days')
      .withIndex('by_day', (q) => q.eq('day', today))
      .unique();
    return (counts?.newInstalls ?? 0) < NEW_INSTALLS_PER_DAY;
  },
});

// The call-backs /register makes (Codex Security, 21 Nov 2026, finding
// 156). /register is open to anyone, and each call-back is an outbound
// request that can take VERIFY_TIMEOUT_MS, so they're charged before they
// start, to the relay's own budget, never to a deployment's registrations
// or the day's new installs (a call-back that says no charges nothing of
// those, so nobody can use up a real backend's allowance by naming it):
//
// - Deployments without an established install here (one at least
//   NEW_INSTALL_MS old: anyone can make up names, or make deployments and
//   register them): at most MAX_NEW_CHECKS_IN_FLIGHT at once and
//   NEW_CHECKS_PER_HOUR an hour, relay-wide.
// - Established ones: at most MAX_KNOWN_CHECKS_IN_FLIGHT at once and
//   KNOWN_CHECKS_PER_HOUR an hour, relay-wide, counted apart from the
//   made-up names (their own index range and row, so a flood of those
//   neither uses their allowance nor contends with their writes). Past the
//   hour's pool, each established deployment still gets its first
//   RESERVED_CHECKS_PER_HOUR of the hour, so someone naming others to drain
//   the pool can't stop one they didn't name registering again.
// - One at a time to any one deployment, and none to it for NO_COOLDOWN_MS
//   after it said no.
//
// Real use is far below all of these (16 Nov: at most 11 registrations a
// day, relay-wide). What's left: someone who knows a deployment's name can
// keep it from registering again (not from sending: a working install
// never calls /register) while they keep sending a no for it at least
// every NO_COOLDOWN_MS, and, if they drain the established pool as well,
// for the rest of that hour; made-up names can hold back new installs (and
// an install under a week old registering again) for the hour, as made-up
// deployments already could the day's new installs (NEW_INSTALLS_PER_DAY);
// and established deployments someone registered and kept a week can hold
// the established slots while they keep answering slowly.
export const MAX_NEW_CHECKS_IN_FLIGHT = 15;
export const MAX_KNOWN_CHECKS_IN_FLIGHT = 10;
export const NO_COOLDOWN_MS = 30_000;
export const NEW_CHECKS_PER_HOUR = 600;
export const KNOWN_CHECKS_PER_HOUR = 1_200;
export const RESERVED_CHECKS_PER_HOUR = 5;
// How long a started call-back counts as still going: past verify.ts's
// VERIFY_TIMEOUT_MS with room to spare, for one whose action died before
// endCheck.
export const CHECK_LEASE_MS = 30_000;

// Charges one call-back to `deployment`, or says why not: { check } to
// hand to endCheck once it's answered, or 'limited'.
export const startCheck = internalMutation({
  args: { deployment: v.string() },
  returns: v.union(v.object({ check: v.id('checks') }), v.literal('limited')),
  handler: async (ctx, { deployment }) => {
    const now = Date.now();
    const live = now - CHECK_LEASE_MS;
    const hour = hourOf(now);
    if (await ctx.db.query('checks').withIndex('by_deployment', (q) => q.eq('deployment', deployment).gt('startedAt', live)).first()) return 'limited';
    const hold = await ctx.db
      .query('checkHolds')
      .withIndex('by_deployment', (q) => q.eq('deployment', deployment))
      .unique();
    if (hold?.noUntil !== undefined && hold.noUntil > now) return 'limited';
    const install = await ctx.db
      .query('installs')
      .withIndex('by_deployment', (q) => q.eq('deployment', deployment))
      .first();
    const known = install !== null && now - install.createdAt >= NEW_INSTALL_MS;
    const going = await ctx.db
      .query('checks')
      .withIndex('by_known', (q) => q.eq('known', known).gt('startedAt', live))
      .take(known ? MAX_KNOWN_CHECKS_IN_FLIGHT : MAX_NEW_CHECKS_IN_FLIGHT);
    if (going.length >= (known ? MAX_KNOWN_CHECKS_IN_FLIGHT : MAX_NEW_CHECKS_IN_FLIGHT)) return 'limited';
    const pool = await ctx.db
      .query('checkHours')
      .withIndex('by_hour', (q) => q.eq('hour', hour).eq('known', known))
      .unique();
    const used = pool?.checks ?? 0;
    const mine = hold?.hour === hour ? (hold.count ?? 0) : 0;
    const reserved = known && mine < RESERVED_CHECKS_PER_HOUR;
    if (used >= (known ? KNOWN_CHECKS_PER_HOUR : NEW_CHECKS_PER_HOUR) && !reserved) return 'limited';
    if (pool) await ctx.db.patch('checkHours', pool._id, { checks: used + 1 });
    else await ctx.db.insert('checkHours', { hour, known, checks: 1 });
    if (hold) await ctx.db.patch('checkHolds', hold._id, { at: now, hour, count: mine + 1 });
    else await ctx.db.insert('checkHolds', { deployment, at: now, hour, count: 1 });
    return { check: await ctx.db.insert('checks', { deployment, known, startedAt: now }) };
  },
});

// A call-back answered: it stops counting as going, and a no keeps the
// deployment from being called back for NO_COOLDOWN_MS (a yes lifts that).
// One answered after its lease ran out (a later call-back may have been
// made and answered since) only stops counting.
export const endCheck = internalMutation({
  args: { check: v.id('checks'), vouched: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { check, vouched }) => {
    const row = await ctx.db.get('checks', check);
    if (!row) return null;
    await ctx.db.delete('checks', check);
    const now = Date.now();
    if (row.startedAt <= now - CHECK_LEASE_MS) return null;
    const hold = await ctx.db
      .query('checkHolds')
      .withIndex('by_deployment', (q) => q.eq('deployment', row.deployment))
      .unique();
    const noUntil = vouched ? undefined : now + NO_COOLDOWN_MS;
    if (hold) await ctx.db.patch('checkHolds', hold._id, { at: now, noUntil });
    else if (noUntil !== undefined) await ctx.db.insert('checkHolds', { deployment: row.deployment, at: now, noUntil });
    return null;
  },
});

async function countNewInstall(ctx: MutationCtx, today: string): Promise<void> {
  const counts = await ctx.db
    .query('days')
    .withIndex('by_day', (q) => q.eq('day', today))
    .unique();
  const made = counts?.newInstalls ?? 0;
  if (made >= NEW_INSTALLS_PER_DAY) throw new ConvexError({ kind: 'busy', message: 'the relay has taken all the new installs it takes today; try again tomorrow' });
  if (counts) await ctx.db.patch(counts._id, { newInstalls: made + 1 });
  else await ctx.db.insert('days', { day: today, sends: 0, failed: 0, registrations: 0, newInstalls: 1 });
}

async function countRegistration(ctx: MutationCtx, today: string): Promise<void> {
  const counts = await ctx.db
    .query('days')
    .withIndex('by_day', (q) => q.eq('day', today))
    .unique();
  if (counts) await ctx.db.patch(counts._id, { registrations: counts.registrations + 1 });
  else await ctx.db.insert('days', { day: today, sends: 0, failed: 0, registrations: 1 });
}

// Checks the install's key and rate limit, and counts the send.
export const admit = internalMutation({
  args: { installId: v.string(), installKey: v.string(), version: v.optional(v.string()) },
  // An admitted send's UTC hour, which /send hands back to counted, so a
  // result arriving after the hour turns gives back to the hour it was
  // charged to (only that one).
  returns: v.union(v.object({ hour: v.string() }), v.literal('auth'), v.literal('limited')),
  handler: async (ctx, { installId, installKey, version }) => {
    const row = await ctx.db
      .query('installs')
      .withIndex('by_installId', (q) => q.eq('installId', installId))
      .unique();
    if (!row || row.keyHash !== (await sha256(installKey))) return 'auth';
    const now = Date.now();
    const hour = hourOf(now);
    const fresh = hourOf(row.hourStart) !== hour;
    const sends = fresh ? 0 : row.hourSends;
    // hourBad is charged here, for every send still out, and given back by
    // counted when it turns out the token wasn't to blame, so a burst of
    // sends at once can't all get past it before the first one fails.
    const bad = fresh ? 0 : (row.hourBad ?? 0);
    if (sends >= SENDS_PER_HOUR || bad >= BAD_TOKEN_SENDS_PER_HOUR) return 'limited';
    const pool = await ctx.db
      .query('hours')
      .withIndex('by_hour', (q) => q.eq('hour', hour))
      .unique();
    // Past the relay-wide ceiling, or the young installs' pool for a young
    // one, only each install's reserved few: a pool someone else filled
    // never stops an install's first sends of the hour.
    const reserved = sends < RESERVED_SENDS_PER_HOUR;
    if ((pool?.sends ?? 0) >= ALL_SENDS_PER_HOUR && !reserved) return 'limited';
    // Young installs share one pool, so a batch of new deployments can't
    // each take a full allowance (the limits above say why).
    const young = now - row.createdAt < NEW_INSTALL_MS;
    if (young && (pool?.newSends ?? 0) >= NEW_INSTALL_SENDS_PER_HOUR && !reserved) return 'limited';
    const counts = { sends: (pool?.sends ?? 0) + 1, newSends: (pool?.newSends ?? 0) + (young ? 1 : 0) };
    if (pool) await ctx.db.patch(pool._id, counts);
    else await ctx.db.insert('hours', { hour, ...counts });
    await ctx.db.patch(row._id, { lastSeenAt: now, hourStart: fresh ? now : row.hourStart, hourSends: sends + 1, hourBad: bad + 1, ...(version !== undefined ? { version: storedVersion(version) } : {}) });
    return { hour };
  },
});

// installId and hour (admit's answer) are required, so every route that
// admits gives the charge back: /clear once left them out, and its clears
// that went through all stayed charged (Daybreak 169).
export const counted = internalMutation({
  args: { ok: v.boolean(), status: v.optional(v.number()), reason: v.optional(v.string()), installId: v.string(), hour: v.string() },
  returns: v.null(),
  handler: async (ctx, { ok, status, reason, installId, hour }) => {
    const today = day();
    // admit charged this send to the install's bad-token allowance; give
    // it back unless the token was to blame, and only in the hour it was
    // charged (a later hour started from nothing).
    if (ok || !tokenFault(status, reason)) {
      const row = await ctx.db
        .query('installs')
        .withIndex('by_installId', (q) => q.eq('installId', installId))
        .unique();
      if (row && hourOf(row.hourStart) === hour && (row.hourBad ?? 0) > 0) await ctx.db.patch(row._id, { hourBad: row.hourBad! - 1 });
    }
    const counts = await ctx.db
      .query('days')
      .withIndex('by_day', (q) => q.eq('day', today))
      .unique();
    const add = { sends: ok ? 1 : 0, failed: ok ? 0 : 1 };
    const reasons = { ...(counts?.reasons ?? {}) };
    if (!ok) {
      let key = reasonKey(status ?? 0, reason);
      if (!(key in reasons) && Object.keys(reasons).length >= MAX_REASONS) key = 'other';
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
    const tally = ok ? {} : { reasons };
    if (counts) await ctx.db.patch(counts._id, { sends: counts.sends + add.sends, failed: counts.failed + add.failed, ...tally });
    else await ctx.db.insert('days', { day: today, registrations: 0, ...add, ...tally });
    return null;
  },
});

// For Mike: `npx convex run relay:stats --prod`.
export const stats = internalQuery({
  args: {},
  returns: v.object({ installs: v.number(), activeLast7Days: v.number(), versions: v.record(v.string(), v.number()), days: v.array(v.object({ day: v.string(), sends: v.number(), failed: v.number(), registrations: v.number(), newInstalls: v.optional(v.number()), reasons: v.optional(v.record(v.string(), v.number())) })) }),
  handler: async (ctx) => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    let installs = 0;
    let active = 0;
    const seen: (string | undefined)[] = [];
    for await (const i of ctx.db.query('installs')) {
      if (i.expiredAt !== undefined) continue;
      installs++;
      if (i.lastSeenAt >= weekAgo) active++;
      seen.push(i.version);
    }
    // In a Map, and anything stored before the rule as "other" (versions.ts).
    const versions = countVersions(seen);
    const days = (await ctx.db.query('days').withIndex('by_day').order('desc').take(14)).map(({ day, sends, failed, registrations, newInstalls, reasons }) => ({ day, sends, failed, registrations, ...(newInstalls !== undefined ? { newInstalls } : {}), ...(reasons ? { reasons } : {}) }));
    return { installs, activeLast7Days: active, versions, days };
  },
});

// Removes an install, for someone asking to be forgotten (or a test):
//   npx convex run relay:forget '{"installId":"i_..."}' --prod
export const forget = internalMutation({
  args: { installId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { installId }) => {
    const row = await ctx.db
      .query('installs')
      .withIndex('by_installId', (q) => q.eq('installId', installId))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return Boolean(row);
  },
});

// Daily (crons.ts): takes the key from installs idle for IDLE_INSTALL_MS,
// which then get 401 (a live backend registers again, as the same
// install), removes the keyless rows after EXPIRED_KEEP_MS more, and the
// hourly pools of days gone. A batch at a time, then again until done.
export const EXPIRE_BATCH = 200;
export const expire = internalMutation({
  args: {},
  returns: v.object({ installs: v.number(), removed: v.number(), hours: v.number(), checks: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    // Rows from before the deployment check (5 Nov 2026; no more can be
    // made) never expire: their backend couldn't come back as the same
    // install, and there are only a handful.
    const idle = [];
    for await (const row of ctx.db.query('installs').withIndex('by_expired', (q) => q.eq('expiredAt', undefined).lt('lastSeenAt', now - IDLE_INSTALL_MS))) {
      if (row.deployment === undefined) continue;
      idle.push(row);
      if (idle.length === EXPIRE_BATCH) break;
    }
    for (const row of idle) await ctx.db.patch(row._id, { keyHash: '', expiredAt: now, version: undefined });
    const gone = await ctx.db
      .query('installs')
      .withIndex('by_expired', (q) => q.gt('expiredAt', 0).lt('expiredAt', now - EXPIRED_KEEP_MS))
      .take(EXPIRE_BATCH);
    for (const row of gone) await ctx.db.delete(row._id);
    const old = await ctx.db
      .query('hours')
      .withIndex('by_hour', (q) => q.lt('hour', hourOf(now - 2 * 86_400_000)))
      .take(EXPIRE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    // Call-back records (startCheck, endCheck): a deployment's a day after
    // it was last touched, hourly counts after two days, and any left going by an action
    // that died.
    const holds = await ctx.db
      .query('checkHolds')
      .withIndex('by_at', (q) => q.lt('at', now - 86_400_000))
      .take(EXPIRE_BATCH);
    for (const row of holds) await ctx.db.delete('checkHolds', row._id);
    const checkHours = await ctx.db
      .query('checkHours')
      .withIndex('by_hour', (q) => q.lt('hour', hourOf(now - 2 * 86_400_000)))
      .take(EXPIRE_BATCH);
    for (const row of checkHours) await ctx.db.delete('checkHours', row._id);
    const checked = [...holds, ...checkHours];
    const stuck = await ctx.db
      .query('checks')
      .withIndex('by_startedAt', (q) => q.lt('startedAt', now - CHECK_LEASE_MS))
      .take(EXPIRE_BATCH);
    for (const row of stuck) await ctx.db.delete('checks', row._id);
    if ([idle, gone, old, holds, checkHours, stuck].some((b) => b.length === EXPIRE_BATCH)) await ctx.scheduler.runAfter(0, internal.relay.expire, {});
    return { installs: idle.length, removed: gone.length, hours: old.length, checks: checked.length + stuck.length };
  },
});

// Wipes the test day's counts too, when there was nothing real in it.
export const resetDay = internalMutation({
  args: { day: v.string() },
  returns: v.null(),
  handler: async (ctx, { day }) => {
    const row = await ctx.db
      .query('days')
      .withIndex('by_day', (q) => q.eq('day', day))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});
