import fs from 'node:fs';
import path from 'node:path';
import { ownStartTime, pidExists, processInfo, sameStart, sameStartTime, startOf, type Started } from './proc.ts';
import { IS_WINDOWS } from './platform.ts';

// One runner per data dir. A second one (`npm start` while the LaunchAgent
// runs, say) would sweep the first one's CLIs as orphans and append to the
// same event logs, so it has to stop before it touches anything.
// run/runner.pid holds the owner's pid and start time; a lock whose owner
// is gone, or whose pid now belongs to another process, is taken over.
export type Lock = { release(): void };

// `name` lets other jobs that must run one at a time across runners (the
// Agent Archive build, agent-archive.ts) use the same kind of lock.
export function acquireLock(runDir: string, name = 'runner.pid'): Lock | { heldBy: number } {
  const file = path.join(runDir, name);
  // Where PowerShell can't give the start time on Windows, node's own clock does.
  const info = processInfo(process.pid);
  const me = { pid: process.pid, ...(info ? startOf(info) : { lstart: IS_WINDOWS ? ownStartTime() : '' }) };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(runDir, { recursive: true });
      // Written whole, then linked in, which fails if the lock exists: an
      // empty file mid-write would look unowned to another taker, who would
      // delete it and take the lock too.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(me) + '\n', { mode: 0o644 });
      try {
        fs.linkSync(tmp, file);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      return {
        release() {
          try {
            if (readHolder(file)?.pid === process.pid) fs.unlinkSync(file);
          } catch {
            // already gone
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = readHolder(file);
      if (holder && holder.pid !== process.pid && holderAlive(holder)) return { heldBy: holder.pid };
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`Couldn't take the lock at ${file}`);
}

type Holder = { pid: number; lstart?: string } & Started;

function readHolder(file: string): Holder | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    // Older runners wrote just the pid.
    if (/^\d+$/.test(raw)) return { pid: Number(raw) };
    const j = JSON.parse(raw) as { pid?: unknown; lstart?: unknown; started?: unknown };
    if (typeof j.pid !== 'number') return null;
    return { pid: j.pid, lstart: typeof j.lstart === 'string' ? j.lstart : undefined, ...(typeof j.started === 'string' ? { started: j.started } : {}) };
  } catch {
    return null;
  }
}

function holderAlive(h: Holder): boolean {
  if (IS_WINDOWS) return holderAliveWindows(h);
  const info = processInfo(h.pid);
  if (!info) return false;
  if (h.lstart || h.started) return sameStart(h, info);
  // A runner under launch.mjs (a release) shows as launch.mjs, not main.ts.
  return /main\.ts|launch\.mjs/.test(info.command);
}

// Windows reads a process's start time through PowerShell, which can fail (policy,
// AppLocker, a timeout under load). That must never make a live runner look gone,
// or a second one starts on the same data dir.
function holderAliveWindows(h: { pid: number; lstart?: string }): boolean {
  if (!pidExists(h.pid)) return false;
  const info = processInfo(h.pid);
  // There, but PowerShell wouldn't say when it started. A stale lock that
  // someone has to delete is a smaller harm than two runners.
  if (!info) return true;
  if (h.lstart) return sameStartTime(h.lstart, info.lstart);
  // No start time recorded: the process name is all there is. The runner runs under node.
  return /^node$/i.test(info.command);
}
