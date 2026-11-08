// Bounded binary blocks support large private transfers without exposing storage
// URLs or accepting client-supplied blob IDs. Originals are assembled on runner.
import { v } from 'convex/values';
import { httpAction, internalMutation, internalQuery, query } from './_generated/server';
import { internal, api } from './_generated/api';
import { messageFields, validate } from './intake';
import { runnerAuth, actAs, sha256 } from './lib';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';

export const BLOCK_BYTES = 8 * 1024 * 1024;
export const fileFields = { id: v.string(), name: v.string(), mediaType: v.string(), size: v.number(), sha256: v.string() };
type FileSpec = { id: string; name: string; mediaType: string; size: number; sha256: string };
type Outcome = { status: number; body: Record<string, any>; keepStorage?: boolean };
const fail = (status: number, error: string): Outcome => ({ status, body: { error } });
const count = (f: FileSpec) => Math.ceil(f.size / BLOCK_BYTES);
const expected = (f: FileSpec, index: number) => Math.min(BLOCK_BYTES, f.size - index * BLOCK_BYTES);
async function auth(ctx: QueryCtx | MutationCtx, keyHash: string) {
  const c = await ctx.db.query('intakeClients').withIndex('by_hash', q => q.eq('keyHash', keyHash)).unique();
  return c && c.revokedAt === undefined ? c : null;
}
async function transfer(ctx: QueryCtx | MutationCtx, clientId: string, messageId: string) {
  return ctx.db.query('intakeTransfers').withIndex('by_client_message', q => q.eq('clientId', clientId).eq('messageId', messageId)).unique();
}
function summary(t: Doc<'intakeTransfers'>) {
  return { transferId: t._id, state: t.state, chunkSize: BLOCK_BYTES, localSaved: Boolean(t.localSaved), cloudDeleted: Boolean(t.cloudDeleted),
    attachments: t.attachments.map((f, i) => ({ ...f, blocks: count(f), uploaded: t.uploaded[i] ?? 0 })) };
}
export const prepare = internalMutation({
  args: { keyHash: v.string(), message: v.object(messageFields), attachments: v.array(v.object(fileFields)) },
  handler: async (ctx, { keyHash, message, attachments }): Promise<Outcome> => {
    const c = await auth(ctx, keyHash); if (!c) return fail(401, 'Invalid intake credential');
    const m = validate(message, attachments.length > 0);
    if ('status' in m) return fail(m.status, m.error ?? 'Invalid message');
    const ids = new Set<string>();
    for (const f of attachments) {
      if (!/^[\x21-\x7e]{1,128}$/.test(f.id) || ids.has(f.id) || !f.name || f.name.length > 512 || /[\x00-\x1f]/.test(f.name)
        || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(f.mediaType) || f.mediaType.length > 255
        || !Number.isSafeInteger(f.size) || f.size < 0 || !/^[a-f0-9]{64}$/.test(f.sha256)) return fail(400, 'Invalid attachment manifest');
      ids.add(f.id);
    }
    const t = await transfer(ctx, c.clientId, m.messageId);
    if (t) {
      if ((['messageId', 'source', 'sourceMessageId', 'text', 'sentAt', 'sender'] as const).some(k => t.message[k] !== m[k])
        || t.attachments.length !== attachments.length || t.attachments.some((f, i) => (['id', 'name', 'mediaType', 'size', 'sha256'] as const).some(k => f[k] !== attachments[i][k]))) return fail(409, 'Message ID already has different content');
      if (t.state === 'cancelled') {
        if (!t.cloudDeleted) return fail(409, 'Cancelled upload cleanup is pending');
        await ctx.db.patch(t._id, { state: 'preparing', uploaded: attachments.map(() => 0), cloudDeleted: false, updatedAt: Date.now() });
        return { status: 200, body: summary((await ctx.db.get(t._id))!) };
      }
      return { status: 200, body: summary(t) };
    }
    if (await ctx.db.query('intakeMessages').withIndex('by_client_message', q => q.eq('clientId', c.clientId).eq('messageId', m.messageId)).unique()) return fail(409, 'Message ID already belongs to another intake');
    const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const n = c.hourStart === hourStart ? c.hourCount ?? 0 : 0;
    if (n >= 120) return fail(429, 'New-message allowance reached; retry next UTC hour');
    const id = await ctx.db.insert('intakeTransfers', { clientId: c.clientId, messageId: m.messageId, message: m, attachments, uploaded: attachments.map(() => 0), state: 'preparing', updatedAt: Date.now() });
    await ctx.db.patch(c._id, { hourStart, hourCount: n + 1 });
    return { status: 201, body: summary((await ctx.db.get(id))!) };
  },
});

const chunkArgs = { keyHash: v.string(), messageId: v.string(), attachmentId: v.string(), index: v.number() };
export const uploadAllowed = internalQuery({
  args: chunkArgs,
  handler: async (ctx, { keyHash, messageId, attachmentId, index }): Promise<Outcome> => {
    const c = await auth(ctx, keyHash); if (!c) return fail(401, 'Invalid intake credential');
    const t = await transfer(ctx, c.clientId, messageId);
    if (!t) return fail(404, 'Transfer not found');
    if (t.state !== 'preparing') return fail(409, 'Transfer is not accepting uploads');
    const f = t.attachments.find(f => f.id === attachmentId);
    if (!f || !Number.isSafeInteger(index) || index < 0 || index >= count(f)) return fail(400, 'Invalid attachment block');
    return { status: 200, body: { bytes: expected(f, index) } };
  },
});
export const putChunk = internalMutation({
  args: { ...chunkArgs, storageId: v.id('_storage'), bytes: v.number(), sha256: v.string() },
  handler: async (ctx, { keyHash, messageId, attachmentId, index, storageId, bytes, sha256 }): Promise<Outcome> => {
    const c = await auth(ctx, keyHash); if (!c) return fail(401, 'Invalid intake credential');
    const t = await transfer(ctx, c.clientId, messageId);
    if (!t || t.state !== 'preparing') return fail(409, 'Transfer is not accepting uploads');
    const pos = t.attachments.findIndex(f => f.id === attachmentId), f = t.attachments[pos];
    if (!f || !Number.isSafeInteger(index) || index < 0 || index >= count(f) || bytes !== expected(f, index) || !/^[a-f0-9]{64}$/.test(sha256)) return fail(400, 'Invalid attachment block');
    const old = await ctx.db.query('intakeChunks').withIndex('by_block', q => q.eq('transferId', t._id).eq('attachmentId', attachmentId).eq('index', index)).unique();
    if (old) return old.bytes === bytes && old.sha256 === sha256
      ? { status: 200, body: { attachmentId, index, bytes, sha256 }, keepStorage: old.storageId === storageId }
      : fail(409, 'Block already has different content');
    await ctx.db.insert('intakeChunks', { transferId: t._id, attachmentId, index, storageId, bytes, sha256 });
    const uploaded = [...t.uploaded]; uploaded[pos] = (uploaded[pos] ?? 0) + 1;
    await ctx.db.patch(t._id, { uploaded, updatedAt: Date.now() });
    return { status: 201, body: { attachmentId, index, bytes, sha256 }, keepStorage: true };
  },
});

export const finalize = internalMutation({
  args: { keyHash: v.string(), messageId: v.string() },
  handler: async (ctx, { keyHash, messageId }): Promise<Outcome> => {
    const c = await auth(ctx, keyHash); if (!c) return fail(401, 'Invalid intake credential');
    const t = await transfer(ctx, c.clientId, messageId); if (!t) return fail(404, 'Transfer not found');
    let id = t.receiptId;
    if (!id) {
      if (t.state !== 'preparing' || t.attachments.some((f, i) => (t.uploaded[i] ?? 0) !== count(f))) return fail(409, 'Attachments are not complete');
      id = await ctx.db.insert('intakeMessages', { clientId: c.clientId, messageId, message: t.message, attachments: t.attachments, ...(t.attachments.length ? { hasAttachments: true } : {}),
        transferId: t._id, state: 'received', receivedAt: Date.now() });
      await ctx.db.patch(t._id, { state: 'finalized', receiptId: id, updatedAt: Date.now() });
      const row = (await ctx.db.get(id))!;
      return { status: 201, body: { receiptId: id, messageId, state: row.state, receivedAt: row.receivedAt } };
    }
    const row = (await ctx.db.get(id))!;
    return { status: 200, body: { receiptId: id, messageId, state: row.state, receivedAt: row.receivedAt } };
  },
});
export const status = internalQuery({
  args: { keyHash: v.string(), messageId: v.string() },
  handler: async (ctx, { keyHash, messageId }): Promise<Outcome> => {
    const c = await auth(ctx, keyHash); if (!c) return fail(401, 'Invalid intake credential');
    const t = await transfer(ctx, c.clientId, messageId);
    if (!t) return fail(404, 'Transfer not found');
    const row = t.receiptId ? await ctx.db.get(t.receiptId) : null;
    return { status: 200, body: { ...summary(t), ...(row ? { receipt: { receiptId: row._id, messageId: row.messageId, state: row.state, receivedAt: row.receivedAt } } : {}) } };
  },
});
export const cancel = internalMutation({
  args: { keyHash: v.string(), messageId: v.string() },
  handler: async (ctx, { keyHash, messageId }): Promise<Outcome> => {
    const c = await auth(ctx, keyHash); if (!c) return fail(401, 'Invalid intake credential');
    const t = await transfer(ctx, c.clientId, messageId); if (!t) return fail(404, 'Transfer not found');
    if (t.receiptId) return fail(409, 'Finalized transfers cannot be cancelled');
    await ctx.db.patch(t._id, { state: 'cancelled', cleanupPending: true });
    await ctx.scheduler.runAfter(0, internal.intakeFiles.cleanDelivered, { transferId: t._id });
    return { status: 200, body: { cancelled: true } };
  },
});
export const cleanDelivered = internalMutation({
  args: { transferId: v.id('intakeTransfers') }, returns: v.null(),
  handler: async (ctx, { transferId }) => {
    const t = await ctx.db.get(transferId);
    if (!t || (!t.localSaved && t.state !== 'cancelled')) return null;
    const chunks = await ctx.db.query('intakeChunks').withIndex('by_block', q => q.eq('transferId', transferId)).take(32);
    for (const c of chunks) { await ctx.storage.delete(c.storageId); await ctx.db.delete(c._id); }
    if (chunks.length === 32) await ctx.scheduler.runAfter(0, internal.intakeFiles.cleanDelivered, { transferId });
    else await ctx.db.patch(transferId, { cloudDeleted: true, cleanupPending: undefined });
    return null;
  },
});
export const sweepCleanup = internalMutation({
  args: {}, returns: v.null(),
  handler: async (ctx) => {
    for (const t of await ctx.db.query('intakeTransfers').withIndex('by_cleanup', q => q.eq('cleanupPending', true)).take(32))
      await ctx.scheduler.runAfter(0, internal.intakeFiles.cleanDelivered, { transferId: t._id });
    return null;
  },
});

export const intakeChunkAccess = query({
  args: { key: v.string(), runnerId: v.string(), receiptId: v.id('intakeMessages'), attachmentId: v.string(), index: v.number(), leaseToken: v.string() },
  handler: async (ctx, { key, runnerId, receiptId, attachmentId, index, leaseToken }) => {
    const caller = await runnerAuth(ctx, key, 'intakeChunkAccess'); await actAs(ctx, caller, runnerId);
    const row = await ctx.db.get(receiptId);
    if (!row?.transferId || row.deliveryState || row.leaseToken !== leaseToken || (row.leaseUntil ?? 0) <= Date.now()) return null;
    const c = await ctx.db.query('intakeClients').withIndex('by_client', q => q.eq('clientId', row.clientId)).unique();
    if (!c || c.revokedAt !== undefined || c.consumerRunnerId !== runnerId) return null;
    const block = await ctx.db.query('intakeChunks').withIndex('by_block', q => q.eq('transferId', row.transferId!).eq('attachmentId', attachmentId).eq('index', index)).unique();
    return block ? { storageId: block.storageId, sha256: block.sha256, bytes: block.bytes } : null;
  },
});

function response(out: Outcome) {
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    ...(out.status === 429 ? { 'Retry-After': String(Math.ceil((3_600_000 - Date.now() % 3_600_000) / 1000)) } : {}) } });
}
async function hashFrom(req: Request) {
  const k = /^Bearer (tbi_[a-f0-9]{64})$/.exec(req.headers.get('authorization') ?? '')?.[1];
  return k ? sha256(k) : null;
}
async function bounded(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  const reader = req.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break;
      length += value.length; if (length > max) { await reader.cancel(); return null; } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let at = 0; for (const c of chunks) { result.set(c, at); at += c.length; } return result;
}
export const jsonRequest = httpAction(async (ctx, req): Promise<Response> => {
  const keyHash = await hashFrom(req);
  if (!keyHash || !await ctx.runQuery(internal.intake.authorized, { keyHash })) return response(fail(401, 'Invalid intake credential'));
  const url = new URL(req.url), op = url.pathname.split('/').pop();
  if (op === 'status') return response(await ctx.runQuery(internal.intakeFiles.status, { keyHash, messageId: url.searchParams.get('messageId') ?? '' }));
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return response(fail(415, 'Expected application/json'));
  const bytes = await bounded(req, 64 * 1024); if (!bytes) return response(fail(413, 'Request exceeds 64 KiB'));
  let b: any;
  try { b = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return response(fail(400, 'Invalid JSON')); }
  if (!b || typeof b !== 'object') return response(fail(400, 'Invalid request'));
  if (op === 'prepare') {
    if (!Array.isArray(b.attachments)) return response(fail(400, 'Expected attachment manifest'));
    const m = validate(b.message, b.attachments.length > 0); if ('status' in m) return response(fail(m.status, m.error ?? 'Invalid message'));
    // Project only expected primitive fields; do not pass arbitrary nested values to Convex validators.
    const specs = b.attachments.map((f: any) => ({ id: f?.id, name: f?.name, mediaType: f?.mediaType, size: f?.size, sha256: f?.sha256 }));
    if (specs.some((f: any) => typeof f.id !== 'string' || typeof f.name !== 'string' || typeof f.mediaType !== 'string' || typeof f.size !== 'number' || typeof f.sha256 !== 'string')) return response(fail(400, 'Invalid manifest'));
    return response(await ctx.runMutation(internal.intakeFiles.prepare, { keyHash, message: m, attachments: specs }));
  }
  if (typeof b.messageId !== 'string') return response(fail(400, 'Expected messageId'));
  if (op === 'finalize') return response(await ctx.runMutation(internal.intakeFiles.finalize, { keyHash, messageId: b.messageId }));
  if (op === 'cancel') return response(await ctx.runMutation(internal.intakeFiles.cancel, { keyHash, messageId: b.messageId }));
  return response(fail(404, 'Not found'));
});
export const upload = httpAction(async (ctx, req): Promise<Response> => {
  const keyHash = await hashFrom(req); if (!keyHash) return response(fail(401, 'Invalid intake credential'));
  const u = new URL(req.url), raw = u.searchParams.get('index');
  const args = { keyHash, messageId: u.searchParams.get('messageId') ?? '', attachmentId: u.searchParams.get('attachmentId') ?? '', index: raw && /^\d+$/.test(raw) ? Number(raw) : -1 };
  const allowed = await ctx.runQuery(internal.intakeFiles.uploadAllowed, args);
  if (allowed.status !== 200) return response(allowed);
  const bytes = await bounded(req, BLOCK_BYTES); if (!bytes) return response(fail(413, 'Block exceeds 8 MiB'));
  if (bytes.length !== allowed.body.bytes) return response(fail(400, 'Incorrect block size'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const checksum = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  const storageId = await ctx.storage.store(new Blob([bytes], { type: 'application/x-threadbear-intake-block' }));
  let keep: boolean | undefined;
  try { const out = await ctx.runMutation(internal.intakeFiles.putChunk, { ...args, storageId, bytes: bytes.length, sha256: checksum }); keep = out.keepStorage === true; return response(out); }
  finally { if (keep === false) await ctx.storage.delete(storageId); }
});
export const download = httpAction(async (ctx, req): Promise<Response> => {
  const key = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!key) return response(fail(401, 'Invalid runner credential'));
  const u = new URL(req.url), receiptId = u.searchParams.get('receiptId') ?? '';
  let access;
  try { access = await ctx.runQuery(api.intakeFiles.intakeChunkAccess, { key, runnerId: u.searchParams.get('runnerId') ?? '', receiptId: receiptId as Id<'intakeMessages'>,
    attachmentId: u.searchParams.get('attachmentId') ?? '', index: Number(u.searchParams.get('index') ?? -1), leaseToken: req.headers.get('x-intake-lease') ?? '' }); }
  catch { return response(fail(403, 'Download refused')); }
  if (!access) return response(fail(403, 'Download refused'));
  const blob = await ctx.storage.get(access.storageId); if (!blob) return response(fail(503, 'Block temporarily unavailable'));
  return new Response(blob, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Chunk-SHA256': access.sha256, 'Content-Length': String(access.bytes) } });
});

// A crash between storage.store and putChunk leaves an unregistered blob.
// Only this private content type is scanned; registered/pending blocks never expire.
export const sweepOrphans = internalMutation({
  args: { cursor: v.optional(v.string()) }, returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.system.query('_storage').paginate({ cursor: cursor ?? null, numItems: 64 });
    for (const blob of page.page) {
      if (blob.contentType === 'application/x-threadbear-intake-block' && blob._creationTime < Date.now() - 86_400_000
        && !await ctx.db.query('intakeChunks').withIndex('by_storageId', q => q.eq('storageId', blob._id)).first()) await ctx.storage.delete(blob._id);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.intakeFiles.sweepOrphans, { cursor: page.continueCursor });
    return null;
  },
});
