// Every function takes `key` and checks it against SPIKE_KEY: one shared
// secret for a throwaway deployment, set with
// `npx convex env set SPIKE_KEY <value>`. Nothing here is meant to outlive
// the spike.
//
// The builders come from convex/server rather than ./_generated so the
// folder typechecks before `npx convex dev` has ever run.
import {
  mutationGeneric,
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type MutationBuilder,
  type QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import schema, { boxState } from "./schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;
const query = queryGeneric as QueryBuilder<DataModel, "public">;

function check(key: string) {
  const want = process.env.SPIKE_KEY;
  if (!want) throw new Error("SPIKE_KEY isn't set on this deployment");
  if (key !== want) throw new Error("bad key");
}

// --- The box agent's side -------------------------------------------------

export const heartbeat = mutation({
  args: {
    key: v.string(),
    box: v.string(),
    pid: v.number(),
    startedAt: v.number(),
    connectionCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    check(args.key);
    const now = Date.now();
    const row = await ctx.db
      .query("boxes")
      .withIndex("by_name", (q) => q.eq("name", args.box))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        lastHeartbeatAt: now,
        bootedAt: row.bootedAt ?? now,
        heartbeats: row.heartbeats + 1,
      });
    } else {
      // A box the driver didn't register (run by hand): keep its beats anyway.
      await ctx.db.insert("boxes", {
        name: args.box,
        provider: "unknown",
        idempotencyKey: "",
        state: "running",
        lastHeartbeatAt: now,
        bootedAt: now,
        heartbeats: 1,
      });
    }
    await ctx.db.insert("beats", {
      box: args.box,
      pid: args.pid,
      startedAt: args.startedAt,
      connectionCount: args.connectionCount ?? 0,
      at: now,
    });
    return now;
  },
});

export const pending = query({
  args: { key: v.string(), box: v.string() },
  handler: async (ctx, args) => {
    check(args.key);
    return await ctx.db
      .query("commands")
      .withIndex("by_box_state", (q) =>
        q.eq("boxName", args.box).eq("state", "pending"),
      )
      .collect();
  },
});

// Only pending -> taken. Returns false for anything else, so a second
// taker (or the same one after a reconnect replays) learns it lost.
export const take = mutation({
  args: { key: v.string(), id: v.id("commands"), by: v.string() },
  handler: async (ctx, args) => {
    check(args.key);
    const cmd = await ctx.db.get(args.id);
    if (!cmd) return false;
    if (cmd.state !== "pending") {
      await ctx.db.patch(cmd._id, { attempts: cmd.attempts + 1 });
      return false;
    }
    await ctx.db.patch(cmd._id, {
      attempts: cmd.attempts + 1,
      takes: cmd.takes + 1,
      state: "taken",
      takenBy: args.by,
      takenAt: Date.now(),
    });
    return true;
  },
});

export const finish = mutation({
  args: { key: v.string(), id: v.id("commands"), by: v.string() },
  handler: async (ctx, args) => {
    check(args.key);
    const cmd = await ctx.db.get(args.id);
    if (!cmd) return false;
    const ok = cmd.state === "taken" && cmd.takenBy === args.by;
    await ctx.db.patch(cmd._id, {
      finishes: cmd.finishes + 1,
      ...(ok ? { state: "done" as const, doneAt: Date.now() } : {}),
    });
    return ok;
  },
});

// --- The driver's side ----------------------------------------------------

export const queue = mutation({
  args: { key: v.string(), box: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    check(args.key);
    return await ctx.db.insert("commands", {
      boxName: args.box,
      text: args.text,
      state: "pending",
      createdAt: Date.now(),
      attempts: 0,
      takes: 0,
      finishes: 0,
    });
  },
});

export const registerBox = mutation({
  args: {
    key: v.string(),
    name: v.string(),
    provider: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    check(args.key);
    const row = await ctx.db
      .query("boxes")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (row) return row._id;
    return await ctx.db.insert("boxes", {
      name: args.name,
      provider: args.provider,
      idempotencyKey: args.idempotencyKey,
      state: "creating",
      heartbeats: 0,
    });
  },
});

export const setBox = mutation({
  args: {
    key: v.string(),
    name: v.string(),
    providerBoxId: v.optional(v.string()),
    state: boxState,
  },
  handler: async (ctx, args) => {
    check(args.key);
    const row = await ctx.db
      .query("boxes")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (!row) throw new Error(`no box ${args.name}`);
    await ctx.db.patch(row._id, {
      state: args.state,
      ...(args.providerBoxId ? { providerBoxId: args.providerBoxId } : {}),
    });
  },
});

export const box = query({
  args: { key: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    check(args.key);
    return await ctx.db
      .query("boxes")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
  },
});

export const command = query({
  args: { key: v.string(), id: v.id("commands") },
  handler: async (ctx, args) => {
    check(args.key);
    return await ctx.db.get(args.id);
  },
});

export const beats = query({
  args: { key: v.string(), box: v.string(), since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    check(args.key);
    return await ctx.db
      .query("beats")
      .withIndex("by_box_at", (q) =>
        q.eq("box", args.box).gt("at", args.since ?? 0),
      )
      .collect();
  },
});
