// Virtual runners' boxes (docs/virtual-runners.md): the virtual runners
// themselves (runnerServices), starting a thread on one, the cloud tokens
// boxes run Claude Code on, a box's boot token, the exchange that trades it
// for the box's key and secrets, and the steps a box and the service
// report. A box's lifecycle is its state machine (boxMachine.ts); the
// service's actions that call the provider are in boxService.ts.
//
// Randomness and sealing happen in actions only: Convex seeds Math.random
// and crypto.getRandomValues inside queries and mutations so they replay
// the same, which is wrong for keys, tokens and IVs. Mutations only store
// hashes and sealed values, and change state atomically.
//
// Not built yet (docs/virtual-runners.md, "What's built"): starting or
// waking one from the phone.
import { ConvexError, v, type Infer } from 'convex/values';
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { box as boxMachine, cloudToken as tokenMachine, command as commandMachine, machines, queued } from './machines';
import { BOOT_MS } from './boxStates';
import { checkRunnerId, forbidden, MACHINE_ID, runnerAuth, sha256, withoutCredentials } from './lib';
import { commandArgs } from './relay';
import { PROVIDERS } from './boxProviders/types';
import { FLY_SUSPEND_MAX_MB } from './boxProviders/fly';
import { UNSTARTED, WAKES_FROM } from './boxHooks';
import { MOVE_GOING } from './moves';
import { BOX_KEY_DEAD, BOX_KEY_PREFIX, isThreadId, mayUseStorage } from './runnerAccess';
import { deleteIfUnused, endCommandFiles, finishedArgs, MAX_RUNNER_UPLOAD_BYTES, uploadedBy } from './sync';
import { HELD_BACK, scrubText } from './redaction';

// A virtual runner's limits when it's made (runnerServices.limits).
// The smallest box a virtual runner may have (setRunnerService).
export const MIN_BOX_MB = 1024;

export const BOX_LIMITS = { maxBoxes: 5, idleSleepMinutes: 10, maxAwakeHoursPerDay: 8, deleteAfterDays: 14 } as const;

// A boot token (`tbt_`) and a box key (`tbb_`, runnerAccess.ts
// BOX_KEY_PREFIX): 32 random bytes in hex each.
export const BOOT_PREFIX = 'tbt_';
const BOOT_TOKEN = /^tbt_[0-9a-f]{64}$/;
// A login as boxes and cloudTokens name it, and a setup token as Claude
// Code prints it: printable, no spaces, of a sane length.
const LOGIN = /^[^\s\u0000-\u001f\u007f]{1,200}$/;
const TOKEN = /^[\x21-\x7e]{16,1000}$/;
const REPO_CHARS = 2048;

const bad = (message: string) => new ConvexError({ kind: 'badArgs', message });
const conflict = (message: string) => new ConvexError({ kind: 'conflict', message });

// ------------------------------------------------------------ sealing (actions only)

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// This file's deployment settings (BOX_SEAL_KEY, FLY_APP), read in one place.
const setting = (name: 'BOX_SEAL_KEY' | 'FLY_APP'): string | undefined => process.env[name];

// BOX_SEAL_KEY: 32 random bytes in base64, set once per deployment
// (`npx convex env set BOX_SEAL_KEY "$(openssl rand -base64 32)"`).
// Changing it makes every sealed token and thread key unreadable.
async function sealKey(): Promise<CryptoKey> {
  const raw = setting('BOX_SEAL_KEY');
  let bytes: Uint8Array | undefined;
  try {
    bytes = raw ? unb64(raw.trim()) : undefined;
  } catch {
    bytes = undefined;
  }
  if (!bytes || bytes.length !== 32) throw new ConvexError({ kind: 'config', message: 'BOX_SEAL_KEY must be set on this deployment to 32 random bytes in base64' });
  return crypto.subtle.importKey('raw', bytes as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// AES-GCM with a fresh 12-byte IV, as base64(iv || ciphertext). `purpose`
// is bound in as associated data, so one sealed value can't be passed off
// as another (a thread key handed back as a login's token, or one login's
// token as another's).
async function seal(key: CryptoKey, plain: Uint8Array, purpose: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose) }, key, plain as Uint8Array<ArrayBuffer>));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

async function unseal(key: CryptoKey, sealed: string, purpose: string): Promise<Uint8Array> {
  const b = unb64(sealed);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: new TextEncoder().encode(purpose) }, key, b.slice(12)));
}

const tokenPurpose = (login: string) => `cloudToken:${login}`;
const threadKeyPurpose = (threadId: string) => `threadKey:${threadId}`;

// An action's own gate: actions have no database, so runnerAuth runs in a
// query, under the action's own name (runnerAccess.ts ACCESS).
// A box's call through an action is read-only (`housekeeping`): a query
// can't mark its attempt as holding work, and reading makes none.
async function actionAuth(ctx: ActionCtx, key: string, fn: string, opts: { housekeeping?: boolean } = {}): Promise<void> {
  await ctx.runQuery(internal.boxes.authorize, { key, fn, ...(opts.housekeeping ? { housekeeping: true } : {}) });
}

export const authorize = internalQuery({
  args: { key: v.string(), fn: v.string(), housekeeping: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { key, fn, housekeeping }) => {
    await runnerAuth(ctx, key, fn, { housekeeping: housekeeping === true });
    return null;
  },
});

// ------------------------------------------------------------ cloud tokens (decision 10)

/** Sets a login's cloud token: sealed here, never stored or returned in the clear. */
export const setCloudToken = action({
  // madeAt: when `claude setup-token` made it (it lasts a year); now if not said.
  args: { key: v.string(), login: v.string(), token: v.string(), madeAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { key, login, token, madeAt }) => {
    await actionAuth(ctx, key, 'setCloudToken');
    if (!LOGIN.test(login)) throw bad('login must be 1 to 200 characters with no spaces or control characters');
    if (!TOKEN.test(token)) throw bad("that doesn't look like a token from claude setup-token");
    if (madeAt !== undefined && (!Number.isSafeInteger(madeAt) || madeAt < 0 || madeAt > Date.now() + 60_000)) throw bad('madeAt must be a time no later than now');
    const sealed = await seal(await sealKey(), new TextEncoder().encode(token), tokenPurpose(login));
    await ctx.runMutation(internal.boxes.storeCloudToken, { login, sealed, madeAt: madeAt ?? Date.now() });
    return null;
  },
});

// The sealed value and its times are the row's own fields; the machine's
// SET (cloudTokenMachine.ts) makes it valid and releases the boxes waiting
// on the login (releaseForToken).
export const storeCloudToken = internalMutation({
  args: { login: v.string(), sealed: v.string(), madeAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { login, sealed, madeAt }) => {
    // Strictly later than the last, so a box's refusal of the old one (by its setAt) never matches the new one.
    const row = await ctx.db.query('cloudTokens').withIndex('by_login', (q) => q.eq('login', login)).unique();
    const now = Math.max(Date.now(), (row?.setAt ?? 0) + 1);
    const r = row
      ? (await ctx.db.patch(row._id, { sealed, madeAt, setAt: now }), await tokenMachine.send(ctx, row._id, { type: 'SET' }))
      : await tokenMachine.create(ctx, { login, sealed, madeAt, setAt: now } as never, { type: 'SET' });
    if (r.status !== 'done') throw conflict(`The token couldn't be set: ${r.reasons.join(' ')}`);
    return null;
  },
});

// Boxes waiting for a token on the login are released (TOKEN_SET), a page
// at a time, only while its token is still valid (one refused meanwhile
// leaves them waiting). They join their virtual runner's queue for room
// (waitingForRoom), which starts the oldest first, by when each thread
// started, whatever released it (wakeWaiting, run here for each one's
// virtual runner): a token never passes a thread already waiting.
const RELEASE_PAGE = 50;
export const releaseForToken = machines.internalMutation({
  args: { login: v.string() },
  returns: v.null(),
  handler: async (ctx, { login }) => {
    const token = await ctx.db.query('cloudTokens').withIndex('by_login', (q) => q.eq('login', login)).unique();
    if (!token || token.tokenState.kind !== 'valid') return null;
    const waiting = await ctx.db.query('boxes').withIndex('by_login_state', (q) => q.eq('login', login).eq('boxState.kind', 'needsToken')).take(RELEASE_PAGE);
    const services = new Set<Id<'runnerServices'>>();
    for (const row of waiting) if ((await boxMachine.send(ctx, row._id, { type: 'TOKEN_SET' })).status === 'done') services.add(row.serviceId);
    for (const serviceId of services) await ctx.scheduler.runAfter(0, internal.boxes.wakeWaiting, { serviceId });
    if (waiting.length === RELEASE_PAGE) await ctx.scheduler.runAfter(0, internal.boxes.releaseForToken, { login });
    return null;
  },
});

/** Which logins have a cloud token, when each was made and set, and whether it's valid or dead. Never the token. */
export const cloudTokens = query({
  args: { key: v.string() },
  returns: v.array(v.object({ login: v.string(), madeAt: v.number(), setAt: v.number(), state: v.union(v.literal('valid'), v.literal('dead')) })),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'cloudTokens');
    const rows = await ctx.db.query('cloudTokens').withIndex('by_login').collect();
    return rows.map((r) => ({ login: r.login, madeAt: r.madeAt, setAt: r.setAt, state: r.tokenState.kind }));
  },
});

/**
 * A box's turn was refused with the cloud token it was given (a 401): the
 * token is dead (REFUSED), and the thread's card asks Mike for a new one.
 * `setAt` is the token the box has (the exchange's tokenSetAt, or the last
 * boxCloudToken's): a refusal of an older one changes nothing. A box's key only.
 */
export const tokenRefused = mutation({
  args: { key: v.string(), setAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { key, setAt }) => {
    const caller = await runnerAuth(ctx, key, 'tokenRefused');
    if (caller.owner || !caller.box) throw forbidden("say a box's token was refused: only the box's own key can");
    const row = (await ctx.db.query('boxes').withIndex('by_threadId', (q) => q.eq('threadId', caller.box!.threadId)).unique())!;
    const token = await ctx.db.query('cloudTokens').withIndex('by_login', (q) => q.eq('login', row.login)).unique();
    if (token) await tokenMachine.send(ctx, token._id, { type: 'REFUSED', setAt });
    return null;
  },
});

/**
 * Its login's token for a box waiting after a refusal (Box mode, "A refused
 * token"): the token and when it was set while it's valid, else null. A
 * box's key only; reading it isn't work (no workAttempts).
 */
export const boxCloudToken = action({
  args: { key: v.string() },
  returns: v.union(v.null(), v.object({ token: v.string(), setAt: v.number() })),
  handler: async (ctx, { key }): Promise<{ token: string; setAt: number } | null> => {
    await actionAuth(ctx, key, 'boxCloudToken', { housekeeping: true });
    const found: { login: string; sealed: string; setAt: number } | null = await ctx.runQuery(internal.boxes.boxTokenFor, { key });
    if (!found) return null;
    let token: string;
    try {
      token = new TextDecoder().decode(await unseal(await sealKey(), found.sealed, tokenPurpose(found.login)));
    } catch {
      throw new ConvexError({ kind: 'config', message: "The login's cloud token can't be unsealed with this deployment's BOX_SEAL_KEY." });
    }
    return { token, setAt: found.setAt };
  },
});

export const boxTokenFor = internalQuery({
  args: { key: v.string() },
  returns: v.union(v.null(), v.object({ login: v.string(), sealed: v.string(), setAt: v.number() })),
  handler: async (ctx, { key }) => {
    const caller = await runnerAuth(ctx, key, 'boxCloudToken', { housekeeping: true });
    if (caller.owner || !caller.box) throw forbidden("read a box's cloud token: only the box's own key can");
    const row = await ctx.db.query('boxes').withIndex('by_threadId', (q) => q.eq('threadId', caller.box!.threadId)).unique();
    if (!row) return null;
    const token = await ctx.db.query('cloudTokens').withIndex('by_login', (q) => q.eq('login', row.login)).unique();
    if (!token || token.tokenState.kind !== 'valid') return null;
    return { login: token.login, sealed: token.sealed, setAt: token.setAt };
  },
});

// ------------------------------------------------------------ a thread's box row

/**
 * A thread's box row, with a fresh per-thread key sealed here (decision 7).
 * Returns the row's id. boxes:startThread does the same with the thread's
 * runners row and its create beside it, in one step (beginThread).
 */
export const newBox = internalAction({
  args: { serviceId: v.id('runnerServices'), threadId: v.string(), runnerId: v.string(), login: v.string(), repo: v.object({ origin: v.string(), subfolder: v.string(), baseBranch: v.string() }) },
  returns: v.id('boxes'),
  handler: async (ctx, args): Promise<Id<'boxes'>> => {
    const sealedThreadKey = await seal(await sealKey(), crypto.getRandomValues(new Uint8Array(32)), threadKeyPurpose(args.threadId));
    return await ctx.runMutation(internal.boxes.insertBox, { ...args, sealedThreadKey });
  },
});

export const insertBox = internalMutation({
  args: { serviceId: v.id('runnerServices'), threadId: v.string(), runnerId: v.string(), login: v.string(), repo: v.object({ origin: v.string(), subfolder: v.string(), baseBranch: v.string() }), sealedThreadKey: v.string() },
  returns: v.id('boxes'),
  handler: async (ctx, a): Promise<Id<'boxes'>> => addBox(ctx, a),
});

type NewBox = { serviceId: Id<'runnerServices'>; threadId: string; runnerId: string; login: string; repo: { origin: string; subfolder: string; baseBranch: string }; sealedThreadKey: string };

// The row, its machine started (START), and the service's create scheduled
// (boxService.ts createBox): the row has no id while its START runs, so
// the step can't schedule it itself.
async function addBox(ctx: MutationCtx, a: NewBox): Promise<Id<'boxes'>> {
  checkRunnerId(a.runnerId);
  if (!isThreadId(a.threadId)) throw bad("that isn't a thread id");
  if (!LOGIN.test(a.login)) throw bad('login must be 1 to 200 characters with no spaces or control characters');
  for (const f of ['origin', 'subfolder', 'baseBranch'] as const) if (a.repo[f].length > REPO_CHARS || /[\u0000-\u001f]/.test(a.repo[f])) throw bad(`repo.${f} is too long or has control characters`);
  const service = await ctx.db.get(a.serviceId);
  if (!service) throw new ConvexError({ kind: 'notFound', message: 'no such virtual runner' });
  if (await ctx.db.query('boxes').withIndex('by_threadId', (q) => q.eq('threadId', a.threadId)).first()) throw conflict('That thread has a box already.');
  // A box's runner id is its own, for life (decision 3): never a machine's
  // or another box's, so nothing it writes lands on another runner.
  if (await ctx.db.query('boxes').withIndex('by_runnerId', (q) => q.eq('runnerId', a.runnerId)).first()) throw conflict("That runner id is another box's.");
  if (await ctx.db.query('runnerKeys').withIndex('by_runnerId', (q) => q.eq('runnerId', a.runnerId)).first()) throw conflict('That runner id has a runner key.');
  const existing = await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', a.runnerId)).unique();
  if (existing && !existing.box) throw conflict("That runner id is a machine's.");
  const made = await boxMachine.create(
    ctx,
    { serviceId: a.serviceId, threadId: a.threadId, runnerId: a.runnerId, provider: service.provider, login: a.login, repo: { ...a.repo, origin: withoutCredentials(a.repo.origin) }, sealedThreadKey: a.sealedThreadKey, createdAt: Date.now() } as never,
    { type: 'START' },
  );
  if (made.status !== 'done') throw conflict(`The box couldn't be made: ${made.reasons.join(' ')}`);
  // One waiting for its login's cloud token (needsToken) is asked for once it's set (TOKEN_SET).
  if (made.to === 'creating') await ctx.scheduler.runAfter(0, internal.boxService.createBox, { boxId: made.id as Id<'boxes'> });
  return made.id as Id<'boxes'>;
}

// ------------------------------------------------------------ virtual runners (decision 2)

const SERVICE_NAME = /^[^\u0000-\u001f\u007f]{1,80}$/;
const IMAGE = /^[\x21-\x7e]{1,300}$/;
// A virtual runner's image when none is given: the box image this repo's
// workflow builds from main and pushes to the Fly app the boxes live in
// (runner/box/Dockerfile, .github/workflows/box-image.yml), so
// registry.fly.io/<FLY_APP>:latest. It's private to that Fly organisation,
// as it holds Claude Code, which isn't ours to publish: Fly pulls it for the
// app's machines with no credentials. A fork's workflow pushes to its own
// app (docs/forking.md).
function defaultBoxImage(provider: string): string {
  const app = setting('FLY_APP')?.trim();
  if (provider !== 'fly' || !app) throw bad("image must be given: there's no default box image without FLY_APP set on this deployment");
  return `registry.fly.io/${app}:latest`;
}
const REGION = /^[a-z0-9-]{1,20}$/;
// Each limit's whole-number range.
const LIMIT_RANGE = { maxBoxes: [1, 100], idleSleepMinutes: [1, 24 * 60], maxAwakeHoursPerDay: [1, 24], deleteAfterDays: [1, 365] } as const;
type Limits = { maxBoxes: number; idleSleepMinutes: number; maxAwakeHoursPerDay: number; deleteAfterDays: number };
const limitsArg = v.object({ maxBoxes: v.optional(v.number()), idleSleepMinutes: v.optional(v.number()), maxAwakeHoursPerDay: v.optional(v.number()), deleteAfterDays: v.optional(v.number()) });
const limitsV = v.object({ maxBoxes: v.number(), idleSleepMinutes: v.number(), maxAwakeHoursPerDay: v.number(), deleteAfterDays: v.number() });

// The states a box counts toward maxBoxes in: up, or on its way up.
type BoxKind = Doc<'boxes'>['boxState']['kind'];
export const RUNNING: readonly BoxKind[] = ['creating', 'starting', 'awake', 'saving', 'archiving', 'waking'];

/**
 * How many of a virtual runner's boxes are running: up or on the way
 * (RUNNING), or seen running by the billing guard whatever their row's
 * state (seenRunningAt: kept running, a pause that failed, a wake gone on;
 * boxService.ts observe), counting to `upTo` at most: what maxBoxes holds.
 */
export async function countRunning(ctx: QueryCtx, serviceId: Id<'runnerServices'>, upTo: number): Promise<number> {
  let n = await countBoxes(ctx, serviceId, RUNNING, upTo);
  // Those in RUNNING are counted already: left out before counting, read until enough.
  for await (const r of ctx.db.query('boxes').withIndex('by_service_seen', (q) => q.eq('serviceId', serviceId).gt('seenRunningAt', 0))) {
    if (n >= upTo) break;
    if (!RUNNING.includes(r.boxState.kind)) n++;
  }
  return n;
}

// How many of a virtual runner's boxes are in these states, counting to `upTo` at most.
async function countBoxes(ctx: QueryCtx, serviceId: Id<'runnerServices'>, kinds: readonly BoxKind[], upTo: number): Promise<number> {
  let n = 0;
  for (const kind of kinds) {
    if (n >= upTo) break;
    n += (await ctx.db.query('boxes').withIndex('by_service_state', (q) => q.eq('serviceId', serviceId).eq('boxState.kind', kind)).take(upTo - n)).length;
  }
  return n;
}

/** Mike's virtual runners, each with how many boxes are up (or on the way) and asleep. */
export const runnerServices = query({
  args: { key: v.string() },
  returns: v.array(v.object({ serviceId: v.id('runnerServices'), name: v.string(), provider: v.string(), image: v.string(), box: v.object({ cpus: v.number(), memoryMb: v.number() }), region: v.optional(v.string()), limits: limitsV, createdAt: v.number(), running: v.number(), asleep: v.number() })),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'runnerServices');
    const out = [];
    for (const s of await ctx.db.query('runnerServices').take(100)) {
      out.push({ serviceId: s._id, name: s.name, provider: s.provider, image: s.image, box: s.box, ...(s.region !== undefined ? { region: s.region } : {}), limits: s.limits, createdAt: s.createdAt, running: await countRunning(ctx, s._id, 1000), asleep: await countBoxes(ctx, s._id, ['asleep'], 1000) });
    }
    return out;
  },
});

/**
 * Makes a virtual runner, or changes one (`serviceId`): its name, image,
 * box size, region and limits (any left out: BOX_LIMITS, or as they were;
 * the image left out: as it was, or defaultBoxImage).
 * A provider is a virtual runner's for life: another one is a new runner.
 */
export const setRunnerService = mutation({
  args: { key: v.string(), serviceId: v.optional(v.id('runnerServices')), name: v.string(), provider: v.string(), image: v.optional(v.string()), box: v.object({ cpus: v.number(), memoryMb: v.number() }), region: v.optional(v.string()), limits: v.optional(limitsArg) },
  returns: v.id('runnerServices'),
  handler: async (ctx, { key, serviceId, ...a }) => {
    await runnerAuth(ctx, key, 'setRunnerService');
    if (!SERVICE_NAME.test(a.name.trim())) throw bad('name must be 1 to 80 characters with no control characters');
    if (!PROVIDERS.includes(a.provider)) throw bad(`provider must be one of ${PROVIDERS.join(', ')}`);
    // A box that can't pause can't sleep with its memory, and one with work
    // newer than its save then has to be kept running (boxService.ts): so,
    // for now, only sizes the provider can pause.
    if (a.provider === 'fly' && a.box.memoryMb > FLY_SUSPEND_MAX_MB) throw bad(`box.memoryMb must be ${FLY_SUSPEND_MAX_MB} or less: Fly can't pause a bigger box.`);
    if (a.image !== undefined && !IMAGE.test(a.image)) throw bad('image must be an image reference, up to 300 characters with no spaces');
    if (!Number.isSafeInteger(a.box.cpus) || a.box.cpus < 1 || a.box.cpus > 16) throw bad('box.cpus must be a whole number from 1 to 16');
    if (!Number.isSafeInteger(a.box.memoryMb) || a.box.memoryMb < 256 || a.box.memoryMb > 65536 || a.box.memoryMb % 256) throw bad('box.memoryMb must be a multiple of 256 from 256 to 65536');
    // A box's runner holds a save in memory to write it and to restore it
    // (runner/src/box-save.ts SAVE_MAX_UNPACKED_BYTES), beside Claude Code:
    // a box smaller than this could take a save its replacement can't read.
    if (a.box.memoryMb < MIN_BOX_MB) throw bad(`box.memoryMb must be ${MIN_BOX_MB} or more: a smaller box may not have the memory to restore its thread's save.`);
    if (a.region !== undefined && !REGION.test(a.region)) throw bad('region must be a provider region code, like syd');
    const old = serviceId ? await ctx.db.get(serviceId) : null;
    if (serviceId && !old) throw new ConvexError({ kind: 'notFound', message: 'no such virtual runner' });
    if (old && old.provider !== a.provider) throw bad("A virtual runner's provider can't change: make a new one.");
    const limits: Limits = { ...(old?.limits ?? BOX_LIMITS) };
    for (const [k, [lo, hi]] of Object.entries(LIMIT_RANGE) as [keyof Limits, readonly [number, number]][]) {
      const x = a.limits?.[k];
      if (x === undefined) continue;
      if (!Number.isSafeInteger(x) || x < lo || x > hi) throw bad(`limits.${k} must be a whole number from ${lo} to ${hi}`);
      limits[k] = x;
    }
    const fields = { name: a.name.trim(), provider: a.provider, image: a.image ?? old?.image ?? defaultBoxImage(a.provider), box: { cpus: a.box.cpus, memoryMb: a.box.memoryMb }, limits };
    if (old) {
      // A region left out goes: the provider picks one.
      await ctx.db.patch(old._id, { ...fields, region: a.region });
      return old._id;
    }
    return await ctx.db.insert('runnerServices', { ...fields, ...(a.region !== undefined ? { region: a.region } : {}), createdAt: Date.now() });
  },
});

const startArgs = {
  serviceId: v.id('runnerServices'),
  threadId: v.string(),
  // Read on the Mac as moveInfo does, credentials taken out here too (decision 11).
  repo: v.object({ origin: v.string(), subfolder: v.string(), baseBranch: v.string() }),
  // The Claude login the box runs on: a cloudTokens row's.
  login: v.string(),
  // The thread's first message, and how it starts, as a `create` carries them.
  text: v.string(),
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  permissionMode: v.optional(v.string()),
  plan: v.optional(v.boolean()),
  // The folder and login on the Mac it was started from, for its sidebar row only (API 94).
  cwd: v.optional(v.string()),
  accountId: v.optional(v.string()),
};

/**
 * Starts a thread on a virtual runner (decision 6): its runner (a runners
 * row marked `box`, with a runner id of its own for life, decision 3), its
 * box row, and its `create` command, queued for that runner, in one step;
 * then the service makes its first box (boxService.ts createBox). Refused
 * at once past the virtual runner's maxBoxes, saying so.
 */
export const startThread = action({
  args: { key: v.string(), ...startArgs },
  returns: v.object({ runnerId: v.string(), commandId: v.id('commands') }),
  handler: async (ctx, { key, ...a }): Promise<{ runnerId: string; commandId: Id<'commands'> }> => {
    await actionAuth(ctx, key, 'startThread');
    const sealedThreadKey = await seal(await sealKey(), crypto.getRandomValues(new Uint8Array(32)), threadKeyPurpose(a.threadId));
    // Shaped as a runner's own (runner.json's sync.runnerId): 12 hex.
    const runnerId = randomHex(6);
    return await ctx.runMutation(internal.boxes.beginThread, { ...a, runnerId, sealedThreadKey });
  },
});

export const beginThread = internalMutation({
  args: { ...startArgs, runnerId: v.string(), sealedThreadKey: v.string() },
  returns: v.object({ runnerId: v.string(), commandId: v.id('commands') }),
  handler: async (ctx, a) => {
    const service = await ctx.db.get(a.serviceId);
    if (!service) throw new ConvexError({ kind: 'notFound', message: 'no such virtual runner' });
    // As relay.ts queueCommand checks a create's, before anything is written.
    const create = commandArgs('create', { text: a.text, model: a.model, effort: a.effort, permissionMode: a.permissionMode, plan: a.plan });
    const max = service.limits.maxBoxes;
    const running = await countRunning(ctx, a.serviceId, max);
    if (running >= max) throw new ConvexError({ kind: 'limit', message: `${service.name} has ${running} boxes up or starting, its limit. One sleeps once its thread has been idle ${service.limits.idleSleepMinutes} minutes, or archive a thread on it.` });
    checkRunnerId(a.runnerId);
    // A new thread: one that's already somewhere moves to a virtual runner (Order, 5), it isn't started there.
    if (await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', a.threadId)).first()) throw conflict('That thread exists already.');
    if (await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', a.runnerId)).first()) throw conflict('That runner id is taken: start it again.');
    await ctx.db.insert('runners', { runnerId: a.runnerId, name: service.name, version: '', startedAt: '', draining: false, threadCount: 0, lastSeenAt: 0, box: { serviceId: a.serviceId } });
    await addBox(ctx, { serviceId: a.serviceId, threadId: a.threadId, runnerId: a.runnerId, login: a.login, repo: a.repo, sealedThreadKey: a.sealedThreadKey });
    // For its own thread (the box takes only that), from the main Mac.
    const commandId = await queued(ctx, { runnerId: a.runnerId, threadId: a.threadId, kind: 'create', args: { ...create, from: 'mac' }, createdAt: Date.now() });
    // Listed at once, everywhere, before its box has written anything (it may wait a while for a token).
    await ctx.db.insert('threadIndex', firstIndexRow(a));
    return { runnerId: a.runnerId, commandId };
  },
});

// The sidebar row a thread on a virtual runner has from its start: its first
// line as title and preview, starting, until its box's runner writes its own.
const INDEX_TITLE_CHARS = 120;
const INDEX_PREVIEW_CHARS = 300;
function firstIndexRow(a: { runnerId: string; threadId: string; text: string; model?: string; permissionMode?: string; plan?: boolean; cwd?: string; accountId?: string }): Omit<Doc<'threadIndex'>, '_id' | '_creationTime'> {
  // Scrubbed whole, as setThreadIndex scrubs what a runner writes, and before
  // it's cut: a key cut short could slip past the rules that know its shape.
  const line = safeScrub(a.text).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const now = new Date().toISOString();
  const mode = a.plan ? 'plan' : a.permissionMode;
  return {
    runnerId: a.runnerId,
    threadId: a.threadId,
    title: line.slice(0, INDEX_TITLE_CHARS),
    cwd: (a.cwd ?? '').slice(0, REPO_CHARS),
    accountId: (a.accountId ?? '').slice(0, 200),
    provider: 'claude',
    ...(a.model ? { model: a.model.slice(0, 200) } : {}),
    status: 'starting',
    needsYou: false,
    unread: false,
    preview: line.slice(0, INDEX_PREVIEW_CHARS),
    createdAt: now,
    lastActivityAt: now,
    ...(mode ? { permissionMode: mode.slice(0, 16) } : {}),
    updatedMs: Date.now(),
  };
}

// A check that throws holds the text back rather than storing it as it came (sync.ts clean).
function safeScrub(text: string): string {
  try {
    return scrubText(text);
  } catch {
    return HELD_BACK;
  }
}

// ------------------------------------------------------------ boot tokens (decision 5)

async function boxOf(ctx: MutationCtx, threadId: string): Promise<Doc<'boxes'>> {
  const row = await ctx.db.query('boxes').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
  if (!row) throw new ConvexError({ kind: 'notFound', message: 'no box for that thread' });
  return row;
}

// The states a box can be booting in, and so take a boot token.
const BOOTING: readonly string[] = ['creating', 'starting', 'waking'];

/**
 * A boot token for the thread's next box, for a box the main Mac starts
 * itself. The service's own create (boxService.ts claimAttempt) takes the
 * same step, newAttempt. Returned once; only its hash is kept, it lasts
 * BOOT_MS, and a newer one replaces it.
 */
export const mintBootToken = action({
  args: { key: v.string(), threadId: v.string() },
  // attempt: the box this token is for, which the service's CREATED and LOST name.
  returns: v.object({ bootToken: v.string(), expiresAt: v.number(), attempt: v.number() }),
  handler: async (ctx, { key, threadId }): Promise<{ bootToken: string; expiresAt: number; attempt: number }> => {
    await actionAuth(ctx, key, 'mintBootToken');
    const bootToken = BOOT_PREFIX + randomHex(32);
    const stored: { expiresAt: number; attempt: number } = await ctx.runMutation(internal.boxes.storeBootToken, { threadId, bootHash: await sha256(bootToken) });
    return { bootToken, ...stored };
  },
});

export const storeBootToken = internalMutation({
  args: { threadId: v.string(), bootHash: v.string() },
  returns: v.object({ expiresAt: v.number(), attempt: v.number() }),
  handler: async (ctx, { threadId, bootHash }) => {
    const row = await boxOf(ctx, threadId);
    if (!BOOTING.includes(row.boxState.kind)) throw conflict(`The box is ${row.boxState.kind}, so it isn't booting.`);
    return newAttempt(ctx, row, bootHash);
  },
});

/**
 * A new attempt at a box, numbered after every one before, with its boot
 * token's hash (BOOT_MS). Invariant W(c), here and only here for both ways
 * a box is asked for (the service's claimAttempt, the owner's
 * mintBootToken): none while a box of the thread may hold work newer than
 * the newest save it made (workAttempts) and the provider hasn't said it's
 * gone. That box is resumed, or waited on, instead.
 */
export function mayMintAttempt(row: Pick<Doc<'boxes'>, 'workAttempts'>): boolean {
  return !(row.workAttempts?.length);
}
export async function newAttempt(ctx: MutationCtx, row: Doc<'boxes'>, bootHash: string): Promise<{ expiresAt: number; attempt: number }> {
  if (!mayMintAttempt(row)) throw conflict(`A box of this thread (attempt ${row.workAttempts!.join(', ')}) may hold work newer than its save: it's resumed or waited on, not replaced.`);
  // The fence: the older box's key is revoked in this same step, so it can
  // make no work behind the new attempt (it had none since its save).
  if (row.boxKeyHash !== undefined) await ctx.db.patch(row._id, { boxKeyHash: undefined, keyAttempt: undefined, keyMachineId: undefined, unsure: undefined });
  const expiresAt = Date.now() + BOOT_MS;
  const attempt = (row.boxAttempt ?? 0) + 1;
  await ctx.db.patch(row._id, { bootTokenHash: bootHash, bootExpiresAt: expiresAt, bootAttempt: attempt, boxAttempt: attempt });
  return { expiresAt, attempt };
}

const exchanged = v.object({
  // Made here only for a box that sent no boxKeyHash (made its own key).
  boxKey: v.optional(v.string()),
  runnerId: v.string(),
  threadId: v.string(),
  claudeToken: v.string(),
  // The per-thread key, base64: the box seals its saves with it (decision 7).
  threadKey: v.string(),
  repo: v.object({ origin: v.string(), subfolder: v.string(), baseBranch: v.string() }),
  // The last save, to restore from; null for a thread's first box.
  save: v.union(v.null(), v.object({ url: v.string(), at: v.number(), bytes: v.number() })),
  // The Claude login the box runs on, as its cloud token is kept (an email):
  // a token login writes no oauthAccount, so the box's runner is told it.
  login: v.string(),
  // When the login's token was set (API 94): what the box names in
  // tokenRefused, and what a newer one from boxCloudToken is newer than.
  tokenSetAt: v.number(),
});

type Exchanged = Infer<typeof exchanged>;
type Peeked = { login: string; threadId: string; sealedToken: string; sealedThreadKey: string; tokenSetAt: number };
type Claimed = { runnerId: string; threadId: string; repo: Exchanged['repo']; save: Exchanged['save'] };
type Replayed = Peeked & Claimed;
const KEY_HASH = /^[0-9a-f]{64}$/;
const refusedBoot = () => new ConvexError({ kind: 'auth', message: 'boot token unknown, used or expired' });

/**
 * The box's first call, with the boot token the provider started it with
 * and no key: trades it, once and within BOOT_MS, for the box's key, the
 * login's token, the thread key, the repo and the last save. The new key
 * replaces any earlier box's in the same step, so only one box can ever act
 * as the thread's runner (decision 3).
 *
 * Unsealing comes first, from a read that uses nothing up (peekBoot): a
 * deployment whose BOX_SEAL_KEY changed, or a sealed value gone bad, fails
 * here and leaves the boot token and the box as they were. Only then does
 * claimBoot use the token up, in one step that checks it again.
 */
export const exchange = action({
  // machineId: the provider's id for the box's own machine (BoxProvider
  // machineIdEnv; FLY_MACHINE_ID on Fly). Without it, the key holder's
  // machine is unknown, and every machine of its attempt stays protected.
  // boxKeyHash: the SHA-256 of a box key the box made itself, which then
  // never crosses the network. With it and machineId, the exchange can be
  // asked again: the same boot token, machine and key hash, while that key
  // is still the thread's and within the token's 10 minutes, get the same
  // answer (a box whose answer was lost); anything else is refused.
  args: { bootToken: v.string(), machineId: v.optional(v.string()), boxKeyHash: v.optional(v.string()) },
  returns: exchanged,
  handler: async (ctx, { bootToken, machineId, boxKeyHash }): Promise<Exchanged> => {
    if (machineId !== undefined && !MACHINE_ID.test(machineId)) throw bad('machineId must be the provider id of the box’s own machine');
    if (boxKeyHash !== undefined && !KEY_HASH.test(boxKeyHash)) throw bad('boxKeyHash must be a SHA-256 in hex');
    if (!BOOT_TOKEN.test(bootToken)) throw refusedBoot();
    const key = await sealKey();
    const bootHash = await sha256(bootToken);
    const peeked: Peeked | null = await ctx.runQuery(internal.boxes.peekBoot, { bootHash });
    if (!peeked) {
      // Used already: only by this very machine and key, asking again.
      const again: Replayed | null = boxKeyHash !== undefined && machineId !== undefined ? await ctx.runQuery(internal.boxes.peekReplay, { bootHash, boxKeyHash, machineId }) : null;
      if (!again) throw refusedBoot();
      let claudeToken: string;
      let threadKey: string;
      try {
        claudeToken = new TextDecoder().decode(await unseal(key, again.sealedToken, tokenPurpose(again.login)));
        threadKey = b64(await unseal(key, again.sealedThreadKey, threadKeyPurpose(again.threadId)));
      } catch {
        throw new ConvexError({ kind: 'config', message: "The box's secrets can't be unsealed with this deployment's BOX_SEAL_KEY." });
      }
      return { runnerId: again.runnerId, threadId: again.threadId, claudeToken, threadKey, repo: again.repo, save: again.save, login: again.login, tokenSetAt: again.tokenSetAt };
    }
    let claudeToken: string;
    let threadKey: string;
    try {
      claudeToken = new TextDecoder().decode(await unseal(key, peeked.sealedToken, tokenPurpose(peeked.login)));
      threadKey = b64(await unseal(key, peeked.sealedThreadKey, threadKeyPurpose(peeked.threadId)));
    } catch {
      throw new ConvexError({ kind: 'config', message: "The box's secrets can't be unsealed with this deployment's BOX_SEAL_KEY. The boot token still works once that's fixed." });
    }
    const boxKey = boxKeyHash === undefined ? BOX_KEY_PREFIX + randomHex(32) : undefined;
    const got: Claimed | null = await ctx.runMutation(internal.boxes.claimBoot, { bootHash, boxKeyHash: boxKeyHash ?? (await sha256(boxKey!)), sealedToken: peeked.sealedToken, sealedThreadKey: peeked.sealedThreadKey, ...(machineId !== undefined ? { machineId } : {}) });
    if (!got) throw refusedBoot();
    return { ...(boxKey ? { boxKey } : {}), runnerId: got.runnerId, threadId: got.threadId, claudeToken, threadKey, repo: got.repo, save: got.save, login: peeked.login, tokenSetAt: peeked.tokenSetAt };
  },
});

// The box a boot token is for, if the token is unused and unexpired: a
// minted token's hash is cleared once it's used (READY) or replaced.
async function bootBox(ctx: QueryCtx, bootHash: string): Promise<Doc<'boxes'> | null> {
  const row = await ctx.db.query('boxes').withIndex('by_boot_hash', (q) => q.eq('bootTokenHash', bootHash)).first();
  return row && (row.bootExpiresAt ?? 0) > Date.now() && BOOTING.includes(row.boxState.kind) ? row : null;
}

async function cloudToken(ctx: QueryCtx, login: string): Promise<Doc<'cloudTokens'>> {
  const token = await ctx.db.query('cloudTokens').withIndex('by_login', (q) => q.eq('login', login)).unique();
  if (!token) throw new ConvexError({ kind: 'noCloudToken', message: `There's no cloud token for ${login} yet: set one in Threadbear, then start the box again.` });
  return token;
}

/**
 * An exchange asked again by the box that made it (its answer lost on the
 * way): the boot token it used, its own machine and the hash of the key it
 * made, while that key is still the thread's (not replaced, revoked or
 * dead) and the token would still have been good. Null for anything else.
 */
export const peekReplay = internalQuery({
  args: { bootHash: v.string(), boxKeyHash: v.string(), machineId: v.string() },
  returns: v.union(
    v.null(),
    v.object({ login: v.string(), threadId: v.string(), sealedToken: v.string(), sealedThreadKey: v.string(), tokenSetAt: v.number(), runnerId: v.string(), repo: v.object({ origin: v.string(), subfolder: v.string(), baseBranch: v.string() }), save: v.union(v.null(), v.object({ url: v.string(), at: v.number(), bytes: v.number() })) }),
  ),
  handler: async (ctx, { bootHash, boxKeyHash, machineId }) => {
    const row = await ctx.db.query('boxes').withIndex('by_box_key', (q) => q.eq('boxKeyHash', boxKeyHash)).first();
    if (!row || row.boxKeyHash !== boxKeyHash || BOX_KEY_DEAD.includes(row.boxState.kind)) return null;
    if (!row.exchanged || row.exchanged.bootHash !== bootHash || row.exchanged.until <= Date.now() || row.keyMachineId !== machineId) return null;
    const token = await cloudToken(ctx, row.login);
    const url = row.save ? await ctx.storage.getUrl(row.save.storageId) : null;
    return { login: row.login, threadId: row.threadId, sealedToken: token.sealed, sealedThreadKey: row.sealedThreadKey, tokenSetAt: token.setAt, runnerId: row.runnerId, repo: row.repo, save: row.save && url ? { url, at: row.save.at, bytes: row.save.bytes } : null };
  },
});

/** What the exchange unseals, read without using the boot token up. A login with no cloud token refuses here. */
export const peekBoot = internalQuery({
  args: { bootHash: v.string() },
  returns: v.union(v.null(), v.object({ login: v.string(), threadId: v.string(), sealedToken: v.string(), sealedThreadKey: v.string(), tokenSetAt: v.number() })),
  handler: async (ctx, { bootHash }) => {
    const row = await bootBox(ctx, bootHash);
    if (!row) return null;
    const token = await cloudToken(ctx, row.login);
    return { login: row.login, threadId: row.threadId, sealedToken: token.sealed, sealedThreadKey: row.sealedThreadKey, tokenSetAt: token.setAt };
  },
});

/**
 * One step: the boot token checked again (unused, unexpired), and the
 * sealed values the action unsealed still the ones there (a token set
 * again meanwhile means trying again), then used up, the box told it's up
 * (READY), and the new box key's hash put in place of the last one. Of two
 * exchanges racing with one token, exactly one gets here first.
 */
export const claimBoot = internalMutation({
  args: { bootHash: v.string(), boxKeyHash: v.string(), sealedToken: v.string(), sealedThreadKey: v.string(), machineId: v.optional(v.string()) },
  returns: v.union(v.null(), v.object({ runnerId: v.string(), threadId: v.string(), repo: v.object({ origin: v.string(), subfolder: v.string(), baseBranch: v.string() }), save: v.union(v.null(), v.object({ url: v.string(), at: v.number(), bytes: v.number() })) })),
  handler: async (ctx, { bootHash, boxKeyHash, sealedToken, sealedThreadKey, machineId }) => {
    const row = await bootBox(ctx, bootHash);
    if (!row) return null;
    // A machine being deleted never takes the key: one that says it's that
    // machine, or (it can't be told) one that doesn't say while any of its
    // attempt is being deleted. The token stays for the machine that's kept.
    const condemned =
      machineId !== undefined
        ? await ctx.db.query('boxCondemned').withIndex('by_machine', (q) => q.eq('providerBoxId', machineId)).first()
        : row.bootAttempt !== undefined
          ? await ctx.db.query('boxCondemned').withIndex('by_box_attempt', (q) => q.eq('boxId', row._id).eq('attempt', row.bootAttempt!)).first()
          : null;
    if (condemned) return null;
    const token = await cloudToken(ctx, row.login);
    if (token.sealed !== sealedToken || row.sealedThreadKey !== sealedThreadKey) throw conflict("The login's cloud token changed while the box started: try again.");
    // Taken before READY clears it: how long a lost answer may be asked for again.
    const until = row.bootExpiresAt ?? Date.now();
    const r = await boxMachine.send(ctx, row._id, { type: 'READY' });
    if (r.status !== 'done') return null;
    await ctx.db.patch(row._id, { boxKeyHash, keyMachineId: machineId, unsure: undefined, exchanged: { bootHash, until } });
    const url = row.save ? await ctx.storage.getUrl(row.save.storageId) : null;
    return {
      runnerId: row.runnerId,
      threadId: row.threadId,
      repo: row.repo,
      save: row.save && url ? { url, at: row.save.at, bytes: row.save.bytes } : null,
    };
  },
});

// ------------------------------------------------------------ what a box and the service report

/**
 * The box has saved its thread (decision 7): a file its runner uploaded
 * (sync:iconUploadUrl, on its box key), sealed with the thread key. It
 * replaces the last save, which is deleted.
 */
export const boxSaved = mutation({
  args: { key: v.string(), storageId: v.id('_storage'), bytes: v.number() },
  returns: v.null(),
  handler: async (ctx, { key, storageId, bytes }) => {
    const caller = await runnerAuth(ctx, key, 'boxSaved');
    if (caller.owner || !caller.box) throw forbidden("save a box's thread: only the box's own key can");
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_RUNNER_UPLOAD_BYTES) throw bad(`bytes must be a whole number from 1 to ${MAX_RUNNER_UPLOAD_BYTES}`);
    const row = (await ctx.db.get(caller.box.id as Id<'boxes'>))!;
    if (row.save?.storageId === storageId) return null;
    const owner = await ctx.db.query('storageOwners').withIndex('by_storageId', (q) => q.eq('storageId', storageId)).first();
    // Its own upload, and nothing yet: a file already on a picture isn't a save.
    if (!mayUseStorage(caller, await uploadedBy(ctx, storageId)) || !owner || owner.attachedAt) throw forbidden("use a stored file its runner didn't upload");
    const old = row.save;
    const r = await boxMachine.send(ctx, row._id, { type: 'SAVED', storageId, bytes });
    if (r.status !== 'done') throw conflict(`The box is ${row.boxState.kind}, so it can't save now.`);
    await ctx.db.patch(owner._id, { attachedAt: Date.now() });
    if (old) await deleteIfUnused(ctx, old.storageId);
    return null;
  },
});

/** Mike archived the thread: its box saves it if it's up, then is deleted (boxService.ts destroyBox). */
export const archiveBox = mutation({
  args: { key: v.string(), threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, threadId }) => {
    await runnerAuth(ctx, key, 'archiveBox');
    const row = await boxOf(ctx, threadId);
    if (ARCHIVED_ALREADY.includes(row.boxState.kind)) return null;
    if (!(await archive(ctx, row))) throw conflict(`The box is ${row.boxState.kind}, so it can't be archived.`);
    return null;
  },
});

/**
 * Whether machine `id` of `attempt` may be taken for the key holder's: yes
 * for an attempt that isn't the key holder's, or when it's the machine that
 * traded the key (keyMachineId). Not when that isn't known (a box that
 * didn't say): the caller must have seen no other machine of the attempt.
 */
export function isKeyMachine(row: Pick<Doc<'boxes'>, 'keyAttempt' | 'keyMachineId'>, attempt: number | undefined, id: string): boolean {
  if (attempt === undefined || attempt !== row.keyAttempt) return true;
  return row.keyMachineId === undefined || row.keyMachineId === id;
}

const serverEvent = v.union(
  v.object({ type: v.literal('CREATED'), providerBoxId: v.string(), attempt: v.optional(v.number()) }),
  v.object({ type: v.literal('IDLE'), attempt: v.optional(v.number()), capped: v.optional(v.boolean()) }),
  v.object({ type: v.literal('WAKE') }),
  v.object({ type: v.literal('RESUMED'), attempt: v.optional(v.number()) }),
  v.object({ type: v.literal('LOST'), attempt: v.optional(v.number()), providerBoxId: v.optional(v.string()) }),
  v.object({ type: v.literal('DESTROYED') }),
  v.object({ type: v.literal('FAILED'), error: v.string(), attempt: v.optional(v.number()) }),
  v.object({ type: v.literal('PAUSED'), attempt: v.optional(v.number()), providerBoxId: v.optional(v.string()) }),
  v.object({ type: v.literal('RETIRED') }),
);

/**
 * What the service's own actions and crons saw (the provider made, resumed,
 * lost or deleted a box; a thread is idle; a message wants it awake). The
 * machine says whether the box's state takes it: `false` if not, which a
 * caller that can race (a second wake) takes as already done.
 */
export const report = machines.internalMutation({
  // op: the reporting action's op lease (boxService.ts withOp). An action
  // that has lost it is told no, and its news changes nothing.
  // A LOST naming its machine (`providerBoxId`) counts only if that's the
  // row's machine: two machines can share an attempt, and a duplicate's
  // loss says nothing of the one the row runs on.
  args: { threadId: v.string(), event: serverEvent, op: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { threadId, event, op }) => {
    const row = await ctx.db.query('boxes').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (!row) throw new ConvexError({ kind: 'notFound', message: 'no box for that thread' });
    if (op !== undefined && !(row.op?.id === op && row.op.until > Date.now())) return false;
    if ((event.type === 'LOST' || event.type === 'PAUSED') && event.providerBoxId !== undefined) {
      // The row's machine, or (a loss) the key holder's not yet taken in.
      const keyHolders = event.type === 'LOST' && row.keyMachineId === event.providerBoxId && (event.attempt ?? row.keyAttempt) === row.keyAttempt;
      if (row.providerBoxId !== event.providerBoxId && !keyHolders) return false;
      // Never the key holder's key or protection for another machine of its attempt.
      if (!isKeyMachine(row, event.attempt ?? row.providerAttempt, event.providerBoxId)) return false;
      const { providerBoxId: _id, ...named } = event;
      return (await boxMachine.send(ctx, row._id, named)).status === 'done';
    }
    if (event.type === 'CREATED' && event.attempt !== undefined && event.attempt === row.keyAttempt && row.keyMachineId !== undefined) {
      // The key holder's machine, by the box's own word: the row's, whatever it named before.
      // Any other of its attempt is a duplicate, not the row's machine.
      if (row.keyMachineId !== event.providerBoxId) return false;
    } else if (event.type === 'CREATED' && event.attempt !== undefined && event.attempt === row.providerAttempt && row.providerBoxId !== undefined && row.providerBoxId !== event.providerBoxId) {
      // A create's late report for an attempt the row already names another
      // machine for (a duplicate the provider made): it isn't the row's.
      return false;
    }
    return (await boxMachine.send(ctx, row._id, event)).status === 'done';
  },
});


/**
 * A command was queued for a box's runner (boxHooks.ts wakeIfAsleep), or one
 * was already waiting when it slept or was archived (wakeIfPending): WAKE,
 * once. A second, for a box already waking or awake, isn't taken. A box
 * that would take its virtual runner past maxBoxes, or that's been up its
 * day's hours, waits instead (`wantsWakeAt`; the message stays pending)
 * until there's room or tomorrow's hours (wakeWaiting), unless its thread
 * is moving (a move can't wait) or Mike woke it past its hours
 * (wakePastHours). An expired one fails what's waiting, saying why.
 */
export const wakeFor = machines.internalMutation({
  args: { runnerId: v.string(), commandId: v.optional(v.id('commands')) },
  returns: v.boolean(),
  handler: async (machineCtx, { runnerId, commandId }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const row = await ctx.db.query('boxes').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).first();
    if (!row || !WAKES_FROM.includes(row.boxState.kind)) return false;
    if (row.boxState.kind === 'expired') {
      await failExpiredRun(ctx, runnerId, commandId);
      return false;
    }
    const why = await wakeBlocked(ctx, row);
    // Past its hours it waits for tomorrow's, apart from those waiting for room (wakeWaiting).
    if (why === 'hours') {
      if (row.waitsForHours === undefined) await ctx.db.patch(row._id, { waitsForHours: day(Date.now()) });
      return false;
    }
    if (why === 'room') {
      if (row.wantsWakeAt === undefined) await ctx.db.patch(row._id, { wantsWakeAt: Date.now() });
      return false;
    }
    return (await boxMachine.send(machineCtx, row._id, { type: 'WAKE' })).status === 'done';
  },
});

/**
 * What keeps a box from waking now, if anything. One saving because it's
 * up its day's hours (`capped`) stays on its way to sleep: a message waits
 * for tomorrow's hours like an asleep box's, unless Mike woke it past them.
 * Any other saving or archiving box is up already. Otherwise it needs some
 * of its day's hours left (or its thread moving), and room under maxBoxes.
 */
async function wakeBlocked(ctx: QueryCtx, row: Doc<'boxes'>): Promise<'hours' | 'room' | null> {
  const limits = (await ctx.db.get(row.serviceId))?.limits ?? BOX_LIMITS;
  const s = row.boxState;
  if (s.kind === 'saving' && s.capped) return overHours(row, limits.maxAwakeHoursPerDay) ? 'hours' : null;
  if (s.kind === 'saving' || s.kind === 'archiving') return null;
  if (!(await activeMove(ctx, row.threadId)) && overHours(row, limits.maxAwakeHoursPerDay)) return 'hours';
  // One seen running is counted already: waking it takes no more room.
  if (row.seenRunningAt === undefined && (await countRunning(ctx, row.serviceId, limits.maxBoxes)) >= limits.maxBoxes) return 'room';
  return null;
}

const day = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * Today's (UTC) running time: what's been charged (closed stretches up,
 * and whatever the billing guard has seen running in any other state,
 * boxService.ts observe), and the part of today it's been up since `since`
 * if it's up now.
 */
export function usedTodayMs(row: Pick<Doc<'boxes'>, 'awakeToday' | 'boxState'>, now = Date.now()): number {
  const today = day(now);
  const dayStart = Date.parse(`${today}T00:00:00.000Z`);
  const had = row.awakeToday?.day === today ? row.awakeToday.ms : 0;
  const s = row.boxState as { kind: string; since?: number };
  const up = ['awake', 'saving', 'archiving'].includes(s.kind) && s.since !== undefined ? s.since : undefined;
  return up === undefined ? had : had + Math.max(0, now - Math.max(up, dayStart));
}

/** Up its day's hours, unless Mike woke it past them today (wakePastHours). */
export function overHours(row: Doc<'boxes'>, maxHours: number, now = Date.now()): boolean {
  return row.hoursWaivedOn !== day(now) && usedTodayMs(row, now) >= maxHours * 60 * 60_000;
}

// A move with no step for this long no longer keeps its box up: one left
// claimed with no final word from its target (the move machine's handedOver
// has no timer: the thread is the target's by then, and all it holds up is
// another move of that thread) mustn't keep a box from sleeping for ever.
export const MOVE_ACTIVE_MS = 60 * 60_000;

/** Whether a thread is moving: a box can't sleep, or wait to wake, mid-move (one still making progress). */
export async function activeMove(ctx: QueryCtx, threadId: string, now = Date.now()): Promise<boolean> {
  for (const m of await ctx.db.query('threadMoves').withIndex('by_thread', (q) => q.eq('threadId', threadId)).collect()) if (MOVE_GOING.includes(m.state) && m.updatedAt > now - MOVE_ACTIVE_MS) return true;
  return false;
}

/**
 * Mike's own word, from the Mac (or later the phone's): wake a thread's box
 * now though it's been up its day's hours, and let it run the rest of
 * today. It still waits for room under maxBoxes.
 */
export const wakePastHours = mutation({
  args: { key: v.string(), threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, threadId }) => {
    await runnerAuth(ctx, key, 'wakePastHours');
    const row = await boxOf(ctx, threadId);
    await ctx.db.patch(row._id, { hoursWaivedOn: day(Date.now()), waitsForHours: undefined });
    await ctx.scheduler.runAfter(0, internal.boxes.wakeFor, { runnerId: row.runnerId });
    return null;
  },
});

/**
 * A box of this virtual runner stopped counting toward maxBoxes (it slept,
 * failed or was archived; boxMachine.ts freed), or a new day began: those
 * waiting for tomorrow's hours whose day has passed join those waiting for
 * room, which wake, oldest first, while there's room. Only boxes that can
 * wake are in that queue, so none is passed over for long. The idle cron
 * runs it for every virtual runner too (wakeAllWaiting).
 */
export const wakeWaiting = machines.internalMutation({
  args: { serviceId: v.id('runnerServices') },
  returns: v.number(),
  handler: async (machineCtx, { serviceId }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const now = Date.now();
    for (const row of await ctx.db.query('boxes').withIndex('by_service_hours', (q) => q.eq('serviceId', serviceId).gt('waitsForHours', '').lt('waitsForHours', day(now))).take(WAKE_BATCH)) {
      await ctx.db.patch(row._id, { waitsForHours: undefined, ...(row.wantsWakeAt === undefined ? { wantsWakeAt: now } : {}) });
    }
    let woken = 0;
    for (const row of await ctx.db.query('boxes').withIndex('by_service_wants', (q) => q.eq('serviceId', serviceId).gt('wantsWakeAt', 0)).take(WAKE_BATCH)) {
      if (!WAKES_FROM.includes(row.boxState.kind) || row.boxState.kind === 'expired') {
        await ctx.db.patch(row._id, { wantsWakeAt: undefined });
        continue;
      }
      const why = await wakeBlocked(ctx, row);
      if (why === 'room') break;
      if (why === 'hours') {
        // Back past its hours (its waiver ran out): to the other queue.
        await ctx.db.patch(row._id, { wantsWakeAt: undefined, waitsForHours: day(now) });
        continue;
      }
      // wake clears wantsWakeAt.
      if ((await boxMachine.send(machineCtx, row._id, { type: 'WAKE' })).status === 'done') woken++;
      else await ctx.db.patch(row._id, { wantsWakeAt: undefined });
    }
    // Then threads that have never run, waiting for room to start, oldest first.
    const max = (await ctx.db.get('runnerServices', serviceId))?.limits.maxBoxes ?? BOX_LIMITS.maxBoxes;
    // In the order they started (the index keeps rows by creation within a
    // state). One whose login's token was refused meanwhile goes back to
    // waiting for a token (ROOM's other step) and uses none of the room.
    for (const row of await ctx.db.query('boxes').withIndex('by_service_state', (q) => q.eq('serviceId', serviceId).eq('boxState.kind', 'waitingForRoom')).take(WAKE_BATCH)) {
      if ((await countRunning(ctx, serviceId, max)) >= max) break;
      const r = await boxMachine.send(machineCtx, row._id, { type: 'ROOM' });
      if (r.status === 'done' && r.to === 'creating') woken++;
    }
    return woken;
  },
});
const WAKE_BATCH = 50;

/** Every virtual runner's waiting boxes (wakeWaiting), a page of virtual runners a run, carrying on from `cursor`. */
export const wakeAllWaiting = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { cursor, numItems }) => {
    const page = await ctx.db.query('runnerServices').paginate({ numItems: numItems ?? 50, cursor: cursor ?? null });
    for (const s of page.page) await ctx.scheduler.runAfter(0, internal.boxes.wakeWaiting, { serviceId: s._id });
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.boxes.wakeAllWaiting, { cursor: page.continueCursor, numItems });
    return null;
  },
});

const EXPIRED_NOTE = "This thread's machine and its last save have been deleted since it was archived, so it can't come back.";
const FAIL_BATCH = 50;

/**
 * An expired box's runner (it can't come back): every command waiting for
 * it fails with EXPIRED_NOTE, `commandId` first (the one that asked), a
 * batch a run, carrying on until none are left.
 */
export const failExpired = internalMutation({
  args: { runnerId: v.string(), commandId: v.optional(v.id('commands')) },
  returns: v.null(),
  handler: async (ctx, { runnerId, commandId }) => {
    await failExpiredRun(ctx, runnerId, commandId);
    return null;
  },
});

async function failExpiredRun(ctx: MutationCtx, runnerId: string, commandId?: Id<'commands'>): Promise<void> {
  const first = commandId ? await ctx.db.get(commandId) : null;
  const batch = await ctx.db.query('commands').withIndex('by_runner_state', (q) => q.eq('runnerId', runnerId).eq('state', 'pending')).take(FAIL_BATCH + 1);
  const todo = [...(first && first.runnerId === runnerId && first.state === 'pending' ? [first] : []), ...batch.filter((c) => c._id !== commandId)].slice(0, FAIL_BATCH);
  for (const c of todo) {
    await commandMachine.send(ctx, c._id, { type: 'THREAD_ELSEWHERE' });
    await ctx.db.patch(c._id, { args: finishedArgs(c.args), note: EXPIRED_NOTE });
    await endCommandFiles(ctx, c._id);
  }
  if (batch.length > todo.length || batch.length > FAIL_BATCH) await ctx.scheduler.runAfter(0, internal.boxes.failExpired, { runnerId });
}

// Archiving a box that's up asks it to save first (boxMachine.ts archiving).
export async function archive(ctx: MutationCtx, row: Doc<'boxes'>): Promise<boolean> {
  const r = await boxMachine.send(ctx, row._id, { type: 'ARCHIVE' });
  if (r.status !== 'done') return false;
  if (r.to === 'archiving') await askToSave(ctx, row);
  return true;
}

/**
 * The box's runner is asked to save its thread (decision 7), to sleep or
 * to be archived: a `save` command for its thread, one at a time.
 */
export async function askToSave(ctx: MutationCtx, row: Pick<Doc<'boxes'>, 'runnerId' | 'threadId'>): Promise<void> {
  for await (const c of ctx.db.query('commands').withIndex('by_runner_state', (q) => q.eq('runnerId', row.runnerId).eq('state', 'pending'))) if (c.kind === 'save') return;
  await queued(ctx, { runnerId: row.runnerId, threadId: row.threadId, kind: 'save', args: {}, createdAt: Date.now() });
}

// The states archiving does nothing more in.
const ARCHIVED_ALREADY: readonly string[] = ['archiving', 'shelved', 'destroying', 'gone', 'expired'];

/**
 * Mike archived a thread whose box never started (boxHooks.ts UNSTARTED):
 * it ends (ARCHIVE, to expired: nothing was made or saved), the archive
 * command that asked is done here, as no runner will ever take it, and the
 * thread's sidebar row is archived, so it goes to Archived everywhere.
 * What else was waiting for it (its create) fails, saying it can't come
 * back (failExpired, scheduled by the machine's step, after this).
 */
export const archiveUnstarted = internalMutation({
  args: { threadId: v.string(), commandId: v.optional(v.id('commands')) },
  returns: v.null(),
  handler: async (ctx, { threadId, commandId }) => {
    const row = await ctx.db.query('boxes').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (!row) return null;
    if (UNSTARTED.includes(row.boxState.kind) && (await boxMachine.send(ctx, row._id, { type: 'ARCHIVE' })).status !== 'done') return null;
    if (row.boxState.kind !== 'expired' && !UNSTARTED.includes(row.boxState.kind)) return null;
    const c = commandId ? await ctx.db.get('commands', commandId) : null;
    if (c && c.runnerId === row.runnerId && c.state === 'pending') {
      await commandMachine.send(ctx, c._id, { type: 'TAKE' });
      await commandMachine.send(ctx, c._id, { type: 'FINISH', ok: true });
    }
    const index = await ctx.db.query('threadIndex').withIndex('by_runner_thread', (q) => q.eq('runnerId', row.runnerId).eq('threadId', threadId)).unique();
    if (index && !index.archivedAt && !index.deleted) await ctx.db.patch('threadIndex', index._id, { archivedAt: new Date().toISOString(), status: 'idle', updatedMs: Date.now() });
    return null;
  },
});

/** The thread was archived or deleted a while ago (boxHooks.ts archiveSoon): its box goes, unless it's back out. */
export const archiveIfStill = internalMutation({
  args: { threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId }) => {
    const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (t && t.view !== 'den') return null;
    const row = await ctx.db.query('boxes').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (!row || ARCHIVED_ALREADY.includes(row.boxState.kind)) return null;
    await archive(ctx, row);
    return null;
  },
});
