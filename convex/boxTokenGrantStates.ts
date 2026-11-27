import { v } from 'convex/values';

export const grantStateV = v.union(
  v.object({ kind: v.literal('issued'), setAt: v.number() }),
  v.object({ kind: v.literal('refused'), setAt: v.number(), afterSetAt: v.number(), reportedAt: v.number() }),
);
