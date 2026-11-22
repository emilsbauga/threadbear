// scripts/fix-link-kinds.sh: before rsync copies a checkout over an older
// copy of it, a path that became a link (the Swift app's Resources/Art, 21 Nov 2026)
// or stopped being one (the iPhone kit's Swift files) is taken out of the
// copy, as macOS's rsync can't swap those over itself.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { testSkippedOnWindows } from '../helpers/platform.ts';

const test = testSkippedOnWindows('it fixes copies on the Mac and Linux check hosts, with links and bash');

const SCRIPT = path.resolve(import.meta.dirname, '../../../scripts/fix-link-kinds.sh');

test('a folder that became a link, and a link that became a file, are taken out of the old copy', () => {
  const root = tmpDir();
  const put = (p: string, text = 'x\n') => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  };
  const link = (to: string, at: string) => {
    fs.mkdirSync(path.dirname(path.join(root, at)), { recursive: true });
    fs.symlinkSync(to, path.join(root, at));
  };
  // The checkout now.
  put('new/mock-runner/server.mjs');
  link('../../mock-runner', 'new/app/Tools/mock-runner');
  put('new/ios/Kit.swift');
  link('../ios/Kit.swift', 'new/app/Kit.swift');
  link('same.txt', 'new/kept');
  // Its old copy.
  put('old/app/Tools/mock-runner/server.mjs');
  put('old/app/Tools/mock-runner/node_modules/ws/index.js');
  link('../app/Kit.swift', 'old/ios/Kit.swift');
  put('old/app/Kit.swift');
  link('same.txt', 'old/kept');
  put('old/untouched.txt', 'still here\n');
  link('../x', 'old/desktop/node_modules');

  const links = execFileSync('bash', [SCRIPT, '--links', path.join(root, 'new')], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(links, ['app/Kit.swift', 'app/Tools/mock-runner', 'kept']);
  execFileSync('bash', [SCRIPT, path.join(root, 'old'), ...links]);

  const old = (p: string) => path.join(root, 'old', p);
  assert.ok(!fs.existsSync(old('app/Tools/mock-runner')), 'the folder that became a link');
  assert.ok(!fs.existsSync(old('ios/Kit.swift')) && !isLink(old('ios/Kit.swift')), 'the link that became a file');
  assert.ok(!fs.existsSync(old('app/Kit.swift')), 'a file that became a link');
  assert.ok(isLink(old('kept')), 'a link that is still one');
  assert.equal(fs.readFileSync(old('untouched.txt'), 'utf8'), 'still here\n');
  assert.ok(isLink(old('desktop/node_modules')), "what rsync leaves out, it leaves too");
});

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
