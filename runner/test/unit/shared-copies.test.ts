// Files in shared/ that an app's build can't take from there, so it keeps a
// copy of its own (shared/README.md): Pele, the diagram library, is in the
// iPhone app's synchronized Xcode folder and the Android app's assets as
// real files. The desktop app and the frozen Swift Mac app build it in from
// shared/rich. Each copy must be the same bytes, or the apps draw diagrams
// differently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');

const COPIES: Record<string, string[]> = {
  'shared/rich/pele.js': ['ios/Threadbear/Rich/pele.js', 'android-native/app/src/main/assets/pele.js'],
  'shared/rich/pele-LICENSE.txt': ['ios/Threadbear/Rich/pele-LICENSE.txt', 'android-native/app/src/main/assets/pele-LICENSE.txt'],
};

test("each app's copy of a shared file is the same as shared/'s", () => {
  for (const [source, copies] of Object.entries(COPIES)) {
    const want = fs.readFileSync(path.join(ROOT, source));
    for (const copy of copies) {
      assert.ok(fs.readFileSync(path.join(ROOT, copy)).equals(want), `${copy} differs from ${source}: copy it over (cp ${source} ${copy})`);
    }
  }
});
