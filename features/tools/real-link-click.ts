// Clicking a link in a reply with the real pointer, the way a hand does:
// moving onto it, resting a moment (long enough for its card, or not), a
// press of about a tenth of a second, then a second click without moving.
// The automation's `link` follows a link without a click, so it can't see a
// click that's lost on the way (Mike, 20 Nov: "I have to click links
// multiple times before it actually opens the link"). Takes over the
// pointer, so only on a machine nobody's using:
//
//   desktop/scripts/remote.sh tinker-desk --desk -- bash -c 'cd desktop && cargo build -p threadbear-gpui --features automation && cd ../features && node tools/real-link-click.ts'
//
// Prints each try, how many opens each click made, and PASS or FAIL.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { GpuiDriver } from '../support/gpui.ts';
import { sleep, type Dump } from '../support/driver.ts';
import { assertInFront, windowFrame, work } from './real-screen.ts';
import { ensurePerfLock } from './perf-lock.ts';

await ensurePerfLock();

const tool = path.join(work, 'real-link-click');
fs.writeFileSync(`${tool}.swift`, `import AppKit
import CoreGraphics
import Foundation
// real-link-click <fromX> <fromY> <toX> <toY> <restSeconds> <pressSeconds> [jitter]
// Moves from one point to the other in 15 steps over 0.2 s, rests, then a
// press and release (with jitter, the release 1 pt off the press, as a
// trackpad's press often is).
let a = CommandLine.arguments
if a[1] == "front" {
  print(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
  exit(0)
}
func wait(_ s: Double) { Thread.sleep(forTimeInterval: s) }
func post(_ type: CGEventType, _ p: CGPoint) {
    guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { return }
    e.setIntegerValueField(.mouseEventClickState, value: 1)
    e.post(tap: .cghidEventTap)
}
let from = CGPoint(x: Double(a[1])!, y: Double(a[2])!)
let to = CGPoint(x: Double(a[3])!, y: Double(a[4])!)
let rest = Double(a[5])!, press = Double(a[6])!
let jitter = a.count > 7
if from != to {
    for i in 1...15 {
        let t = Double(i) / 15
        post(.mouseMoved, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
        wait(0.2 / 15)
    }
}
wait(rest)
if press < 0 { post(.mouseMoved, to); wait(0.1); exit(0) }
post(.leftMouseDown, to)
if jitter { wait(press / 2); post(.leftMouseDragged, CGPoint(x: to.x + 1, y: to.y)); wait(press / 2) } else { wait(press) }
post(.leftMouseUp, jitter ? CGPoint(x: to.x + 1, y: to.y) : to)
wait(0.1)
`);
execFileSync('swiftc', ['-O', `${tool}.swift`, '-o', tool]);

const reply = [
  'You asked what these versions are. Here are the first two.',
  '',
  '1. [The Evening](http://127.0.0.1:8790/flows/evening/)',
  '   - **The idea:** you sit down for one evening in November.',
  '2. [The Slow Book](http://127.0.0.1:8790/flows/slowbook/#year)',
  '   - **The idea:** the same month review, done each month.',
  '',
  'That is everything for now.',
].join('\n');

type Line = { text: string; x: number; y: number; w: number; h: number };
const app = new GpuiDriver();
await app.start();
let failed = 0;
const answer = (s: string) => s.replace(/^ok /, '');
const opened = async (): Promise<string[]> => JSON.parse(answer(await app.do({ cmd: 'opened' })));

try {
  for (let i = 0; i < 300; i += 1) {
    const d = await app.dump();
    if (d.connection === 'connected' && d.sidebar.sections.some((s) => s.threads.length)) break;
    await sleep(50);
  }
  const threadId = 'link-click-thread';
  await app.do({ cmd: 'mock', method: 'thread', params: { id: threadId, title: 'Clicking links' } });
  await sleep(500);
  await app.do({ cmd: 'open', id: threadId });
  await sleep(800);
  await app.do({ cmd: 'mock', method: 'stream', params: { threadId, text: reply, hz: 60 } });
  const finished = (d: Dump) => d.transcript.rows.some((r) => r.kind === 'footer' && r.turn === 'turn_stream');
  for (let i = 0; i < 400 && !finished(await app.dump()); i += 1) await sleep(50);
  const rowId = [...(await app.dump()).transcript.rows].reverse().find((r) => r.kind === 'assistant')!.id;
  await app.do({ cmd: 'front' });
  await sleep(800);

  const lines: Line[] = JSON.parse(answer(await app.do({ cmd: 'text-lines', row: rowId })));
  console.log(`lines: ${JSON.stringify(lines.map((l) => [l.text, l.x, l.y, l.w]))}`);
  const [wx, wy] = windowFrame(app.pid!);
  const on = (words: string): [number, number] => {
    const l = lines.find((l) => l.text.includes(words));
    if (!l) throw new Error(`no line with ${words}`);
    // A third of the way along the link's words: the line holds only the link.
    return [Math.round(wx + l.x + Math.min(l.w / 3, 40)), Math.round(wy + l.y + Math.min(l.h, 26) / 2)];
  };
  const away = (at: [number, number]): [number, number] => [at[0] + 60, at[1] + 90];

  // Another app in front (as the browser is, after the last link opened),
  // with no window over ours: Finder, as first-click.ts has it.
  const front = () => Number(execFileSync(tool, ['front']).toString().trim());
  async function putAnotherAppInFront(): Promise<void> {
    execFileSync('/usr/bin/osascript', ['-e', 'tell application "Finder" to activate']);
    for (let i = 0; i < 20 && front() === app.pid; i += 1) await sleep(150);
    if (front() === app.pid) throw new Error('Finder never came in front');
    await sleep(400);
  }

  async function tryClick(name: string, at: [number, number], from: [number, number], rest: number, press: number, jitter = false): Promise<number> {
    await opened();
    assertInFront(app.pid!, [at, from]);
    const before = front();
    execFileSync(tool, [...from.map(String), ...at.map(String), String(rest), String(press), ...(jitter ? ['jitter'] : [])]);
    await sleep(500);
    const got = await opened();
    console.log(`  ${name}: ${got.length} open(s) ${JSON.stringify(got)}${before !== app.pid ? ' (another app was in front)' : ''}`);
    return got.length;
  }

  for (const [label, words] of [['The Evening', 'The Evening'], ['The Slow Book', 'The Slow Book']] as const) {
    const at = on(words);
    for (const [how, rest, press, jitter] of [
      ['moved on, rested 1 s (card up), 90 ms press', 1.0, 0.09, false],
      ['moved on, rested 0.15 s, 90 ms press', 0.15, 0.09, false],
      ['moved on, rested 1 s, 120 ms press, 1 pt slip', 1.0, 0.12, true],
      ['moved on, rested 0.6 s, 200 ms press', 0.6, 0.2, false],
      ['another app in front, moved on, rested 0.6 s, 90 ms press', 0.6, 0.09, false],
    ] as const) {
      // Off the reply first and settled, so every try starts from the same place.
      execFileSync(tool, [...away(at).map(String), ...away(at).map(String), '0.8', '-1']);
      if (how.startsWith('another app')) await putAnotherAppInFront();
      await opened();
      const first = await tryClick(`${label}, ${how}, first click`, at, away(at), rest, press, jitter);
      const second = await tryClick(`${label}, ${how}, second click, not moved`, at, at, 0.4, press, jitter);
      const ok = first === 1;
      if (!ok) failed += 1;
      console.log(`${ok ? 'pass' : 'FAIL'}  ${label}: ${how} (first ${first}, second ${second})`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  console.log(failed ? `${failed} FAILED` : 'all passed');
  if (failed) process.exitCode = 1;
  await app.stop();
  process.exit();
}
