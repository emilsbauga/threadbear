// media.import from a thread's own key (Daybreak finding 157): metered below
// Full access, refused before any work once over, never holding the event
// loop, and leaving nothing behind when it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from '../helpers/fakes.ts';
import { makePng } from '../helpers/png.ts';
import { RpcServer } from '../../src/rpc.ts';
import { RunnerClient } from '../../src/client.ts';
import { readToken } from '../../src/config.ts';
import { nullLogger } from '../../src/log.ts';
import { threadKey } from '../../src/rpc-auth.ts';
import { CallerGate } from '../../src/rpc-gate.ts';
import { ImportQuota } from '../../src/media-quota.ts';
import type { PermissionMode } from '../../src/protocol.ts';
import { patiently } from '../helpers/patience.ts';

async function serve() {
  const h = makeHarness();
  const token = readToken(h.home);
  // As main.ts builds it, reading the quota at each call (tests swap it).
  const gate = new CallerGate({ runner: h.runner, images: { take: (id, images) => h.runner.importQuota.take(id, images), releaseHeld: (images) => h.runner.importQuota.releaseHeld(images) } });
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token, runner: h.runner, log: nullLogger, gate });
  const { port } = await server.listen();
  return { h, server, token, url: `ws://127.0.0.1:${port}/rpc` };
}

const thread = (h: ReturnType<typeof makeHarness>, mode: PermissionMode) =>
  h.runner.create({ text: mode, accountId: 'claude-3', permissionMode: mode }).thread;
const inbox = (home: string) => (fs.existsSync(path.join(home, 'inbox')) ? fs.readdirSync(path.join(home, 'inbox')) : []);
const setQuota = (h: ReturnType<typeof makeHarness>, q: ImportQuota) => {
  Object.defineProperty(h.runner, 'importQuota', { value: q });
  return q;
};
const small = (h: ReturnType<typeof makeHarness>, files: number) => setQuota(h, new ImportQuota({ perThread: { files, bytes: 1024 * 1024 }, all: { files: 100, bytes: 100 * 1024 * 1024 } }));

test('an Ask thread is refused before any work once over its allowance, the same file again counting too', async () => {
  const { h, server, token, url } = await serve();
  small(h, 3);
  const me = thread(h, 'ask');
  const c = await RunnerClient.connect(url, threadKey(token, me.id), { threadId: me.id });
  try {
    const shot = path.join(h.home, 'shot.png');
    fs.writeFileSync(shot, makePng(11, 10));
    const a = (await c.call('media.import', { path: shot })).image;
    const b = (await c.call('media.import', { path: shot })).image;
    assert.notEqual(a.path, b.path, 'each import its own copy, so two sends of one file both work');
    await c.call('media.import', { path: shot });
    const before = inbox(h.home);
    await assert.rejects(c.call('media.import', { path: shot }), (e: { code: number; message: string }) => e.code === -32602 && /today/.test(e.message));
    assert.deepEqual(inbox(h.home), before, 'nothing written once over');
    // Bytes count too: one file over the day's bytes is refused.
    small(h, 100);
    const big = path.join(h.home, 'big.png');
    fs.writeFileSync(big, Buffer.concat([makePng(5, 5), Buffer.alloc(2 * 1024 * 1024)]));
    await assert.rejects(c.call('media.import', { path: big }), /today/);
    assert.deepEqual(inbox(h.home), before);
    // And one picture over 25 MB, whatever's left.
    setQuota(h, new ImportQuota());
    const huge = path.join(h.home, 'huge.png');
    fs.writeFileSync(huge, Buffer.concat([makePng(5, 5), Buffer.alloc(26 * 1024 * 1024)]));
    await assert.rejects(c.call('media.import', { path: huge }), /over 25 MB/);
    assert.deepEqual(inbox(h.home), before);
  } finally {
    c.close();
    await server.close();
  }
});

test('the allowance is per thread and for all limited threads together; Full threads and the owner are not metered', async () => {
  const { h, server, token, url } = await serve();
  const a = thread(h, 'ask');
  const b = thread(h, 'auto');
  const full = thread(h, 'full');
  setQuota(h, new ImportQuota({ perThread: { files: 2, bytes: 1024 * 1024 }, all: { files: 3, bytes: 1024 * 1024 } }));
  const conns = await Promise.all([a, b, full].map((t) => RunnerClient.connect(url, threadKey(token, t.id), { threadId: t.id })));
  const owner = await RunnerClient.connect(url, token);
  let n = 0;
  const fresh = () => {
    const f = path.join(h.home, `p-${n++}.png`);
    fs.writeFileSync(f, makePng(8 + n, 8));
    return f;
  };
  try {
    const [ca, cb, cf] = conns as [RunnerClient, RunnerClient, RunnerClient];
    await ca.call('media.import', { path: fresh() });
    await ca.call('media.import', { path: fresh() });
    await assert.rejects(ca.call('media.import', { path: fresh() }), /This thread/);
    await cb.call('media.import', { path: fresh() });
    await assert.rejects(cb.call('media.import', { path: fresh() }), /Threads below Full/);
    for (let i = 0; i < 5; i++) await cf.call('media.import', { path: fresh() });
    for (let i = 0; i < 5; i++) await owner.call('media.import', { path: fresh() });
  } finally {
    for (const c of [...conns, owner]) c.close();
    await server.close();
  }
});

test("a thread's import doesn't hold the event loop, and leaves nothing when it fails", async () => {
  const h = makeHarness();
  const me = thread(h, 'ask');
  // A big (but allowed) file: the copy goes in pieces, and timers keep running meanwhile.
  const big = path.join(h.home, 'big.png');
  fs.writeFileSync(big, Buffer.concat([makePng(5, 5), Buffer.alloc(20 * 1024 * 1024)]));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    const { image } = await h.runner.importMediaForThread(me.id, big, true);
    assert.ok(ticks > 1, `timers ran during the import (${ticks})`);
    assert.equal(fs.statSync(image.path).size, fs.statSync(big).size);
  } finally {
    clearInterval(timer);
  }
  // Not a picture, or one that won't convert: refused, and nothing is left in the inbox.
  const before = inbox(h.home);
  const junk = path.join(h.home, 'junk.bin');
  fs.writeFileSync(junk, 'not a picture at all');
  await assert.rejects(h.runner.importMediaForThread(me.id, junk, true), /Not a supported image/);
  const fakeBmp = path.join(h.home, 'broken.bmp');
  fs.writeFileSync(fakeBmp, Buffer.concat([Buffer.from('BM'), Buffer.alloc(200, 7)]));
  await assert.rejects(h.runner.importMediaForThread(me.id, fakeBmp, true), /Not a supported image/);
  assert.deepEqual(inbox(h.home), before, 'no leftovers');
  // A FIFO is refused without blocking.
  if (process.platform !== 'win32') {
    const fifo = path.join(h.home, 'pipe.png');
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [fifo]);
    await assert.rejects(h.runner.importMediaForThread(me.id, fifo, true), /Not a file/);
  }
});

// Gemini's review of the fix: threads.send and threads.create took pictures by
// any path, and the runner copied each into the thread's media, unmetered.
test("a limited thread's message carries only pictures it imported, each once, as a copy of what was imported", async () => {
  const { h, server, token, url } = await serve();
  const me = thread(h, 'ask');
  const other = thread(h, 'ask');
  const c = await RunnerClient.connect(url, threadKey(token, me.id), { threadId: me.id });
  const c2 = await RunnerClient.connect(url, threadKey(token, other.id), { threadId: other.id });
  try {
    const src = path.join(h.home, 'shot.png');
    fs.writeFileSync(src, makePng(12, 12));
    const notImported = /only pictures it added with media.import/;
    await assert.rejects(c.call('threads.send', { threadId: me.id, text: 'look', images: [{ path: src, mediaType: 'image/png' }] }), notImported);
    await assert.rejects(c.call('threads.create', { text: 'look', accountId: 'claude-3', images: [{ path: src, mediaType: 'image/png' }] }), notImported);
    const { image } = await c.call('media.import', { path: src });
    // Not another thread's import.
    await assert.rejects(c2.call('threads.send', { threadId: other.id, text: 'look', images: [image] }), notImported);
    await assert.rejects(c.call('threads.send', { threadId: me.id, text: 'look', images: [image, image] }), /twice/);
    await assert.rejects(c.call('threads.send', { threadId: me.id, text: 'look', images: Array.from({ length: 11 }, () => image) }), /At most 10/);
    await c.call('threads.send', { threadId: me.id, text: 'look', images: [image] });
    const sent = h.events(me.id).filter((e) => e.type === 'user.message').at(-1)!;
    assert.equal(sent.images.length, 1);
    assert.ok(sent.images[0].path.startsWith(path.join(h.home, 'threads', me.id, 'media')));
    assert.equal(fs.existsSync(image.path), false, 'the inbox copy is used up');
    assert.deepEqual(inbox(h.home).filter((n) => n.includes('.held.')), [], "and the send's own copy is gone once it's done");
    // Not to a thread on another runner (one being handed over, at the same
    // mode): the copy's path would cross to a runner that can't check it.
    const later = (await c.call('media.import', { path: src })).image;
    const away = { id: 'away-thread', title: 'away', permissionMode: 'ask' as const, status: 'idle' };
    const gate = new CallerGate({ runner: h.runner, remote: { owns: (id) => id === away.id, summaries: () => [away] }, images: h.runner.importQuota });
    assert.throws(() => gate.check(me.id, 'threads.send', { threadId: away.id, text: 'look', images: [later] }), /isn't on this runner/);
    assert.ok(fs.existsSync(later.path), 'and the picture is still there to send');
    await assert.rejects(c.call('threads.send', { threadId: me.id, text: 'again', images: [image] }), notImported, 'used up');
    // The inbox file is the thread's to write: grown, or swapped for another
    // file, it's refused rather than copied into the thread.
    const grown = (await c.call('media.import', { path: src })).image;
    fs.appendFileSync(grown.path, Buffer.alloc(5 * 1024 * 1024));
    await assert.rejects(c.call('threads.send', { threadId: me.id, text: 'grown', images: [grown] }), notImported);
    const swapped = (await c.call('media.import', { path: src })).image;
    const tiff = path.join(h.home, 'x.tiff');
    fs.writeFileSync(tiff, Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0]), Buffer.alloc(fs.statSync(swapped.path).size - 4)]));
    fs.renameSync(tiff, swapped.path);
    await assert.rejects(c.call('threads.send', { threadId: me.id, text: 'swapped', images: [swapped] }), notImported);
    // The same file, its bytes changed in place to something to convert: refused, not converted.
    const edited = (await c.call('media.import', { path: src })).image;
    const size = fs.statSync(edited.path).size;
    fs.writeFileSync(edited.path, Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0]), Buffer.alloc(size - 4)]), { flag: 'r+' });
    await assert.rejects(c.call('threads.send', { threadId: me.id, text: 'edited', images: [edited] }), notImported);
    // A path through a link to somewhere else, resolving to the imported name: what's opened is the imported file.
    const real = (await c.call('media.import', { path: src })).image;
    const pivot = path.join(h.home, 'pivot');
    fs.mkdirSync(path.join(h.home, 'decoy', 'a', 'b'), { recursive: true });
    fs.symlinkSync(path.join(h.home, 'decoy', 'a', 'b'), pivot);
    // Sent as written, not tidied: followed through the link it would reach decoy/<rel>.
    const rel = path.relative(path.dirname(h.home), real.path);
    fs.mkdirSync(path.dirname(path.join(h.home, 'decoy', rel)), { recursive: true });
    fs.writeFileSync(path.join(h.home, 'decoy', rel), Buffer.concat([makePng(3, 3), Buffer.alloc(3 * 1024 * 1024)]));
    await c.call('threads.send', { threadId: me.id, text: 'pivot', images: [{ ...real, path: `${pivot}/../../${rel}` }] });
    const last = h.events(me.id).filter((e) => e.type === 'user.message').at(-1)!;
    assert.deepEqual([last.images[0].width, last.images[0].height], [12, 12]);
  } finally {
    c.close();
    c2.close();
    await server.close();
  }
});

test('an import whose client has gone by the time it is done is removed at once', async () => {
  const { h, server, token, url } = await serve();
  const me = thread(h, 'ask');
  const big = path.join(h.home, 'big.png');
  fs.writeFileSync(big, Buffer.concat([makePng(5, 5), Buffer.alloc(20 * 1024 * 1024)]));
  setQuota(h, new ImportQuota());
  const c = await RunnerClient.connect(url, threadKey(token, me.id), { threadId: me.id });
  try {
    void c.call('media.import', { path: big }).catch(() => {});
    c.close();
    const q = h.runner.importQuota as unknown as { running: Set<string>; spent: unknown[] };
    await patiently(() => q.spent.length === 1 && q.running.size === 0);
    await patiently(() => inbox(h.home).length === 0);
    assert.equal(q.spent.length, 1, 'it ran, and stays counted');
  } finally {
    await server.close();
  }
});
