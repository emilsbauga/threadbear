// The box image's Debian packages come only as box/debs.lock names them,
// each file checked by its size and SHA-256 before dpkg sees any of them
// (box/debs.ts, box/Dockerfile). Daybreak, 24 Nov: "Production box images
// install mutable Debian packages without source-pinned artifacts": the
// Dockerfile ran `apt-get update && apt-get install ca-certificates git
// procps`, so rebuilding the same commit took whatever Debian's archive (or
// anyone who could sign for it) published that day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkInstalled, fetchDebs, readLock, sourcesOf } from '../../box/debs.ts';
import { tmpDir } from '../helpers/fakes.ts';

const BOX = path.join(import.meta.dirname, '..', '..', 'box');
const REPO = path.join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

test('the committed lock names every package exactly, from one snapshot, for the base image the Dockerfile pins', () => {
  const text = read(path.join(BOX, 'debs.lock'));
  const { snapshot, packages } = readLock(text);
  assert.match(snapshot, /^\d{8}T\d{6}Z$/);
  const asked = /^# packages: (.+)$/m.exec(text)![1]!.split(' ');
  for (const name of asked) assert.ok(packages.some((p) => p.name === name), `${name} is in the lock`);
  // Made against the base image the Dockerfile builds on: a new base needs a new lock.
  const base = /^# base: (.+)$/m.exec(text)![1];
  assert.equal(base, /^ARG NODE_IMAGE=(.+)$/m.exec(read(path.join(BOX, 'Dockerfile')))![1]);
  assert.match(base!, /@sha256:[0-9a-f]{64}$/);
});

test('the Dockerfile takes nothing from apt or a download that isn\'t checked against its hash', () => {
  const docker = read(path.join(BOX, 'Dockerfile'));
  const runs = docker.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(runs, /\bapt(-get)?\s+(update|install|upgrade|dist-upgrade)\b/);
  assert.doesNotMatch(runs, /\bcurl\b|\bwget\b/);
  // The lock's packages are fetched and checked, then installed, in one step.
  assert.match(runs, /RUN node \/opt\/threadbear\/box\/debs\.ts \/opt\/threadbear\/box\/debs\.lock \/tmp\/debs \\\n\s*&& dpkg -i \/tmp\/debs\/\*\.deb/);
  // Claude Code is kept only with its pinned checksum.
  assert.match(runs, /sha256sum -c -/);
  // Both files reach the build, and a change to either rebuilds the image.
  const ignore = read(path.join(REPO, 'runner', '.dockerignore'));
  for (const f of ['box/debs.lock', 'box/debs.ts']) assert.ok(ignore.includes(`!${f}\n`), f);
  const workflow = read(path.join(REPO, '.github', 'workflows', 'box-image.yml'));
  for (const f of ['runner/box/debs.lock', 'runner/box/debs.ts']) assert.ok(workflow.includes(`- '${f}'`), f);
});

function lockFor(files: Record<string, Buffer>): string {
  const lines = Object.entries(files).map(([name, bytes]) =>
    [name, '1.0-1', 'amd64', bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), 'debian', `pool/main/x/${name}/${name}_1.0-1_amd64.deb`].join(' '),
  );
  return ['# snapshot: 20261124T000000Z', ...lines, ''].join('\n');
}

test('a file that isn\'t the one the lock names stops the build before anything is written for dpkg', async () => {
  const good = { git: Buffer.from('the reviewed git'), procps: Buffer.from('the reviewed procps') };
  const lock = lockFor(good);
  const asked: string[] = [];
  // The archive now offers a different build of procps under the same name
  // (a newer version, or a compromised signer's), from every source.
  const served = (bytes: Record<string, Buffer>) => async (url: string) => {
    asked.push(url);
    const name = /pool\/main\/x\/([^/]+)\//.exec(url)![1]!;
    return new Response(new Uint8Array(bytes[name as keyof typeof bytes]!), { status: 200 });
  };
  const out = path.join(tmpDir(), 'debs');
  await assert.rejects(fetchDebs(lock, out, { fetchImpl: served({ ...good, procps: Buffer.from('a different procps') }), log: () => {}, waitMs: async () => {} }), /procps 1\.0-1: no source had the file/);
  assert.equal(fs.existsSync(out), false, 'nothing for dpkg to install');
  // Both sources were tried, and neither answer was taken.
  assert.ok(asked.some((u) => u.startsWith('https://snapshot.debian.org/archive/debian/20261124T000000Z/pool/main/x/procps/')));
  assert.ok(asked.some((u) => u.startsWith('https://deb.debian.org/debian/pool/main/x/procps/')));

  // The same lock with the reviewed files: each written, byte for byte.
  const got = await fetchDebs(lock, out, { fetchImpl: served(good), log: () => {} });
  assert.deepEqual(got.map((p) => p.name), ['git', 'procps']);
  assert.deepEqual(fs.readFileSync(path.join(out, 'procps_amd64.deb')), good.procps);
});

test('the snapshot being down falls back to deb.debian.org, still checked against the lock', async () => {
  const bytes = Buffer.from('git');
  const lock = lockFor({ git: bytes });
  const fetchImpl = async (url: string) => (url.includes('snapshot.debian.org') ? new Response('busy', { status: 503, headers: { 'retry-after': '5' } }) : new Response(new Uint8Array(bytes), { status: 200 }));
  const out = path.join(tmpDir(), 'debs');
  const waits: number[] = [];
  await fetchDebs(lock, out, { fetchImpl, log: () => {}, waitMs: async (ms) => void waits.push(ms) });
  assert.deepEqual(fs.readFileSync(path.join(out, 'git_amd64.deb')), bytes);
  // The busy snapshot was given time first, as long as it asked.
  assert.deepEqual(waits, [5000, 5000, 5000, 5000, 5000]);
});

test('a source that sends more than the locked file is cut off, not read to the end', async () => {
  const bytes = Buffer.from('git');
  const lock = lockFor({ git: bytes });
  let pulled = 0;
  const endless = () =>
    new Response(
      new ReadableStream({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(1024));
          if (pulled > 10_000) c.close();
        },
      }),
      { status: 200 },
    );
  await assert.rejects(fetchDebs(lock, path.join(tmpDir(), 'debs'), { fetchImpl: async () => endless(), log: () => {}, waitMs: async () => {} }), /no source had the file/);
  assert.ok(pulled < 10, `read ${pulled} KB of a 3-byte file`);
});

test('a lock line that names a URL, a path out of the pool or another archive is refused', () => {
  const ok = `git 1:2.47.3-0+deb13u1 amd64 10 ${'a'.repeat(64)} debian pool/main/g/git/git_2.47.3-0%2bdeb13u1_amd64.deb`;
  assert.equal(readLock(`# snapshot: 20261124T000000Z\n${ok}\n`).packages[0]!.version, '1:2.47.3-0+deb13u1');
  assert.deepEqual(sourcesOf(readLock(`# snapshot: 20261124T000000Z\n${ok}\n`).packages[0]!, '20261124T000000Z'), [
    'https://snapshot.debian.org/archive/debian/20261124T000000Z/pool/main/g/git/git_2.47.3-0%2bdeb13u1_amd64.deb',
    'https://deb.debian.org/debian/pool/main/g/git/git_2.47.3-0%2bdeb13u1_amd64.deb',
  ]);
  for (const bad of [
    ok.replace('pool/main/g/git/', 'https://evil.example/'),
    ok.replace('pool/main/g/git/', 'pool/../../x/'),
    ok.replace(' debian ', ' ubuntu '),
    ok.replace('a'.repeat(64), 'a'.repeat(63)),
    ok.replace(' amd64 ', ' arm64 '),
    `${ok} extra`,
  ]) {
    assert.throws(() => readLock(`# snapshot: 20261124T000000Z\n${bad}\n`), /not a package line/, bad);
  }
  assert.throws(() => readLock(`${ok}\n`), /no "# snapshot:" line/);
  assert.throws(() => readLock(`# snapshot: 20261124T000000Z\n${ok}\n${ok}\n`), /named twice/);
});

test("after the install, dpkg must have each locked package at its locked version", () => {
  const lock = `# snapshot: 20261124T000000Z\ngit 1:2.47.3-0+deb13u1 amd64 10 ${'a'.repeat(64)} debian pool/main/g/git/git.deb\nprocps 2:4.0.4-9 amd64 10 ${'b'.repeat(64)} debian pool/main/p/procps/procps.deb\n`;
  checkInstalled(lock, () => 'git 1:2.47.3-0+deb13u1 amd64\nprocps 2:4.0.4-9 amd64\n');
  assert.throws(() => checkInstalled(lock, () => 'git 1:2.47.4-0+deb13u1 amd64\nprocps 2:4.0.4-9 amd64\n'), /git 1:2\.47\.3-0\+deb13u1 amd64 \(has 1:2\.47\.4/);
  assert.throws(() => checkInstalled(lock, () => 'git 1:2.47.3-0+deb13u1 amd64\n'), /procps .*has none/);
});
