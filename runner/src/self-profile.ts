// The runner looking at its own CPU (tb profile, runner.profile). On 19 Nov
// the live runner's main thread was busy enough that app requests waited up
// to 12 s, and `sample` could only say it was in fs calls: JS frames have no
// names there. This runs V8's profiler in-process through node:inspector's
// Session, so it needs no restart, signal or open debug port, and writes a
// .cpuprofile (Chrome DevTools or speedscope open it) beside a summary of
// where the time went.
//
// The stall watch beside it logs each time the event loop was held up for a
// second or more, so a slow spell shows in tb logs with when and how long
// (as info, not warn: warnings go to Sentry, and this is for reading here).
import fs from 'node:fs';
import path from 'node:path';
import { Session } from 'node:inspector/promises';
import type { Logger } from './log.ts';
import { ErrorCode, RpcError } from './protocol.ts';

export const MAX_PROFILE_SECONDS = 120;

type CallFrame = { functionName: string; url: string; lineNumber: number; columnNumber: number };
type ProfileNode = { id: number; callFrame: CallFrame; hitCount?: number; children?: number[] };
export type CpuProfile = { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] };

export type ProfileLine = { name: string; where: string; ms: number; pct: number };
export type ProfileSummary = {
  ms: number;
  // Time the thread was running JS or native code (not idle, not GC).
  busyMs: number;
  gcMs: number;
  // Leaf frames: where the time was spent.
  self: ProfileLine[];
  // The nearest frame of the runner's own code under each sample, so a
  // readdirSync deep in node:fs is charged to the function that called it.
  own: ProfileLine[];
  // Every function on the stack, counted once per sample.
  total: ProfileLine[];
};

const SPECIAL = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);

function short(url: string): string {
  if (!url) return '';
  const i = url.lastIndexOf('/src/');
  if (i >= 0) return url.slice(i + 1);
  const n = url.lastIndexOf('/node_modules/');
  if (n >= 0) return url.slice(n + 1);
  return url.replace(/^file:\/\//, '');
}

function label(f: CallFrame): { name: string; where: string } {
  const where = f.url ? `${short(f.url)}:${f.lineNumber + 1}` : '';
  return { name: f.functionName || '(anonymous)', where };
}

// The runner's own code: not node's, not a package's, not V8's.
function isOwn(f: CallFrame): boolean {
  return !!f.url && !f.url.startsWith('node:') && !f.url.includes('/node_modules/') && f.url.includes('/src/');
}

export function summarize(p: CpuProfile, top = 25): ProfileSummary {
  const byId = new Map<number, ProfileNode>();
  const parent = new Map<number, number>();
  for (const n of p.nodes) {
    byId.set(n.id, n);
    for (const c of n.children ?? []) parent.set(c, n.id);
  }
  const samples = p.samples ?? [];
  const deltas = p.timeDeltas ?? [];
  const totalUs = Math.max(0, p.endTime - p.startTime);
  const self = new Map<string, number>();
  const own = new Map<string, number>();
  const total = new Map<string, number>();
  const names = new Map<string, { name: string; where: string }>();
  let busy = 0;
  let gc = 0;
  const key = (f: CallFrame): string => {
    const l = label(f);
    const k = `${l.name} ${l.where}`;
    if (!names.has(k)) names.set(k, l);
    return k;
  };
  const add = (m: Map<string, number>, k: string, us: number) => m.set(k, (m.get(k) ?? 0) + us);
  for (let i = 0; i < samples.length; i++) {
    // A sample's time is the gap to the next one, as DevTools counts it.
    const us = Math.max(0, deltas[i + 1] ?? 0);
    const leaf = byId.get(samples[i]);
    if (!leaf) continue;
    const fn = leaf.callFrame.functionName;
    if (fn === '(idle)' || fn === '(program)' || fn === '(root)') continue;
    if (fn === '(garbage collector)') {
      gc += us;
      continue;
    }
    busy += us;
    add(self, key(leaf.callFrame), us);
    const seen = new Set<string>();
    let ownCharged = false;
    for (let id: number | undefined = leaf.id; id !== undefined; id = parent.get(id)) {
      const n = byId.get(id);
      if (!n || SPECIAL.has(n.callFrame.functionName)) continue;
      const k = key(n.callFrame);
      if (!seen.has(k)) {
        seen.add(k);
        add(total, k, us);
      }
      if (!ownCharged && isOwn(n.callFrame)) {
        ownCharged = true;
        add(own, k, us);
      }
    }
    if (!ownCharged) add(own, key(leaf.callFrame), us);
  }
  const lines = (m: Map<string, number>): ProfileLine[] =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([k, us]) => ({ ...names.get(k)!, ms: Math.round(us / 1000), pct: totalUs ? Math.round((us / totalUs) * 1000) / 10 : 0 }));
  return { ms: Math.round(totalUs / 1000), busyMs: Math.round(busy / 1000), gcMs: Math.round(gc / 1000), self: lines(self), own: lines(own), total: lines(total) };
}

export type ProfileResult = { file: string; summary: ProfileSummary };

export class SelfProfiler {
  private running = false;
  private o: { dir: string; log: Logger; now?: () => Date };
  constructor(o: { dir: string; log: Logger; now?: () => Date }) {
    this.o = o;
  }

  async profile(seconds: number): Promise<ProfileResult> {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_PROFILE_SECONDS) {
      throw new RpcError(ErrorCode.badParams, `seconds must be more than 0 and at most ${MAX_PROFILE_SECONDS}`);
    }
    if (this.running) throw new RpcError(ErrorCode.badParams, 'A profile is already running; wait for it to finish.');
    this.running = true;
    const session = new Session();
    try {
      session.connect();
      await session.post('Profiler.enable');
      // 1 ms between samples: fine enough for a 100 ms stall, light enough
      // to leave on for two minutes.
      await session.post('Profiler.setSamplingInterval', { interval: 1000 });
      await session.post('Profiler.start');
      await new Promise((r) => setTimeout(r, seconds * 1000));
      const { profile } = (await session.post('Profiler.stop')) as { profile: CpuProfile };
      await session.post('Profiler.disable');
      fs.mkdirSync(this.o.dir, { recursive: true });
      const stamp = (this.o.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
      const file = path.join(this.o.dir, `runner-${stamp}.cpuprofile`);
      await fs.promises.writeFile(file, JSON.stringify(profile));
      prune(this.o.dir, 10);
      const summary = summarize(profile);
      this.o.log.info('cpu profile written', { file, seconds, busyMs: summary.busyMs });
      return { file, summary };
    } finally {
      session.disconnect();
      this.running = false;
    }
  }
}

// Keep the newest few: each is a few MB.
function prune(dir: string, keep: number): void {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    // Best effort.
  }
}

export function profileMethods(p: SelfProfiler): Record<string, (params: Record<string, unknown>) => unknown> {
  return {
    'runner.profile': (params) => p.profile(params.seconds === undefined ? 10 : Number(params.seconds)),
  };
}

// Logs each time the event loop was held up past `thresholdMs`: a timer due
// every `everyMs` that fires late by that much. Returns a stop function.
export function watchStalls(o: { log: Logger; thresholdMs?: number; everyMs?: number; now?: () => number }): () => void {
  const every = o.everyMs ?? 250;
  const threshold = o.thresholdMs ?? 1000;
  const now = o.now ?? (() => performance.now());
  let due = now() + every;
  const timer = setInterval(() => {
    const t = now();
    const late = t - due;
    if (late >= threshold) o.log.info('event loop stalled', { ms: Math.round(late) });
    due = t + every;
  }, every);
  timer.unref();
  return () => clearInterval(timer);
}
