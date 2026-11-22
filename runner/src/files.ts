// files.read and files.list (docs/protocol/runners.md, "Other runners' threads"): a file on this
// Mac, for a Mac app showing one of this runner's threads from another Mac.
// Pictures, long tool output (blobs) and file links in a thread's events
// are paths here, which that app can't open, so it asks for the bytes and
// keeps its own copy. Anyone holding this runner's token can already run
// commands through it, so reading a file gives them nothing new; the cap
// is about the size of a WebSocket message, not about what's readable.
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode, RpcError } from './protocol.ts';
import { expandHome } from './config.ts';
import { sniffImage } from './media.ts';

export const FILES_DEFAULT_MAX = 16 * 1024 * 1024;
export const FILES_HARD_MAX = 48 * 1024 * 1024;

const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  pdf: 'application/pdf', json: 'application/json', html: 'text/html', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', zip: 'application/zip',
};

export type FileRead =
  | { path: string; unchanged: true; size: number; modifiedAt: string }
  | { path: string; size: number; modifiedAt: string; mediaType: string; data: string; truncated: boolean };

export function readFileFor(p: { path?: unknown; maxBytes?: unknown; known?: unknown }): FileRead {
  if (typeof p.path !== 'string' || !p.path.trim()) throw new RpcError(ErrorCode.badParams, 'path must be a string');
  const file = path.resolve(expandHome(p.path.trim()));
  if (!path.isAbsolute(p.path.trim()) && !p.path.trim().startsWith('~')) throw new RpcError(ErrorCode.badParams, `path must be absolute: ${p.path}`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new RpcError(ErrorCode.badParams, `No such file: ${file}`);
  }
  if (!stat.isFile()) throw new RpcError(ErrorCode.badParams, `Not a file: ${file}`);
  const modifiedAt = stat.mtime.toISOString();
  // The copy the app has is still this one: say so rather than send it again.
  const known = p.known as { size?: unknown; modifiedAt?: unknown } | undefined;
  if (known && known.size === stat.size && known.modifiedAt === modifiedAt) return { path: file, unchanged: true, size: stat.size, modifiedAt };
  const asked = typeof p.maxBytes === 'number' && p.maxBytes > 0 ? p.maxBytes : FILES_DEFAULT_MAX;
  const max = Math.min(asked, FILES_HARD_MAX);
  const length = Math.min(stat.size, max);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  const mediaType = sniffImage(buf)?.mediaType ?? TYPES[ext] ?? 'application/octet-stream';
  return { path: file, size: stat.size, modifiedAt, mediaType, data: buf.toString('base64'), truncated: stat.size > length };
}

export const FILES_LIST_MAX = 5000;

export type FolderEntry = { name: string; isFolder: boolean; hidden: boolean; size?: number; modifiedAt?: string };
export type FolderList = { path: string; entries: FolderEntry[]; truncated: boolean };

// files.list: a folder on this Mac, for the side pane's folder browser on
// another Mac. Same trust as files.read. Sent in the order the disk gives
// them; the app sorts, as Mike picks the column there.
export function listFolderFor(p: { path?: unknown }): FolderList {
  if (typeof p.path !== 'string' || !p.path.trim()) throw new RpcError(ErrorCode.badParams, 'path must be a string');
  const raw = p.path.trim();
  if (!path.isAbsolute(raw) && !raw.startsWith('~')) throw new RpcError(ErrorCode.badParams, `path must be absolute: ${raw}`);
  const folder = path.resolve(expandHome(raw));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(folder);
  } catch {
    throw new RpcError(ErrorCode.badParams, `No such folder: ${folder}`);
  }
  if (!stat.isDirectory()) throw new RpcError(ErrorCode.badParams, `Not a folder: ${folder}`);
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch (e) {
    // No permission, usually: macOS's privacy rules or the folder's own.
    throw new RpcError(ErrorCode.badParams, `Can't read ${folder}: ${(e as Error).message}`);
  }
  const entries = names.slice(0, FILES_LIST_MAX).map((name): FolderEntry => {
    const hidden = name.startsWith('.');
    try {
      // statSync follows a symlink, so a link to a folder opens as one.
      const s = fs.statSync(path.join(folder, name));
      return { name, isFolder: s.isDirectory(), hidden, ...(s.isDirectory() ? {} : { size: s.size }), modifiedAt: s.mtime.toISOString() };
    } catch {
      // A broken link, or gone since the listing: still there to see.
      return { name, isFolder: false, hidden };
    }
  });
  return { path: folder, entries, truncated: names.length > entries.length };
}

export function filesMethods(): Record<string, (p: Record<string, unknown>) => unknown> {
  return { 'files.read': (p) => readFileFor(p), 'files.list': (p) => listFolderFor(p) };
}
