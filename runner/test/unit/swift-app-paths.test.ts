// The frozen Swift Mac app (app/, and BearDock in dock/) is to be deleted in
// one `git rm` (docs/gpui-port.md, "Deleting the Swift app"). Until 21 Nov
// 2026 live things reached into it: the desktop app's tests ran its mock
// runner, the GPUI app built in its art and Pele, the iPhone kit linked its
// Swift files. Those moved out (mock-runner/, shared/, features/tools,
// ios/), and the Swift app points out at them now, not the other way round.
//
// This keeps it that way: it fails when a file outside app/ and dock/ names a
// real path inside them (in code, a script, a workflow, a config file, or a
// link), so deleting them can't break something else. Prose isn't checked
// (Markdown, HTML, comments): a doc or comment about the Swift app is about
// it, not a use of it. ALLOWED is what still has to point there until the
// Swift app goes, each with why: the to-do list for deletion day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SELF = path.relative(ROOT, import.meta.filename).split(path.sep).join('/');

// Where each moved on 21 Nov 2026. git's rename detection carries a branch's
// edits to the files across, but a file it adds in a new folder (a new demo
// fixture) stays where it was made, silently, where nothing reads it.
const MOVED: Record<string, string> = {
  'app/Tools/mock-runner/': 'mock-runner/',
  'app/Tools/droptarget.swift': 'features/tools/droptarget.swift',
  'app/Tools/post-gesture.swift': 'features/tools/post-gesture.swift',
  'app/Tools/realdrag.swift': 'features/tools/realdrag.swift',
};

// file → why it still names the Swift app's folders. Deletion day: each of
// these changes or goes with them.
const ALLOWED: Record<string, string> = {
  'check.sh': "builds and tests the Swift app (its steps, swift_needed's app/ and dock/)",
  'scripts/swift-freeze.sh': 'the freeze itself: what in app/ stays open',
  'runner/test/unit/swift-freeze.test.ts': "the freeze's tests",
  'runner/test/unit/check-mock-swift-tests.test.ts': 'tests check.sh running the Swift tests of the mock runner',
  'runner/test/unit/check-remote-room.test.ts': 'tests check-remote.sh sending Swift changes to a Mac',
  '.github/workflows/xcode-26.yml': 'builds the Swift app on Xcode 26 (its path filter and package cache key)',
  'threadbear': 'hands the Swift-only commands (restart, mock, perf, stop) to app/threadbear while it exists',
  'runner/launcher/build-launcher.sh': "the runner launcher's icon, through app/icons; repointing it to shared/icons changes the launcher's source hash and rebuilds and re-signs it for everyone, so it goes with the next launcher change or on deletion day",
  'features/support/swift.ts': 'drives the Swift app for its specs (@swift-pending) through app/Tools/dev-app.sh',
  'features/tools/motion-clip.ts': "records the Swift app's motion through app/Tools/dev-app.sh",
  'site/scripts/clips.mjs': "films the site's clips in the Swift app (app/Tools/dev-app.sh), until they're filmed in the desktop app",
  'runner/test/unit/perf-swift.test.ts': "tests the Swift app's perf runs",
  'runner/test/unit/dev-app-reap.test.ts': "tests the Swift app's dev-app.sh",
  'runner/test/unit/fork-view.test.ts': "reads the Swift app's sources for the fork view's checks",
  'runner/test/unit/shared-cases.test.ts': 'the Swift app (mac) is one of the apps a shared case can name',
  'runner/test/unit/reviews.test.ts': "checks the Swift app's design review decoder against the protocol",
  'eslint.config.mjs': "lint leaves the Swift app's folders alone",
};

// Text that only looks like a use: sample paths in tests and data, and old
// paths that are history. Each is the one file and path, so a real use
// elsewhere in the same file still counts.
const LOOKALIKES: Record<string, string[]> = {
  'desktop/core/src/file_refs.rs': ['app/Sources/.'],
  'desktop/scripts/make-bundle.sh': ['app/Resources/Info.plist'],
  'mock-runner/server.mjs': ['app/icons/threadbear.png'],
  'runner/test/fixtures/pool-folder-cases.json': ['app/Tests/Fixtures'],
  'runner/test/unit/agent-write-trust.test.ts': ['app/Sources/ThreadbearCore/Protocol/Models.swift'],
  'runner/test/unit/project-icons.test.ts': ['app/icons/threadbear.png'],
  // A fork's checkout from before the move, found by its old mock runner.
  'runner/src/tb-dev.ts': ['app/Tools/mock-runner/server.mjs'],
  'runner/test/unit/tb-dev.test.ts': ['app/Tools/mock-runner', 'app/Tools/mock-runner/server.mjs'],
  'runner/test/unit/fix-link-kinds.test.ts': ['app/Tools/mock-runner'],
  'runner/test/unit/swift-changes.test.ts': ['app/Tools/mock-runner/server.mjs', 'app/Tools/realdrag.swift', 'app/Sources/Threadbear/Resources/Art/librarian.png', 'app/Sources/Threadbear/Resources/Rich/pele.js'],
  'site/scripts/clips/turns.json': ['app/Sources'],
};

// Paths an app/ or dock/ reference may start from: the top of the repo, the
// file's own folder through ../, or a variable holding either ($ROOT/app).
// Not one inside another folder (android-native/app/, desktop/dock/), nor
// an absolute path (another machine's /app/).
const REF = /(?<![\w.@/-])((?:\$\{?\w+\}?\/)?(?:\.\.\/)*)(app|dock)\/([\w.@*-]+(?:\/[\w.@*-]+)*)/g;
// path.join(root, 'app', 'Tools', 'dev-app.sh') and the like.
const JOINED = /(['"])(app|dock)\1((?:\s*,\s*(['"])[\w.@-]+\4)+)/g;
const PROSE = /\.(md|html|txt|svg|png|jpg|jpeg|gif|pdf|mp4|mov|webm|ico|icns|ttf|woff2?|lock)$/i;

// What git has: the files and links outside app/ and dock/ to scan, and
// every path inside them (folders too) and the links there, to check a
// reference against. Git's, not the disk's: a build folder isn't a use, and
// the disk's app/readme.md is app/README.md on a Mac.
// links: each link outside app/ and dock/, and where it points, from git (a
// Windows checkout may write one as a file, a link or a copy).
type Tracked = { files: string[]; links: Map<string, string>; inside: Set<string>; insideLinks: Set<string> };
let cached: Tracked | undefined;
function tracked(): Tracked {
  if (cached) return cached;
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const t: Tracked = { files: [], links: new Map(), inside: new Set(), insideLinks: new Set() };
  const linkBlobs: [string, string][] = [];
  for (const entry of out.split('\0').filter(Boolean)) {
    const file = entry.slice(entry.indexOf('\t') + 1);
    const link = entry.startsWith('120000 ');
    if (/^(app|dock)\//.test(file)) {
      if (link) t.insideLinks.add(file);
      for (let p = file; p.includes('/'); p = p.slice(0, p.lastIndexOf('/'))) t.inside.add(p);
    } else if (!file.startsWith('docs/archive/') && !file.startsWith('.check-') && file !== SELF) {
      if (link) linkBlobs.push([file, entry.split(' ')[1]]);
      else t.files.push(file);
    }
  }
  if (linkBlobs.length) {
    // A link's blob is where it points: one cat-file for them all.
    const out = execFileSync('git', ['-C', ROOT, 'cat-file', '--batch'], { input: linkBlobs.map(([, blob]) => blob).join('\n') + '\n', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let at = 0;
    for (const [file] of linkBlobs) {
      const header = out.slice(at, out.indexOf('\n', at));
      const size = Number(header.split(' ')[2]);
      const start = at + header.length + 1;
      t.links.set(file, out.slice(start, start + size));
      at = start + size + 1;
    }
  }
  cached = t;
  return t;
}

// Whether the part of a line before a match is a comment: one starting the
// line, or a // or # one after code (not a ` -- ` or ` * `, which are code).
function inComment(before: string): boolean {
  return /^\s*(\/\/|#|\*|\/\*|<!--)/.test(before) || /(^|\s)(\/\/|#)(\s|$)/.test(before);
}

// A real path in app/ or dock/ (a glob's fixed part; anything under one of
// app/'s links to what moved out counts, as it goes through app/), or
// undefined.
function real(top: string, rest: string): string | undefined {
  const parts = rest.split('/');
  const glob = parts.findIndex((p) => p.includes('*'));
  const fixed = [top, ...(glob < 0 ? parts : parts.slice(0, glob))];
  if (fixed.some((p) => p === '.' || p === '..' || p === '')) return undefined;
  const rel = fixed.join('/');
  // An old home of something that moved out, which is gone now.
  if (Object.keys(MOVED).some((from) => (from.endsWith('/') ? `${rel}/`.startsWith(from) : rel === from))) return rel;
  const { inside, insideLinks } = tracked();
  for (let n = 2; n <= fixed.length; n++) {
    if (insideLinks.has(fixed.slice(0, n).join('/'))) return fixed.join('/');
  }
  return inside.has(rel) || (fixed.length === 1 && inside.size > 0) ? rel : undefined;
}

function references(file: string): string[] {
  if (PROSE.test(file)) return [];
  let text: string;
  try {
    text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return [];
  }
  if (text.includes('\0')) return [];
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(REF)) {
      if (inComment(line.slice(0, m.index))) continue;
      const hit = real(m[2], m[3]);
      if (hit) found.add(hit);
    }
    for (const m of line.matchAll(JOINED)) {
      if (inComment(line.slice(0, m.index))) continue;
      const parts = [...m[3].matchAll(/(['"])([\w.@-]+)\1/g)].map((p) => p[2]);
      const hit = real(m[2], parts.join('/'));
      if (hit) found.add(hit);
    }
  }
  return [...found];
}

function scan(): Map<string, string[]> {
  const { files, links } = tracked();
  const hits = new Map<string, string[]>();
  for (const file of files) {
    const refs = references(file).filter((r) => !LOOKALIKES[file]?.includes(r));
    if (refs.length) hits.set(file, refs);
  }
  for (const [link, target] of links) {
    // A Windows checkout writes a link as a file holding where it points.
    const to = path.posix.normalize(path.posix.join(path.posix.dirname(link), target));
    if (/^(app|dock)\//.test(to)) hits.set(link, [to]);
  }
  return hits;
}

test('nothing outside app/ and dock/ uses a path inside them, but what ALLOWED says', () => {
  const hits = scan();
  const unlisted = [...hits].filter(([file]) => !(file in ALLOWED)).map(([file, refs]) => `  ${file}: ${refs.join(', ')}`);
  assert.equal(unlisted.length, 0, `These use the frozen Swift app's folders, which are to be deleted (docs/gpui-port.md, "Deleting the Swift app"):
${unlisted.join('\n')}
Don't reach into app/ or dock/ from outside. Something more than one app uses goes in a neutral home, and the Swift app links to it there if it needs it too:
the mock runner in mock-runner/, pictures, Pele and the icon in shared/ (shared/README.md), the real-screen test tools in features/tools, the iPhone kit's Swift in ios/ThreadbearKit.
Only something that's about the Swift app itself (building, testing or driving it) goes in ALLOWED in ${SELF}, with why.`);
});

test('everything in ALLOWED still uses them, so the list is exactly what deletion day has to change', () => {
  const hits = scan();
  const stale = Object.keys(ALLOWED).filter((file) => !hits.has(file));
  assert.deepEqual(stale, [], 'These no longer name app/ or dock/: take them out of ALLOWED');
});

test('nothing is left in the old homes of what moved out of app/', () => {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', 'app/Tools'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const left = out.flatMap((f) => Object.entries(MOVED).filter(([from]) => from.endsWith('/') ? f.startsWith(from) : f === from).map(([from, to]) => `  git mv ${f} ${to}${f.slice(from.length)}`));
  assert.deepEqual(left, [], `These are where something used to be before it moved out of the frozen Swift app (21 Nov 2026), likely brought by a rebase. Move them (mkdir -p a new folder first):\n${left.join('\n')}`);
});

test('the scan finds a use, and passes over prose and lookalikes', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.swift-app-paths-'));
  try {
    const rel = path.relative(ROOT, dir);
    const put = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
    put('a.ts', "spawn(path.join(root, 'app/Tools/dev-app.sh'));\nconst x = path.join(root, 'app', 'Package.swift');\n");
    put('b.sh', 'node "$ROOT/app/Package.swift"\n# app/Package.swift in a comment\n');
    put('c.md', 'Run `app/Tools/dev-app.sh`.\n');
    put('d.ts', "const fake = 'app/Nothing/here.swift'; const kt = 'android-native/app/src/main';\n");
    assert.deepEqual(references(`${rel}/a.ts`).sort(), ['app/Package.swift', 'app/Tools/dev-app.sh']);
    assert.deepEqual(references(`${rel}/b.sh`), ['app/Package.swift']);
    assert.deepEqual(references(`${rel}/c.md`), []);
    assert.deepEqual(references(`${rel}/d.ts`), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
