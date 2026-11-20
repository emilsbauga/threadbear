import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import { isCliFor } from './stuck-jobs.ts';
import { IS_WINDOWS } from './platform.ts';

// A CLI frozen on something only a person can answer (docs/protocol.md,
// "Frozen CLIs"). On 31 Oct 2026 a phone thread went to Bruce, its command
// named ~/Documents, and the CLI's main thread sat in open(2) waiting on a
// macOS privacy dialog nobody was at the Mac to click. The thread looked
// like it was working for 11 minutes, until Mike asked another thread why.
//
// Quiet alone says nothing: a long build is quiet too. So a turn that's been
// quiet for a minute gets a look with macOS's `sample`, and what counts is
// the main thread spending the whole sample inside one file system call, at
// two looks in a row. A CLI waiting on the model or on a command sits in
// kevent instead, so the signature doesn't catch those.
//
// Only the CLI itself is looked at. A command that blocks the same way is
// the CLI's own business: it moves it to the background after 2 minutes and
// tells the agent, which can then say so (tried on a real CLI, 31 Oct 2026).

export const SWEEP_MS = 30_000;
// How long a turn has to have said nothing before it gets a look.
export const QUIET_MS = 60_000;
// Between looks at a turn that seems fine. It doubles up to the most, as a
// quiet CLI is nearly always a long command, and sampling costs a second.
export const MAX_GAP_MS = 5 * 60_000;
// How long after saying so a frozen CLI is stopped. Long enough to get to
// the dialog if you're at that Mac, and nothing is lost: the session resumes.
export const STOP_AFTER_MS = 5 * 60_000;
// How much of the sample the main thread has to spend in the call.
const STUCK_SHARE = 0.9;

export type QuietTurn = { threadId: string; turnId: string; sessionId: string; quietMs: number };

export type Proc = { pid: number; command: string };

export interface FrozenProbe {
  processes(): Promise<Proc[]>;
  // The file system call its main thread is stuck in, if it is.
  stuckIn(pid: number): Promise<string | undefined>;
}

type Host = {
  quietTurns(minMs: number): QuietTurn[];
  cliFrozen(threadId: string, turnId: string, text: string): void;
  cliMovingAgain(threadId: string, turnId: string, text: string): void;
  stopFrozenCli(threadId: string, turnId: string, text: string): void;
};

type Deps = { host: Host; clock: Clock; log: Logger; machine: string; probe?: FrozenProbe };

type Watch = {
  threadId: string;
  nextLookAt: number;
  gap: number;
  // It looked stuck at the last look.
  suspect: boolean;
  toldAt?: number;
};

export class FrozenClis {
  private deps: Deps;
  private probe: FrozenProbe;
  private timer?: TimerHandle;
  private sweeping = false;
  private watches = new Map<string, Watch>();

  // Windows has no ps, sandbox-exec or sample to look at a CLI with, so
  // without a probe of its own there is nothing to do there: it never arms.
  private readonly off: boolean;

  constructor(deps: Deps) {
    this.deps = deps;
    this.off = IS_WINDOWS && !deps.probe;
    this.probe = deps.probe ?? realProbe();
  }

  start(): void {
    if (!this.off) this.arm();
  }

  stop(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  private arm(): void {
    this.timer = this.deps.clock.setTimeout(() => {
      void this.sweep().finally(() => this.timer && this.arm());
    }, SWEEP_MS);
  }

  async sweep(): Promise<void> {
    if (this.off || this.sweeping) return;
    this.sweeping = true;
    try {
      await this.look();
    } catch (e) {
      this.deps.log.warn('frozen CLI check failed', { error: (e as Error).message });
    } finally {
      this.sweeping = false;
    }
  }

  private async look(): Promise<void> {
    const { host, clock, machine } = this.deps;
    const now = clock.now();
    const turns = host.quietTurns(QUIET_MS);
    const quiet = new Set(turns.map((t) => t.turnId));
    // It said something, so it isn't frozen, or the turn is over.
    for (const [turnId, w] of this.watches) {
      if (quiet.has(turnId)) continue;
      this.watches.delete(turnId);
      if (w.toldAt !== undefined) host.cliMovingAgain(w.threadId, turnId, movingText(machine));
    }
    const due = turns.filter((t) => (this.watches.get(t.turnId)?.nextLookAt ?? 0) <= now);
    if (!due.length) return;
    const table = await this.probe.processes();
    for (const turn of due) await this.lookAt(turn, table, now);
  }

  private async lookAt(turn: QuietTurn, table: Proc[], now: number): Promise<void> {
    const { host, machine, log } = this.deps;
    let w = this.watches.get(turn.turnId);
    if (!w) {
      w = { threadId: turn.threadId, nextLookAt: 0, gap: SWEEP_MS, suspect: false };
      this.watches.set(turn.turnId, w);
    }
    const cli = table.find((p) => isCliFor(p.command, turn.sessionId));
    if (!cli) {
      // Not started yet, or just gone. Its exit ends the turn.
      w.nextLookAt = now + SWEEP_MS;
      return;
    }
    const stuck = Boolean(await this.probe.stuckIn(cli.pid));
    // Once is a slow disk. The same thing at the next look is frozen.
    const again = stuck && w.suspect;
    w.suspect = stuck;
    if (!stuck) {
      if (w.toldAt !== undefined) {
        host.cliMovingAgain(turn.threadId, turn.turnId, movingText(machine));
        w.toldAt = undefined;
      }
      w.nextLookAt = now + w.gap;
      w.gap = Math.min(w.gap * 2, MAX_GAP_MS);
      return;
    }
    w.gap = SWEEP_MS;
    w.nextLookAt = now + SWEEP_MS;
    if (!again) return;
    if (w.toldAt === undefined) {
      w.toldAt = now;
      log.warn('a CLI looks frozen', { threadId: turn.threadId });
      host.cliFrozen(turn.threadId, turn.turnId, frozenText(machine));
    } else if (now - w.toldAt >= STOP_AFTER_MS) {
      this.watches.delete(turn.turnId);
      log.warn('stopping a frozen CLI', { threadId: turn.threadId });
      host.stopFrozenCli(turn.threadId, turn.turnId, stoppedText(machine));
    }
  }
}

export function frozenText(machine: string): string {
  return `Claude Code is stuck opening a file on ${machine}, so this thread isn't getting anywhere. macOS is probably showing a permission prompt on that Mac's screen, or a disk isn't responding. Answer the prompt there, or give Threadbear Runner Full Disk Access in System Settings > Privacy & Security on that Mac. If nothing changes, this turn stops in ${STOP_AFTER_MS / 60_000} minutes.`;
}

export function movingText(machine: string): string {
  return `Claude Code on ${machine} is moving again.`;
}

export function stoppedText(machine: string): string {
  return `Stopped this turn: Claude Code stayed stuck opening a file on ${machine}, probably on a macOS permission prompt nobody answered. Answer it on that Mac's screen, or give Threadbear Runner Full Disk Access in System Settings > Privacy & Security there, then send your message again.`;
}

// The file system calls a privacy prompt or a dead disk holds up.
const FILE_CALL = /^(?:__)?(?:open|openat|open_dprotected_np|stat|stat64|lstat|lstat64|fstatat|fstatat64|getattrlist|getattrlistat|getattrlistbulk|getdirentries|getdirentries64|access|faccessat|readlink|readlinkat)(?:\$NOCANCEL|_nocancel)?$/;

// Reads `sample`'s call graph: the main thread's block is its header line
// (with how many samples it had) and the indented frames up to the next
// thread, each with its own count.
export function fileCallInSample(text: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*\d+\s+Thread_\S+.*com\.apple\.main-thread/.test(l));
  if (start < 0) return undefined;
  const total = Number(/^\s*(\d+)/.exec(lines[start])![1]);
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*\d+\s+Thread_/.test(line)) break;
    const m = /^[\s+!:|]*(\d+)\s+(\S+)\s+\(in libsystem_kernel/.exec(line);
    if (m && FILE_CALL.test(m[2]) && Number(m[1]) >= total * STUCK_SHARE) return m[2];
  }
  return undefined;
}

export function parseProcs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), command: m[2] });
  }
  return out;
}

// sample hunts for debug symbols through Spotlight, wherever it says they
// are. On Bruce that took it to a folder deep in an external drive, which
// macOS asks about in Threadbear Runner's name: the very prompt this file is
// looking for. It happened first at 21:54 on 31 Oct 2026, in the unit test of
// this code that every release build runs, and that prompt then held up every
// other app on that drive until 06:43 (docs/protocol.md, "A dialog on a Mac's
// screen"). The sandbox refuses those paths before macOS thinks of asking.
// The stacks it's after come from the system's own libraries, which it can
// still read (tried on Bruce, 1 Nov 2026).
export function sampleSandbox(home: string): string {
  const paths = [
    '/Volumes',
    '/System/Volumes/Data/Volumes',
    ...['Desktop', 'Documents', 'Downloads', 'Dropbox', 'Library/CloudStorage', 'Library/Mobile Documents'].map((d) => path.join(home, d)),
  ];
  return `(version 1)(allow default)(deny file* ${paths.map((p) => `(subpath ${JSON.stringify(p)})`).join(' ')})`;
}

export function realProbe(): FrozenProbe {
  return {
    async processes() {
      return parseProcs(await run('/bin/ps', ['-axo', 'pid=,command=']));
    },
    async stuckIn(pid) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadbear-sample-'));
      const file = path.join(dir, 'sample.txt');
      try {
        await run('/usr/bin/sandbox-exec', ['-p', sampleSandbox(os.homedir()), '/usr/bin/sample', String(pid), '1', '-mayDie', '-file', file]);
        return fileCallInSample(fs.readFileSync(file, 'utf8'));
      } catch {
        // It ended, or macOS won't let it be sampled: nothing to go on.
        return undefined;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
