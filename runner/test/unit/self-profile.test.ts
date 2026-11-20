import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfProfiler, summarize, watchStalls, type CpuProfile } from '../../src/self-profile.ts';
import { nullLogger, type Logger } from '../../src/log.ts';

const frame = (functionName: string, url = '', lineNumber = 0) => ({ functionName, url, lineNumber, columnNumber: 0 });

test('summarize charges a node:fs call to the runner function that made it', () => {
  // root > tick (src/folder-cache.ts) > walk (src/folder-cache.ts) > readdirSync (node:fs)
  //      > (idle)
  const p: CpuProfile = {
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 5, 6] },
      { id: 2, callFrame: frame('tick', 'file:///x/runner/src/folder-cache.ts', 9), children: [3] },
      { id: 3, callFrame: frame('walk', 'file:///x/runner/src/folder-cache.ts', 19), children: [4] },
      { id: 4, callFrame: frame('readdirSync', 'node:fs', 1) },
      { id: 5, callFrame: frame('(idle)') },
      { id: 6, callFrame: frame('(garbage collector)') },
    ],
    startTime: 0,
    endTime: 10_000,
    // Four samples in readdirSync, one in walk itself, three idle, one GC.
    samples: [4, 4, 4, 4, 3, 5, 5, 5, 6],
    timeDeltas: [0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
  };
  const s = summarize(p);
  assert.equal(s.ms, 10);
  // The last sample's time isn't known (no next delta), as in DevTools.
  assert.equal(s.gcMs, 0);
  assert.equal(s.busyMs, 5);
  assert.deepEqual(s.self[0], { name: 'readdirSync', where: 'node:fs:2', ms: 4, pct: 40 });
  assert.deepEqual(s.own[0], { name: 'walk', where: 'src/folder-cache.ts:20', ms: 5, pct: 50 });
  assert.equal(s.own.length, 1);
  const tick = s.total.find((l) => l.name === 'tick');
  assert.equal(tick?.ms, 5);
  assert.ok(!s.total.some((l) => l.name === '(root)' || l.name === '(idle)'));
});

test('a recursive function is counted once per sample in total', () => {
  const p: CpuProfile = {
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2] },
      { id: 2, callFrame: frame('walk', 'file:///r/src/a.ts', 0), children: [3] },
      { id: 3, callFrame: frame('walk', 'file:///r/src/a.ts', 0) },
    ],
    startTime: 0,
    endTime: 2000,
    samples: [3, 3],
    timeDeltas: [0, 1000, 1000],
  };
  assert.equal(summarize(p).total[0].ms, 2);
});

test('profile writes a .cpuprofile and refuses a second at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-profile-'));
  try {
    const p = new SelfProfiler({ dir, log: nullLogger });
    const first = p.profile(0.3);
    await assert.rejects(p.profile(1), /already running/);
    const end = Date.now() + 100;
    while (Date.now() < end) fs.readdirSync(dir);
    const r = await first;
    assert.ok(r.file.startsWith(dir) && r.file.endsWith('.cpuprofile'));
    const saved = JSON.parse(fs.readFileSync(r.file, 'utf8')) as CpuProfile;
    assert.ok(saved.nodes.length > 0);
    assert.ok(r.summary.busyMs >= 50, `busy ${r.summary.busyMs}`);
    await assert.rejects(p.profile(0), /at most 120/);
    await assert.rejects(p.profile(121), /at most 120/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watchStalls logs a timer that fires a second late, and not one on time', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const lines: { msg: string; extra?: Record<string, unknown> }[] = [];
  const log: Logger = { ...nullLogger, info: (msg, extra) => lines.push({ msg, extra }) };
  let clock = 0;
  const stop = watchStalls({ log, everyMs: 250, now: () => clock });
  try {
    // On time, and a little late: nothing.
    for (const late of [0, 0, 400]) {
      clock += 250 + late;
      t.mock.timers.tick(250);
    }
    assert.equal(lines.length, 0);
    // The loop held for 1.5 s past when the timer was due.
    clock += 250 + 1500;
    t.mock.timers.tick(250);
    assert.deepEqual(lines, [{ msg: 'event loop stalled', extra: { ms: 1500 } }]);
  } finally {
    stop();
  }
});
