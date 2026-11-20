// The spike's throwaway backend: just enough to tell whether a box's
// process keeps its Convex connection through a pause, and whether a
// command queued while it slept is taken exactly once. Not the real
// `boxes` table from docs/virtual-runners.md, though the names match.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const boxState = v.union(
  v.literal("creating"),
  v.literal("starting"),
  v.literal("running"),
  v.literal("pausing"),
  v.literal("paused"),
  v.literal("resuming"),
  v.literal("destroyed"),
);

export const commandState = v.union(
  v.literal("pending"),
  v.literal("taken"),
  v.literal("done"),
);

export default defineSchema({
  boxes: defineTable({
    name: v.string(),
    provider: v.string(),
    providerBoxId: v.optional(v.string()),
    idempotencyKey: v.string(),
    state: boxState,
    lastHeartbeatAt: v.optional(v.number()),
    // Time of the very first heartbeat from any process in this box.
    bootedAt: v.optional(v.number()),
    heartbeats: v.number(),
  }).index("by_name", ["name"]),

  commands: defineTable({
    boxName: v.string(),
    text: v.string(),
    state: commandState,
    takenBy: v.optional(v.string()),
    createdAt: v.number(),
    takenAt: v.optional(v.number()),
    doneAt: v.optional(v.number()),
    // Every call to take, won or not. More than one means the agent (or a
    // second agent) tried again, which is what "exactly once" is about.
    attempts: v.number(),
    // Takes that won (pending -> taken). Can only ever be 0 or 1; kept as a
    // count so the driver checks the number rather than trusting the code.
    takes: v.number(),
    // Every call to finish, including ones that didn't change anything.
    finishes: v.number(),
  }).index("by_box_state", ["boxName", "state"]),

  // One row per heartbeat, so the driver can see which process sent it
  // (pid + startedAt) and whether its websocket had reconnected.
  beats: defineTable({
    box: v.string(),
    pid: v.number(),
    startedAt: v.number(),
    connectionCount: v.number(),
    at: v.number(),
  }).index("by_box_at", ["box", "at"]),

  // --- The login test (claude-turn.ts) ---------------------------------

  // A Claude setup token, sealed with AES-GCM under the deployment's
  // SEAL_KEY, so a data export or backup doesn't hold it in the clear.
  logins: defineTable({
    name: v.string(),
    sealed: v.string(), // base64 of iv (12 bytes) + ciphertext
    setAt: v.number(),
  }).index("by_name", ["name"]),

  // One per box start: the provider gets only this, single use, 10 minutes.
  // Stored hashed; the box trades it for the login and a report key.
  bootTokens: defineTable({
    box: v.string(),
    login: v.string(),
    hash: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    reportKeyHash: v.optional(v.string()),
    // The lose-a-box test: a boot token for a box that runs this thread.
    thread: v.optional(v.string()),
  })
    .index("by_hash", ["hash"])
    .index("by_report_key", ["reportKeyHash"]),

  // What the box reports back about its Claude turn.
  turns: defineTable({
    box: v.string(),
    at: v.number(),
    report: v.any(),
  }).index("by_box", ["box"]),

  // --- The lose-a-box test (lose-box.ts) --------------------------------

  // One thread that outlives its boxes (docs/virtual-runners.md, 3 and 7).
  threads: defineTable({
    name: v.string(),
    // The per-thread key that seals saves, itself sealed under SEAL_KEY.
    sealedThreadKey: v.string(),
    sessionId: v.string(),
    // The one live box credential: a new box's replaces the last box's.
    box: v.optional(v.string()),
    boxKeyHash: v.optional(v.string()),
    saveRequestedAt: v.optional(v.number()),
    save: v.optional(v.object({ storageId: v.id("_storage"), at: v.number(), bytes: v.number(), box: v.string() })),
  })
    .index("by_name", ["name"])
    .index("by_box_key", ["boxKeyHash"]),
});
