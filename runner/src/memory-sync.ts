// Shared memory (docs/protocol.md, "Shared memory"; the sharedMemory
// experiment). What makes a thread on the M5 know Mike is mostly what Claude
// Code loads before the first message: the global CLAUDE.md and the memory
// folder of the project it's in (MEMORY.md and its files, which agents write
// as they learn things). Those lived on the M5 alone, so a thread on Bruce or
// Tinker Desk started knowing nothing about him (17 Nov 2026).
//
// The main Mac (the owner key) puts its files up (sync:putMemory). Every other
// runner keeps a copy of them (memory-cache/ in its data dir, from
// sync:memorySince) and, each pass, makes every one of its Claude logins (and
// Codex's AGENTS.md, for the global file) match it. A file someone changed
// there isn't written over unseen: it's offered back first
// (sync:offerMemory), and one that was there before sync ever wrote to that
// place is left alone. Offers land on the main Mac in memory-offers/ in the
// data dir, as data for the nightly retro to fold in or drop, never straight
// into memory: a runner key mustn't be able to brief the main Mac's agents
// (convex/memorySync.ts).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, isDirectory, readJsonSync } from './fsutil.ts';
import type { Logger } from './log.ts';

// The same rule as convex/memorySync.ts MEMORY_PATH (memory-sync.test.ts
// holds them to each other). Releases carry runner/ alone, so it's a copy.
export const MEMORY_PATH = /^(?:global\/CLAUDE\.md|memory\/~(?:-[A-Za-z0-9-]*)?\/[A-Za-z0-9][A-Za-z0-9._-]*\.md)$/;
export const MAX_MEMORY_PATH = 240;
export const MAX_MEMORY_FILE = 128 * 1024;
// One call's files, by count and by bytes of text (the backend refuses more,
// convex/memorySync.ts MAX_MEMORY_BATCH and MAX_BATCH_BYTES).
export const MEMORY_BATCH = 50;
export const MEMORY_BATCH_BYTES = 1024 * 1024;
export const GLOBAL_PATH = 'global/CLAUDE.md';
export const MEMORY_TICK_MS = 60_000;
export const MEMORY_API_VERSION = 84;
// The most the main Mac keeps in memory-offers/ before it stops taking more.
// Another runner's key can send offers as fast as it likes, so they can't be
// allowed to fill the main Mac's disk; past this they wait in the backend,
// which holds a few per runner (MAX_OFFERS_PER_RUNNER), until the folder has
// been gone through.
export const MAX_OFFERS_ON_DISK = 20 * 1024 * 1024;

export type MemoryPut = { path: string; hash: string; text?: string; gone?: boolean };
export type MemoryRow = { path: string; hash: string; text: string; gone?: true; seq: number };
export type MemoryOffer = { id: string; runnerId: string; path: string; hash: string; text: string; at: number };

export type MemoryBackend = {
  // This runner holds the owner key: the main Mac, whose files are the ones shared.
  readonly owner: boolean;
  put(files: MemoryPut[]): Promise<number>;
  since(after: number): Promise<{ rows: MemoryRow[]; more: boolean; seq: number }>;
  offer(files: { path: string; hash: string; text: string }[]): Promise<void>;
  offers(): Promise<MemoryOffer[]>;
  take(taken: { id: string; hash: string }[]): Promise<void>;
};

export type MemorySyncDeps = {
  home: string;
  // The runner's data dir: memory-sync.json and memory-cache/, and
  // memory-offers/ on the main Mac.
  dataDir: string;
  on: () => boolean;
  // Each Claude login's config dir (~/.claude for claude-main), and each
  // Codex one's (CODEX_HOME), as the runner knows them now.
  claudeDirs: () => string[];
  codexDirs: () => string[];
  // Takes out secret values the runner knows of before anything goes up.
  scrub: (text: string) => string;
  log: Pick<Logger, 'info' | 'warn' | 'debug'>;
  setTimer?: (run: () => void, ms: number) => { unref?: () => void };
};

// What this runner last synced, so it can tell its own writes from edits.
type Manifest = {
  // Receivers: the newest seq taken into memory-cache/.
  after: number;
  // Main Mac: each path's hash as last put up. Others: as the main Mac has it
  // now, which is what memory-cache/ holds.
  files: Record<string, string>;
  // Others, by file on disk: the path it holds and the hash sync last wrote
  // there. A file whose hash still matches is sync's to replace or delete.
  wrote: Record<string, { path: string; hash: string }>;
  // Others, by file: the main Mac's version was already there when sync
  // first looked, so it's kept up to date but never deleted.
  adopted: Record<string, true>;
  // Others, by file: something else was there before sync, so it's left
  // alone for good (another login's own CLAUDE.md, say).
  kept: Record<string, true>;
  // Others, by file: the hash of the text last offered from it.
  offered: Record<string, string>;
};

export function memoryPathOk(p: string): boolean {
  return typeof p === 'string' && p.length <= MAX_MEMORY_PATH && MEMORY_PATH.test(p) && !p.includes('..');
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Claude Code names a project's folder after its path with every character
// that isn't a letter or digit made a dash ("/Users/bruce/dev/me" is
// "-Users-bruce-dev-me"). A folder under home becomes "~" and the rest, so it
// lands under the other Mac's home; anything else isn't shared.
export function homeSlug(home: string): string {
  return home.replace(/[^A-Za-z0-9]/g, '-');
}

export function folderOf(slug: string, home: string): string | undefined {
  const h = homeSlug(home);
  if (slug === h) return '~';
  // ~/Library is apps' own scratch folders (Claude's desktop app makes one a
  // chat), not projects anyone opens on another Mac.
  if (slug.startsWith(`${h}-`) && !slug.startsWith(`${h}-Library-`)) return `~${slug.slice(h.length)}`;
  return undefined;
}

export function slugOf(folder: string, home: string): string {
  return homeSlug(home) + folder.slice(1);
}

// A file as it is on disk now: missing, there but not something sync reads
// (a folder, a FIFO, over the size limit), or its text.
type Seen = { state: 'missing' } | { state: 'odd' } | { state: 'text'; text: string; hash: string };

function look(file: string): Seen {
  let st: fs.Stats;
  try {
    // Followed: the M5's logins link their CLAUDE.md to one file.
    st = fs.statSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // A link to nowhere is still something there.
      try {
        fs.lstatSync(file);
        return { state: 'odd' };
      } catch {
        return { state: 'missing' };
      }
    }
    return { state: 'odd' };
  }
  if (!st.isFile() || st.size > MAX_MEMORY_FILE) return { state: 'odd' };
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { state: 'text', text, hash: sha256(text) };
  } catch {
    return { state: 'odd' };
  }
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // Not there yet: its nearest folder that is, and the rest.
    const parent = path.dirname(p);
    return parent === p ? p : path.join(real(parent), path.basename(p));
  }
}

function inside(file: string, roots: string[]): boolean {
  return roots.some((r) => file.startsWith(r + path.sep));
}

function uniq<T>(items: T[], keyOf: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = keyOf(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function claudeDirsOf(home: string, dirs: string[]): string[] {
  return uniq([path.join(home, '.claude'), ...dirs].filter(isDirectory), real);
}

// Every memory file under home in these logins, as path -> the files that
// hold it (one per distinct real folder).
function memoryFiles(home: string, claudeDirs: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const dir of claudeDirs) {
    const projects = path.join(dir, 'projects');
    let slugs: string[] = [];
    try {
      slugs = fs.readdirSync(projects);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const folder = folderOf(slug, home);
      if (!folder) continue;
      const mem = path.join(projects, slug, 'memory');
      if (!isDirectory(mem)) continue;
      const r = real(mem);
      if (seen.has(r)) continue;
      seen.add(r);
      let names: string[] = [];
      try {
        names = fs.readdirSync(mem);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.md') || name.startsWith('.')) continue;
        const p = `memory/${folder}/${name}`;
        if (!memoryPathOk(p)) continue;
        out.set(p, [...(out.get(p) ?? []), path.join(mem, name)]);
      }
    }
  }
  return out;
}

// The main Mac's files now: path -> text. ~/.claude's CLAUDE.md is the global
// one (else the first login's that has one). Where two logins hold the same
// memory path in different folders (logins not linked to one memory), the
// newer file wins.
export function scanLocal(home: string, claudeDirs: string[]): Map<string, string> {
  const dirs = claudeDirsOf(home, claudeDirs);
  const out = new Map<string, string>();
  for (const d of dirs) {
    const g = look(path.join(d, 'CLAUDE.md'));
    if (g.state === 'text') {
      out.set(GLOBAL_PATH, g.text);
      break;
    }
  }
  for (const [p, files] of memoryFiles(home, dirs)) {
    let best: { text: string; mtime: number } | undefined;
    for (const f of files) {
      const s = look(f);
      if (s.state !== 'text') continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(f).mtimeMs;
      } catch {}
      if (!best || mtime > best.mtime) best = { text: s.text, mtime };
    }
    if (best) out.set(p, best.text);
  }
  return out;
}

// Where a path goes on this runner: one file per distinct real place, across
// every login (and Codex's AGENTS.md for the global one, where Codex is).
export function targetsOf(p: string, home: string, claudeDirs: string[], codexDirs: string[]): string[] {
  if (!memoryPathOk(p)) return [];
  const claude = claudeDirsOf(home, claudeDirs);
  let files: string[];
  if (p === GLOBAL_PATH) {
    const codex = uniq([path.join(home, '.codex'), ...codexDirs].filter(isDirectory), real);
    files = [...claude.map((d) => path.join(d, 'CLAUDE.md')), ...codex.map((d) => path.join(d, 'AGENTS.md'))];
  } else {
    const [, folder, name] = p.split('/');
    const slug = slugOf(folder!, home);
    files = claude.map((d) => path.join(d, 'projects', slug, 'memory', name!));
  }
  return uniq(files, real);
}

// Calls of at most MEMORY_BATCH files and MEMORY_BATCH_BYTES of text.
function batches<T extends { text?: string }>(items: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const it of items) {
    const b = Buffer.byteLength(it.text ?? '');
    if (cur.length && (cur.length >= MEMORY_BATCH || bytes + b > MEMORY_BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

// What a folder takes on disk, near enough: every file and folder counts as
// at least a block, so a flood of empty offers fills the quota too.
const BLOCK = 4096;
function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += BLOCK + dirBytes(p);
    else {
      try {
        total += Math.max(BLOCK, fs.lstatSync(p).size);
      } catch {}
    }
  }
  return total;
}

export class MemorySync {
  private deps: MemorySyncDeps;
  private backend?: MemoryBackend;
  private manifest: Manifest;
  private manifestPath: string;
  private cacheDir: string;
  private running = false;
  private timer?: { unref?: () => void };
  private stopped = false;
  private fullSaid = false;

  constructor(deps: MemorySyncDeps) {
    this.deps = deps;
    this.manifestPath = path.join(deps.dataDir, 'memory-sync.json');
    this.cacheDir = path.join(deps.dataDir, 'memory-cache');
    const m = readJsonSync<Partial<Manifest>>(this.manifestPath);
    const obj = <T>(x: unknown): Record<string, T> => (x && typeof x === 'object' && !Array.isArray(x) ? { ...(x as Record<string, T>) } : {});
    this.manifest = {
      after: typeof m?.after === 'number' ? m.after : 0,
      files: obj(m?.files),
      wrote: obj(m?.wrote),
      adopted: obj(m?.adopted),
      kept: obj(m?.kept),
      offered: obj(m?.offered),
    };
  }

  // From sync's heartbeat once the backend has API 84, again and again: the
  // first call starts the minute timer.
  attach(backend: MemoryBackend): void {
    this.backend = backend;
    if (this.timer || this.stopped) return;
    this.schedule(1000);
  }

  // A runner that's stopping or handing over: no more passes, so two
  // runners never write the same files or manifest.
  stop(): void {
    this.stopped = true;
  }

  // Tests: a pass under way.
  get busy(): boolean {
    return this.running;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    const set = this.deps.setTimer ?? ((run: () => void, wait: number) => setTimeout(run, wait));
    this.timer = set(() => {
      this.timer = undefined;
      void this.tick().finally(() => this.schedule(MEMORY_TICK_MS));
    }, ms);
    this.timer.unref?.();
  }

  // Between awaits: a runner told to stop (a handover) writes nothing more,
  // so a pass still waiting on the backend can't undo the new runner's work.
  private live(): void {
    if (this.stopped) throw new Error('memory sync stopped');
  }

  // One pass. Exposed for tests.
  async tick(): Promise<void> {
    if (this.running || this.stopped || !this.backend || !this.deps.on()) return;
    this.running = true;
    try {
      if (this.backend.owner) {
        await this.putUp();
        await this.takeOffers();
      } else {
        await this.pullDown();
        await this.reconcile();
      }
    } catch (e) {
      if (!this.stopped) this.deps.log.warn('memory sync failed', { error: String((e as Error)?.message ?? e) });
    } finally {
      this.running = false;
    }
  }

  private save(): void {
    this.live();
    atomicWriteFileSync(this.manifestPath, JSON.stringify(this.manifest), 0o600);
  }

  // ---- the main Mac

  private async putUp(): Promise<void> {
    const local = scanLocal(this.deps.home, this.deps.claudeDirs());
    const changes: MemoryPut[] = [];
    for (const [p, raw] of local) {
      const text = this.deps.scrub(raw);
      const hash = sha256(text);
      if (this.manifest.files[p] !== hash) changes.push({ path: p, hash, text });
    }
    for (const p of Object.keys(this.manifest.files)) {
      if (!local.has(p)) changes.push({ path: p, hash: sha256(''), gone: true });
    }
    for (const batch of batches(changes)) {
      await this.backend!.put(batch);
      this.live();
      for (const f of batch) {
        if (f.gone) delete this.manifest.files[f.path];
        else this.manifest.files[f.path] = f.hash;
      }
      this.save();
    }
    if (changes.length) this.deps.log.info('memory put up', { files: changes.length });
  }

  // Offers from other runners go into memory-offers/<runner>/<path>/<hash>.md,
  // where the nightly retro reads them. Never into memory.
  private async takeOffers(): Promise<void> {
    const root = path.join(this.deps.dataDir, 'memory-offers');
    if (dirBytes(root) > MAX_OFFERS_ON_DISK) {
      if (!this.fullSaid) this.deps.log.warn('memory-offers is full; offers wait in the backend until it has been gone through', { root });
      this.fullSaid = true;
      return;
    }
    this.fullSaid = false;
    const offers = await this.backend!.offers();
    this.live();
    if (!offers.length) return;
    const taken: { id: string; hash: string }[] = [];
    for (const o of offers) {
      if (memoryPathOk(o.path) && /^[A-Za-z0-9_-]{1,64}$/.test(o.runnerId) && /^[0-9a-f]{64}$/.test(o.hash)) {
        const file = path.join(root, o.runnerId, ...o.path.split('/'), `${o.hash.slice(0, 12)}.md`);
        if (file.startsWith(root + path.sep)) atomicWriteFileSync(file, o.text, 0o600);
      }
      taken.push({ id: o.id, hash: o.hash });
    }
    await this.backend!.take(taken);
    this.deps.log.info('memory offers saved', { files: taken.length });
  }

  // ---- every other runner

  private cacheFile(p: string): string {
    return path.join(this.cacheDir, ...p.split('/'));
  }

  // The main Mac's changes, into memory-cache/. Nothing in the logins is
  // touched here; reconcile() does that.
  private async pullDown(): Promise<void> {
    for (let pages = 0; pages < 500; pages++) {
      const page = await this.backend!.since(this.manifest.after);
      this.live();
      for (const row of page.rows) {
        if (row.seq <= this.manifest.after) continue;
        if (memoryPathOk(row.path)) {
          if (row.gone) {
            fs.rmSync(this.cacheFile(row.path), { force: true });
            delete this.manifest.files[row.path];
          } else {
            atomicWriteFileSync(this.cacheFile(row.path), row.text, 0o600);
            this.manifest.files[row.path] = row.hash;
          }
        }
        this.manifest.after = row.seq;
      }
      this.save();
      if (!page.more || !page.rows.length) return;
    }
  }

  private cached(p: string): string | undefined {
    const s = look(this.cacheFile(p));
    return s.state === 'text' && s.hash === this.manifest.files[p] ? s.text : undefined;
  }

  // Makes every login match the main Mac's files, offering first anything
  // that would be lost. Writes happen only after the offers have gone, and
  // each only if the file is still as it was when it was read: an edit that
  // lands in between is left for the next pass, which offers it.
  private async reconcile(): Promise<void> {
    const { home } = this.deps;
    const claude = this.deps.claudeDirs();
    const codex = this.deps.codexDirs();
    const roots = uniq([...claudeDirsOf(home, claude), ...[path.join(home, '.codex'), ...codex].filter(isDirectory), path.join(home, '.agents')].map(real), (r) => r);
    const offers: { file: string; path: string; text: string; hash: string }[] = [];
    const writes: { file: string; path: string; text: string; hash: string; expect: string | undefined }[] = [];
    const deletes: { file: string; expect: string }[] = [];
    const offer = (file: string, p: string, text: string) => {
      const scrubbed = this.deps.scrub(text);
      const hash = sha256(scrubbed);
      if (this.manifest.offered[file] !== hash) offers.push({ file, path: p, text: scrubbed, hash });
    };
    const handled = new Set<string>();

    // The main Mac's files, in every place they go.
    for (const [p, want] of Object.entries(this.manifest.files)) {
      const text = this.cached(p);
      if (text === undefined) continue;
      for (const file of targetsOf(p, home, claude, codex)) {
        const at = real(file);
        handled.add(at);
        if (!inside(at, roots)) continue;
        const seen = look(at);
        if (this.manifest.kept[at]) {
          // Never written, but each version still offered, including one
          // whose offer failed last time.
          if (seen.state === 'text') offer(at, p, seen.text);
          continue;
        }
        const mine = this.manifest.wrote[at];
        if (seen.state === 'odd') {
          this.manifest.kept[at] = true;
          continue;
        }
        if (seen.state === 'missing') {
          writes.push({ file: at, path: p, text, hash: want, expect: undefined });
          continue;
        }
        if (seen.hash === want) {
          if (!mine) this.manifest.adopted[at] = true;
          this.manifest.wrote[at] = { path: p, hash: want };
          continue;
        }
        if (!mine) {
          // Someone's own file, there before sync: kept, and offered once.
          this.manifest.kept[at] = true;
          this.deps.log.warn('memory sync left a file it did not write', { file: at });
          offer(at, p, seen.text);
          continue;
        }
        if (seen.hash !== mine.hash) {
          // Changed here since sync wrote it: offered, and kept until the main
          // Mac has a newer version than the one it was changed from (so a
          // line an agent here just added to MEMORY.md isn't taken straight
          // back out). Then that replaces it, the edit having been offered.
          offer(at, p, seen.text);
          if (mine.hash === want) continue;
        }
        writes.push({ file: at, path: p, text, hash: want, expect: seen.hash });
      }
    }

    // Files sync wrote whose path the main Mac no longer has.
    for (const [at, mine] of Object.entries(this.manifest.wrote)) {
      if (this.manifest.files[mine.path] !== undefined) continue;
      handled.add(at);
      // A folder relinked since sync wrote here leads somewhere else now:
      // forgotten, never deleted.
      if (real(at) !== at || !inside(at, roots)) {
        delete this.manifest.wrote[at];
        delete this.manifest.adopted[at];
        continue;
      }
      const seen = look(at);
      if (seen.state === 'text' && seen.hash !== mine.hash) offer(at, mine.path, seen.text);
      if (seen.state === 'text' && seen.hash === mine.hash && !this.manifest.adopted[at]) deletes.push({ file: at, expect: seen.hash });
      else {
        delete this.manifest.wrote[at];
        delete this.manifest.adopted[at];
      }
    }

    // Anything else here: new memories, and a global file the main Mac doesn't have.
    const local = memoryFiles(home, claudeDirsOf(home, claude));
    if (this.manifest.files[GLOBAL_PATH] === undefined) local.set(GLOBAL_PATH, targetsOf(GLOBAL_PATH, home, claude, codex));
    for (const [p, files] of local) {
      for (const file of files) {
        const at = real(file);
        if (handled.has(at) || !inside(at, roots)) continue;
        const seen = look(at);
        if (seen.state === 'text') offer(at, p, seen.text);
      }
    }

    // Offers first, as one offer row per text: two logins' different edits of
    // one file are two offers, never one in place of the other.
    // Each batch is recorded as it goes, so a full backend (too many waiting)
    // doesn't send the same ones again next pass. A file whose offer didn't
    // go isn't replaced this pass; everything else still is.
    const sendable = uniq(offers, (o) => `${o.path}\n${o.hash}`);
    const sent = new Set<string>();
    let sentCount = 0;
    try {
      for (const batch of batches(sendable)) {
        await this.backend!.offer(batch.map(({ path: p, hash, text }) => ({ path: p, hash, text })));
        this.live();
        for (const o of batch) sent.add(`${o.path}\n${o.hash}`);
        sentCount += batch.length;
        for (const o of offers) if (sent.has(`${o.path}\n${o.hash}`)) this.manifest.offered[o.file] = o.hash;
        this.save();
      }
    } catch (e) {
      this.live();
      this.deps.log.warn('memory offers did not all go', { error: String((e as Error)?.message ?? e), sent: sentCount, of: sendable.length });
    }
    if (sentCount) this.deps.log.info('memory offered to the main Mac', { files: sentCount });
    const unsent = new Set(offers.filter((o) => !sent.has(`${o.path}\n${o.hash}`)).map((o) => o.file));

    this.live();
    let wrote = 0;
    for (const w of writes) {
      if (unsent.has(w.file) || real(w.file) !== w.file) continue;
      const now = look(w.file);
      const still = w.expect === undefined ? now.state === 'missing' : now.state === 'text' && now.hash === w.expect;
      if (!still) continue;
      atomicWriteFileSync(w.file, w.text);
      this.manifest.wrote[w.file] = { path: w.path, hash: w.hash };
      wrote++;
    }
    for (const d of deletes) {
      const now = look(d.file);
      if (now.state === 'text' && now.hash === d.expect && real(d.file) === d.file && inside(d.file, roots)) fs.rmSync(d.file, { force: true });
      delete this.manifest.wrote[d.file];
      delete this.manifest.adopted[d.file];
    }
    if (wrote || deletes.length) this.deps.log.info('memory written down', { files: wrote, deleted: deletes.length });
    this.save();
  }
}
