// Every spec and tool that gives the app a web runtime puts it under
// runtimeParent() (features/support/web-runtime.ts), not straight in the temp
// folder. remote.sh's temp folder is on Tinker Desk's external SSD, and
// Chromium's helpers, run from there, asked macOS for that disk on every new
// build with nobody at the screen to answer; the prompt held Desk Runner's
// own reads too, so --desk runs stopped (19 Nov). remote.sh points
// THREADBEAR_WEB_RUNTIME_PARENT at the home disk instead.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full);
    return /\.(ts|mjs)$/.test(entry.name) ? [full] : [];
  });
}

test('every web runtime the specs and tools make goes under runtimeParent()', () => {
  const offenders: string[] = [];
  for (const file of sources(path.join(root, 'features'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/THREADBEAR_WEB_RUNTIME_DIR\s*=/.test(text)) continue;
    if (!text.includes('runtimeParent()')) offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, [], 'these set THREADBEAR_WEB_RUNTIME_DIR without runtimeParent() from features/support/web-runtime.ts');
});

test('remote.sh keeps the web runtimes off the folder its temp files go in', () => {
  const remote = fs.readFileSync(path.join(root, 'desktop/scripts/remote.sh'), 'utf8');
  const parent = /export THREADBEAR_WEB_RUNTIME_PARENT="([^"]+)"/.exec(remote)?.[1];
  assert.ok(parent, 'remote.sh no longer sets THREADBEAR_WEB_RUNTIME_PARENT');
  assert.ok(!parent.includes('$base') && !parent.includes('/gpui/'), `the web runtimes are under the build volume again: ${parent}`);
});
