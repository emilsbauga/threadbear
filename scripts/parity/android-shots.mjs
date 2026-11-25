// The Android app's half of android-shots.sh, on a booted emulator with
// the debug app installed: opens each scenario's thread (paired with the
// run's backend on the first launch, AppModel.pairForParity), reads the
// screen's accessibility tree (uiautomator) until it shows the words the
// scenario must show, or 25 s, and saves a picture. Prints JSON: each
// scenario's file and the words it didn't show.
//
//   node scripts/parity/android-shots.mjs <adb> <serial> <convex url> <seed.json> <out dir>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { missingWords } from './words.mjs';

const [adb, serial, url, seedFile, out] = process.argv.slice(2);
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
const run = (args, opts = {}) => execFileSync(adb, ['-s', serial, ...args], { timeout: 30000, maxBuffer: 64 << 20, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entity = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (entity[e] ?? m)));

// The text and descriptions of everything on screen, one per line. An
// emulator slowed by other work on the host can put up "System UI isn't
// responding" over the app, and it covered every picture on 23 Nov: its
// Wait button is tapped, and the next look reads the app.
function screenText() {
  try {
    run(['shell', 'uiautomator', 'dump', '/sdcard/tb-ui.xml'], { stdio: 'ignore' });
    const xml = run(['exec-out', 'cat', '/sdcard/tb-ui.xml'], { encoding: 'utf8' });
    if (/isn(?:'|&apos;|&#39;)t responding/.test(xml)) {
      const wait = xml.match(/text="Wait"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (wait) {
        const [x1, y1, x2, y2] = wait.slice(1).map(Number);
        run(['shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1)], { stdio: 'ignore' });
        return '';
      }
    }
    return [...xml.matchAll(/\s(?:text|content-desc)="([^"]*)"/g)].map((m) => unescape(m[1])).filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

// Pair with the run's backend before opening any thread: a launch that
// pairs and opens at once can swap backends after the open was taken, and
// the first scenario's picture is then the inbox (23 Nov run).
run(['shell', 'am', 'start', '-S', '-W', '-n', 'com.mikerosoft.threadbear.android/.MainActivity',
  '--es', 'parityUrl', url, '--es', 'parityToken', seed.token], { stdio: 'ignore' });
await sleep(4000);

const results = [];
for (const [i, t] of seed.threads.entries()) {
  run(['shell', 'am', 'start', '-S', '-W', '-n', 'com.mikerosoft.threadbear.android/.MainActivity',
    '--es', 'parityUrl', url, '--es', 'parityToken', seed.token, '--es', 'threadId', t.threadId], { stdio: 'ignore' });
  // Never under 4 s, so a card still settling isn't caught half drawn.
  await sleep(4000);
  let missing = t.shows;
  let text = '';
  for (const until = Date.now() + 21000; Date.now() < until; ) {
    text = screenText();
    missing = missingWords(t.shows, text);
    if (!missing.length) break;
    await sleep(1500);
  }
  const file = `android-${i + 1}.png`;
  fs.writeFileSync(path.join(out, file), run(['exec-out', 'screencap', '-p']));
  fs.writeFileSync(path.join(out, `android-${i + 1}.txt`), text);
  results.push({ name: t.name, file, missing });
}
console.log(JSON.stringify(results, null, 2));
