// Keeps the Mac from going to sleep on its own while a thread is working
// (on unless runner.json's `keepAwake` is false, Settings > General; an
// experiment from 6 to 10 Nov 2026). Without it, a long turn on a
// Mac left alone stopped when the Mac slept, and a thread steered from the
// phone sat there until someone woke the Mac. Conductor, Synara, Zuse and
// Autohand all do this (6 Nov 2026, thread d698c77d).
//
// It runs macOS's own `caffeinate -i` while any thread has a turn,
// background job or sub-agent going, and for a few minutes after, so a
// quick run of turns doesn't start and stop it each time. -i only stops
// idle sleep: the display still sleeps and the screen still locks, and
// closing the lid still sleeps a Mac on battery. -w ties it to the
// runner's pid, so it ends with the runner however that goes. On battery
// it lets go below LOW_BATTERY percent.
// On Windows the runner's helper holds SetThreadExecutionState instead
// (win32-helper.ps1, awake), the same idle-sleep-only hold, which ends with
// the helper. A helper started again (one too slow to answer is) holds
// nothing, so each sweep asks again while it's held. Linux: a no-op.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import { win32Helper } from './win32-helper.ts';

export const SWEEP_MS = 30_000;
// How long it stays awake after the last thread stops working.
export const LINGER_MS = 3 * 60_000;
export const LOW_BATTERY = 15;
// How often the battery is read while awake (a spawn, so not every sweep).
export const BATTERY_EVERY_MS = 2 * 60_000;

export type Power = { onBattery: boolean; percent?: number };

export type KeepAwakeDeps = {
  busy: () => number; // threads working now
  on: () => boolean; // the setting, read each sweep
  clock: Clock;
  log: Logger;
  // Starts caffeinate and returns a handle to stop it; replaced in tests.
  hold?: () => Hold | undefined;
  power?: () => Promise<Power | undefined>;
};

// `renew`: said again each sweep it's held, for a hold that can be lost
// without the runner seeing (Windows' helper started again).
export type Hold = { stop(): void; renew?(): void };

export class KeepAwake {
  private deps: KeepAwakeDeps;
  private timer?: TimerHandle;
  private held?: Hold;
  private lastBusy = 0;
  private power?: Power;
  private powerAt = 0;
  private reading = false;

  constructor(deps: KeepAwakeDeps) {
    this.deps = deps;
  }

  start(): void {
    this.sweep();
  }

  stop(): void {
    this.timer?.cancel();
    this.timer = undefined;
    this.release('the runner stopped');
  }

  status(): { holding: boolean } {
    return { holding: Boolean(this.held) };
  }

  sweep(): void {
    this.timer = this.deps.clock.setTimeout(() => this.sweep(), SWEEP_MS);
    const now = this.deps.clock.now();
    if (!this.deps.on()) return this.release('the experiment is off');
    if (this.deps.busy() > 0) this.lastBusy = now;
    const wanted = this.lastBusy > 0 && now - this.lastBusy < LINGER_MS;
    if (!wanted) return this.release('no thread is working');
    // Read before the low-battery check too, so plugging in is noticed.
    if (now - this.powerAt >= BATTERY_EVERY_MS) this.readPower(now);
    if (this.lowBattery()) return this.release('the battery is low');
    if (!this.held) {
      this.held = (this.deps.hold ?? defaultHold)();
      if (this.held) this.deps.log.info('keeping the computer awake while threads work');
    } else this.held.renew?.();
  }

  private lowBattery(): boolean {
    const p = this.power;
    return Boolean(p?.onBattery && p.percent !== undefined && p.percent < LOW_BATTERY);
  }

  private readPower(now: number): void {
    if (this.reading) return;
    this.reading = true;
    this.powerAt = now;
    (this.deps.power ?? readPower)()
      .then((p) => {
        this.power = p;
        if (this.lowBattery()) this.release('the battery is low');
      })
      .catch(() => undefined)
      .finally(() => {
        this.reading = false;
      });
  }

  private release(why: string): void {
    if (!this.held) return;
    this.held.stop();
    this.held = undefined;
    this.deps.log.info('letting the computer sleep again', { why });
  }
}

function defaultHold(): Hold | undefined {
  return process.platform === 'win32' ? helperHold() : caffeinate();
}

function helperHold(): Hold {
  const ask = (on: number) => void win32Helper().ask('awake', { on }).catch(() => undefined);
  ask(1);
  return { stop: () => ask(0), renew: () => ask(1) };
}

function caffeinate(): Hold | undefined {
  if (process.platform !== 'darwin') return undefined;
  let child: ChildProcess;
  try {
    child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  } catch {
    return undefined;
  }
  child.on('error', () => undefined);
  return { stop: () => void child.kill() };
}

// `pmset -g batt`: "Now drawing from 'Battery Power'" and "-InternalBattery-0 (id=…)	87%; discharging".
function readPower(): Promise<Power | undefined> {
  if (process.platform === 'win32') return win32Helper().ask('power').then(parseWinPower, () => undefined);
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      resolve(parsePower(String(stdout)));
    });
  });
}

export function parsePower(out: string): Power | undefined {
  if (!out.trim()) return undefined;
  const pct = /(\d{1,3})%/.exec(out);
  return { onBattery: /'Battery Power'/.test(out), ...(pct ? { percent: Number(pct[1]) } : {}) };
}

// The helper's answer to power: "<on battery 0|1> <percent, -1 unknown>".
export function parseWinPower(text: string): Power | undefined {
  const m = /^([01]) (-1|\d{1,3})$/.exec(text.trim());
  if (!m) return undefined;
  return { onBattery: m[1] === '1', ...(m[2] !== '-1' ? { percent: Number(m[2]) } : {}) };
}
