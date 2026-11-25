// Fetches the box image's Debian packages (box/Dockerfile) exactly as
// box/debs.lock names them: each file is downloaded, its size and SHA-256
// checked against the lock, and only once every one has checked out are they
// written for dpkg to install. A file that doesn't match stops the build
// before any package's scripts run, wherever it came from: Debian's dated
// snapshot first (snapshot.debian.org, which keeps every file it ever
// published), then deb.debian.org, which has it until a newer version
// replaces it. So no archive, mirror or signing key decides what's in a box,
// only the committed lock (Daybreak, 24 Nov). box/lock-debs.sh moves it on.
//
//   node box/debs.ts <debs.lock> <out dir>
//   node box/debs.ts --installed <debs.lock>   (after dpkg -i: what dpkg has)
//
// No packages here: Node's own fetch (and its own CA list, as the base image
// has no ca-certificates yet) and crypto.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Deb = { name: string; version: string; arch: string; size: number; sha256: string; archive: string; pool: string };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const NAME = /^[a-z0-9][a-z0-9+.-]*$/;
const VERSION = /^[A-Za-z0-9.+~:-]+$/;
const POOL = /^pool\/[A-Za-z0-9/._%+~-]+\.deb$/;

// The lock's packages, and its snapshot. Throws on anything not in the
// lock's own form, so a hand edit can't slip a URL or a path in.
export function readLock(text: string): { snapshot: string; packages: Deb[] } {
  let snapshot: string | undefined;
  const packages: Deb[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = /^# snapshot: (\d{8}T\d{6}Z)$/.exec(line);
      if (m) snapshot = m[1];
      continue;
    }
    const [name, version, arch, size, sha256, archive, pool, ...rest] = line.split(' ');
    if (
      rest.length ||
      !NAME.test(name ?? '') ||
      !VERSION.test(version ?? '') ||
      !['amd64', 'all'].includes(arch ?? '') ||
      !/^\d{1,9}$/.test(size ?? '') ||
      !/^[0-9a-f]{64}$/.test(sha256 ?? '') ||
      !['debian', 'debian-security'].includes(archive ?? '') ||
      !POOL.test(pool ?? '') ||
      pool!.includes('..')
    ) {
      throw new Error(`debs.lock: not a package line: ${line}`);
    }
    packages.push({ name: name!, version: version!, arch: arch!, size: Number(size), sha256: sha256!, archive: archive!, pool: pool! });
  }
  if (!snapshot) throw new Error('debs.lock: no "# snapshot:" line');
  if (!packages.length) throw new Error('debs.lock: no packages');
  if (new Set(packages.map((p) => p.name)).size !== packages.length) throw new Error('debs.lock: a package named twice');
  return { snapshot, packages };
}

export function sourcesOf(pkg: Deb, snapshot: string): string[] {
  return [`https://snapshot.debian.org/archive/${pkg.archive}/${snapshot}/${pkg.pool}`, `https://deb.debian.org/${pkg.archive}/${pkg.pool}`];
}

// One package's bytes, from the first source that has exactly them. A
// request has a deadline, and a body is read only up to the lock's size, so
// a source that stalls or sends more than the file can't hold the build up
// or fill its memory (Gemini's review). snapshot.debian.org is often slow to
// answer, so a busy reply is tried again with a growing wait (its
// Retry-After, up to a minute) before the next source.
const ATTEMPTS = 6;
const REQUEST_MS = 120_000;

async function readCapped(res: Response, max: number): Promise<Buffer | undefined> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) return undefined;
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const parts: Buffer[] = [];
  let length = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) {
      await reader.cancel();
      return undefined;
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

async function fetchOne(pkg: Deb, snapshot: string, fetchImpl: Fetch, log: (s: string) => void, waitMs: (ms: number) => Promise<void>): Promise<Buffer> {
  const problems: string[] = [];
  for (const url of sourcesOf(pkg, snapshot)) {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      let wait = Math.min(60_000, 1000 * 2 ** (attempt - 1));
      try {
        const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(REQUEST_MS) });
        if (!res.ok) {
          problems.push(`${url}: HTTP ${res.status}`);
          if (res.status === 404 || res.status === 410) break;
          const after = Number(res.headers.get('retry-after'));
          if (Number.isFinite(after) && after > 0) wait = Math.min(60_000, after * 1000);
          if (attempt < ATTEMPTS) await waitMs(wait);
          continue;
        }
        const bytes = await readCapped(res, pkg.size);
        const sum = bytes && crypto.createHash('sha256').update(bytes).digest('hex');
        if (!bytes || bytes.length !== pkg.size || sum !== pkg.sha256) {
          // Not what the lock says: never used, and no retry makes it so.
          problems.push(`${url}: ${bytes ? `${bytes.length} bytes with SHA-256 ${sum}` : `more than ${pkg.size} bytes`}, not the lock's ${pkg.size} bytes with ${pkg.sha256}`);
          break;
        }
        return bytes;
      } catch (e) {
        problems.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
        if (attempt < ATTEMPTS) await waitMs(wait);
      }
    }
  }
  log(problems.join('\n'));
  throw new Error(`${pkg.name} ${pkg.version}: no source had the file debs.lock names`);
}

// Downloads and checks every package, then writes them all to `outDir`, so
// nothing is there to install unless every one matched.
export async function fetchDebs(
  lockText: string,
  outDir: string,
  {
    fetchImpl = fetch as Fetch,
    log = (s: string) => console.error(s),
    waitMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: { fetchImpl?: Fetch; log?: (s: string) => void; waitMs?: (ms: number) => Promise<void> } = {},
): Promise<Deb[]> {
  const { snapshot, packages } = readLock(lockText);
  const got: [Deb, Buffer][] = [];
  for (const pkg of packages) got.push([pkg, await fetchOne(pkg, snapshot, fetchImpl, log, waitMs)]);
  fs.mkdirSync(outDir, { recursive: true });
  for (const [pkg, bytes] of got) fs.writeFileSync(path.join(outDir, `${pkg.name}_${pkg.arch}.deb`), bytes, { flag: 'wx' });
  return packages;
}

// Each locked package as dpkg now has it: name, version and architecture
// exactly the lock's, after the install (the image's record of what's in it).
export function checkInstalled(lockText: string, query: (names: string[]) => string): void {
  const { packages } = readLock(lockText);
  const have = new Map(
    query(packages.map((p) => p.name))
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, version, arch] = line.split(' ');
        return [name!, `${version} ${arch}`] as const;
      }),
  );
  const wrong = packages.filter((p) => have.get(p.name) !== `${p.version} ${p.arch}`);
  if (wrong.length) throw new Error(`dpkg doesn't have these as debs.lock names them: ${wrong.map((p) => `${p.name} ${p.version} ${p.arch} (has ${have.get(p.name) ?? 'none'})`).join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [first, second] = process.argv.slice(2);
  if (first === '--installed' && second) {
    const { execFileSync } = await import('node:child_process');
    checkInstalled(fs.readFileSync(second, 'utf8'), (names) => execFileSync('dpkg-query', ['-W', '-f=${Package} ${Version} ${Architecture}\n', ...names], { encoding: 'utf8' }));
    console.log('debs.ts: every package installed as debs.lock names it');
  } else if (first && second) {
    const packages = await fetchDebs(fs.readFileSync(first, 'utf8'), second);
    console.log(`debs.ts: ${packages.length} packages, each as debs.lock names it`);
  } else {
    console.error('usage: node debs.ts <debs.lock> <out dir> | node debs.ts --installed <debs.lock>');
    process.exit(2);
  }
}
