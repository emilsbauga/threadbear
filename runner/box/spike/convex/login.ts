// The login test: a Claude setup token kept in Convex, handed to a box
// only through a one-time boot token (docs/virtual-runners.md, decisions 5
// and 10).
//
// Randomness and sealing happen in actions: Convex seeds Math.random and
// crypto.getRandomValues inside queries and mutations so they replay the
// same, which is wrong for keys and IVs. The mutations only store hashes
// and flip state atomically.
import {
  actionGeneric,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type ActionBuilder,
  type DataModelFromSchemaDefinition,
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

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64(bytes).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]!);
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return b64(new Uint8Array(d));
}

async function sealKey(): Promise<CryptoKey> {
  const raw = process.env.SEAL_KEY;
  if (!raw) throw new Error("SEAL_KEY isn't set on this deployment");
  return crypto.subtle.importKey("raw", unb64(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

const ref = {
  storeLogin: makeFunctionReference<"mutation">("login:storeLogin"),
  storeBoot: makeFunctionReference<"mutation">("login:storeBoot"),
  claimBoot: makeFunctionReference<"mutation">("login:claimBoot"),
  setReportKey: makeFunctionReference<"mutation">("login:setReportKey"),
};

// --- The owner's side (the Mac, here the driver) ---------------------------

export const setLogin = action({
  args: { key: v.string(), name: v.string(), token: v.string() },
  handler: async (ctx, { key, name, token }) => {
    checkKey(key);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(), new TextEncoder().encode(token)),
    );
    const sealed = new Uint8Array(iv.length + ct.length);
    sealed.set(iv);
    sealed.set(ct, iv.length);
    await ctx.runMutation(ref.storeLogin as any, { name, sealed: b64(sealed) });
  },
});

export const storeLogin = internalMutation({
  args: { name: v.string(), sealed: v.string() },
  handler: async (ctx, { name, sealed }) => {
    const row = await ctx.db.query("logins").withIndex("by_name", (q) => q.eq("name", name)).unique();
    if (row) await ctx.db.patch(row._id, { sealed, setAt: Date.now() });
    else await ctx.db.insert("logins", { name, sealed, setAt: Date.now() });
  },
});

// Returns the boot token once; only its hash is kept.
export const mintBoot = action({
  args: { key: v.string(), box: v.string(), login: v.string() },
  handler: async (ctx, { key, box, login }): Promise<string> => {
    checkKey(key);
    const token = randomToken();
    await ctx.runMutation(ref.storeBoot as any, { box, login, hash: await sha256(token) });
    return token;
  },
});

export const storeBoot = internalMutation({
  args: { box: v.string(), login: v.string(), hash: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("bootTokens", { ...args, expiresAt: Date.now() + BOOT_TTL_MS });
  },
});

export const turn = query({
  args: { key: v.string(), box: v.string() },
  handler: async (ctx, { key, box }) => {
    checkKey(key);
    return await ctx.db.query("turns").withIndex("by_box", (q) => q.eq("box", box)).first();
  },
});

// --- The box's side: no SPIKE_KEY, only what the boot token gives it ------

export const exchange = action({
  args: { bootToken: v.string() },
  handler: async (ctx, { bootToken }): Promise<{ box: string; claudeToken: string; reportKey: string }> => {
    const claimed: { id: string; box: string; sealed: string } | null = await ctx.runMutation(
      ref.claimBoot as any,
      { hash: await sha256(bootToken) },
    );
    if (!claimed) throw new Error("boot token unknown, used or expired");
    const sealed = unb64(claimed.sealed);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(0, 12) },
      await sealKey(),
      sealed.slice(12),
    );
    const reportKey = randomToken();
    await ctx.runMutation(ref.setReportKey as any, { id: claimed.id, reportKeyHash: await sha256(reportKey) });
    return { box: claimed.box, claudeToken: new TextDecoder().decode(plain), reportKey };
  },
});

// Atomic: of two exchanges racing with one boot token, one wins.
export const claimBoot = internalMutation({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    const row = await ctx.db.query("bootTokens").withIndex("by_hash", (q) => q.eq("hash", hash)).unique();
    if (!row || row.usedAt !== undefined || row.expiresAt < Date.now()) return null;
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    const login = await ctx.db.query("logins").withIndex("by_name", (q) => q.eq("name", row.login)).unique();
    if (!login) return null;
    return { id: row._id, box: row.box, sealed: login.sealed };
  },
});

export const setReportKey = internalMutation({
  args: { id: v.id("bootTokens"), reportKeyHash: v.string() },
  handler: async (ctx, { id, reportKeyHash }) => {
    await ctx.db.patch(id, { reportKeyHash });
  },
});

export const report = mutation({
  args: { reportKey: v.string(), report: v.any() },
  handler: async (ctx, { reportKey, report }) => {
    // Hashing needs no randomness, so it's fine in a mutation.
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(reportKey));
    const hash = b64(new Uint8Array(d));
    const row = await ctx.db.query("bootTokens").withIndex("by_report_key", (q) => q.eq("reportKeyHash", hash)).unique();
    if (!row) throw new Error("bad report key");
    await ctx.db.insert("turns", { box: row.box, at: Date.now(), report });
  },
});
