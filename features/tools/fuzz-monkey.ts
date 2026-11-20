// A seeded random walk through the GPUI app on its mock runner, looking for
// crashes, freezes and states that can't be right. An experiment (18 Nov
// 2026): Mike asked to try fuzzing the app overnight on Tinker Desk.
//
//   node tools/fuzz-monkey.ts --seed 7 --minutes 10 --out <dir>
//   node tools/fuzz-monkey.ts --replay <dir>/finding-1/trace.json --out <dir>
//   node tools/fuzz-monkey.ts --replay <trace.json> --shrink --out <dir>
//
// Each step reads `dump`, picks one action among what's there (weighted
// towards what a person does), runs it, then checks the invariants below.
// A failure keeps the seed, the trace of commands so far, a picture, the
// app's log and its kept panics, then replays the trace on a fresh app to
// see whether it repeats.
//
// It's a debug build with `automation`, through features/support/gpui.ts,
// so it opens nothing for real (open_gate.rs) and its Terminal panel gets a
// shell that runs nothing (TB_SPEC_SHELL, set below). Whole runs go on
// Tinker Desk: tools/fuzz-monkey.sh through desktop/scripts/remote.sh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GpuiDriver } from '../support/gpui.ts';
import { sleep, type Dump } from '../support/driver.ts';
import { ensurePerfLock } from './perf-lock.ts';

type Cmd = Record<string, unknown>;
// How long after a mock event (a runner restart, a failed read) its error
// messages count as caused by it: the longest restart is 2.8 s, and the app
// waits a moment before it tries again.
const MOCK_SETTLE_MS = 10_000;
type Step = { cmd: Cmd; ms: number; result: string; refused?: boolean };
type Failure = { kind: string; detail: string; step: number };

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const seed = Number(opt('seed', String(Date.now() % 100000)));
const minutes = Number(opt('minutes', '10'));
const maxSteps = Number(opt('steps', '100000'));
// Steps before a fresh app (and a fresh walk); a big number keeps one app all run, to see memory over time.
const sessionSteps = Number(opt('session-steps', '400'));
// How often the mock runner misbehaves (restarts, slow replies, failed reads), against 6 by default.
const mockWeight = Number(opt('mock-weight', '6'));
const out = path.resolve(opt('out', path.join(os.tmpdir(), 'tb-fuzz')));
const replayFile = opt('replay', '');
fs.mkdirSync(out, { recursive: true });

// A shell for the Terminal panel that swallows everything typed into it.
const shellDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tb-fuzz-shell-'));
const shell = path.join(shellDir, 'nothing.sh');
fs.writeFileSync(shell, '#!/bin/sh\nexec cat >/dev/null\n', { mode: 0o700 });
process.env.TB_SPEC_SHELL = shell;
process.on('exit', () => fs.rmSync(shellDir, { recursive: true, force: true }));

// mulberry32: small, seedable, the same walk for the same seed.
function rng(s: number) {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Words a person might type, and some a person wouldn't.
const WORDS = [
  'fix the build', 'can you check this', 'yes', 'no', 'ok go ahead', '/', '/mo', '@', '#', '```js\nconsole.log(1)\n```',
  '**bold** _it_ `code`', 'line one\nline two\nline three', '🙂🐻🍯', 'مرحبا بالعالم', 'עברית', '日本語のテキスト',
  '<script>alert(1)</script>', 'https://example.com/a?b=c', '~/dev/me/misc/file.ts:12',
  '   ', '\t', '[link](https://x.dev)', '- [ ] task\n- [x] done', '| a | b |\n|---|---|\n| 1 | 2 |', '$(echo hi)', '%s%s%n',
];
// Long text goes in by paste: `type` presses each character as its own key
// and draws a frame after it (gpui-kit's input_text), so 1,500 characters
// took 24 s in a debug build, which reads as a freeze and isn't one.
const LONG = ['a'.repeat(400), 'word '.repeat(300), 'line of a log 0123456789\n'.repeat(800), '🐻'.repeat(500), '```\n' + 'x = 1\n'.repeat(2000) + '```'];
// Keys with ⌘ that a person uses here. Not ⌘Q or ⌘W: the run needs its window.
const CMD_KEYS = ['1', '2', '3', '4', '5', 'k', '/', '[', ']', 'n', 'f', '=', '-', '0', 'e', 'j', 'l', 'i', 'b', ',', '.', 'backspace', 'up', 'down', 'enter', 't', 'g', 'shift-a', 'shift-d', 'shift-n'];
const PLAIN_KEYS = ['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'space', 'backspace', 'delete', 'escape', 'tab'];
// Menu items that would end the run, open something outside the app, or hand keys to a shell.
const MENU_SKIP = /quit|close|hide|minimi[sz]e|print|terminal|finder|website|github|help|report|sign out|log out|restart|install|update|relaunch|bring them in|full screen|enter full|exit full|window size/i;

const MOCK_EVENTS: ((r: () => number, ids: string[]) => Cmd | null)[] = [
  (r, ids) => ids.length ? { cmd: 'mock', method: 'stream', params: { threadId: pick(r, ids), hz: 10 + Math.floor(r() * 50), seconds: 1 + Math.floor(r() * 8), tools: r() < 0.5 } } : null,
  (r, ids) => ids.length ? { cmd: 'mock', method: 'status', params: { threadId: pick(r, ids), status: pick(r, ['idle', 'running', 'waiting', 'error']), needsYou: r() < 0.4 } } : null,
  (r, ids) => ids.length ? { cmd: 'mock', method: 'approval', params: { threadId: pick(r, ids), title: 'npm test' } } : null,
  (r) => ({ cmd: 'mock', method: 'notice', params: { level: pick(r, ['info', 'warning', 'error']), message: 'A notice from the fuzzer' } }),
  (r) => ({ cmd: 'mock', method: 'slow', params: { ms: pick(r, [0, 0, 50, 300, 1500]) } }),
  (r) => ({ cmd: 'mock', method: 'restart', params: { downMs: 300 + Math.floor(r() * 2500) } }),
  (r) => ({ cmd: 'mock', method: 'goAway', params: { downMs: 300 + Math.floor(r() * 2500) } }),
  (r, ids) => ids.length ? { cmd: 'mock', method: 'failEvents', params: { threadId: pick(r, ids), times: 1 + Math.floor(r() * 2) } } : null,
  (r, ids) => ids.length ? { cmd: 'mock', method: 'background', params: { threadId: pick(r, ids), tasks: r() < 0.5 ? [] : [{ kind: 'shell', description: 'npm test' }, { kind: 'agent', description: 'Explore', finished: r() < 0.5 }] } } : null,
  (r) => ({ cmd: 'mock', method: 'thread', params: { title: pick(r, WORDS).slice(0, 80) || 'A thread' } }),
];

function pick<T>(r: () => number, xs: T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

function threadIds(d: Dump): string[] {
  return d.sidebar.sections.flatMap((s) => s.threads.map((t) => t.id));
}

/** One action from what this dump shows, weighted towards what people do. */
function nextAction(r: () => number, d: Dump, menuItems: string[], size: { w: number; h: number }): Cmd {
  const ids = threadIds(d);
  const rows = d.transcript.rows ?? [];
  const rails = [...(d.rails?.activity ?? []), ...(d.rails?.right ?? [])].map((b) => b.title).filter(Boolean);
  const choices: [number, () => Cmd | null][] = [
    [14, () => (ids.length ? { cmd: 'open', id: pick(r, ids) } : null)],
    [6, () => ({ cmd: 'type', text: pick(r, WORDS), replace: r() < 0.3 })],
    [2, () => ({ cmd: 'paste', text: r() < 0.5 ? pick(r, LONG) : pick(r, WORDS) })],
    [2, () => (d.selection ? { cmd: 'send', text: pick(r, WORDS) } : null)],
    [4, () => ({ cmd: 'menu-key', modifiers: ['cmd'], key: pick(r, CMD_KEYS) })],
    [4, () => ({ cmd: 'menu-key', modifiers: [], key: pick(r, PLAIN_KEYS) })],
    [2, () => ({ cmd: 'return', shift: r() < 0.3 })],
    [2, () => ({ cmd: 'escape' })],
    [5, () => (rows.length ? { cmd: r() < 0.5 ? 'expand' : 'collapse', row: pick(r, rows).id } : null)],
    [4, () => (d.selection ? { cmd: 'scroll', to: pick(r, ['top', 'bottom']) } : null)],
    [3, () => (rows.length && d.selection ? { cmd: 'scroll-to', row: pick(r, rows).id } : null)],
    [4, () => ({ cmd: 'mode', mode: pick(r, ['inbox', 'inbox', 'scheduled', 'projects', 'librarian', 'archive', 'snoozed']) })],
    [4, () => (rails.length ? { cmd: 'click', title: pick(r, rails) } : null)],
    // Left clicks only: a right click opens a native menu, which holds the
    // main thread in AppKit's menu loop until someone picks from it, so every
    // command after it times out (18 Nov: two "freezes", both an open menu).
    [8, () => ({ cmd: 'click-at', x: Math.floor(r() * size.w), y: Math.floor(r() * size.h), count: r() < 0.1 ? 2 : 1 })],
    [3, () => (menuItems.length ? { cmd: 'menu-item', title: pick(r, menuItems) } : null)],
    [2, () => (d.selection ? { cmd: 'archive' } : null)],
    [1, () => (d.archivedNote ? { cmd: 'undo-archive' } : null)],
    [1, () => (d.selection ? { cmd: 'snooze', seconds: pick(r, [5, 60, 3600]) } : null)],
    [2, () => ({ cmd: 'mouse-button', button: pick(r, ['back', 'forward']) })],
    [2, () => ({ cmd: 'search', text: pick(r, ['', 'fix', 'demo', '🙂', 'zzz']) })],
    [1, () => ({ cmd: 'resize', w: 500 + Math.floor(r() * 1400), h: 360 + Math.floor(r() * 700) })],
    [1, () => ({ cmd: 'zoom', to: pick(r, ['in', 'out', 'reset']) })],
    [1, () => ({ cmd: 'appearance', mode: pick(r, ['light', 'dark']) })],
    [2, () => (d.selection ? { cmd: 'panel', show: r() < 0.5 } : null)],
    [1, () => (d.selection ? { cmd: 'rename', title: pick(r, WORDS).slice(0, 60) } : null)],
    [mockWeight, () => MOCK_EVENTS[Math.floor(r() * MOCK_EVENTS.length)](r, ids)],
  ];
  for (let tries = 0; tries < 20; tries += 1) {
    const total = choices.reduce((n, [w]) => n + w, 0);
    let x = r() * total;
    for (const [w, make] of choices) {
      x -= w;
      if (x <= 0) {
        const c = make();
        if (c) return c;
        break;
      }
    }
  }
  return { cmd: 'escape' };
}

/** A command that never got an answer means the app froze or died, not that it said no. */
function isHard(message: string): string | null {
  if (/timed out after/.test(message)) return 'freeze';
  if (/unanswered|dropped `|command loop has ended|closed its automation connection|no connection to the app/.test(message)) return 'crash';
  return null;
}

function okJson(line: string): Record<string, unknown> {
  try {
    return JSON.parse(line.replace(/^ok /, '')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function rssKb(pid: number | undefined): number {
  if (!pid) return 0;
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
}

/** The app's own crash or hang record; an app that keeps none says so, which isn't a failure. */
async function report(app: GpuiDriver, cmd: 'crashes' | 'hangs'): Promise<string> {
  try {
    return await app.do({ cmd }, 15);
  } catch (e) {
    if (isHard((e as Error).message)) throw e;
    return 'ok {}';
  }
}

/** Invariants that hold whatever was clicked. Returns what broke, if anything. */
async function check(app: GpuiDriver, before: { panics: number; stalls: number; error?: string | null }, recentMock: boolean): Promise<{ kind: string; detail: string } | null> {
  const pid = app.pid;
  if (pid) {
    try {
      process.kill(pid, 0);
    } catch {
      return { kind: 'crash', detail: 'the app process is gone' };
    }
  }
  const crashes = okJson(await report(app, 'crashes'));
  const panics = (crashes.panics as unknown[] | undefined) ?? [];
  if (panics.length > before.panics) {
    const p = panics[panics.length - 1] as { message?: string; location?: string };
    before.panics = panics.length;
    return { kind: 'panic', detail: `${p.location ?? '?'}: ${(p.message ?? '').slice(0, 300)}` };
  }
  const hangs = okJson(await report(app, 'hangs'));
  const stalls = (hangs.stalls as { name: string; stuckIn?: string; recoveredAfter?: number }[] | undefined) ?? [];
  if (stalls.length > before.stalls) {
    const s = stalls[stalls.length - 1];
    before.stalls = stalls.length;
    return { kind: 'hang', detail: `main thread stuck${s.recoveredAfter ? ` ${s.recoveredAfter}s` : ''} in ${s.stuckIn ?? 'unknown'}` };
  }
  const started = Date.now();
  const d = await app.dump();
  const dumpMs = Date.now() - started;
  if (dumpMs > 5000) return { kind: 'slow', detail: `dump took ${dumpMs} ms` };
  // Each thread once per section, and each transcript row once. Not the
  // Librarian's: its Recent lists what it did, so a thread can be there twice.
  for (const s of d.sidebar.mode === 'librarian' ? [] : d.sidebar.sections) {
    const seen = new Set<string>();
    for (const t of s.threads) {
      if (seen.has(t.id)) return { kind: 'state', detail: `thread ${t.id} listed twice in ${s.name}` };
      seen.add(t.id);
    }
  }
  const rowIds = new Set<string>();
  for (const row of d.transcript.rows ?? []) {
    if (rowIds.has(row.id)) return { kind: 'state', detail: `transcript row ${row.id} drawn twice` };
    rowIds.add(row.id);
  }
  // The transcript on show is the selected thread's, once it's had a moment.
  if (d.selection && d.transcript.threadId && d.transcript.threadId !== d.selection.id && d.transcript.state === 'loaded') {
    await sleep(1500);
    const again = await app.dump();
    if (again.selection && again.transcript.threadId && again.transcript.threadId !== again.selection.id && again.transcript.state === 'loaded') {
      return { kind: 'state', detail: `selected ${again.selection.id} but the transcript shows ${again.transcript.threadId}` };
    }
  }
  // An error bar the fuzzer didn't cause through the mock (a runner going
  // away, a failed read, its own notice) is worth a look.
  // Only a new one: a runner restart's message can stay up long after.
  const fresh = d.error && d.error !== before.error;
  before.error = d.error ?? null;
  if (fresh && !recentMock && d.connection === 'connected' && !/fuzzer/.test(d.error!)) return { kind: 'error-bar', detail: d.error!.slice(0, 300) };
  return null;
}

async function startApp(): Promise<GpuiDriver> {
  const app = new GpuiDriver();
  await app.start();
  for (let i = 0; i < 200; i += 1) {
    const d = await app.dump();
    if (d.connection === 'connected' && threadIds(d).length) break;
    await sleep(50);
  }
  return app;
}

async function menuItems(app: GpuiDriver): Promise<string[]> {
  try {
    const menus = JSON.parse((await app.do({ cmd: 'menus' })).replace(/^ok /, '')) as { title?: string; items?: { title?: string }[] }[];
    return menus.filter((m) => !MENU_SKIP.test(m.title ?? '')).flatMap((m) => (m.items ?? []).map((i) => i.title ?? '')).filter((t) => t && !MENU_SKIP.test(t));
  } catch {
    return [];
  }
}

/** Runs a fixed list of commands on a fresh app; the first failure, if any. */
async function replay(cmds: Cmd[]): Promise<Failure | null> {
  const app = await startApp();
  const before: { panics: number; stalls: number; error?: string | null } = { panics: 0, stalls: 0 };
  let lastMock = 0;
  try {
    for (let i = 0; i < cmds.length; i += 1) {
      const c = cmds[i];
      if (c.cmd === 'mock') lastMock = Date.now();
      try {
        await app.do(c, 20);
      } catch (e) {
        const hard = isHard((e as Error).message);
        if (hard) {
          if (hard === 'freeze') sampleTo(app.pid, path.join(out, `replay-sample-${i}.txt`));
          return { kind: hard, detail: (e as Error).message.split('\n')[0], step: i };
        }
      }
      const f = await check(app, before, Date.now() - lastMock < MOCK_SETTLE_MS).catch((e) => ({ kind: isHard((e as Error).message) ?? 'check', detail: (e as Error).message.split('\n')[0] }));
      if (f) {
        if (f.kind === 'freeze') sampleTo(app.pid, path.join(out, `replay-sample-${i}.txt`));
        return { ...f, step: i };
      }
    }
    return null;
  } finally {
    await app.stop().catch(() => {});
  }
}

/** Shortest list of commands that still fails the same way (a bounded ddmin). */
async function shrink(cmds: Cmd[], kind: string, budgetMs: number): Promise<Cmd[]> {
  const until = Date.now() + budgetMs;
  let best = cmds;
  let chunks = 2;
  while (chunks <= best.length && Date.now() < until) {
    const size = Math.ceil(best.length / chunks);
    let cut = false;
    for (let i = 0; i < chunks && Date.now() < until; i += 1) {
      const without = [...best.slice(0, i * size), ...best.slice((i + 1) * size)];
      if (!without.length) continue;
      const f = await replay(without);
      if (f && f.kind === kind) {
        best = without.slice(0, f.step + 1);
        chunks = Math.max(chunks - 1, 2);
        cut = true;
        console.log(`shrink: ${best.length} steps still fail (${kind})`);
        break;
      }
    }
    if (!cut) {
      if (chunks >= best.length) break;
      chunks = Math.min(chunks * 2, best.length);
    }
  }
  return best;
}

/** Where the app's main thread is while it doesn't answer: macOS's `sample`,
 * read from outside, as the app can't answer for itself then. */
function sampleTo(pid: number | undefined, file: string) {
  if (!pid || process.platform !== 'darwin') return;
  try {
    execFileSync('/usr/bin/sample', [String(pid), '2', '-file', file], { stdio: 'ignore', timeout: 30_000 });
  } catch {
    // The process went, or sample couldn't attach: the log says the rest.
  }
}

/** Whether the app's main thread is sitting in a native menu's loop. */
function openMenu(pid: number | undefined): boolean {
  if (!pid || process.platform !== 'darwin') return false;
  const file = path.join(os.tmpdir(), `tb-fuzz-menu-${pid}.txt`);
  sampleTo(pid, file);
  try {
    return /popUpMenuPositioningItem|popUpContextMenu|_NSMenuTracking|NSContextMenu/.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function keep(app: GpuiDriver | null, dir: string, f: Failure, trace: Step[]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'trace.json'), JSON.stringify({ seed, failure: f, commands: trace.map((s) => s.cmd), steps: trace }, null, 2));
  if (app) {
    if (f.kind === 'freeze') sampleTo(app.pid, path.join(dir, 'sample.txt'));
    await app.shot(path.join(dir, 'shot.png')).catch(() => {});
    fs.writeFileSync(path.join(dir, 'app.log'), await app.appLog().catch(() => ''));
    fs.writeFileSync(path.join(dir, 'evidence.txt'), await app.evidence(false).catch((e) => String(e)));
  }
}

async function fuzz() {
  const r = rng(seed);
  const until = Date.now() + minutes * 60_000;
  const summary = { seed, minutes, steps: 0, refused: 0, byCmd: {} as Record<string, number>, refusedByCmd: {} as Record<string, number>, rss: [] as number[], findings: [] as (Failure & { dir: string; repeats?: string })[], restarts: 0, nativeMenus: 0 };
  let n = 0;
  while (Date.now() < until && summary.steps < maxSteps) {
    const app = await startApp();
    const items = await menuItems(app);
    let size = { w: 1240, h: 820 };
    const before: { panics: number; stalls: number; error?: string | null } = { panics: 0, stalls: 0 };
    const trace: Step[] = [];
    let lastMock = 0;
    let failure: Failure | null = null;
    try {
      while (Date.now() < until && summary.steps < maxSteps) {
        const d = await app.dump();
        const c = nextAction(r, d, items, size);
        if (c.cmd === 'resize') size = { w: c.w as number, h: c.h as number };
        if (c.cmd === 'mock') lastMock = Date.now();
        const t0 = Date.now();
        let result = '';
        let refused = false;
        try {
          result = (await app.do(c, 20)).slice(0, 200);
        } catch (e) {
          const msg = (e as Error).message;
          const hard = isHard(msg);
          if (hard) {
            failure = { kind: hard, detail: msg.split('\n')[0], step: trace.length };
          }
          refused = true;
          result = msg.split('\n')[0].slice(0, 200);
        }
        trace.push({ cmd: c, ms: Date.now() - t0, result, refused });
        summary.steps += 1;
        summary.byCmd[String(c.cmd)] = (summary.byCmd[String(c.cmd)] ?? 0) + 1;
        if (refused) {
          summary.refused += 1;
          summary.refusedByCmd[String(c.cmd)] = (summary.refusedByCmd[String(c.cmd)] ?? 0) + 1;
        }
        if (failure) break;
        const f = await check(app, before, Date.now() - lastMock < MOCK_SETTLE_MS).catch((e) => ({ kind: isHard((e as Error).message) ?? 'check', detail: (e as Error).message.split('\n')[0] }));
        if (f) {
          failure = { ...f, step: trace.length - 1 };
          break;
        }
        if (summary.steps % 50 === 0) summary.rss.push(rssKb(app.pid));
        // A restart of the walk now and then, so one long session isn't the only shape tried.
        if (trace.length >= sessionSteps) break;
      }
      if (failure && failure.kind === 'freeze' && openMenu(app.pid)) {
        // A native menu something else opened (a "..." button, say): not a
        // freeze, just the app waiting for a pick. A new app and walk on.
        summary.nativeMenus += 1;
        console.log(`native menu open at step ${failure.step} (not a bug), after ${JSON.stringify(trace[trace.length - 1]?.cmd).slice(0, 120)}`);
        failure = null;
      }
      if (failure) {
        n += 1;
        const dir = path.join(out, `finding-${seed}-${n}`);
        await keep(app, dir, failure, trace);
        summary.findings.push({ ...failure, dir });
        console.log(`FINDING ${failure.kind} at step ${failure.step}: ${failure.detail}`);
      }
    } finally {
      await app.stop().catch(() => {});
    }
    summary.restarts += 1;
    // Does it repeat? One replay of the whole trace on a fresh app.
    const last = summary.findings[summary.findings.length - 1];
    if (failure && last && Date.now() < until + 60_000) {
      const trace = JSON.parse(fs.readFileSync(path.join(last.dir, 'trace.json'), 'utf8')).commands as Cmd[];
      const again = await replay(trace);
      last.repeats = again ? `${again.kind} at step ${again.step}` : 'no';
      console.log(`replay: ${last.repeats}`);
    }
  }
  const perMin = summary.steps / minutes;
  fs.writeFileSync(path.join(out, `run-${seed}.json`), JSON.stringify({ ...summary, actionsPerMinute: Math.round(perMin) }, null, 2));
  console.log(`seed ${seed}: ${summary.steps} steps (${Math.round(perMin)}/min), ${summary.refused} refused, ${summary.findings.length} findings, ${summary.restarts} app starts; rss ${summary.rss[0] ?? 0}..${summary.rss[summary.rss.length - 1] ?? 0} kB`);
}

await ensurePerfLock();
if (replayFile) {
  const saved = JSON.parse(fs.readFileSync(replayFile, 'utf8')) as { commands: Cmd[]; failure?: Failure };
  const f = await replay(saved.commands);
  console.log(f ? `replay failed: ${f.kind} at step ${f.step}: ${f.detail}` : 'replay passed');
  if (f && flag('shrink')) {
    const small = await shrink(saved.commands.slice(0, f.step + 1), f.kind, Number(opt('shrink-minutes', '8')) * 60_000);
    const file = path.join(out, `shrunk-${path.basename(path.dirname(replayFile))}.json`);
    fs.writeFileSync(file, JSON.stringify({ failure: f, commands: small }, null, 2));
    console.log(`shrunk to ${small.length} steps: ${file}`);
  }
} else {
  await fuzz();
}
