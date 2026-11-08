import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Write to a temp file in the same folder, fsync, then rename, so a crash
// never leaves a half-written thread.json behind.
export function atomicWriteFileSync(file: string, data: string | Buffer, mode?: number, exclusive = false): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w', mode ?? 0o644);
  try {
    if (typeof data === 'string') fs.writeSync(fd, data);
    else fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (exclusive) {
    // Publish a fully written file only if no competing creator published one.
    try { fs.linkSync(tmp, file); } finally { fs.unlinkSync(tmp); }
  } else fs.renameSync(tmp, file);
}

export function readJsonSync<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Removes the `.<name>.<pid>.<hex>.tmp` files atomicWriteFileSync leaves if
// the process dies between writing and renaming. dirs are scanned one
// level down as well (the thread folders). Only safe while holding the
// runner lock, when nothing else is writing.
export function removeTempFiles(...dirs: string[]): number {
  let removed = 0;
  const clean = (dir: string, depth: number) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isFile() && /^\..+\.\d+\.[0-9a-f]{8}\.tmp$/.test(d.name)) {
        try {
          fs.unlinkSync(p);
          removed++;
        } catch {
          // gone already
        }
      } else if (d.isDirectory() && depth > 0) clean(p, depth - 1);
    }
  };
  for (const d of dirs) clean(d, 1);
  return removed;
}
