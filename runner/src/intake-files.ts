import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { intakeThreadId, savedIntake, type IntakeRecord } from './intake-record.ts';
import type { AttachmentRef } from './protocol.ts';
import { atomicWriteFileSync } from './fsutil.ts';
export const BLOCK_BYTES = 8 * 1024 * 1024;
const hex = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
async function matches(file: string, size: number, sha: string): Promise<boolean> {
  try {
    const st = await fsp.lstat(file); if (!st.isFile() || st.size !== size) return false;
    const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b);
    return h.digest('hex') === sha;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function downloadIntakeFiles(args: {
  home: string; item: IntakeRecord; origin: string; key: string; runnerId: string; leaseToken: string;
  signal: AbortSignal; fetcher?: typeof fetch;
}): Promise<AttachmentRef[]> {
  const { home, item, signal } = args;
  if (savedIntake(home, item)) return [];
  const threadDir = path.join(home, 'threads', intakeThreadId(item.clientId, item.receiptId));
  const recordPath = path.join(threadDir, 'thread.json');
  if (fs.existsSync(recordPath)) {
    const rec = JSON.parse(await fsp.readFile(recordPath, 'utf8'));
    if (rec.intake?.clientId !== item.clientId || rec.intake?.receiptId !== item.receiptId) throw new Error('Intake thread identity collision');
    return []; // Already published: never overwrite subsequent user edits.
  }
  const dir = path.join(threadDir, 'attachments');
  const staging = path.join(dir, '.transfer');
  const refs: AttachmentRef[] = [];
  for (const spec of item.attachments ?? []) {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(spec.size) || spec.size < 0 || !/^[a-f0-9]{64}$/.test(spec.sha256)) throw new Error('Invalid attachment manifest');
    await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
    const stem = hex(spec.id), ext = /\.[a-zA-Z0-9]{1,16}$/.exec(spec.name)?.[0] ?? '';
    const file = path.join(dir, stem + ext), held = path.join(staging, stem + '.held.json');
    if (!await matches(file, spec.size, spec.sha256)) {
      if (fs.existsSync(held)) throw new Error('Intake file held for checksum investigation');
      const blocks: string[] = [];
      for (let index = 0; index < Math.ceil(spec.size / BLOCK_BYTES); index++) {
        signal.throwIfAborted();
        const block = path.join(staging, `${stem}.${index}`), meta = block + '.json';
        const size = Math.min(BLOCK_BYTES, spec.size - index * BLOCK_BYTES);
        let sha = ''; try { sha = JSON.parse(await fsp.readFile(meta, 'utf8')).sha256; } catch {}
        if (!/^[a-f0-9]{64}$/.test(sha) || !await matches(block, size, sha)) {
          const url = new URL('/intake/v2/download', args.origin);
          for (const [k, v] of Object.entries({ runnerId: args.runnerId, receiptId: item.receiptId, attachmentId: spec.id, index: String(index) })) url.searchParams.set(k, v);
          const res = await (args.fetcher ?? fetch)(url, { headers: { Authorization: `Bearer ${args.key}`, 'X-Intake-Lease': args.leaseToken }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
          if (!res.ok) { await res.body?.cancel(); throw new Error(`Intake file download refused (${res.status})`); }
          sha = res.headers.get('x-chunk-sha256') ?? '';
          if (!/^[a-f0-9]{64}$/.test(sha)) { await res.body?.cancel(); throw new Error('Invalid block checksum'); }
          const reader = res.body?.getReader(); if (!reader) throw new Error('Empty block response');
          const parts: Buffer[] = []; let length = 0;
          try { while (true) { const { done, value } = await reader.read(); if (done) break;
            length += value.length; if (length > size) { await reader.cancel(); throw new Error('Oversized block response'); } parts.push(Buffer.from(value));
          } } finally { reader.releaseLock(); }
          const bytes = Buffer.concat(parts);
          if (bytes.length !== size || hex(bytes) !== sha) {
            atomicWriteFileSync(held, JSON.stringify({ attachmentId: spec.id, reason: 'block-checksum', sha256: spec.sha256 }), 0o600);
            throw new Error('Intake block checksum mismatch');
          }
          atomicWriteFileSync(block, bytes, 0o600);
          atomicWriteFileSync(meta, JSON.stringify({ sha256: sha }), 0o600);
        }
        blocks.push(block);
      }
      const temp = path.join(staging, stem + '.assembling');
      const handle = await fsp.open(temp, 'w', 0o600);
      const h = crypto.createHash('sha256'); let length = 0;
      try {
        for (const block of blocks) for await (const b of fs.createReadStream(block)) {
          signal.throwIfAborted(); h.update(b); length += b.length;
          let offset = 0; while (offset < b.length) { const { bytesWritten } = await handle.write(b, offset); offset += bytesWritten; }
        }
        if (length !== spec.size || h.digest('hex') !== spec.sha256) {
          // A frozen manifest mismatch requires operator investigation, not repeated cloud downloads.
          atomicWriteFileSync(held, JSON.stringify({ attachmentId: spec.id, reason: 'file-checksum', sha256: spec.sha256 }), 0o600);
          throw new Error('Intake file checksum mismatch');
        }
        await handle.sync();
      } finally { await handle.close(); }
      signal.throwIfAborted(); await fsp.rename(temp, file);
      const directory = await fsp.open(dir, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      for (const b of blocks) { await fsp.rm(b, { force: true }); await fsp.rm(b + '.json', { force: true }); }
    }
    // Also clean blocks left by a crash immediately after the final rename.
    for (let i = 0; i < Math.ceil(spec.size / BLOCK_BYTES); i++) {
      await fsp.rm(path.join(staging, `${stem}.${i}`), { force: true });
      await fsp.rm(path.join(staging, `${stem}.${i}.json`), { force: true });
    }
    refs.push({ ...spec, path: file });
  }
  try { await fsp.rmdir(staging); } catch (e) { if (!['ENOENT', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
  return refs;
}

// Intake files are already thread-owned; RPC edits may select them, never
// replace their provenance or point at a different local file.
export function selectAttachments(dir: string, files: AttachmentRef[], known?: AttachmentRef[]): AttachmentRef[] {
  const ids = new Set<string>();
  return files.map(f => {
    if (!f || typeof f.id !== 'string' || typeof f.path !== 'string' || typeof f.name !== 'string' || typeof f.mediaType !== 'string'
      || !Number.isSafeInteger(f.size) || f.size < 0 || !/^[a-f0-9]{64}$/.test(f.sha256) || ids.has(f.id)
      || path.dirname(f.path) !== dir || (known && !known.some(k => k.id === f.id && k.path === f.path && k.name === f.name && k.mediaType === f.mediaType && k.size === f.size && k.sha256 === f.sha256))) throw new Error('Invalid attachment selection');
    ids.add(f.id);
    const st = fs.lstatSync(f.path); if (!st.isFile() || st.size !== f.size) throw new Error('Attachment file is missing or changed');
    return { ...f };
  });
}
