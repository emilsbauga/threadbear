// Runs a synchronous look at a folder (claude-trust.ts claudeCommands,
// unhashed-scan.ts) so that no read in it can wait on a FIFO or socket.
// Read whole, a FIFO with no writer holds the thread in the OS for good:
// past any time limit, and past the runner's exit, as node joins its
// worker threads (Codex's reviews, 19 Nov). The trust code reads with
// fs.readFileSync and fs.openSync, so for the length of the call those
// open without waiting (O_NONBLOCK), look at what they opened (fstat, so
// nothing can be swapped in between) and refuse a FIFO or socket.
//
// Refusing isn't enough by itself: the trust code takes a file it can't
// read as missing, and a FIFO mustn't pass for missing settings that
// Claude would then read. So the whole call fails, naming the file.
// Devices are read as before (a hook's /dev/null reads as nothing at once).
// Only the runner's own reads: git, which the look runs, reads its config
// itself, and a FIFO there holds it until its time limit (safe-git.ts, 10 s).
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

class SpecialFile extends Error {}

function readOnly(flags: unknown): boolean {
  return flags === undefined || flags === 'r' || flags === fs.constants.O_RDONLY;
}

export function noFifoReads<T>(fn: () => T): T {
  const readFileSync = fs.readFileSync;
  const openSync = fs.openSync;
  let special: string | undefined;
  // Opens `p` to read without waiting, refusing a FIFO or socket.
  const open = (p: fs.PathLike, mode?: fs.Mode): number => {
    const fd = openSync(p, fs.constants.O_RDONLY | NONBLOCK, mode);
    let st: fs.Stats;
    try {
      st = fs.fstatSync(fd);
    } catch (e) {
      fs.closeSync(fd);
      throw e;
    }
    if (st.isFIFO() || st.isSocket()) {
      fs.closeSync(fd);
      special ??= String(p);
      throw new SpecialFile(`${String(p)} is a FIFO or socket`);
    }
    return fd;
  };
  fs.openSync = function guarded(this: unknown, p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) {
    if (!readOnly(flags)) return openSync.call(fs, p, flags!, mode);
    return open(p, mode);
  } as typeof fs.openSync;
  fs.readFileSync = function guarded(this: unknown, ...args: Parameters<typeof readFileSync>) {
    const [p, options] = args;
    const flag = typeof options === 'object' && options !== null ? options.flag : undefined;
    if (typeof p === 'number' || !readOnly(flag)) return readFileSync.apply(fs, args);
    const fd = open(p);
    try {
      return readFileSync.call(fs, fd, options as never);
    } finally {
      fs.closeSync(fd);
    }
  } as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    const value = fn();
    if (special !== undefined) throw new Error(`${special} is a FIFO or socket, not a file, so Threadbear can't tell what it holds.`);
    return value;
  } catch (e) {
    if (special !== undefined) throw new Error(`${special} is a FIFO or socket, not a file, so Threadbear can't tell what it holds.`);
    throw e;
  } finally {
    fs.readFileSync = readFileSync;
    fs.openSync = openSync;
    syncBuiltinESMExports();
  }
}
