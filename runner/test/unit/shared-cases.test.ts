// shared/cases holds one file of cases per rule that each app writes its own
// copy of (draft blocks, link policy, inbox urgency...), and every app the
// file names runs every case (shared/cases/README.md). This checks the files
// are well formed, and that each is read by a test on exactly the apps it
// claims: a file read by one app only, without saying so, guards nothing
// (the review of 20 Nov 2026 found the same rules kept in step by hand).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CASES = path.join(ROOT, 'shared/cases');

// Where each app's tests live, and which files there are tests.
const PLATFORMS: Record<string, { roots: string[]; isTest: (file: string) => boolean }> = {
  desktop: { roots: ['desktop/core'], isTest: (f) => f.endsWith('.rs') },
  ios: { roots: ['ios/ThreadbearKit/Tests'], isTest: (f) => f.endsWith('.swift') },
  android: { roots: ['android-native/kit/src/test'], isTest: (f) => f.endsWith('.kt') },
  web: { roots: ['web/src'], isTest: (f) => f.endsWith('.test.ts') },
  mac: { roots: ['app/Tests'], isTest: (f) => f.endsWith('.swift') },
  // The runner works some states out for the apps (wait-states.json). Its
  // tests about check hosts and CI paths name case files only as paths.
  runner: { roots: ['runner/test'], isTest: (f) => f.endsWith('.test.ts') && !/(check-cache|desktop-ci-paths|shared-cases)\.test\.ts$/.test(f) },
};

type CaseFile = { about: unknown; platforms: unknown; cases: unknown };

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'target' || e.name === 'build' || e.name === '.build' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function caseFiles(): string[] {
  return fs.readdirSync(CASES).filter((f) => f.endsWith('.json')).sort();
}

function load(file: string): CaseFile {
  return JSON.parse(fs.readFileSync(path.join(CASES, file), 'utf8')) as CaseFile;
}

// The case files an app's tests name in a string ("shared/cases/x.json",
// after a quote or a slash), not in a comment.
function namedBy(platform: string): Set<string> {
  const { roots, isTest } = PLATFORMS[platform];
  const found = new Set<string>();
  for (const root of roots) {
    for (const file of walk(path.join(ROOT, root)).filter(isTest)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/["'/]shared\/cases\/([a-z0-9-]+\.json)["']/g)) found.add(m[1]);
    }
  }
  return found;
}

test('there are case files, and each is well formed', () => {
  const files = caseFiles();
  assert.ok(files.includes('inbox-urgency.json'), 'the scan finds the first one');
  for (const file of files) {
    const f = load(file);
    assert.equal(typeof f.about, 'string', `${file}: about`);
    assert.ok(Array.isArray(f.platforms) && f.platforms.length > 0, `${file}: platforms`);
    const platforms = f.platforms as string[];
    for (const p of platforms) assert.ok(p in PLATFORMS, `${file}: unknown platform ${p}`);
    assert.ok(Array.isArray(f.cases) && f.cases.length > 0, `${file}: cases`);
    const names = new Set<string>();
    for (const c of f.cases as Record<string, unknown>[]) {
      assert.equal(typeof c.name, 'string', `${file}: every case has a name`);
      const name = c.name as string;
      assert.ok(!names.has(name), `${file}: two cases are called "${name}"`);
      names.add(name);
      if (c.differs === undefined) continue;
      assert.ok(c.differs && typeof c.differs === 'object', `${file}: "${name}" differs is an object`);
      for (const [p, why] of Object.entries(c.differs as Record<string, unknown>)) {
        assert.ok(platforms.includes(p), `${file}: "${name}" differs on ${p}, which the file doesn't name`);
        assert.ok(typeof why === 'string' && why.trim().length > 0, `${file}: "${name}" says why it differs on ${p}`);
      }
      assert.ok(Object.keys(c.differs as object).length < platforms.length, `${file}: "${name}" differs everywhere`);
    }
  }
});

test('each case file is read by a test on exactly the apps it names', () => {
  const files = caseFiles();
  const problems: string[] = [];
  for (const platform of Object.keys(PLATFORMS)) {
    const named = namedBy(platform);
    for (const file of files) {
      const claims = (load(file).platforms as string[]).includes(platform);
      if (claims && !named.has(file)) problems.push(`${file} names ${platform}, but no ${platform} test reads shared/cases/${file}`);
      if (!claims && named.has(file)) problems.push(`a ${platform} test reads ${file}, which doesn't name ${platform} in platforms`);
    }
    for (const file of named) {
      if (!files.includes(file)) problems.push(`a ${platform} test reads shared/cases/${file}, which isn't there`);
    }
  }
  assert.deepEqual(problems, []);
});

test('known differences are counted', (t) => {
  const counts: Record<string, number> = {};
  for (const file of caseFiles()) {
    for (const c of load(file).cases as { differs?: Record<string, string> }[]) {
      for (const p of Object.keys(c.differs ?? {})) counts[p] = (counts[p] ?? 0) + 1;
    }
  }
  t.diagnostic(`known differences: ${JSON.stringify(counts)}`);
});
