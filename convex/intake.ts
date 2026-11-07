// Text-only external intake. No runner commands, model calls or pruning.
// See docs/protocol.md, "External message intake".
import { v } from 'convex/values';
import { httpAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { sha256 } from './lib';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';

const messageFields = {
  messageId: v.string(), source: v.union(v.literal('email'), v.literal('telegram')),
  sourceMessageId: v.string(), text: v.string(), sentAt: v.string(), sender: v.optional(v.string()),
};
type Message = { messageId: string; source: 'email' | 'telegram'; sourceMessageId: string; text: string; sentAt: string; sender?: string };
type Receipt = { receiptId: string; messageId: string; state: 'received'; receivedAt: number };
type Result = { status: number; error?: string; receipt?: Receipt };
const messageIdOk = (s: unknown): s is string => typeof s === 'string' && /^[\x21-\x7e]{1,256}$/.test(s);
const short = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 512;
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const receiptOf = (row: Doc<'intakeMessages'>): Receipt => ({ receiptId: row._id, messageId: row.messageId, state: row.state, receivedAt: row.receivedAt });
const failure = (status: number, error: string): Result => ({ status, error });

function validate(value: unknown): Message | Result {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failure(400, 'Expected a message object');
  const m = value as Record<string, unknown>;
  if (!messageIdOk(m.messageId) || !short(m.sourceMessageId)
    || (m.source !== 'email' && m.source !== 'telegram') || typeof m.text !== 'string' || !m.text.trim()
    || typeof m.sentAt !== 'string' || m.sentAt.length > 64
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(m.sentAt)
    || !Number.isFinite(Date.parse(m.sentAt)) || (m.sender !== undefined && !short(m.sender))) return failure(400, 'Invalid message fields');
  if (bytes(m.text) > 48 * 1024) return failure(413, 'Text exceeds 48 KiB');
  return { messageId: m.messageId, source: m.source, sourceMessageId: m.sourceMessageId, text: m.text, sentAt: m.sentAt,
    ...(m.sender !== undefined ? { sender: m.sender as string } : {}) };
}

// Only the deployment administrator can call these internal functions. Hashes
// are supplied so plaintext credentials never appear in function arguments/logs.
export const provision = internalMutation({
  args: { clientId: v.string(), keyHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { clientId, keyHash }) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(clientId) || !/^[a-f0-9]{64}$/.test(keyHash)) throw new Error('Invalid client ID or SHA-256 hash');
    const used = await ctx.db.query('intakeClients').withIndex('by_hash', q => q.eq('keyHash', keyHash)).unique();
    if (used && used.clientId !== clientId) throw new Error('Key hash already used by another client');
    const existing = await ctx.db.query('intakeClients').withIndex('by_client', q => q.eq('clientId', clientId)).unique();
    if (existing) await ctx.db.patch(existing._id, { keyHash, revokedAt: undefined });
    else await ctx.db.insert('intakeClients', { clientId, keyHash, createdAt: Date.now() });
    return null;
  },
});

export const revoke = internalMutation({
  args: { clientId: v.string() }, returns: v.null(),
  handler: async (ctx, { clientId }) => {
    const row = await ctx.db.query('intakeClients').withIndex('by_client', q => q.eq('clientId', clientId)).unique();
    if (row) await ctx.db.patch(row._id, { revokedAt: Date.now() });
    return null;
  },
});

async function client(ctx: QueryCtx | MutationCtx, keyHash: string) {
  const row = await ctx.db.query('intakeClients').withIndex('by_hash', q => q.eq('keyHash', keyHash)).unique();
  return row && row.revokedAt === undefined ? row : null;
}
export const authorized = internalQuery({
  args: { keyHash: v.string() }, returns: v.boolean(),
  handler: async (ctx, { keyHash }) => Boolean(await client(ctx, keyHash)),
});

export const accept = internalMutation({
  args: { keyHash: v.string(), message: v.object(messageFields) },
  handler: async (ctx, { keyHash, message }): Promise<Result> => {
    const c = await client(ctx, keyHash);
    if (!c) return failure(401, 'Invalid intake credential');
    const m = validate(message);
    if ('status' in m) return m;
    const existing = await ctx.db.query('intakeMessages').withIndex('by_client_message', q => q.eq('clientId', c.clientId).eq('messageId', m.messageId)).unique();
    if (existing) {
      // Explicit fields, in stable order, ignore JSON property ordering.
      const old = existing.message;
      if (old.source !== m.source || old.sourceMessageId !== m.sourceMessageId || old.text !== m.text || old.sentAt !== m.sentAt || old.sender !== m.sender) return failure(409, 'Message ID already has different content');
      return { status: 200, receipt: receiptOf(existing) };
    }
    const now = Date.now();
    const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
    const count = c.hourStart === hourStart ? c.hourCount ?? 0 : 0;
    if (count >= 120) return failure(429, 'New-message allowance reached; retry next UTC hour');
    const id = await ctx.db.insert('intakeMessages', { clientId: c.clientId, messageId: m.messageId, message: m, state: 'received', receivedAt: now });
    await ctx.db.patch(c._id, { hourStart, hourCount: count + 1 });
    return { status: 201, receipt: { receiptId: id, messageId: m.messageId, state: 'received', receivedAt: now } };
  },
});

export const receipt = internalQuery({
  args: { keyHash: v.string(), messageId: v.string() },
  handler: async (ctx, { keyHash, messageId }): Promise<Result> => {
    const c = await client(ctx, keyHash);
    if (!c) return failure(401, 'Invalid intake credential');
    if (!messageIdOk(messageId)) return failure(400, 'Invalid message ID');
    const row = await ctx.db.query('intakeMessages').withIndex('by_client_message', q => q.eq('clientId', c.clientId).eq('messageId', messageId)).unique();
    return row ? { status: 200, receipt: receiptOf(row) } : failure(404, 'Receipt not found');
  },
});

function respond(result: Result): Response {
  return new Response(JSON.stringify(result.receipt ?? { error: result.error }), {
    status: result.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(result.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
      ...(result.status === 429 ? { 'Retry-After': String(Math.ceil((3_600_000 - Date.now() % 3_600_000) / 1000)) } : {}) },
  });
}
async function requestHash(request: Request): Promise<string | null> {
  const token = /^Bearer (tbi_[a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  return token ? sha256(token) : null;
}

export const postMessage = httpAction(async (ctx, request): Promise<Response> => {
  const keyHash = await requestHash(request);
  if (!keyHash || !await ctx.runQuery(internal.intake.authorized, { keyHash })) return respond(failure(401, 'Invalid intake credential'));
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return respond(failure(415, 'Expected application/json'));
  // Bound the actual stream too: content-length is optional and untrusted.
  if (Number(request.headers.get('content-length') ?? 0) > 64 * 1024) return respond(failure(413, 'Request exceeds 64 KiB'));
  const reader = request.body?.getReader();
  if (!reader) return respond(failure(400, 'Expected JSON body'));
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        return respond(failure(413, 'Request exceeds 64 KiB'));
      }
      chunks.push(value);
    }
  } catch { return respond(failure(400, 'Could not read request')); }
  finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { body.set(chunk, at); at += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { return respond(failure(400, 'Invalid JSON')); }
  const message = validate(value);
  if ('status' in message) return respond(message);
  // Rechecks auth inside the write transaction, including revocation mid-request.
  return respond(await ctx.runMutation(internal.intake.accept, { keyHash, message }));
});

export const getReceipt = httpAction(async (ctx, request): Promise<Response> => {
  const keyHash = await requestHash(request);
  if (!keyHash) return respond(failure(401, 'Invalid intake credential'));
  const messageId = new URL(request.url).searchParams.get('messageId') ?? '';
  return respond(await ctx.runQuery(internal.intake.receipt, { keyHash, messageId }));
});
