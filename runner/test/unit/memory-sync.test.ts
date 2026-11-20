// Shared memory (memory-sync.ts, docs/protocol.md "Shared memory"): the main
// Mac puts its global CLAUDE.md and memory folders up, the other runners copy
// them into their own logins under their own home, and their agents' saves
// come back as offers that land beside the main Mac's memory, never in it.
// The later tests are the cases a Codex review found on 17 Nov 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderOf, GLOBAL_PATH, MAX_MEMORY_FILE, MAX_OFFERS_ON_DISK, MEMORY_PATH, MemorySync, slugOf, type MemoryBackend, type MemoryOffer, type MemoryPut, type MemoryRow } from '../../src/memory-sync.ts';

// The backend's side, as convex/memorySync.ts does it: one seq per change,
// only changed rows written, gone rows kept, one offer row per version.
class FakeBackend {
  files = new Map<string, MemoryRow>();
  seq = 0;
  offers: MemoryOffer[] = [];
  nextId = 1;
  // Runs inside an offer call, before it returns (an edit landing mid-request).
  duringOffer?: () => void;
  // Offers that may wait at once (the backend's MAX_OFFERS_PER_RUNNER), and
  // offer calls to fail outright.
  cap = Infinity;
  failOffers = 0;
  // Holds memorySince's answer until released.
  hold?: Promise<void>;
  as(owner: boolean, runnerId: string): MemoryBackend {
    return {
      owner,
      put: async (files: MemoryPut[]) => {
        assert.ok(owner, 'only the owner puts');
        let n = 0;
        for (const f of files) {
          assert.match(f.path, MEMORY_PATH);
          const row = this.files.get(f.path);
          if (f.gone) {
            if (!row || row.gone) continue;
            this.files.set(f.path, { path: f.path, hash: f.hash, text: '', gone: true, seq: ++this.seq });
          } else {
            if (row && !row.gone && row.hash === f.hash) continue;
            this.files.set(f.path, { path: f.path, hash: f.hash, text: f.text!, seq: ++this.seq });
          }
          n++;
        }
        return n;
      },
      since: async (after: number) => {
        if (this.hold) await this.hold;
        const rows = [...this.files.values()].filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq);
        return { rows: rows.slice(0, 2), more: rows.length > 2, seq: this.seq };
      },
      offer: async (files) => {
        assert.ok(!owner, "the owner's files aren't offers");
        if (this.failOffers > 0) {
          this.failOffers--;
          throw new Error('network');
        }
        for (const f of files) {
          if (this.offers.some((o) => o.runnerId === runnerId && o.path === f.path && o.hash === f.hash)) continue;
          if (this.offers.filter((o) => o.runnerId === runnerId).length >= this.cap) throw new Error('200 offers already waiting for the main Mac');
          this.offers.push({ id: String(this.nextId++), runnerId, ...f, at: Date.now() });
        }
        this.duringOffer?.();
        this.duringOffer = undefined;
      },
      offers: async () => {
        assert.ok(owner);
        return this.offers.slice(0, 20);
      },
      take: async (taken) => {
        this.offers = this.offers.filter((o) => !taken.some((t) => t.id === o.id && t.hash === o.hash));
      },
    };
  }
}

type Mac = { root: string; home: string; data: string; claude: string[]; codex: string[] };

function mac(name: string, extraLogins = 0, codex = false): Mac {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tb-mem-${name}-`)));
  const home = path.join(root, 'Users', name);
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const claude = [path.join(home, '.claude')];
  for (let i = 1; i <= extraLogins; i++) claude.push(addLogin({ root, home, data, claude, codex: [] }, i));
  if (codex) fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return { root, home, data, claude, codex: [] };
}

function addLogin(m: Mac, i: number): string {
  const d = path.join(m.root, 'accounts', `claude-${i}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function memDir(m: Mac, dir: string, rel: string): string {
  return path.join(dir, 'projects', slugOf(rel, m.home), 'memory');
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

// Every offer the main Mac saved for a runner and path, by text.
function saved(m: Mac, runner: string, p: string): string[] {
  const dir = path.join(m.data, 'memory-offers', runner, ...p.split('/'));
  try {
    return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).sort();
  } catch {
    return [];
  }
}

const quiet = { info() {}, warn() {}, debug() {} };

function syncFor(m: Mac, opts: { on?: () => boolean; scrub?: (t: string) => string } = {}): MemorySync {
  return new MemorySync({
    home: m.home,
    dataDir: m.data,
    on: opts.on ?? (() => true),
    claudeDirs: () => m.claude,
    codexDirs: () => m.codex,
    scrub: opts.scrub ?? ((t) => t),
    log: quiet,
    setTimer: () => ({}),
  });
}

// The main Mac and one other runner, both attached to one backend.
function pair(otherLogins = 0, codex = false) {
  const backend = new FakeBackend();
  const m5 = mac('m5mike');
  const bruce = mac('bruce', otherLogins, codex);
  const owner = syncFor(m5);
  owner.attach(backend.as(true, 'm5'));
  const other = syncFor(bruce);
  other.attach(backend.as(false, 'bruce'));
  const misc = memDir(m5, m5.claude[0]!, '~-dev-me-misc');
  const there = (dir = bruce.claude[0]!) => memDir(bruce, dir, '~-dev-me-misc');
  const both = async () => {
    await owner.tick();
    await other.tick();
  };
  return { backend, m5, bruce, owner, other, misc, there, both };
}

test("the runner's path rule is the backend's", () => {
  const convex = fs.readFileSync(path.join(import.meta.dirname, '../../../convex/memorySync.ts'), 'utf8');
  const m = convex.match(/export const MEMORY_PATH = (\/.*\/);/);
  assert.ok(m, 'found the backend rule');
  assert.equal(m![1], String(MEMORY_PATH));
  for (const ok of ['global/CLAUDE.md', 'memory/~/MEMORY.md', 'memory/~-dev-me-misc/claude-accounts.md']) assert.match(ok, MEMORY_PATH);
  for (const bad of ['memory/~-dev/../x.md', 'memory/dev/x.md', 'memory/~-dev/sub/x.md', 'memory/~-dev/.x.md', 'global/AGENTS.md', 'memory/~-dev/x.txt']) assert.doesNotMatch(bad, MEMORY_PATH);
});

test('folders under home travel as ~ paths; ~/Library and the rest stay put', () => {
  assert.equal(folderOf('-Users-m5-mike-dev-me-misc', '/Users/m5-mike'), '~-dev-me-misc');
  assert.equal(folderOf('-Users-m5-mike', '/Users/m5-mike'), '~');
  assert.equal(folderOf('-Users-m5-mike-Library-Application-Support-Claude-x', '/Users/m5-mike'), undefined);
  assert.equal(folderOf('-private-tmp', '/Users/m5-mike'), undefined);
  assert.equal(folderOf('-Users-m5-mike2-dev', '/Users/m5-mike'), undefined);
  assert.equal(slugOf('~-dev-me-misc', '/Users/bruce'), '-Users-bruce-dev-me-misc');
  assert.equal(slugOf('~', '/Users/bruce'), '-Users-bruce');
});

test("the main Mac's memory reaches every login on another runner, under its own home, and changes follow", async () => {
  const { backend, m5, bruce, owner, misc, there, both } = pair(1, true);
  write(path.join(m5.home, '.claude', 'CLAUDE.md'), '# I talk, I dont type\n');
  write(path.join(misc, 'MEMORY.md'), '- [Bruce](bruce.md)\n');
  write(path.join(misc, 'bruce.md'), 'Bruce is a Mac mini\n');
  write(path.join(misc, 'old.md'), 'going\n');
  write(path.join(memDir(m5, m5.claude[0]!, '~-Library-Application-Support-Claude-scratch'), 'x.md'), 'scratch\n');
  write(path.join(m5.claude[0]!, 'projects', '-private-tmp', 'memory', 'y.md'), 'tmp\n');

  await both();
  assert.deepEqual([...backend.files.keys()].sort(), [GLOBAL_PATH, 'memory/~-dev-me-misc/MEMORY.md', 'memory/~-dev-me-misc/bruce.md', 'memory/~-dev-me-misc/old.md']);
  for (const dir of bruce.claude) {
    assert.equal(read(path.join(dir, 'CLAUDE.md')), '# I talk, I dont type\n');
    assert.equal(read(path.join(there(dir), 'bruce.md')), 'Bruce is a Mac mini\n');
  }
  assert.equal(read(path.join(bruce.home, '.codex', 'AGENTS.md')), '# I talk, I dont type\n');
  assert.equal(backend.offers.length, 0, 'what it wrote down is not offered back');

  // An edit and a delete on the main Mac.
  write(path.join(misc, 'bruce.md'), 'Bruce is a Mac mini with 8 GB\n');
  fs.rmSync(path.join(misc, 'old.md'));
  await both();
  assert.equal(read(path.join(there(), 'bruce.md')), 'Bruce is a Mac mini with 8 GB\n');
  assert.equal(read(path.join(there(), 'old.md')), undefined);
  assert.equal(backend.offers.length, 0);
  // Nothing changed: nothing more goes up.
  const seq = backend.seq;
  await owner.tick();
  assert.equal(backend.seq, seq);
});

test("another runner's saves come back as offers beside the main Mac's memory, never in it", async () => {
  const { backend, m5, misc, there, both, other, owner } = pair();
  write(path.join(misc, 'MEMORY.md'), 'index v1\n');
  await both();

  write(path.join(there(), 'new.md'), 'learned on bruce\n');
  write(path.join(there(), 'MEMORY.md'), 'index v1 + bruce line\n');
  await other.tick();
  assert.deepEqual(backend.offers.map((o) => o.path).sort(), ['memory/~-dev-me-misc/MEMORY.md', 'memory/~-dev-me-misc/new.md']);
  await other.tick();
  assert.equal(backend.offers.length, 2, 'each version offered once');
  // Its own edit stays until the main Mac has a newer version.
  assert.equal(read(path.join(there(), 'MEMORY.md')), 'index v1 + bruce line\n');

  await owner.tick();
  assert.equal(backend.offers.length, 0, 'taken');
  assert.deepEqual(saved(m5, 'bruce', 'memory/~-dev-me-misc/new.md'), ['learned on bruce\n']);
  assert.equal(read(path.join(misc, 'new.md')), undefined, "the main Mac's memory is untouched");
  assert.equal(read(path.join(misc, 'MEMORY.md')), 'index v1\n');
  assert.equal(backend.files.has('memory/~-dev-me-misc/new.md'), false, 'and nothing of it goes to the other runners');

  write(path.join(misc, 'MEMORY.md'), 'index v2\n');
  await both();
  assert.equal(read(path.join(there(), 'MEMORY.md')), 'index v2\n');
});

test("a file that was there before sync isn't written over, and is offered instead", async () => {
  const { m5, bruce, both, owner } = pair();
  write(path.join(m5.home, '.claude', 'CLAUDE.md'), 'mike global\n');
  write(path.join(bruce.home, '.claude', 'CLAUDE.md'), "bruce's own\n");
  await both();
  await both();
  assert.equal(read(path.join(bruce.home, '.claude', 'CLAUDE.md')), "bruce's own\n");
  write(path.join(m5.home, '.claude', 'CLAUDE.md'), 'mike global v2\n');
  await both();
  await owner.tick();
  assert.equal(read(path.join(bruce.home, '.claude', 'CLAUDE.md')), "bruce's own\n", 'still left alone');
  assert.deepEqual(saved(m5, 'bruce', GLOBAL_PATH), ["bruce's own\n"]);
  assert.equal(read(path.join(m5.home, '.claude', 'CLAUDE.md')), 'mike global v2\n');
});

test('off: nothing goes up or comes down; secrets are masked before anything goes up', async () => {
  const backend = new FakeBackend();
  const m5 = mac('m5mike');
  write(path.join(m5.home, '.claude', 'CLAUDE.md'), 'token sk-live-123\n');
  let on = false;
  const owner = syncFor(m5, { on: () => on, scrub: (t) => t.replace(/sk-live-\d+/g, '[secret]') });
  owner.attach(backend.as(true, 'm5'));
  await owner.tick();
  assert.equal(backend.files.size, 0);
  on = true;
  await owner.tick();
  assert.equal(backend.files.get(GLOBAL_PATH)?.text, 'token [secret]\n');
});

test('a file too big to read, or not a file, is left alone even the first time', async () => {
  const { m5, bruce, both } = pair();
  write(path.join(m5.home, '.claude', 'CLAUDE.md'), 'mike global\n');
  const big = 'x'.repeat(MAX_MEMORY_FILE + 1);
  write(path.join(bruce.home, '.claude', 'CLAUDE.md'), big);
  await both();
  assert.equal(read(path.join(bruce.home, '.claude', 'CLAUDE.md')), big);
});

test("two logins' different edits of one file both reach the main Mac", async () => {
  const { m5, misc, there, both, bruce, owner, other } = pair(1);
  write(path.join(misc, 'a.md'), 'v1\n');
  await both();
  write(path.join(there(bruce.claude[0]!), 'a.md'), 'edit in login A\n');
  write(path.join(there(bruce.claude[1]!), 'a.md'), 'edit in login B\n');
  write(path.join(misc, 'a.md'), 'v2\n');
  await owner.tick();
  await other.tick();
  await owner.tick();
  assert.deepEqual(saved(m5, 'bruce', 'memory/~-dev-me-misc/a.md'), ['edit in login A\n', 'edit in login B\n']);
  for (const dir of bruce.claude) assert.equal(read(path.join(there(dir), 'a.md')), 'v2\n');
});

test('an edit that lands while its older version is being offered is not written over', async () => {
  const { backend, m5, misc, there, both, owner, other } = pair();
  write(path.join(misc, 'a.md'), 'v1\n');
  await both();
  write(path.join(there(), 'a.md'), 'edit B\n');
  write(path.join(misc, 'a.md'), 'v2\n');
  await owner.tick();
  backend.duringOffer = () => write(path.join(there(), 'a.md'), 'edit C\n');
  await other.tick();
  assert.equal(read(path.join(there(), 'a.md')), 'edit C\n', 'C survives this pass');
  await other.tick();
  await owner.tick();
  assert.deepEqual(saved(m5, 'bruce', 'memory/~-dev-me-misc/a.md'), ['edit B\n', 'edit C\n']);
  assert.equal(read(path.join(there(), 'a.md')), 'v2\n', 'and is replaced once offered');
});

test('the main Mac stops taking offers once memory-offers is full', async () => {
  const { backend, m5, there, both, other, owner } = pair();
  await both();
  write(path.join(m5.data, 'memory-offers', 'bruce', 'filler'), 'x'.repeat(MAX_OFFERS_ON_DISK + 1));
  write(path.join(there(), 'new.md'), 'learned\n');
  await other.tick();
  await owner.tick();
  assert.equal(backend.offers.length, 1, 'left waiting in the backend');
  fs.rmSync(path.join(m5.data, 'memory-offers', 'bruce', 'filler'));
  await owner.tick();
  assert.equal(backend.offers.length, 0);
});

test("a link out of the logins' folders isn't followed for writes or deletes", async () => {
  const { m5, bruce, misc, both } = pair();
  const outside = path.join(bruce.root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(bruce.home, '.claude', 'projects'));
  write(path.join(misc, 'a.md'), 'v1\n');
  await both();
  assert.deepEqual(fs.readdirSync(outside), []);
  void m5;
});

test('a login added later, and a synced file deleted by hand, catch up with no change on the main Mac', async () => {
  const { bruce, misc, there, both, other, m5 } = pair(0, false);
  write(path.join(m5.home, '.claude', 'CLAUDE.md'), 'mike global\n');
  write(path.join(misc, 'a.md'), 'v1\n');
  await both();
  bruce.claude.push(addLogin(bruce, 1));
  fs.mkdirSync(path.join(bruce.home, '.codex'));
  fs.rmSync(path.join(there(), 'a.md'));
  await other.tick();
  assert.equal(read(path.join(there(bruce.claude[1]!), 'a.md')), 'v1\n');
  assert.equal(read(path.join(bruce.claude[1]!, 'CLAUDE.md')), 'mike global\n');
  assert.equal(read(path.join(bruce.home, '.codex', 'AGENTS.md')), 'mike global\n');
  assert.equal(read(path.join(there(), 'a.md')), 'v1\n');
});

test("an edit to Codex's AGENTS.md is offered; a file already matching is never deleted", async () => {
  const { m5, bruce, misc, there, both, owner } = pair(0, true);
  write(path.join(m5.home, '.claude', 'CLAUDE.md'), 'mike global\n');
  write(path.join(there(), 'same.md'), 'same\n');
  write(path.join(misc, 'same.md'), 'same\n');
  await both();
  write(path.join(bruce.home, '.codex', 'AGENTS.md'), 'codex edit\n');
  fs.rmSync(path.join(misc, 'same.md'));
  await both();
  await owner.tick();
  assert.deepEqual(saved(m5, 'bruce', GLOBAL_PATH), ['codex edit\n']);
  assert.equal(read(path.join(there(), 'same.md')), 'same\n', 'it was there before sync, so it stays');
});

test('a stopped runner does nothing more', async () => {
  const { backend, misc, other, owner } = pair();
  write(path.join(misc, 'a.md'), 'v1\n');
  owner.stop();
  await owner.tick();
  assert.equal(backend.files.size, 0);
  void other;
});

// Round two of the review.

test('a flood of empty offers still fills the quota on the main Mac', async () => {
  const { backend, m5, there, both, other, owner } = pair();
  await both();
  const dir = path.join(m5.data, 'memory-offers', 'bruce', 'memory', '~');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < MAX_OFFERS_ON_DISK / 4096 + 10; i++) fs.writeFileSync(path.join(dir, `e${i}.md`), '');
  write(path.join(there(), 'new.md'), 'learned\n');
  await other.tick();
  await owner.tick();
  assert.equal(backend.offers.length, 1, 'not taken: empty files count as a block each');
});

test('a folder relinked after sync wrote there is never deleted from', async () => {
  const { bruce, misc, there, both } = pair();
  write(path.join(misc, 'a.md'), 'v1\n');
  await both();
  assert.equal(read(path.join(there(), 'a.md')), 'v1\n');
  const outside = path.join(bruce.root, 'outside');
  fs.renameSync(path.join(bruce.home, '.claude', 'projects'), outside);
  fs.symlinkSync(outside, path.join(bruce.home, '.claude', 'projects'));
  fs.rmSync(path.join(misc, 'a.md'));
  await both();
  assert.equal(read(path.join(outside, slugOf('~-dev-me-misc', bruce.home), 'memory', 'a.md')), 'v1\n');
});

test("more new files than the backend will hold don't stop the main Mac's memory coming down, nor get sent again", async () => {
  const { backend, misc, there, both, other, owner, m5 } = pair();
  backend.cap = 200;
  write(path.join(misc, 'a.md'), 'v1\n');
  await both();
  for (let i = 0; i < 201; i++) write(path.join(there(), `n${i}.md`), `note ${i}\n`);
  write(path.join(misc, 'a.md'), 'v2\n');
  await both();
  assert.equal(backend.offers.length, 200);
  assert.equal(read(path.join(there(), 'a.md')), 'v2\n', 'still applied');
  await owner.tick();
  await other.tick();
  await owner.tick();
  // 20 + 20 taken, and only the one that didn't fit was sent again.
  assert.equal(backend.offers.length, 200 - 40 + 1);
  void m5;
});

test("a pre-existing file whose offer failed is offered on a later pass", async () => {
  const { backend, m5, bruce, both, owner, other } = pair();
  write(path.join(m5.home, '.claude', 'CLAUDE.md'), 'mike global\n');
  write(path.join(bruce.home, '.claude', 'CLAUDE.md'), "bruce's own\n");
  await owner.tick();
  backend.failOffers = 1;
  await other.tick();
  assert.equal(backend.offers.length, 0);
  await other.tick();
  assert.deepEqual(backend.offers.map((o) => o.text), ["bruce's own\n"]);
  assert.equal(read(path.join(bruce.home, '.claude', 'CLAUDE.md')), "bruce's own\n");
});

test('a runner stopped mid-pass writes nothing after its backend answers', async () => {
  const { backend, misc, there, owner, other, bruce } = pair();
  write(path.join(misc, 'a.md'), 'v1\n');
  await owner.tick();
  let release!: () => void;
  backend.hold = new Promise((r) => (release = r));
  const pass = other.tick();
  other.stop();
  release();
  await pass;
  assert.equal(read(path.join(there(), 'a.md')), undefined);
  assert.equal(fs.existsSync(path.join(bruce.data, 'memory-sync.json')), false);
});
