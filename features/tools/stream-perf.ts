// How smoothly the GPUI app draws a reply while it streams, from GPUI's own
// frame profiler: frames shown, how many were late (a hitch you can see), and
// how long their work took. A streaming reply's new words fade in
// (rows/markdown.rs), which redraws its text every frame while a fade is
// going, so this is run both ways to see what the fade costs: as it is, and
// with TB_REDUCE_MOTION=on, where nothing fades.
//
//   desktop/scripts/remote.sh tinker-desk --desk -- bash -c 'cd desktop &&
//     cargo build --release -p threadbear-gpui --features automation,frame-stats &&
//     cd .. && TB_GPUI_PROFILE=release node features/tools/stream-perf.ts [seconds] &&
//     TB_REDUCE_MOTION=on TB_GPUI_PROFILE=release node features/tools/stream-perf.ts [seconds]'
//
// The mock streams at 30 Hz, 2 to 12 characters a time, as Claude does, into
// the demo thread "Morning brief"; the window is in front, so only on a
// machine nobody's using.
import { GpuiDriver } from '../support/gpui.ts';
import { sleep } from '../support/driver.ts';
import { ensurePerfLock } from './perf-lock.ts';

await ensurePerfLock();

const seconds = Number(process.argv[2] ?? 12);
type Screen = { hz: number; presented: number; late: number; missedRefreshes: number; workMs: Record<string, number>; drawMs: Record<string, number> };

const app = new GpuiDriver();
await app.start();
try {
  let id = '';
  for (let i = 0; i < 400 && !id; i += 1) {
    const d = await app.dump();
    id = d.sidebar.sections.flatMap((s) => s.threads).find((t) => t.title === 'Morning brief')?.id ?? '';
    if (!id) await sleep(50);
  }
  if (!id) throw new Error('no demo thread "Morning brief"');
  await app.do({ cmd: 'open', id });
  for (let i = 0; i < 400 && (await app.dump()).transcript.state !== 'loaded'; i += 1) await sleep(50);
  await app.do({ cmd: 'front' });
  await sleep(1000);
  const fade = (await app.dump()).juice?.replyFadeMs ?? 0;
  await app.do({ cmd: 'frame-stats', reset: true });
  await app.do({ cmd: 'mock', method: 'stream', params: { threadId: id, seconds } });
  await sleep(seconds * 1000 + 500);
  const stats = JSON.parse(await app.do({ cmd: 'frame-stats', reset: true })) as { screens: Screen[] };
  console.log(`\nA reply streaming for ${seconds} s, ${fade ? `its words fading in over ${fade} ms` : 'nothing fading (Reduce Motion)'}`);
  if (!stats.screens.length) console.log('  no frames recorded');
  for (const s of stats.screens) {
    const pct = s.presented ? Math.round((100 * s.late) / s.presented) : 0;
    console.log(`  ${s.hz} Hz screen: ${s.presented} frames shown, ${s.late} late (${pct}%), ${s.missedRefreshes} refreshes missed`);
    console.log(`    work per frame (ms): median ${s.workMs.p50}, 90% ${s.workMs.p90}, 99% ${s.workMs.p99}, worst ${s.workMs.max}`);
    console.log(`    draw per frame (ms): median ${s.drawMs.p50}, 90% ${s.drawMs.p90}, 99% ${s.drawMs.p99}, worst ${s.drawMs.max}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await app.stop();
  process.exit();
}
