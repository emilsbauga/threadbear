#!/usr/bin/env node
// Runs the GPUI specs under shaken conditions, to find what only fails
// sometimes: a slow runner answering out of order, another window size, dark,
// Reduce Motion, a random scenario order. One round per call, cut off at its
// time limit, so it can take its turn on a check host between other work:
//
//   desktop/scripts/remote.sh tinker-desk --desk -- node features/tools/stress.mjs \
//     --cond slow+dark --shard 2/6 [--seed 7] [--tags '@x'] [--repeat 3] [--minutes 9] [file.feature...]
//
// Conditions (join with +): plain, order (random order only; every round
// shuffles anyway), motion, dark, narrow, wide, slow.
//
// Each scenario's result goes to <out>/results.jsonl as it ends
// (TB_STRESS_LOG, support/world.ts), and failure pictures to <out>/failures.
// <out> is ~/.cache/threadbear-check/stress-out/<time>-<cond> unless --out,
// so a check host still looks like one with nothing of Threadbear's on it.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONDITIONS = {
  plain: {},
  order: {},
  motion: { TB_REDUCE_MOTION: 'on' },
  dark: { TB_STRESS_APPEARANCE: 'dark' },
  narrow: { TB_STRESS_SIZE: '900x640' },
  wide: { TB_STRESS_SIZE: '1680x1050' },
  // Every request answered up to 400 ms late, at random, so answers can
  // overtake each other; reading a thread and the list a little later still.
  slow: { TB_STRESS_JITTER_MS: '400', TB_STRESS_EVENTS_DELAY_MS: '700', TB_STRESS_LIST_DELAY_MS: '700' },
};

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const [value] = args.splice(at, 2).slice(1);
  return value;
};
const cond = opt('cond', 'plain');
const shard = opt('shard', '');
const tags = opt('tags', '');
const seed = Number(opt('seed', String(Math.floor(Math.random() * 1e6))));
const repeat = Number(opt('repeat', '1'));
const minutes = Number(opt('minutes', '9'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.resolve(opt('out', path.join(os.homedir(), '.cache/threadbear-check/stress-out', `${stamp}-${cond}`)));
const files = args.filter((a) => /\.feature(:\d+)*$/.test(a));

const env = {};
for (const c of cond.split('+')) {
  if (!(c in CONDITIONS)) throw new Error(`unknown condition ${c}: one of ${Object.keys(CONDITIONS).join(', ')}`);
  Object.assign(env, CONDITIONS[c]);
}
fs.mkdirSync(path.join(out, 'failures'), { recursive: true });
const deadline = Date.now() + minutes * 60_000;

// The app, built once and copied somewhere private, as spec.sh does.
console.log(`stress: building (${cond})`);
execFileSync('cargo', ['build', '-p', 'threadbear-gpui', '--features', 'automation'], { cwd: path.join(root, 'desktop'), stdio: ['ignore', 'ignore', 'inherit'] });
const target = process.env.CARGO_TARGET_DIR ?? path.join(root, 'desktop/target');
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-gpui-'));
for (const f of ['threadbear-gpui', 'threadbear-web-helper']) fs.copyFileSync(path.join(target, 'debug', f), path.join(bin, f));
fs.chmodSync(path.join(bin, 'threadbear-gpui'), 0o755);
fs.chmodSync(path.join(bin, 'threadbear-web-helper'), 0o755);

const log = path.join(out, 'results.jsonl');
const meta = { cond, env, shard, tags, seed, repeat, minutes, files, started: new Date().toISOString(), host: os.hostname(), rounds: [] };
const failuresDir = path.join(root, 'features/reports/failures');

for (let i = 0; i < repeat && Date.now() < deadline - 30_000; i++) {
  const roundSeed = seed + i;
  fs.rmSync(failuresDir, { recursive: true, force: true });
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  const before = lines();
  const cucumber = spawn(path.join(root, 'features/node_modules/.bin/cucumber-js'), ['--order', `random:${roundSeed}`, ...files], {
    cwd: path.join(root, 'features'),
    env: {
      ...process.env, ...env,
      TB_APP: 'gpui', TB_GPUI_BIN: path.join(bin, 'threadbear-gpui'), TB_STRESS_LOG: log,
      ...(shard ? { TB_SHARD: shard } : {}), ...(tags ? { TB_TAGS: tags } : {}),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  });
  let cut = false;
  const timer = setTimeout(() => {
    cut = true;
    try { process.kill(-cucumber.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-cucumber.pid, 'SIGKILL'); } catch {} }, 15_000).unref();
  }, Math.max(1000, deadline - Date.now()));
  const code = await new Promise((done) => cucumber.once('exit', (c) => done(c)));
  clearTimeout(timer);
  for (const f of fs.existsSync(failuresDir) ? fs.readdirSync(failuresDir) : []) {
    // A copy, not a rename: on Tinker Desk the cache's folders aren't all on
    // one disk (EXDEV, 18 Nov).
    fs.copyFileSync(path.join(failuresDir, f), path.join(out, 'failures', `r${i}-${f}`));
    fs.rmSync(path.join(failuresDir, f), { force: true });
  }
  const ran = lines() - before;
  meta.rounds.push({ seed: roundSeed, code, cut, scenarios: ran });
  console.log(`stress: round ${i + 1}/${repeat} seed ${roundSeed}: ${ran} scenarios, exit ${code}${cut ? ' (cut at the time limit)' : ''}`);
  if (cut) break;
}
meta.ended = new Date().toISOString();
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));
fs.rmSync(bin, { recursive: true, force: true });

const results = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const count = {};
for (const r of results) count[r.status] = (count[r.status] ?? 0) + 1;
console.log(`stress: ${out}\nstress: ${JSON.stringify(count)}`);
for (const r of results.filter((r) => r.status === 'FAILED')) console.log(`FAILED ${r.uri}: ${r.name}\n  ${r.message.split('\n')[0].slice(0, 300)}`);
