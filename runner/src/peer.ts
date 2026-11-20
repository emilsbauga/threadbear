// Which thread a process on this Mac belongs to, for the RPC server (docs/
// protocol.md, "Who's really calling"). Credentials alone can't say: anything
// a thread's shell runs can read the token file or wipe its own key from the
// environment. The kernel can say what it's a child of, so the server looks at
// the far end of the connection and walks up its parents to a thread's CLI.
import { execFile } from 'node:child_process';
import { lsofPath } from './handover.ts';
import { psTable, type ProcessRegistry } from './proc.ts';
import type { Logger } from './log.ts';
import { parseSnapshot, win32Helper, winAddress, type WinConnection, type WinProcess } from './win32-helper.ts';

export type PeerDeps = {
  // threadOfPid gets the process's start time where the lookup has one
  // (Windows), so a CLI's pid taken by a newer process doesn't count.
  registry: { threadOfPid(pid: number, created?: bigint): string | undefined | Promise<string | undefined> } & Partial<Pick<ProcessRegistry, 'threadOfGroup'>>;
  // A thread this runner or a draining one really has (a registry entry can
  // be a job's label, like models:<account>).
  known: (threadId: string) => boolean;
  log: Logger;
  // Tests pass stand-ins: the processes holding this exact client socket.
  lsof?: (sock: PeerSocket) => Promise<number[]>;
  table?: () => Promise<ProcRow[]>;
  // Windows: the helper's snapshot of a port (tests pass a stand-in).
  snapshot?: (port: number) => Promise<Snapshot>;
  platform?: NodeJS.Platform;
  // How long lsof and ps each get. Live connections keep LOOKUP_MS; the test
  // of a real lookup gives them longer, as on a loaded Mac lsof alone took
  // over 3 s (a fork, 15 Nov).
  lookupMs?: number;
};

const LOOKUP_MS = 3000;

// A process as the lookup sees it. created (Windows only, a FILETIME) is
// when it started: Windows keeps a process's parent id after the parent
// has gone, and gives that id to the next process, so a parent that
// started after its child isn't its parent.
export type ProcRow = { pid: number; ppid: number; pgid?: number; created?: bigint };

// The accepted connection, as the runner's side sees it: the client's
// address and port, and the address and port it reached. All four, because
// a port number alone isn't one socket: a client bound to 127.0.0.2 (Linux
// lets any 127/8 address be used) can share another's port, and lsof's
// `-iTCP:<port>` also lists any socket whose far end uses that number, like
// a Full thread's dev server talking to port 5432 (Daybreak finding 137).
export type PeerSocket = { remoteAddress: string; remotePort: number; localAddress: string; localPort: number };

// Thrown when the processes holding one socket sit under different threads
// (a socket handed to a child in another thread can't be told apart): the
// server refuses the connection rather than pick one.
export class AmbiguousPeer extends Error {}

// What lsof calls an address in a name: IPv6 in brackets, an IPv4-mapped
// one as plain IPv4 (Node's dual-stack form).
function lsofAddr(addr: string, port: number): string {
  const a = addr.startsWith('::ffff:') && addr.includes('.') ? addr.slice(7) : addr;
  return a.includes(':') ? `[${a}]:${port}` : `${a}:${port}`;
}

// A slow ps mustn't hold a connection's frames back for long (rpc.ts queues them).
function deadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('process lookup timed out')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// The processes holding the client's end of exactly this connection: a file
// whose name is client->server. `-iTCP@addr:port` only narrows what lsof
// reads; the name decides. The runner's own end (server->client) never
// matches, nor does any other socket that merely shares a port number.
function lsofPids(sock: PeerSocket, ms: number): Promise<number[]> {
  const client = lsofAddr(sock.remoteAddress, sock.remotePort);
  const want = `${client}->${lsofAddr(sock.localAddress, sock.localPort)}`;
  return new Promise((resolve, reject) => {
    execFile(lsofPath(), ['-nP', `-iTCP@${client}`, '-sTCP:ESTABLISHED', '-Fpn'], { timeout: ms }, (err, stdout) => {
      // lsof exits 1 when nothing matched; what it printed still counts.
      if (err && (err as { code?: unknown }).code !== 1 && !stdout) return reject(err);
      resolve(socketOwners(stdout, want));
    });
  });
}

// From lsof's -F output (p<pid>, then f<fd> and n<name> per file), the pids
// with a file named exactly `want`.
export function socketOwners(out: string, want: string): number[] {
  const pids = new Set<number>();
  let pid: number | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && line.slice(1) === want && pid !== undefined && Number.isInteger(pid)) pids.add(pid);
  }
  return [...pids];
}

// The same on Windows, from the runner's helper (win32-helper.ts). Its one
// PowerShell answers a question at a time, so connections don't each ask:
// a lookup joins the next snapshot of the port (its connections and every
// process) taken after it asked, and every lookup waiting then shares it.
// Asked one each, a thread could open enough connections of its own to
// queue a stolen-credential one past its deadline (Codex's review, 18 Nov
// 2026). It's at most two snapshots' wait, whatever the number waiting.
export type Snapshot = { connections: WinConnection[]; processes: WinProcess[] };

export function coalesce<T>(take: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  let queued: Promise<T> | undefined;
  const next = (): Promise<T> => {
    if (!running) {
      running = take().finally(() => {
        running = undefined;
      });
      return running;
    }
    // One is already going, maybe from before this connection: wait for a
    // new one.
    queued ??= running.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      queued = undefined;
      return next();
    });
    return queued;
  };
  return next;
}

const snapshots = new Map<number, () => Promise<Snapshot>>();

function windowsSnapshot(port: number): Promise<Snapshot> {
  let take = snapshots.get(port);
  if (!take) {
    take = coalesce(async () => parseSnapshot(await win32Helper().ask('snapshot', { port })));
    snapshots.set(port, take);
  }
  return take();
}

// The pids holding exactly the client's end of this connection, from a
// snapshot: its own address and port are the client's, its far end the
// runner's.
export function snapshotOwners(snap: Snapshot, sock: PeerSocket): number[] {
  const pids = new Set<number>();
  for (const c of snap.connections) {
    if (winAddress(c.localAddress) !== winAddress(sock.remoteAddress) || c.localPort !== sock.remotePort) continue;
    if (winAddress(c.remoteAddress) !== winAddress(sock.localAddress) || c.remotePort !== sock.localPort) continue;
    pids.add(c.pid);
  }
  return [...pids];
}

// The thread the process at the client's end of this connection belongs to,
// or undefined when it isn't under a thread's CLI or the lookup can't tell
// (no lsof, on a machine without it, or the Windows helper failing): then
// the credential presented decides.
// Every process holding the socket is looked at (a forked child keeps its
// parent's); if they name different threads it throws AmbiguousPeer.
export async function threadOfSocket(sock: PeerSocket, deps: PeerDeps): Promise<string | undefined> {
  let pids: number[];
  let table: ProcRow[];
  const windows = (deps.platform ?? process.platform) === 'win32';
  const ms = deps.lookupMs ?? LOOKUP_MS;
  try {
    if (windows && !deps.lsof) {
      const snap = await deadline((deps.snapshot ?? windowsSnapshot)(sock.localPort), ms);
      pids = snapshotOwners(snap, sock).filter((p) => p !== process.pid);
      table = snap.processes;
      // The connection is open (the runner accepted it before asking), so
      // a snapshot without it hasn't seen what it should (Codex's second
      // review): not "nobody's".
      if (pids.length === 0) throw new Error("the snapshot doesn't have this connection");
    } else {
      pids = (await deadline((deps.lsof ?? ((s: PeerSocket) => lsofPids(s, ms)))(sock), ms)).filter((p) => p !== process.pid);
      if (pids.length === 0) return undefined;
      table = await deadline((deps.table ?? psTable)(), ms);
    }
  } catch (e) {
    // On Windows the helper is the runner's own and always there, so a
    // lookup that fails is something stopping, suspending or swamping it:
    // the connection closes (rpc.ts) rather than going by its credential
    // alone, which a stolen one would pass (Codex's review, 18 Nov 2026).
    // The app and tb connect again. On a Mac or Linux without lsof the
    // credential still decides, as before.
    if (windows) throw new Error(`could not tell which process connected: ${String(e)}`);
    deps.log.warn('could not tell which process connected to the RPC', { error: String(e) });
    return undefined;
  }
  if (pids.length === 0) return undefined;
  const threads = new Set<string>();
  for (const peer of pids) {
    const t = await threadOfPid(peer, table, deps);
    if (t) threads.add(t);
  }
  if (threads.size > 1) throw new AmbiguousPeer(`one connection is held by processes under ${threads.size} threads`);
  return [...threads][0];
}

async function threadOfPid(peer: number, table: ProcRow[], deps: PeerDeps): Promise<string | undefined> {
  const rows = new Map(table.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  for (let p: number | undefined = peer; p !== undefined && p > 1 && !seen.has(p); p = parentOf(rows, p)) {
    seen.add(p);
    const t = await deps.registry.threadOfPid(p, rows.get(p)?.created);
    if (t && deps.known(t)) return t;
  }
  // Left its parents behind (a nohup or a backgrounded subshell), but still
  // in a process group a thread's tool command ran in.
  const group = table.find((r) => r.pid === peer)?.pgid;
  const byGroup = group ? deps.registry.threadOfGroup?.(group) : undefined;
  if (byGroup && deps.known(byGroup)) return byGroup;
  return undefined;
}

// The parent a process really has: none when the recorded parent started
// after it did (Windows: the parent died and its id went to a newer
// process, which mustn't count as its parent).
function parentOf(rows: Map<number, ProcRow>, pid: number): number | undefined {
  const row = rows.get(pid);
  if (!row) return undefined;
  const parent = rows.get(row.ppid);
  if (row.created && parent?.created && parent.created > row.created) return undefined;
  return row.ppid;
}
