// The lose-a-box test (docs/virtual-runners.md step 1, "Losing a box loses
// nothing"): a thread outlives its box. Each box trades a boot token for a
// box key scoped to the thread, which replaces the last box's key in the
// same mutation (decision 3); saves are sealed with a per-thread key and
// kept in file storage (decision 7).
//
// Randomness lives in actions, as in login.ts.
import {
  actionGeneric,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type ActionBuilder,
  type DataModelFromSchemaDefinition,
  type GenericDatabaseReader,
  type MutationBuilder,
  type QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import schema from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const action = actionGeneric as ActionBuilder<DataModel, "public">;
const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const query = queryGeneric as QueryBuilder<DataModel, "public">;

const BOOT_TTL_MS = 10 * 60_000;

function checkKey(key: string) {
  const want = process.env.SPIKE_KEY;
  if (!want) throw new Error("SPIKE_KEY isn't set on this deployment");
  if (key !== want) throw new Error("bad key");
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const randomToken = () =>
  b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]!);

async function sha256(s: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

async function sealKey(): Promise<CryptoKey> {
  const raw = process.env.SEAL_KEY;
  if (!raw) throw new Error("SEAL_KEY isn't set on this deployment");
  return crypto.subtle.importKey("raw", unb64(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(plain: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(), plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

async function unseal(sealed: string): Promise<Uint8Array> {
  const b = unb64(sealed);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, await sealKey(), b.slice(12)));
}

// The box key's thread, or a throw: every box call goes through this.
async function threadFor(db: GenericDatabaseReader<DataModel>, boxKey: string) {
  const hash = await sha256(boxKey);
  const row = await db.query("threads").withIndex("by_box_key", (q) => q.eq("boxKeyHash", hash)).unique();
  if (!row) throw new Error("box key refused");
  return row;
}

const ref = {
  insertThread: makeFunctionReference<"mutation">("lose:insertThread"),
  storeBoot: makeFunctionReference<"mutation">("lose:storeBoot"),
  claim: makeFunctionReference<"mutation">("lose:claim"),
};

// --- The owner's side -------------------------------------------------------

export const createThread = action({
  args: { key: v.string(), name: v.string() },
  handler: async (ctx, { key, name }) => {
    checkKey(key);
    const sealedThreadKey = await seal(crypto.getRandomValues(new Uint8Array(32)));
    await ctx.runMutation(ref.insertThread as any, { name, sealedThreadKey, sessionId: crypto.randomUUID() });
  },
});

export const insertThread = internalMutation({
  args: { name: v.string(), sealedThreadKey: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("threads", args);
  },
});

export const mintBoot = action({
  args: { key: v.string(), thread: v.string(), box: v.string(), login: v.string() },
  handler: async (ctx, { key, thread, box, login }): Promise<string> => {
    checkKey(key);
    const token = randomToken();
    await ctx.runMutation(ref.storeBoot as any, { thread, box, login, hash: await sha256(token) });
    return token;
  },
});

export const storeBoot = internalMutation({
  args: { thread: v.string(), box: v.string(), login: v.string(), hash: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("bootTokens", { ...args, expiresAt: Date.now() + BOOT_TTL_MS });
  },
});

export const requestSave = mutation({
  args: { key: v.string(), thread: v.string() },
  handler: async (ctx, { key, thread }) => {
    checkKey(key);
    const row = await ctx.db.query("threads").withIndex("by_name", (q) => q.eq("name", thread)).unique();
    if (!row) throw new Error("no such thread");
    await ctx.db.patch(row._id, { saveRequestedAt: Date.now() });
  },
});

export const thread = query({
  args: { key: v.string(), thread: v.string() },
  handler: async (ctx, { key, thread }) => {
    checkKey(key);
    return await ctx.db.query("threads").withIndex("by_name", (q) => q.eq("name", thread)).unique();
  },
});

export const reports = query({
  args: { key: v.string(), box: v.string() },
  handler: async (ctx, { key, box }) => {
    checkKey(key);
    return await ctx.db.query("turns").withIndex("by_box", (q) => q.eq("box", box)).collect();
  },
});

// --- The box's side ---------------------------------------------------------

export const exchange = action({
  args: { bootToken: v.string() },
  handler: async (
    ctx,
    { bootToken },
  ): Promise<{ box: string; claudeToken: string; boxKey: string; threadKey: string; sessionId: string }> => {
    const boxKey = randomToken();
    const got: { box: string; sealedLogin: string; sealedThreadKey: string; sessionId: string } | null =
      await ctx.runMutation(ref.claim as any, { hash: await sha256(bootToken), boxKeyHash: await sha256(boxKey) });
    if (!got) throw new Error("boot token unknown, used or expired");
    return {
      box: got.box,
      boxKey,
      sessionId: got.sessionId,
      claudeToken: new TextDecoder().decode(await unseal(got.sealedLogin)),
      threadKey: b64(await unseal(got.sealedThreadKey)),
    };
  },
});

// Atomic: uses up the boot token and makes this box the thread's only box,
// so the last box's key stops working in the same step.
export const claim = internalMutation({
  args: { hash: v.string(), boxKeyHash: v.string() },
  handler: async (ctx, { hash, boxKeyHash }) => {
    const boot = await ctx.db.query("bootTokens").withIndex("by_hash", (q) => q.eq("hash", hash)).unique();
    if (!boot?.thread || boot.usedAt !== undefined || boot.expiresAt < Date.now()) return null;
    await ctx.db.patch(boot._id, { usedAt: Date.now() });
    const thread = await ctx.db.query("threads").withIndex("by_name", (q) => q.eq("name", boot.thread!)).unique();
    const login = await ctx.db.query("logins").withIndex("by_name", (q) => q.eq("name", boot.login)).unique();
    if (!thread || !login) return null;
    await ctx.db.patch(thread._id, { box: boot.box, boxKeyHash });
    return { box: boot.box, sealedLogin: login.sealed, sealedThreadKey: thread.sealedThreadKey, sessionId: thread.sessionId };
  },
});

// What the box polls: is a save wanted, and where is the last one.
export const state = query({
  args: { boxKey: v.string() },
  handler: async (ctx, { boxKey }) => {
    const t = await threadFor(ctx.db, boxKey);
    return {
      saveWanted: t.saveRequestedAt !== undefined && (t.save?.at ?? 0) < t.saveRequestedAt,
      lastSave: t.save ? { url: await ctx.storage.getUrl(t.save.storageId), at: t.save.at, bytes: t.save.bytes } : null,
    };
  },
});

export const uploadUrl = mutation({
  args: { boxKey: v.string() },
  handler: async (ctx, { boxKey }) => {
    await threadFor(ctx.db, boxKey);
    return await ctx.storage.generateUploadUrl();
  },
});

export const recordSave = mutation({
  args: { boxKey: v.string(), storageId: v.id("_storage"), bytes: v.number() },
  handler: async (ctx, { boxKey, storageId, bytes }) => {
    const t = await threadFor(ctx.db, boxKey);
    // Replaces the last save, as decision 7 says.
    if (t.save) await ctx.storage.delete(t.save.storageId);
    await ctx.db.patch(t._id, { save: { storageId, at: Date.now(), bytes, box: t.box! } });
  },
});

export const report = mutation({
  args: { boxKey: v.string(), report: v.any() },
  handler: async (ctx, { boxKey, report }) => {
    const t = await threadFor(ctx.db, boxKey);
    await ctx.db.insert("turns", { box: t.box!, at: Date.now(), report });
  },
});

// A cheap call that only checks the box key.
export const ping = query({
  args: { boxKey: v.string() },
  handler: async (ctx, { boxKey }) => (await threadFor(ctx.db, boxKey)).box,
});
