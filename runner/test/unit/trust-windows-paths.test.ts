// The trust checks' Windows path spellings: an NTFS stream or trailing dot
// naming the same new file (code-writes.ts, 18 Nov 2026), and a drive path
// naming a script (script-trust.ts). Most of these only run on Windows.
//
// They were in agent-write-trust and patch-hash-binding, which are on
// test/windows-known-failing.txt, so on Windows they only ran as a report
// that never fails the run (and timed out before reaching them), and
// everywhere else they're skipped: no CI could ever fail on them. This file
// isn't on that list, so the Windows job must pass it. Keep it that way:
// only what passes on Windows goes here, and nothing that needs a shell,
// a fake runner or a CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { IS_WINDOWS, onlyOnWindows } from '../helpers/platform.ts';
import { canonicalPath, runsAsCodeByName, windowsFileName } from '../../src/code-writes.ts';
import { namedPaths, PatchTrust, scanModule } from '../../src/patch-trust.ts';
import { reachOf } from '../../src/script-trust.ts';

// Files under `folder`, made with their folders, each with a later mtime, or
// the hash cache keeps the old version.
function put(folder: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(folder, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const later = new Date(Date.now() + Math.random() * 1000 + 1000);
    fs.utimesSync(file, later, later);
    // Windows scans a file the first time it is read after it is written.
    if (IS_WINDOWS) fs.readFileSync(file);
  }
}

// NTFS reads more than one spelling as the same new file, so a write to
// `evil.ts::$DATA` made the real evil.ts while the name check saw something
// else (the Windows port's review).
test('windowsFileName: the stream, trailing dots and spaces NTFS drops from a name, whatever platform asks', () => {
  const same = (given: string, want: string) => assert.equal(windowsFileName(given), want, given);
  same('C:\\p\\.threadbear\\patches\\evil.ts::$DATA', 'C:\\p\\.threadbear\\patches\\evil.ts');
  same('C:\\p\\.threadbear\\patches\\evil.ts::$data', 'C:\\p\\.threadbear\\patches\\evil.ts');
  same('C:\\p\\.threadbear\\patches\\evil.ts:stream', 'C:\\p\\.threadbear\\patches\\evil.ts');
  same('C:\\p\\.threadbear\\patches\\evil.ts:stream:$DATA', 'C:\\p\\.threadbear\\patches\\evil.ts');
  same('C:\\p\\.claude\\settings.json::$DATA', 'C:\\p\\.claude\\settings.json');
  same('C:\\p\\.mcp.json::$DATA', 'C:\\p\\.mcp.json');
  same('C:\\p\\.threadbear\\patches\\evil.ts.', 'C:\\p\\.threadbear\\patches\\evil.ts');
  same('C:\\p\\.threadbear\\patches\\evil.ts ', 'C:\\p\\.threadbear\\patches\\evil.ts');
  same('C:\\p\\.threadbear\\patches\\evil.ts. . ', 'C:\\p\\.threadbear\\patches\\evil.ts');
  same('C:\\p\\.threadbear\\patches\\evil.ts.::$DATA', 'C:\\p\\.threadbear\\patches\\evil.ts');
  same('C:\\p\\.threadbear::$INDEX_ALLOCATION\\patches\\evil.ts', 'C:\\p\\.threadbear\\patches\\evil.ts');
  same('C:\\p\\.threadbear.\\patches \\evil.ts', 'C:\\p\\.threadbear\\patches\\evil.ts');
  same('C:/p/.threadbear/patches/evil.ts::$DATA', 'C:\\p\\.threadbear\\patches\\evil.ts');
  // The drive stays, also after \\?\, and . and .. are left for the path to settle.
  same('\\\\?\\C:\\p\\.mcp.json::$DATA', '\\\\?\\C:\\p\\.mcp.json');
  same('C:\\p\\.\\q\\..\\.mcp.json', 'C:\\p\\.\\q\\..\\.mcp.json');
  same('C:\\p\\.mcp.json', 'C:\\p\\.mcp.json');
  same('C:\\p\\', 'C:\\p\\');
  same('evil.ts::$DATA', 'evil.ts');
});

test('a write to a new file spelt as an NTFS stream or with a trailing dot is still code by its name (Windows)', onlyOnWindows('NTFS names are Windows only'), () => {
  const home = tmpDir();
  const project = tmpDir();
  for (const dir of [path.join(project, '.threadbear', 'patches'), path.join(project, '.claude'), path.join(home, '.threadbear')]) fs.mkdirSync(dir, { recursive: true });
  const spellings = (file: string) => [`${file}::$DATA`, `${file}::$data`, `${file}.`, `${file} `, `${file}. `, `${file}.::$DATA`];
  for (const file of [path.join(project, '.threadbear', 'patches', 'evil.ts'), path.join(project, '.threadbear', 'patches', 'evil.mjs'), path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json'), path.join(project, '.mcp.json'), path.join(home, '.threadbear', 'x.json')]) {
    assert.ok(runsAsCodeByName(file, home), `${file}, plainly`);
    for (const spelt of spellings(file)) assert.ok(runsAsCodeByName(spelt, home), spelt);
  }
  // A directory spelt the same way, and a name that only looks like one.
  assert.ok(runsAsCodeByName(path.join(project, '.threadbear::$INDEX_ALLOCATION', 'patches', 'evil.ts'), home));
  assert.ok(runsAsCodeByName(path.join(project, '.threadbear', 'patches. ', 'evil.ts'), home));
  assert.ok(!runsAsCodeByName(`${path.join(project, 'src', 'index.ts')}::$DATA`, home));
  assert.ok(!runsAsCodeByName(`${path.join(project, '.threadbear', 'patches', 'notes.md')}::$DATA`, home));
  assert.ok(!runsAsCodeByName(`${path.join(project, '.threadbear', 'patches', 'evil.ts.bak')}. `, home));
  // The real thing: writing through the stream spelling makes the real patch, and the name check agrees it's one.
  const spelt = `${path.join(project, '.threadbear', 'patches', 'made.ts')}::$DATA`;
  fs.writeFileSync(spelt, 'export default {};\n');
  assert.ok(fs.existsSync(path.join(project, '.threadbear', 'patches', 'made.ts')), 'the stream spelling made made.ts');
  assert.ok(runsAsCodeByName(spelt, home));
});

test("a script a hashed patch names that isn't there yet is covered when it's written by its stream spelling too (Windows)", onlyOnWindows('NTFS names are Windows only'), async () => {
  const folder = path.join(tmpDir(), 'app');
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  put(folder, { '.threadbear/patches/p.ts': "export default { actions: [{ title: 'Go', run: './scripts/new.sh' }] };\n" });
  const patch = path.join(folder, '.threadbear', 'patches', 'p.ts');
  const trust = new PatchTrust();
  trust.trustCurrent([patch]);
  await trust.check(patch, 0);
  const made = path.join(folder, 'scripts', 'new.sh');
  assert.equal(trust.covers(canonicalPath(made)), true, 'by its name');
  for (const spelt of [`${made}::$DATA`, `${made}.`, `${made} `]) {
    assert.equal(canonicalPath(spelt), canonicalPath(made), spelt);
    assert.equal(trust.covers(canonicalPath(spelt)), true, spelt);
  }
  assert.equal(trust.covers(canonicalPath(`${path.join(folder, 'scripts', 'other.sh')}::$DATA`)), false);
});

// Codex's review, 18 Nov 2026.
test("a write to a named stream asks on Windows, whatever the file's called", onlyOnWindows('Windows streams'), () => {
  assert.equal(runsAsCodeByName('C:\\work\\proj\\container.dat:task.js'), true);
  assert.equal(runsAsCodeByName('C:\\work\\proj\\notes.txt'), false);
});

// A Windows path has no /, so a command named by one was not taken for a path
// and the script it names was never hashed: a trusted patch could run it changed.
test('Windows: a single-quoted drive path to a script in the repo is followed, as ./x.sh is', onlyOnWindows('a Windows path'), () => {
  const folder = fs.realpathSync(tmpDir());
  const evil = path.join(folder, 'tools', 'evil.sh');
  put(folder, { 'tools/evil.sh': '#!/bin/sh\necho hi\n', 'run.sh': `#!/bin/sh\n'${evil}'\n` });
  // Follow options as patchHash gives them, for script-trust on its own.
  const reach = reachOf(path.join(folder, 'run.sh'), {
    folder,
    top: folder,
    scanJs: (src: string, file: string) => {
      const s = scanModule(src, file);
      return { specifiers: s.specifiers, strings: s.strings, ...(s.problem ? { problem: s.problem.code } : {}) };
    },
    resolveImport: (dir: string, spec: string) => path.resolve(dir, spec),
    namedPaths,
  });
  assert.ok(reach.files.some((f) => f.split(path.sep).join('/').endsWith('tools/evil.sh')), `evil.sh should be hashed: ${JSON.stringify(reach)}`);
});
