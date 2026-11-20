// The GPUI app's setup cards (hello.rs), end to end, against a real runner:
// a dev runner on a throwaway data folder (runner/scripts/dev-runner.sh) and
// a scripted GPUI app on it (desktop/scripts/dev-app.sh --home), as a new
// install opens them. It goes through every card as someone would, checks
// what each shows and that its switches reach the runner, checks Done
// leaves a new thread ready to type in, and saves a dark shot of each card.
//
//   node desktop/scripts/hello-e2e.mjs [--shots DIR] [--keep] [--no-build]
//
// Sign in… and Add open Terminal, so they're left to a person trying the
// cards on a desktop nobody's using (Tinker Desk's, through remote.sh
// --desk). Never touches the live runner or the installed app.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const desktop = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(desktop, '..');
const devApp = path.join(desktop, 'scripts', 'dev-app.sh');
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'gpui-hello-e2e-'));
const keep = args.includes('--keep');
const noBuild = args.includes('--no-build');
const id = `gpui-hello-e2e-${process.pid}`;
fs.mkdirSync(shots, { recursive: true });

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One automation command; its result, without the command's name. An error
// comes back as the line all the same.
function run(command) {
  let out;
  try {
    out = execFileSync('bash', [devApp, 'do', '--id', id, JSON.stringify(command)], { encoding: 'utf8', timeout: 120_000 });
  } catch (error) {
    out = String(error.stdout ?? '') + String(error.stderr ?? '');
  }
  return out.trim().split('\n').pop().replace(/^\S+ /, '');
}
function dump() {
  try {
    return JSON.parse(execFileSync('bash', [devApp, 'dump', '--id', id, '--json'], { encoding: 'utf8', timeout: 60_000 }));
  } catch {
    return {};
  }
}
const hello = () => run({ cmd: 'hello' });
let shotNo = 0;
function shot(name) {
  const file = path.join(shots, `${String(++shotNo).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
  try {
    execFileSync('bash', [devApp, 'shot', '--id', id, file], { stdio: 'ignore', timeout: 60_000 });
  } catch {
    // A shot that fails doesn't fail the run.
  }
}

async function until(what, test, seconds = 20) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const value = test();
    if (value) return value;
    if (Date.now() > end) return check(what, false, 'timed out');
    await sleep(500);
  }
}


// The dev runner, in the background, on a temp data folder.
const runnerLog = path.join(shots, 'dev-runner.out');
const runner = spawn('bash', [path.join(repo, 'runner', 'scripts', 'dev-runner.sh')], { detached: true, stdio: ['ignore', fs.openSync(runnerLog, 'w'), fs.openSync(runnerLog, 'a')] });
runner.unref();
let appStarted = false;

async function main() {
  const home = await until('dev runner started', () => /^ {2}data: (.+?)(?: \(deleted|$)/m.exec(fs.readFileSync(runnerLog, 'utf8'))?.[1], 120);
  if (!home) return;
  await until('dev runner listening', () => fs.existsSync(path.join(home, 'runner.json')) && fs.existsSync(path.join(home, 'secrets', 'runner-token')), 60);
  // As a new install opens: the first-run start allowed in a scripted app.
  process.env.THREADBEAR_TOUR_AUTOSTART = '1';
  execFileSync('bash', [devApp, 'start', '--home', home, '--id', id, '--appearance', 'dark', ...(noBuild ? ['--no-build'] : [])], { stdio: 'inherit', timeout: 1_800_000, env: process.env });
  appStarted = true;
  await until('app connected', () => dump().connection === 'connected', 30);

  const first = await until('a new install gets the cards by itself', () => {
    const h = dump().hello;
    return h?.card === 'welcome' && h;
  }, 20);
  check('not the tour', run({ cmd: 'tour' }).startsWith('ok off'), run({ cmd: 'tour' }));
  if (!first) return;
  check('no Phone card without a backend to pair with', !first.cards.includes('phone'), first.cards.join(' '));
  shot('welcome');

  const go = (expect) => {
    const line = run({ cmd: 'hello', do: 'next' });
    check(`on to ${expect}`, new RegExp(`^ok \\d+/\\d+ ${expect}$`).test(line), line);
    return dump().hello;
  };

  let h = go('agents');
  const agents = h?.agents ?? [];
  check('the agents card lists the logins it found', agents.length > 0, JSON.stringify(agents));
  check('and says one is signed in', agents.some((a) => a.ready), JSON.stringify(agents));
  shot('agents');

  h = go('folder');
  await until('GitHub looked up', () => dump().hello?.gh !== null && dump().hello?.gh !== undefined, 15);
  shot('folder');
  check('Back goes back', run({ cmd: 'hello', do: 'back' }) === 'ok 2/' + h.count + ' agents', hello());
  run({ cmd: 'hello', do: 'next' });

  h = go('extras');
  shot('extras');
  // A switch on the card reaches the runner: Keep the Mac awake, off and on.
  const awake = () => JSON.parse(fs.readFileSync(path.join(home, 'runner.json'), 'utf8')).keepAwake;
  run({ cmd: 'click', title: 'Stop your Mac sleeping on its own while a thread is working' });
  await until('Keep the Mac awake saved to the runner', () => awake() === false, 10);
  run({ cmd: 'click', title: 'Stop your Mac sleeping on its own while a thread is working' });
  await until('and back on', () => awake() === true, 10);

  // Done on the last card: the cards go and a new thread waits, its box empty.
  run({ cmd: 'hello', do: 'next' });
  check('Done puts the cards away', hello() === 'ok off', hello());
  const done = await until('a new thread, ready to type in', () => {
    const d = dump();
    return !d.selection && d.composer?.draft === 'new' && d;
  }, 10);
  if (done) {
    shot('done');
    check('its box is empty', !done.composer?.text, done.composer?.text);
    check('Finish setting up opens with what\'s left', done.setup?.shown === true, JSON.stringify(done.setup));
  }
  check('the cards don\'t come back by themselves', JSON.parse(fs.readFileSync(path.join(home, 'desktop-settings.json'), 'utf8')).tourSeen === true);

  // Help brings them back.
  run({ cmd: 'menu-item', title: 'Set Up Threadbear' });
  await until('Help > Set Up Threadbear opens them', () => dump().hello?.card === 'welcome', 10);
}

try {
  await main();
} catch (error) {
  check('the run itself', false, error.message.split('\n')[0]);
} finally {
  if (appStarted) {
    try {
      execFileSync('bash', [devApp, 'stop', '--id', id], { stdio: 'ignore', timeout: 60_000 });
    } catch {}
  }
  // The dev runner's own pid, as it printed it (never pkill: the live runner
  // runs the same file).
  const pid = /^ {2}pid: {2}(\d+)/m.exec(fs.readFileSync(runnerLog, 'utf8'))?.[1];
  if (pid && !keep) {
    try {
      process.kill(+pid);
    } catch {}
  }
  console.log(`\n${failures.length ? `${failures.length} failed` : 'all passed'}. Shots in ${shots}`);
  process.exitCode = failures.length ? 1 : 0;
}
