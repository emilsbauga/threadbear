// Real window-server gestures on the Canvas page (thread-canvas.feature, the
// threadCanvas experiment), only on a test Mac. Through remote.sh tinker-desk --desk:
//   TB_REAL_SCREEN=1 node features/tools/canvas-gestures.ts
// Two fingers move the board (and never go Back), ⌘ and two fingers zoom it,
// and inside a thread two fingers scroll the thread while ⌘ flies back out.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GpuiDriver } from '../support/gpui.ts';
import { okValue, sleep } from '../support/driver.ts';
import { assertInFront, recording, swiftTool, windowAt, windowFrame } from './real-screen.ts';

type Board = { showing: boolean; entered: string | null; flying: boolean; camera: { s: number; tx: number; ty: number } };

export async function checkCanvasGestures(app: GpuiDriver): Promise<void> {
  if (process.platform !== 'darwin' || process.env.TB_REAL_SCREEN !== '1') throw new Error('Canvas gestures need a test Mac and TB_REAL_SCREEN=1');
  if (recording()) throw new Error('A recording is running; no GUI events posted');
  const gesture = swiftTool('post-gesture');
  const board = async (cmd: Record<string, unknown> = {}): Promise<Board> => {
    await app.dump();
    return JSON.parse(okValue(await app.do({ cmd: 'canvas', ...cmd }))) as Board;
  };
  const settle = async () => {
    for (let n = 0; n < 60; n++) {
      if (!(await board()).flying) return;
      await sleep(50);
    }
  };
  function swipe(at: number[], dx: number, dy: number, cmd = false) {
    const [wx, wy] = windowFrame(app.pid!);
    const screen: [number, number] = [wx + at[0], wy + at[1]];
    assertInFront(app.pid!, [screen]);
    execFileSync(gesture, [String(screen[0]), String(screen[1]), '0', ...Array(10).fill(`${dx},${dy}`)], {
      env: { ...process.env, ...(cmd ? { PG_FLAGS: 'cmd' } : {}) },
    });
  }
  try {
    for (let n = 0; n < 100; n++) {
      try { await board({ show: true }); break; } catch { await sleep(100); }
    }
    await app.do({ cmd: 'resize', w: 1180, h: 760 });
    execFileSync('caffeinate', ['-u', '-t', '2']);
    await app.do({ cmd: 'front' });
    await sleep(600);
    // A spot on the board that's really the app's on screen (a display
    // tool's floating window sat over the middle on 24 Nov).
    const [wx, wy] = windowFrame(app.pid!);
    const mid = [[640, 380], [400, 300], [900, 300], [400, 560], [900, 560], [250, 200]]
      .find(([x, y]) => windowAt(wx + x, wy + y)?.pid === app.pid);
    assert(mid, 'no spot on the board is in front');
    const start = await board();
    assert(start.showing, 'the Canvas page did not come up');
    swipe(mid, -6, -4);
    await sleep(400);
    const panned = await board();
    console.log('pan', start.camera, panned.camera);
    assert(panned.showing, 'two fingers took the board down (went Back?)');
    assert(Math.abs(panned.camera.tx - start.camera.tx) > 10 || Math.abs(panned.camera.ty - start.camera.ty) > 10, 'two fingers did not move the board');
    assert(Math.abs(panned.camera.s - start.camera.s) < 1e-4, 'two fingers zoomed the board');
    console.log('PASS: two fingers move the board and stay on it');
    swipe(mid, 0, 8, true);
    await sleep(400);
    const zoomed = await board();
    console.log('zoom', panned.camera, zoomed.camera);
    assert(Math.abs(zoomed.camera.s - panned.camera.s) > 1e-3, '⌘ and two fingers did not zoom');
    console.log('PASS: ⌘ and two fingers zoom the board');
    await board({ enter: 'nest_browser' });
    await settle();
    await app.do({ cmd: 'waitFor', loaded: true });
    const inside = await board();
    assert.equal(inside.entered, 'nest_browser', 'the flight in did not hand over to the thread');
    swipe(mid, 0, -6);
    await sleep(400);
    const scrolled = await board();
    assert.equal(scrolled.entered, 'nest_browser', 'two fingers inside the thread left it');
    assert.deepEqual(scrolled.camera, inside.camera, 'two fingers inside the thread moved the board');
    console.log('PASS: two fingers inside the thread leave the board where it is');
    for (const dy of [-8, 8]) {
      swipe(mid, 0, dy, true);
      await sleep(300);
      if (!(await board()).entered) break;
    }
    await settle();
    const out = await board();
    assert.equal(out.entered, null, '⌘ and two fingers did not fly out of the thread');
    assert(out.camera.s < inside.camera.s, 'the flight out did not zoom out');
    console.log('PASS: ⌘ and two fingers fly back out of the thread');
  } catch (error) {
    try { const file = path.join(os.tmpdir(), `threadbear-canvas-gesture-${process.pid}`); fs.writeFileSync(`${file}.json`, JSON.stringify(await app.dump())); await app.shot(`${file}.png`); console.error(`Saved ${file}.png`); } catch {}
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.env.TB_MOCK_THREAD_CANVAS = '1';
  process.env.TB_MOCK_NESTED = '1';
  process.env.TB_MOCK_NESTED_OFF = '1';
  const app = new GpuiDriver();
  await app.start();
  try { await checkCanvasGestures(app); } finally { await app.stop(); }
}
