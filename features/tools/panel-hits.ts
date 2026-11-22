// Real presses in a web panel's page land where the pointer is. Mike found the
// YouTube panel taking each press about 12 points above the pointer (16 Nov):
// the top of a button did nothing, and a drag to select text started a line
// higher. A script's clicks go through DevTools or straight into AppKit and
// never met it, so this posts real ones through the window server, at a
// button's top and bottom edges and its middle, and checks where the page
// says each landed. Then it does it again after the things that move or
// resize the page's view: a window resize, another thread and back.
// Takes over the pointer, so only on a machine nobody's using (AGENTS.md,
// "Tests that need the real screen"; --desk holds the perf lock), with the web
// runtime's archive:
//
//   desktop/scripts/remote.sh tinker-desk -- bash -c 'cd desktop && cargo build -p threadbear-gpui --features automation'
//   desktop/scripts/remote.sh tinker-desk --desk -- \
//     env TB_WEB_RUNTIME_ARCHIVE=<the pinned archive> node features/tools/panel-hits.ts
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { GpuiDriver } from '../support/gpui.ts';
import { sleep, type Dump } from '../support/driver.ts';
import { startSites, stopSites } from '../support/web-pages.ts';
import { runtimeParent } from '../support/web-runtime.ts';
import { assertInFront, recording, windowFrame, work } from './real-screen.ts';

const archive = process.env.TB_WEB_RUNTIME_ARCHIVE;
if (!archive) throw new Error('TB_WEB_RUNTIME_ARCHIVE is the pinned web runtime archive');
if (recording()) throw new Error('something is recording this screen; no events posted');

// One real press and release at a point, moved there first as a hand does.
const tool = path.join(work, 'panel-press');
fs.writeFileSync(`${tool}.swift`, `import CoreGraphics
import Foundation
let a = CommandLine.arguments
let at = CGPoint(x: Double(a[1])!, y: Double(a[2])!)
let source = CGEventSource(stateID: .hidSystemState)
func post(_ type: CGEventType) { CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: .left)!.post(tap: .cghidEventTap) }
post(.mouseMoved); usleep(250_000)
post(.leftMouseDown); usleep(60_000)
post(.leftMouseUp); usleep(100_000)
`);
execFileSync('swiftc', ['-O', `${tool}.swift`, '-o', tool]);
// The screen awake for the whole run, or the events go nowhere (features/README.md, "Real screen").
const awake = spawn('/usr/bin/caffeinate', ['-u', '-d', '-w', String(process.pid)], { stdio: 'ignore' });
awake.unref();

const runtime = fs.mkdtempSync(path.join(runtimeParent(), 'tb-panel-hits-runtime-'));
process.env.THREADBEAR_WEB_RUNTIME_DIR = runtime;
const sites = await startSites();
const app = new GpuiDriver();
const results: string[] = [];
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed += 1;
}
type Page = { key: string; title?: string; loading?: boolean; hidden?: boolean; slot?: number[]; frame?: number[]; picture?: number[] | null };
const pages = (d: Dump) => ((d as { webPanels?: { pages: Page[] } }).webPanels?.pages ?? []);
const showing = async () => pages(await app.dump()).find((p) => p.title === 'Hits' && p.hidden === false && p.loading === false);
async function until<T>(what: () => Promise<T | undefined>, ms = 3000): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await what();
    if (got) return got;
    if (Date.now() > end) return undefined;
    await sleep(100);
  }
}
async function evalIn(js: string): Promise<unknown> {
  const out = await app.do({ cmd: 'webPanel', do: 'eval', js });
  return JSON.parse(out.replace(/^[^{]*/, '')).value;
}

/** Presses at a button's top and bottom edges (2 points in) and its middle, each checked against where the page says it landed. */
async function pressAround(when: string, buttons = ['b1', 'b2']): Promise<void> {
  const page = await until(showing, 10_000);
  if (!page?.slot) throw new Error(`the Hits page isn't showing ${when}`);
  const [sx, sy] = page.slot;
  // The page's own coordinates can't see a drawing that's drifted (the
  // presses below aim where the page says its buttons are), so the size
  // Chromium draws it at is checked against the view's as well.
  const [, , fw, fh] = page.frame ?? [];
  const [pw, ph] = page.picture ?? [];
  check(`${when}: the page is drawn the size of its view`, pw !== undefined && Math.abs(pw - fw) <= 1 && Math.abs(ph - fh) <= 1, `view ${fw} x ${fh}, picture ${pw} x ${ph}`);
  for (const id of buttons) {
    const [left, top, , height] = (await evalIn(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`)) as number[];
    for (const [where, y] of [['top edge', top + 2], ['middle', top + height / 2], ['bottom edge', top + height - 2]] as const) {
      await evalIn('hits.length = 0');
      await app.do({ cmd: 'front' });
      await sleep(300);
      const [wx, wy] = windowFrame(app.pid!);
      const at: [number, number] = [Math.round(wx + sx + left + 30), Math.round(wy + sy + y)];
      assertInFront(app.pid!, [at]);
      execFileSync(tool, at.map(String));
      const hit = (await until(async () => ((await evalIn('JSON.stringify(hits[0] || null)')) as string) !== 'null' ? JSON.parse((await evalIn('JSON.stringify(hits[0])')) as string) : undefined, 2000)) as { x: number; y: number; on: string } | undefined;
      const expectedY = at[1] - wy - sy;
      check(`${when}: a press at ${id}'s ${where} presses it, where the pointer is`, hit?.on === id && Math.abs(hit.y - expectedY) <= 1.5, hit ? `on ${hit.on} at y ${hit.y}, pointer at ${expectedY.toFixed(1)}` : 'the page got no press');
    }
  }
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
  await sleep(800);
  const d = await app.dump();
  const threads = d.sidebar.sections.flatMap((s) => s.threads);
  const [first, second] = threads;
  await app.do({ cmd: 'open', id: first.id });
  await app.do({ cmd: 'mock', method: 'urlPanel', params: { threadId: first.id, url: `${sites.home}hits`, title: 'Preview' } });
  await app.do({ cmd: 'panel', id: 'mock.page' });
  if (!(await until(showing, 60_000))) throw new Error("the panel's page didn't show");
  await pressAround('as it opens');

  await app.do({ cmd: 'resize', w: 1180, h: 760 });
  await sleep(800);
  await pressAround('after a window resize');

  await app.do({ cmd: 'open', id: second.id });
  await sleep(600);
  await app.do({ cmd: 'resize', w: 1240, h: 820 });
  await sleep(600);
  await app.do({ cmd: 'open', id: first.id });
  await sleep(800);
  await pressAround('after another thread, a resize and back');

  // Across the top its height comes in half points, which is what drifted.
  await app.do({ cmd: 'dock-move', panel: 'mock.page', edge: 'top' });
  for (let i = 0; i < 25; i += 1) await app.do({ cmd: 'resize', w: 1240, h: 700 + ((i * 37) % 121) });
  await app.do({ cmd: 'resize', w: 1240, h: 820 });
  await sleep(800);
  // Button Two is below the bottom of a panel this short.
  await pressAround('across the top, after 25 resizes', ['b1']);
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  console.log(results.join('\n'));
  if (failed) process.exitCode = 1;
  await app.stop();
  stopSites();
  fs.rmSync(runtime, { recursive: true, force: true });
  process.exit();
}
