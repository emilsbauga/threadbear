// The slow parts of patch trust, run in a worker thread so they don't hold
// up the runner's main thread (trust-worker.ts is the worker's side).
//
// On 19 Nov the live runner's main thread was 70 to 83% busy and app
// requests waited up to 12 s (tb profile). Each thread's patch list is read
// every 15 s, and every turn's end makes it read again, and most of the time
// went on two synchronous looks: what a folder's Claude Code settings,
// agents and skills run (claude-trust.ts claudeCommands, a git listing or a
// walk of up to 20,000 folders: 1.5 s for ~/dev/me/misc, which isn't a git
// checkout and had 23 threads), and what a home patch run from each thread's
// folder reaches (unhashed-scan.ts). The same code runs here, so the answers
// are the same; only the thread it runs on changes.
//
// Two lanes, each a worker of its own: `urgent` for the look a message
// waits on before its CLI starts, `background` for the patch list. The
// background lane shares a look already under way for the same folder;
// the urgent one never does, as a pull just before the message may have
// brought hooks the earlier look missed.
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { claudeCommandsKinds, type ClaudeCommands } from './claude-trust.ts';
import { codeOfUnhashedPatch, type UnsureWhy } from './unhashed-scan.ts';
import { noFifoReads } from './no-fifo-reads.ts';
import { spawnGateInstalled } from './spawn-gate.ts';

export type TrustRequest = { id: number } & (
  // One look per kind of thread (grants or not), one after the other.
  | { kind: 'claudeCommands'; cwd: string; home: string; grants: boolean[] }
  | { kind: 'editsAsk'; file: string; from: string; now: number; maxAgeMs?: number }
);
// `ready`: sent once, when the worker's code has loaded.
export type TrustReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string } | { ready: true };
type Ask = TrustRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export type EditsAsk = { all: boolean; why?: UnsureWhy };
export type Lane = 'urgent' | 'background';

// A look that takes longer than this once it has started (a hung disk, a
// FIFO) is given up on and its worker replaced.
export const TRUST_CALL_TIMEOUT_MS = 120_000;

// A worker that hasn't loaded in this long counts as one that can't. Apart
// from a call's limit: on a busy Mac loading alone can take a second or two.
const LOAD_TIMEOUT_MS = 30_000;

// The same call on this thread: when no worker can be started here at all.
// Its reads still never wait on a FIFO (no-fifo-reads.ts).
function inline(ask: Ask): unknown {
  return noFifoReads(() => {
    if (ask.kind === 'claudeCommands') return claudeCommandsKinds(ask.cwd, ask.home, ask.grants);
    const scan = codeOfUnhashedPatch(ask.file, ask.from, ask.now, ask.maxAgeMs);
    return { all: scan.all, ...(scan.why ? { why: scan.why } : {}) };
  });
}

type Call = { ask: Ask; resolve: (v: unknown) => void; reject: (e: Error) => void };

// What a call looks at: the folder, or the patch file and the folder its
// commands are followed from (a hung folder isn't the patch's fault).
function whatOf(ask: Ask): string {
  return ask.kind === 'claudeCommands' ? ask.cwd : `${ask.file} (from ${ask.from})`;
}

// At most this many workers stuck in reads the OS won't let go of, both
// lanes together: each is a thread, for as long as the read lasts. With
// FIFOs refused (no-fifo-reads.ts) that's a hung disk or network mount,
// which held the whole runner before; such a worker also holds the
// runner's exit, as node joins its threads, and nothing here can help that.
const MAX_STUCK = 4;

// One worker, given one call at a time from a queue here, so a call's time
// limit runs from when it starts and a call that hangs or crashes the
// worker fails alone: the calls behind it go to a new worker.
class OneWorker {
  private worker?: Worker;
  // Whether this worker's code has loaded (it says so): one that never
  // does means workers can't run here, and the calls run on this thread as
  // they did before.
  private ready = false;
  private queue: Call[] = [];
  private current?: { call: Call; id: number; timer: NodeJS.Timeout };
  private nextId = 1;
  private closed = false;
  // Workers given up on mid-look, by what they were looking at, until they
  // exit. One stuck in a read the OS won't let go of (a FIFO, a hung mount)
  // never does, so further looks there fail at once rather than leave
  // another stuck worker each time (Codex's review).
  // Shared by both lanes: a folder stuck in one is stuck in the other.
  private stuck: Map<string, Set<Worker>>;
  private timeoutMs: number;
  private script: URL;
  constructor(timeoutMs: number, script: URL, stuck: Map<string, Set<Worker>>) {
    this.timeoutMs = timeoutMs;
    this.script = script;
    this.stuck = stuck;
  }

  call(ask: Ask): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The trust worker is closed.'));
    const stuck = this.stuckOn(ask);
    if (stuck) return Promise.reject(stuck);
    return new Promise((resolve, reject) => {
      this.queue.push({ ask, resolve, reject });
      this.next();
    });
  }

  close(): void {
    this.closed = true;
    const calls = [...(this.current ? [this.current.call] : []), ...this.queue];
    this.queue = [];
    this.drop();
    for (const c of calls) c.reject(new Error('The trust worker is closed.'));
  }

  private next(): void {
    if (this.current || this.closed) return;
    // Calls queued before a look at the same place got stuck fail now, in
    // a loop rather than one call deep each (a long queue).
    while (this.queue.length) {
      const stuck = this.stuckOn(this.queue[0].ask);
      if (!stuck) break;
      this.queue.shift()!.reject(stuck);
    }
    if (!this.queue.length) {
      // Idle: never what keeps the process going.
      this.worker?.unref();
      return;
    }
    let worker: Worker;
    try {
      worker = this.start();
    } catch (e) {
      // No worker to be had at all (no threads left): as one that can't load.
      this.crashed(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    // Held open while it has work: an unreferenced worker's reply never
    // comes if nothing else keeps the process going.
    worker.ref();
    // Nothing goes to it until its code has loaded and it says so, so a
    // worker that stops before then never had a call that could be why.
    if (!this.ready) return;
    const call = this.queue.shift()!;
    const id = this.nextId++;
    const what = whatOf(call.ask);
    const timer = setTimeout(() => {
      // Each worker apart: both lanes can be stuck on one folder.
      const all = this.stuck.get(what) ?? new Set<Worker>();
      all.add(worker);
      this.stuck.set(what, all);
      worker.once('exit', () => {
        all.delete(worker);
        if (!all.size && this.stuck.get(what) === all) this.stuck.delete(what);
      });
      this.failCurrent(new Error(`Looking at ${what} took over ${Math.round(this.timeoutMs / 1000)} s.`));
    }, this.timeoutMs);
    timer.unref();
    this.current = { call, id, timer };
    worker.postMessage({ ...call.ask, id } satisfies TrustRequest);
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    // The runner's environment as it is at each call (HOME, a test's change),
    // and none of its node flags: the runner has none, and a preload (the
    // tests' sets the umask, which a worker may not) would stop it loading.
    const worker = new Worker(this.script, { env: SHARE_ENV, execArgv: [] });
    worker.unref();
    // A worker that hasn't loaded in this long counts as one that can't.
    const loading = setTimeout(() => {
      if (this.worker === worker && !this.ready) this.crashed(new Error("the trust worker didn't load"));
    }, LOAD_TIMEOUT_MS);
    loading.unref();
    worker.on('message', (r: TrustReply) => {
      if ('ready' in r) {
        clearTimeout(loading);
        if (this.worker !== worker) return;
        this.ready = true;
        this.next();
        return;
      }
      const cur = this.current;
      if (this.worker !== worker || !cur || cur.id !== r.id) return;
      clearTimeout(cur.timer);
      this.current = undefined;
      worker.unref();
      if (r.ok) cur.call.resolve(r.value);
      else cur.call.reject(new Error(r.error));
      this.next();
    });
    worker.on('error', (e: unknown) => {
      if (this.worker === worker) this.crashed(e instanceof Error ? e : new Error(String(e)));
    });
    worker.on('exit', () => {
      if (this.worker === worker) this.crashed(new Error('the trust worker exited'));
    });
    this.worker = worker;
    return worker;
  }

  // A worker that never loaded (and so never had a call): everything
  // waiting runs on this thread, as it did before there were workers. One
  // that loaded and then died (a crash, out of memory) fails only the call
  // it was on, which would likely do the same on this thread; the rest go
  // to a new worker.
  private crashed(e: Error): void {
    if (!this.ready) {
      const calls = [...this.queue];
      this.queue = [];
      this.drop();
      for (const c of calls) {
        // Never while anything is stuck: the same folder by another name, or
        // one like it, would hang the runner on this thread.
        const stuck = this.stuckOn(c.ask) ?? (this.stuck.size ? new Error(`An earlier look is still stuck (${[...this.stuck.keys()].join(', ')}), and no worker can be started to look here.`) : undefined);
        if (stuck) {
          c.reject(stuck);
          continue;
        }
        try {
          c.resolve(inline(c.ask));
        } catch (err) {
          c.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      return;
    }
    this.failCurrent(new Error(`The trust worker stopped: ${e.message}`));
  }

  // Also once a few are stuck at all: the same folder by other names (a
  // link to it) would otherwise leave a stuck worker for each name.
  private stuckOn(ask: Ask): Error | undefined {
    const what = whatOf(ask);
    if (this.stuck.has(what)) return new Error(`An earlier look at ${what} is still stuck, so it can't be looked at yet.`);
    const workers = [...this.stuck.values()].reduce((n, all) => n + all.size, 0);
    if (workers >= MAX_STUCK) return new Error(`${workers} earlier looks are still stuck (${[...this.stuck.keys()].join(', ')}), so no more are started until one lets go.`);
    return undefined;
  }

  // The call under way fails; its worker goes, and the next call gets a new one.
  private failCurrent(e: Error): void {
    const cur = this.current;
    this.current = undefined;
    if (cur) clearTimeout(cur.timer);
    this.drop();
    cur?.call.reject(e);
    this.next();
  }

  private drop(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.ready = false;
    if (!worker) return;
    void worker.terminate().catch(() => undefined);
    // After terminate, which holds the process open until the worker has
    // gone: one stuck in a read the OS won't let go of never goes, and
    // mustn't keep the runner from exiting.
    worker.unref();
  }
}

export class TrustOffThread {
  private lanes: Record<Lane, OneWorker>;
  private shared = new Map<string, Promise<unknown>>();
  // script: the worker's code (tests give one that never answers).
  constructor(o: { timeoutMs?: number; script?: URL } = {}) {
    // Box mode's gate (spawn-gate.ts) holds the main thread's processes
    // only, and a look runs git: main.ts makes none there, and this makes
    // sure.
    if (spawnGateInstalled()) throw new Error("No trust worker in box mode: a worker's processes would get round its spawn gate.");
    const ms = o.timeoutMs ?? TRUST_CALL_TIMEOUT_MS;
    const script = o.script ?? new URL('./trust-worker.ts', import.meta.url);
    const stuck = new Map<string, Set<Worker>>();
    this.lanes = { urgent: new OneWorker(ms, script, stuck), background: new OneWorker(ms, script, stuck) };
  }

  // What the folder's Claude Code settings run for each kind of thread
  // (grants or not), looked at one after the other.
  claudeCommands(cwd: string, home: string, grants: boolean[], lane: Lane): Promise<(ClaudeCommands | undefined)[]> {
    return this.ask({ kind: 'claudeCommands', cwd, home, grants }, lane) as Promise<(ClaudeCommands | undefined)[]>;
  }

  editsAsk(file: string, from: string, now: number, maxAgeMs?: number): Promise<EditsAsk> {
    return this.ask({ kind: 'editsAsk', file, from, now, ...(maxAgeMs !== undefined ? { maxAgeMs } : {}) }, 'background') as Promise<EditsAsk>;
  }

  // Calls from now on don't share a look begun before (forgetFolders: what
  // it read may be from before the change).
  forget(): void {
    this.shared.clear();
  }

  close(): void {
    this.lanes.urgent.close();
    this.lanes.background.close();
  }

  private ask(ask: Ask, lane: Lane): Promise<unknown> {
    if (lane === 'urgent') return this.run(ask, lane);
    // `now` only bounds how old a cached scan may be: not part of the key.
    // How old it may be is: a caller asking for a fresh one never shares a
    // look that may answer with an older one (Codex's and Gemini's reviews).
    const key = JSON.stringify(ask.kind === 'editsAsk' ? [ask.kind, ask.file, ask.from, ask.maxAgeMs ?? null] : ask);
    const going = this.shared.get(key);
    if (going) return going;
    const p = this.run(ask, lane).finally(() => {
      if (this.shared.get(key) === p) this.shared.delete(key);
    });
    this.shared.set(key, p);
    return p;
  }

  private run(ask: Ask, lane: Lane): Promise<unknown> {
    return this.lanes[lane].call(ask);
  }

}

