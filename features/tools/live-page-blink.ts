// A live page's card keeps its page shown, at its full height, while another
// thread runs. Mike, 25 Nov: Run showed the page as a 140-point strip, then
// it blinked on and off and mostly sat blank. The card measured itself as the
// transcript's room and shrank, and each frame that redrew only the sidebar (a
// running thread's spinner) replayed the cached main panel without placing the
// page, so it was hidden. This runs a slow turn in another thread, presses
// Run on the mock's live page, then moves the real pointer over the sidebar
// for a few seconds. Takes over the pointer, so only on Tinker Desk's
// desktop (AGENTS.md, "Tests that need the real screen"), with the web
// runtime's archive:
//
//   desktop/scripts/remote.sh tinker-desk -- bash -c 'cd desktop && cargo build -p threadbear-gpui --features automation'
//   desktop/scripts/remote.sh tinker-desk --desk -- \
//     env TB_WEB_RUNTIME_ARCHIVE=<the pinned archive> node features/tools/live-page-blink.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GpuiDriver } from '../support/gpui.ts';
import { sleep, type Dump } from '../support/driver.ts';
import { runtimeParent } from '../support/web-runtime.ts';
import { assertInFront, recording, windowFrame } from './real-screen.ts';

const archive = process.env.TB_WEB_RUNTIME_ARCHIVE;
if (!archive) throw new Error('TB_WEB_RUNTIME_ARCHIVE is the pinned web runtime archive');
if (recording()) throw new Error('something is recording this screen; no events posted');

const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tb-live-blink-'));
const page = path.join(work, 'tour.html');
fs.writeFileSync(page, `<!doctype html><html><body style="margin:0;background:#f3efe8;font:16px system-ui">
<h1 style="margin:24px">State machines for Convex</h1><p id="t" style="margin:24px">0</p>
<script>let n = 0; setInterval(() => { document.getElementById('t').textContent = ++n; }, 100);
window.hides = 0; document.addEventListener('visibilitychange', () => { if (document.hidden) window.hides += 1; });</script>
</body></html>`);
// Another thread's turn that runs a while, so its spinner draws the sidebar
// every frame and nothing else.
const turns = path.join(work, 'turns.json');
fs.writeFileSync(turns, JSON.stringify([{ match: 'slow job', tools: [{ name: 'Bash', kind: 'command', title: 'sleep 30', input: { command: 'sleep 30' }, result: '', ms: 30000 }], reply: 'Done.' }]));
// Real pointer moves up and down the sidebar, as a hand's: each row it
// crosses redraws the sidebar alone, the frames that replay the main panel.
const mover = path.join(work, 'sidebar-moves');
fs.writeFileSync(`${mover}.swift`, `import CoreGraphics
import Foundation
let a = CommandLine.arguments.dropFirst().map { Double($0)! }
let (x, top, bottom, seconds) = (a[0], a[1], a[2], a[3])
let source = CGEventSource(stateID: .hidSystemState)
let steps = Int(seconds * 60)
for i in 0..<steps {
  let t = Double(i % 120) / 120
  let y = top + (bottom - top) * (t < 0.5 ? t * 2 : (1 - t) * 2)
  CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!.post(tap: .cghidEventTap)
  usleep(16_000)
}
`);
execFileSync('swiftc', ['-O', `${mover}.swift`, '-o', mover]);
process.env.TB_MOCK_LIVE_PAGES = page;
process.env.MOCK_SCRIPTED_TURNS = turns;
process.env.THREADBEAR_WEB_RUNTIME_DIR = fs.mkdtempSync(path.join(runtimeParent(), 'tb-live-blink-runtime-'));

type Page = { key: string; hidden?: boolean; loading?: boolean; slot?: number[] };
const live = (d: Dump) => ((d as { webPanels?: { pages: Page[] } }).webPanels?.pages ?? []).find((p) => p.key.startsWith('live:'));

const app = new GpuiDriver();
const results: string[] = [];
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed += 1;
}

await app.start();
try {
  for (let i = 0; i < 300; i += 1) {
    const d = await app.dump();
    if (d.connection === 'connected' && d.sidebar.sections.some((s) => s.threads.length)) break;
    await sleep(50);
  }
  await app.do({ cmd: 'webRuntime', do: 'install', archive, wait: 600 }, 630);
  await app.do({ cmd: 'front' });
  await app.do({ cmd: 'resize', w: 1240, h: 860 });
  const other = (await app.dump()).sidebar.sections.flatMap((s) => s.threads).find((t) => t.id !== 'demo_live_page');
  if (!other) throw new Error('no other thread to run a turn in');
  await app.do({ cmd: 'open', id: other.id });
  await app.do({ cmd: 'send', text: 'a slow job please' });
  await sleep(1500);
  await app.do({ cmd: 'open', id: 'demo_live_page' });
  await sleep(800);
  // Run by its tip (live_pages::RUN_TIP), once the card has drawn.
  let ran = false;
  for (let i = 0; i < 40 && !ran; i += 1) {
    try {
      await app.do({ cmd: 'click', tip: 'Run this page here: its scripts on, with no internet and no files but its own' });
      ran = true;
    } catch {
      await sleep(250);
    }
  }
  if (!ran) {
    await app.shot(path.join(work, 'no-run.png'));
    throw new Error(`no Run on the card; see ${path.join(work, 'no-run.png')}, live pages ${JSON.stringify((await app.dump() as { livePages?: unknown }).livePages)}`);
  }
  // Until it first shows, then a sample every 50 ms for 6 seconds.
  let first: Page | undefined;
  for (let i = 0; i < 200 && !first; i += 1) {
    const p = live(await app.dump());
    if (p && p.hidden === false && p.loading === false) first = p;
    else await sleep(50);
  }
  check('the page shows after Run', !!first);
  // The app's dump draws a fresh frame each time, which hides the blink
  // (only frames that replay the cached main panel lost the page), so
  // nothing asks the app anything for 6 seconds while the pointer moves over
  // the sidebar: the page itself counts the times it was hidden, read
  // through DevTools, which draws nothing.
  const key = first?.key ?? '';
  const hides = async () => Number(JSON.parse(await app.do({ cmd: 'webPanel', do: 'eval', key, js: 'window.hides' })).value);
  const before = await hides();
  const [wx, wy, , wh] = windowFrame(app.pid!);
  const lane: [number, number][] = [[wx + 120, wy + 120], [wx + 120, wy + wh - 120]];
  try {
    assertInFront(app.pid!, lane);
    execFileSync(mover, [String(lane[0][0]), String(lane[0][1]), String(lane[1][1]), '6']);
  } catch (e) {
    // A locked screen takes no events: the page still has 6 seconds, but
    // only the spinner's frames, so a pass here proves less.
    results.push(`SKIP  pointer moves: ${(e as Error).message.split('\n')[0]}`);
    await sleep(6000);
  }
  const hidden = (await hides()) - before;
  const heights = new Set<number>();
  for (let i = 0; i < 5; i += 1) {
    const p = live(await app.dump());
    if (p?.slot) heights.add(Math.round(p.slot[3]));
    await sleep(100);
  }
  const running = (await app.dump()).sidebar.sections.flatMap((s) => s.threads).find((t) => t.id === other.id);
  check('the other thread was still running while sampling', !!running && running.status !== 'idle', `status ${running?.status}`);
  check('the page stays shown while another thread runs', hidden === 0, `hidden ${hidden} times in 6 s`);
  const tallest = Math.max(...heights);
  check('the card keeps its height rather than shrinking to the least', heights.size === 1 && tallest > 200, `heights seen ${[...heights].join(', ')}`);
  await app.shot(path.join(work, 'live-page.png'));
  results.push(`shot: ${path.join(work, 'live-page.png')}`);
} finally {
  await app.stop();
}
console.log(results.join('\n'));
process.exit(failed ? 1 : 0);
