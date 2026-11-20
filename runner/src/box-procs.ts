// Box mode's categorical quiesce (box-save.ts, Codex's third review of
// slice 3): in a box the runner owns the whole machine, so before a
// stopping save copies anything, every other process the box has started
// is killed: the CLI's leftovers, a worktree setup's background children,
// a teardown, anything an agent left running. What's spared: the runner,
// its ancestors (the image's entrypoint), PID 1, and whatever was already
// running when the box booted (the provider's own helpers, such as Fly's
// init and its SSH server). Never on a normal runner: main.ts makes one
// only in box mode, and it reads Linux's /proc (a box is a Linux machine).
import fs from 'node:fs';
import path from 'node:path';

export type Proc = { pid: number; ppid: number; start: string; alive: boolean; cmd?: string };
// The provider's processes, as the box's first start found them (box.json's
// `baseline`): spared by pid and start time, every start after.
export type Baseline = { pid: number; start: string; cmd: string };

// One /proc/<pid>/stat (or a task's): its state, parent and start time
// (clock ticks since boot, which tells a reused pid from the first).
function readStat(file: string): { state: string; ppid: number; start: string } | undefined {
  let stat: string;
  try {
    stat = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined; // gone meanwhile
  }
  // "pid (comm) state ppid ...": comm can hold spaces and parens, so the
  // fields are read after its last ')'.
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ppid = Number(rest[1]);
  if (!Number.isInteger(ppid)) return undefined;
  return { state: rest[0] ?? '', ppid, start: rest[19] ?? '' };
}

const dead = (state: string) => state === 'Z' || state === 'X';

// Every process. A thread-group leader that's a zombie can still have live
// threads (its tasks): it's alive while any task is, and a SIGKILL to the
// group's id ends them all.
export function listProcs(root = '/proc'): Proc[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (e) {
    throw new Error(`can't list the box's processes (${String((e as Error).message ?? e)})`);
  }
  const out: Proc[] = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const st = readStat(path.join(root, n, 'stat'));
    if (!st) continue;
    let alive = !dead(st.state);
    if (!alive) {
      let tasks: string[] = [];
      try {
        tasks = fs.readdirSync(path.join(root, n, 'task'));
      } catch {
        tasks = [];
      }
      alive = tasks.some((t) => {
        const ts = readStat(path.join(root, n, 'task', t, 'stat'));
        return ts !== undefined && !dead(ts.state);
      });
    }
    let cmd = '';
    try {
      cmd = fs.readFileSync(path.join(root, n, 'cmdline'), 'utf8').split('\0').join(' ').trim().slice(0, 200);
    } catch {
      cmd = '';
    }
    out.push({ pid: Number(n), ppid: st.ppid, start: st.start, alive, ...(cmd ? { cmd } : {}) });
  }
  return out;
}

const key = (p: { pid: number; start: string }) => `${p.pid}:${p.start}`;

export class BoxProcesses {
  private readonly self: number;
  private readonly list: () => Proc[];
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseline: Set<string>;

  // `baseline`: the provider's processes as the box's first start found
  // them (capture), kept in box.json; nothing else is ever spared, so an
  // agent's process that outlived a restart of the runner isn't.
  constructor(o: { self?: number; baseline?: Baseline[]; list?: () => Proc[]; kill?: (pid: number, signal: NodeJS.Signals) => void; sleep?: (ms: number) => Promise<void> } = {}) {
    this.self = o.self ?? process.pid;
    this.baseline = new Set((o.baseline ?? []).map(key));
    this.list = o.list ?? (() => listProcs());
    this.kill = o.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // What's running now, for the baseline: taken once, at the first start
  // after a fresh exchange, before anything of the thread runs (main.ts).
  capture(): Baseline[] {
    return this.list()
      .filter((p) => p.alive)
      .map((p) => ({ pid: p.pid, start: p.start, cmd: p.cmd ?? '' }));
  }

  // The processes a stopping save kills: every one alive but the runner,
  // its ancestors, PID 1, and the provider's baseline.
  private others(procs: Proc[]): Proc[] {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const spared = new Set<number>([1, this.self]);
    // Its ancestors, up to PID 1.
    for (let p = byPid.get(this.self); p && !spared.has(p.ppid); p = byPid.get(p.ppid)) spared.add(p.ppid);
    return procs.filter((p) => p.alive && !spared.has(p.pid) && !this.baseline.has(key(p)));
  }

  /**
   * Kills every other process the box has started (the whole thread group,
   * by its id), and looks again until none is alive (a process forking as
   * it dies, a new one started): throws if some won't go. Returns how many
   * kills it sent.
   */
  async stopOthers(tries = 20): Promise<number> {
    let killed = 0;
    for (let i = 0; i < tries; i++) {
      const left = this.others(this.list());
      if (!left.length) return killed;
      for (const p of left) {
        try {
          this.kill(p.pid, 'SIGKILL');
          killed++;
        } catch {
          // gone already
        }
      }
      await this.sleep(50);
    }
    const still = this.others(this.list());
    if (!still.length) return killed;
    throw new Error(`${still.length} of the box's processes wouldn't stop (${still.slice(0, 5).map((p) => p.pid).join(', ')}), so nothing was saved.`);
  }
}
