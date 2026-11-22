// How much a thread below Full access may put in the runner's inbox through
// media.import (Daybreak finding 157). The call is open to every thread's key
// so `tb send --image` works from an Ask thread, but each import is a write
// (and maybe a conversion), so it's metered: refused before the file is even
// opened once the thread, or all such threads together, have used the day's
// allowance, or while that thread already has one running. The file is opened
// once, and that one open file is what's measured and copied, so it can't be
// swapped or grown in between. A converted picture counts at its real size,
// and is refused if that no longer fits.
//
// What such a thread then sends or starts a thread with may only be pictures
// it imported itself, each once (take). The inbox file is the thread's to
// write too, so take doesn't trust it: it copies what's there now, from one
// open file that must still be the one imported (same file, same size), into
// a copy of its own, only if it's still a picture that needs no converting,
// and the message carries that copy. Otherwise threads.send would copy (or
// convert) any file into a thread's media, unmetered.
//
// Full-access threads and the runner's own token aren't metered: they can
// already write anything on the Mac. The counts are kept in memory, so a
// runner restart starts them afresh; nothing below Full can restart it.
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode, RpcError, type ImageRef } from './protocol.ts';
import crypto from 'node:crypto';
import { extForMediaType, importOpened, openForImport, readImageInfo } from './media.ts';

const DAY_MS = 86_400_000;

export type ImportLimits = { files: number; bytes: number };

export const PER_THREAD: ImportLimits = { files: 50, bytes: 200 * 1024 * 1024 };
export const ALL_THREADS: ImportLimits = { files: 200, bytes: 1024 * 1024 * 1024 };
// Biggest picture such a thread may import (a screenshot is a few MB): what
// a send copies at once stays small.
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;
// Imports running at once, across the threads metered here.
const MAX_RUNNING = 2;
// Pictures one message or new thread may carry from such a thread.
export const MAX_IMAGES_PER_SEND = 10;

type Spent = { threadId: string; at: number; bytes: number };
type Made = { threadId: string; dev: number; ino: number; size: number; mediaType: string; width?: number; height?: number };

const bad = (message: string) => new RpcError(ErrorCode.badParams, message);

export class ImportQuota {
  private spent: Spent[] = [];
  private running = new Set<string>();
  // Inbox files a metered thread imported and hasn't sent yet, by path.
  private made = new Map<string, Made>();
  // The copies take made, until the send that carries them is done.
  private held = new Set<string>();
  private readonly now: () => number;
  private readonly perThread: ImportLimits;
  private readonly all: ImportLimits;

  constructor(opts: { now?: () => number; perThread?: ImportLimits; all?: ImportLimits } = {}) {
    this.now = opts.now ?? Date.now;
    this.perThread = opts.perThread ?? PER_THREAD;
    this.all = opts.all ?? ALL_THREADS;
  }

  // Imports `src` into `dir` for `threadId` if the allowance has room,
  // counting it whether or not it succeeds (a failed conversion still cost
  // the work). Throws -32602, having copied nothing, otherwise.
  async run(threadId: string, src: string, dir: string): Promise<ImageRef> {
    // Everything that can refuse without looking at the file comes first, so
    // a refused call opens nothing.
    if (this.running.has(threadId)) throw bad('This thread is already adding a picture; wait for it to finish');
    if (this.running.size >= MAX_RUNNING) throw bad('Too many threads are adding pictures right now; try again in a moment');
    this.prune();
    const overMine = () => bad(`This thread has added its pictures for today (${this.perThread.files} files or ${Math.round(this.perThread.bytes / 1024 / 1024)} MB a day below Full access); try again later`);
    const overAll = () => bad('Threads below Full access have added their pictures for today; try again later');
    if (this.mine(threadId).length + 1 > this.perThread.files) throw overMine();
    if (this.spent.length + 1 > this.all.files) throw overAll();
    this.running.add(threadId);
    try {
      const opened = await openForImport(src).catch((e: Error) => {
        throw bad(e.message);
      });
      try {
        const { st } = opened;
        if (st.size > MAX_PICTURE_BYTES) throw bad(`${opened.name} is too big to add from a thread below Full access (over ${MAX_PICTURE_BYTES / 1024 / 1024} MB)`);
        if (st.size > this.roomMine(threadId)) throw overMine();
        if (st.size > this.roomAll()) throw overAll();
        // Again now the open is done: another import may have been counted meanwhile.
        if (this.mine(threadId).length + 1 > this.perThread.files) throw overMine();
        if (this.spent.length + 1 > this.all.files) throw overAll();
        const entry: Spent = { threadId, at: this.now(), bytes: st.size };
        this.spent.push(entry);
        const ref = await importOpened(dir, opened, { maxOut: Math.min(MAX_PICTURE_BYTES, this.roomMine(threadId) + entry.bytes, this.roomAll() + entry.bytes) }).catch((e: Error) => {
          throw bad(e.message);
        });
        // A converted picture counts at whichever is bigger, checked again
        // now it's made, as another thread's may have finished meanwhile.
        const out = await fs.promises.lstat(ref.path);
        const grown = Math.max(0, out.size - entry.bytes);
        if (grown > this.roomMine(threadId) || grown > this.roomAll()) {
          await fs.promises.rm(ref.path, { force: true });
          throw grown > this.roomMine(threadId) ? overMine() : overAll();
        }
        entry.bytes += grown;
        this.made.set(path.resolve(ref.path), { threadId, dev: out.dev, ino: out.ino, size: out.size, mediaType: ref.mediaType, width: ref.width, height: ref.height });
        return ref;
      } finally {
        await opened.fh.close();
      }
    } finally {
      this.running.delete(threadId);
    }
  }

  private prune(): void {
    const cutoff = this.now() - DAY_MS;
    this.spent = this.spent.filter((s) => s.at > cutoff);
  }

  private mine(threadId: string): Spent[] {
    return this.spent.filter((s) => s.threadId === threadId);
  }

  private roomMine(threadId: string): number {
    return this.perThread.bytes - this.mine(threadId).reduce((n, s) => n + s.bytes, 0);
  }

  private roomAll(): number {
    return this.all.bytes - this.spent.reduce((n, s) => n + s.bytes, 0);
  }

  // The pictures a metered thread's message or new thread carries: each must
  // be one it imported and hasn't sent, and it's used up here. Gives back the
  // refs to send in their place: fresh copies, made here from the inbox file
  // as it now is, which must still be that file at that size and a picture
  // that needs no converting. Throws -32602 otherwise.
  take(threadId: string, images: unknown): ImageRef[] {
    if (images === undefined || images === null) return [];
    if (!Array.isArray(images)) throw bad('images must be an array');
    if (images.length > MAX_IMAGES_PER_SEND) throw bad(`At most ${MAX_IMAGES_PER_SEND} pictures at once from a thread below Full access`);
    const notMine = (p?: string) => bad(`A thread below Full access sends only pictures it added with media.import (tb send --image), each once: ${p ? path.basename(p) : 'a picture'}`);
    const paths = images.map((img) => {
      const p = img && typeof img === 'object' && typeof (img as ImageRef).path === 'string' ? path.resolve((img as ImageRef).path) : undefined;
      if (!p || this.made.get(p)?.threadId !== threadId) throw notMine(p);
      return p;
    });
    if (new Set(paths).size !== paths.length) throw bad('The same picture twice in one message');
    const out: ImageRef[] = [];
    try {
      for (const p of paths) {
        const m = this.made.get(p)!;
        this.made.delete(p);
        const ref = copyHeld(p, m, () => notMine(p));
        this.held.add(ref.path);
        out.push(ref);
        fs.rmSync(p, { force: true });
      }
    } catch (e) {
      for (const r of out) fs.rmSync(r.path, { force: true });
      throw e;
    }
    return out;
  }

  // Once the send carrying take's copies is done (copied into the thread, or
  // refused), they go.
  releaseHeld(images: unknown): void {
    if (!Array.isArray(images)) return;
    for (const img of images) {
      const p = img && typeof img === 'object' ? (img as ImageRef).path : undefined;
      if (typeof p === 'string' && this.held.delete(p)) fs.rmSync(p, { force: true });
    }
  }

  // An import whose caller had gone by the time it finished: nobody has its
  // path, so it goes now rather than in a week (it stays counted).
  discard(ref: ImageRef): void {
    const p = path.resolve(ref.path);
    this.made.delete(p);
    fs.rmSync(p, { force: true });
  }
}

// The held copy take sends: the inbox file opened once without following a
// link, checked to be the file imported at the size imported, its bytes copied
// into a new file beside it, and that copy checked to be a picture of the
// type imported. Synchronous, as the send that follows is; the size was
// counted when it was imported.
function copyHeld(p: string, m: Made, refuse: () => Error): ImageRef {
  const held = path.join(path.dirname(p), `${crypto.randomUUID()}.held.${extForMediaType(m.mediaType)}`);
  let fd: number | undefined;
  let out: number | undefined;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== m.dev || st.ino !== m.ino || st.size !== m.size) throw refuse();
    out = fs.openSync(held, 'wx', 0o600);
    const buf = Buffer.alloc(Math.min(m.size, 1024 * 1024));
    let at = 0;
    while (at < m.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, m.size - at), at);
      if (n === 0) break;
      fs.writeSync(out, buf, 0, n);
      at += n;
    }
    if (at !== m.size) throw refuse();
  } catch (e) {
    if (out !== undefined) fs.closeSync(out);
    out = undefined;
    fs.rmSync(held, { force: true });
    throw e instanceof RpcError ? e : refuse();
  } finally {
    if (out !== undefined) fs.closeSync(out);
    if (fd !== undefined) fs.closeSync(fd);
  }
  const info = readImageInfo(held);
  if (!info || info.mediaType !== m.mediaType) {
    fs.rmSync(held, { force: true });
    throw refuse();
  }
  return { path: held, mediaType: info.mediaType, ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}) };
}
