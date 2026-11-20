// The relay keeps as little as it can: one row per Threadbear install (an
// id, the hash of its key, when it was made and last seen, the app version
// it says it is) and a count of notifications per day. Never a name, a
// thread, a message or a device token. docs/push-relay.md.
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  installs: defineTable({
    installId: v.string(),
    keyHash: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    version: v.optional(v.string()),
    // Sends in the current hour, for the rate limit.
    hourStart: v.number(),
    hourSends: v.number(),
    // Of those, the ones a bad device token failed or still out (relay.ts
    // admit, counted).
    hourBad: v.optional(v.number()),
    // The deployment it registered for, checked by calling it back
    // (verify.ts), and how often that deployment registered on that UTC
    // day. None for installs from before the check (5 Nov 2026).
    deployment: v.optional(v.string()),
    registeredDay: v.optional(v.string()),
    registeredToday: v.optional(v.number()),
    // When its key was taken for being idle (relay.ts expire): keyHash is
    // then empty, which no key hashes to, until it registers again.
    expiredAt: v.optional(v.number()),
  })
    .index('by_installId', ['installId'])
    .index('by_deployment', ['deployment'])
    // For expiring installs nobody has used in a long while (relay.ts expire).
    .index('by_expired', ['expiredAt', 'lastSeenAt']),

  // Anonymous totals per UTC day: notifications forwarded and installs that
  // sent one. What Mike looks at; nothing per install.
  days: defineTable({
    day: v.string(),
    sends: v.number(),
    failed: v.number(),
    registrations: v.number(),
    // Of those, deployments seen for the first time, capped relay-wide
    // (relay.ts NEW_INSTALLS_PER_DAY). Since 16 Nov 2026.
    newInstalls: v.optional(v.number()),
    // Of those, the ones registered without a deployment check, which
    // only happened on 5 Nov 2026 (that way in is gone; kept so old day
    // rows still match the schema).
    legacyRegistrations: v.optional(v.number()),
    // Why the failed ones failed, as "<status> <reason>" (Apple's status
    // and reason, or 0 and the relay's own, like "0 timeout"): the only
    // way to tell a relay problem (its key turned down) from a backend's
    // (a stale token) without logging anything per install. Since 6 Nov
    // 2026, when 65 sends in two days failed and nothing said why.
    reasons: v.optional(v.record(v.string(), v.number())),
  }).index('by_day', ['day']),

  // Sends this UTC hour ("2026-11-16T09") relay-wide, and of those by
  // installs under a week old, which share one allowance (relay.ts
  // ALL_SENDS_PER_HOUR, NEW_INSTALL_SENDS_PER_HOUR). Removed after two
  // days (relay.ts expire).
  hours: defineTable({
    hour: v.string(),
    sends: v.number(),
    newSends: v.number(),
  }).index('by_hour', ['hour']),
});
