// What the runner does after an uncaught exception or unhandled rejection
// (main.ts). Mike, 21 Nov 2026: after one the process may be half way
// through something (a write that never finished, a map out of step with
// disk), so rather than carry on serving every thread like that it restarts
// the way a deploy does, and launch.mjs starts it again.
//
// The guard here stops that becoming a loop: an error that comes back at
// every start would otherwise restart the runner every few seconds and cut
// every thread's turn each time. After ERROR_EXITS restarts for errors
// within ERROR_EXIT_WINDOW_MS the next error is only logged, as before, and
// the apps are told; ERROR_QUIET_MS without an uncaught error clears it.
// The count is kept in <home>/run/error-exits.json, as each restart is a new
// process.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.ts';
import { atomicWriteFileSync } from './fsutil.ts';

export const ERROR_EXITS = 3;
export const ERROR_EXIT_WINDOW_MS = 10 * 60_000;
export const ERROR_QUIET_MS = 60 * 60_000;
// How long the shutdown after an error may take before the process exits
// anyway: a stop that hangs (a write that never returns, a second error
// mid-shutdown) must not leave a runner that serves nothing.
export const ERROR_STOP_DEADLINE_MS = 30_000;
// How long the restart after an error may take to begin (a stop, or a
// handover's new runner starting) before the runner stops instead. A
// handover first waits up to 3 minutes for a mail look to finish.
export const ERROR_LEAVE_DEADLINE_MS = 5 * 60_000;
// Exit code for a runner nothing restarts (a dev runner): EX_SOFTWARE, so
// dev-runner.sh stops and keeps its data dir rather than starting it again.
export const ERROR_EXIT_CODE = 70;

export type ErrorExitState = {
  // The release they happened on: a new one starts with a clean slate, so
  // a fix isn't held back by the broken release's count.
  release?: string;
  // When each recent restart for an error happened (ISO).
  exits: string[];
  // Set while the guard holds: the runner carries on after errors.
  tripped?: { at: string; lastErrorAt: string; errors: number };
};

export function errorExitsPath(home: string): string {
  return path.join(paths.run(home), 'error-exits.json');
}

const isoOk = (s: unknown): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s));

// Whatever is there, read leniently: a missing or broken file is no
// history, and so is another release's (`release`: this runner's, if any).
export function readErrorExits(home: string, release?: string): ErrorExitState {
  const fresh: ErrorExitState = release ? { release, exits: [] } : { exits: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(errorExitsPath(home), 'utf8')) as Partial<ErrorExitState>;
    if ((raw?.release ?? undefined) !== release) return fresh;
    const exits = Array.isArray(raw?.exits) ? raw.exits.filter(isoOk) : [];
    const t = raw?.tripped;
    const tripped = t && isoOk(t.at) && isoOk(t.lastErrorAt) ? { at: t.at, lastErrorAt: t.lastErrorAt, errors: Number.isFinite(t.errors) ? t.errors : 1 } : undefined;
    return { ...fresh, exits, ...(tripped ? { tripped } : {}) };
  } catch {
    return fresh;
  }
}

export function writeErrorExits(home: string, state: ErrorExitState): void {
  fs.mkdirSync(paths.run(home), { recursive: true });
  atomicWriteFileSync(errorExitsPath(home), JSON.stringify(state, null, 2) + '\n');
}

// Whether the guard still holds at `now`.
// A clock that went back since (the last error looks in the future) lets it go.
export function guardHolds(state: ErrorExitState, now: number): boolean {
  if (!state.tripped) return false;
  const age = now - Date.parse(state.tripped.lastErrorAt);
  return age >= 0 && age < ERROR_QUIET_MS;
}

export type ErrorExitDecision = {
  // Restart for this error, or carry on.
  exit: boolean;
  // This error is the one that tripped the guard.
  tripped: boolean;
  state: ErrorExitState;
};

// One uncaught error at `now`: restart, or carry on because the guard holds
// or this error trips it. Pure; the caller writes `state`.
export function decideErrorExit(state: ErrorExitState, now: number): ErrorExitDecision {
  const at = new Date(now).toISOString();
  const rel = state.release ? { release: state.release } : {};
  if (guardHolds(state, now)) {
    const t = state.tripped!;
    return { exit: false, tripped: false, state: { ...rel, exits: state.exits, tripped: { ...t, lastErrorAt: at, errors: t.errors + 1 } } };
  }
  // Quiet long enough (or never tripped): only recent restarts count.
  const recent = state.exits.filter((e) => {
    const t = Date.parse(e);
    return t > now - ERROR_EXIT_WINDOW_MS && t <= now;
  });
  if (recent.length >= ERROR_EXITS) return { exit: false, tripped: true, state: { ...rel, exits: recent, tripped: { at, lastErrorAt: at, errors: 1 } } };
  return { exit: true, tripped: false, state: { ...rel, exits: [...recent, at] } };
}

// What this runner can do after an uncaught error:
// - restart: launch.mjs supervises it (every installed runner on releases:
//   launchd on a Mac, systemd on Linux, the Scheduled Task on Windows) and
//   starts it again 0.5 s after a planned exit;
// - exit: a dev runner (dev-runner.sh): it stops, loudly, and isn't
//   started again, so the error is seen rather than restarted past;
// - carry on: anything else (tests, a runner started by hand, an install
//   with --from-source): nothing here can tell whether something would
//   start it again, so it logs and carries on, as before.
export type ErrorMode = 'restart' | 'exit' | 'carry on';

export function errorMode(o: { supervised: boolean; devRunner: boolean }): ErrorMode {
  if (o.supervised) return 'restart';
  if (o.devRunner) return 'exit';
  return 'carry on';
}

// The variables that say what this runner is for (dev-runner.sh's
// THREADBEAR_DEV_RUNNER, the test hook's), read once at start and taken out
// of the environment, so the CLIs it starts, and a runner a thread's test
// starts, don't inherit them.
export function takeErrorEnv(env: NodeJS.ProcessEnv): { devRunner: boolean; hookEnv: NodeJS.ProcessEnv } {
  const devRunner = env.THREADBEAR_DEV_RUNNER === '1';
  const hookEnv = { THREADBEAR_TEST_THROW: env.THREADBEAR_TEST_THROW, THREADBEAR_TEST_THROW_MS: env.THREADBEAR_TEST_THROW_MS };
  delete env.THREADBEAR_DEV_RUNNER;
  delete env.THREADBEAR_TEST_THROW;
  delete env.THREADBEAR_TEST_THROW_MS;
  return { devRunner, hookEnv };
}

export function guardNotice(state: ErrorExitState): string {
  const n = state.exits.length || ERROR_EXITS;
  return (
    `The runner restarted itself ${n} times in ${ERROR_EXIT_WINDOW_MS / 60_000} minutes after unexpected errors, ` +
    `so it has stopped restarting for them and carries on as it is. The errors are in the runner log (tb logs). ` +
    `It restarts for them again after an hour without one.`
  );
}

// The same folder, through symlinks and case-insensitive file systems too.
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const ra = real(a);
  const rb = real(b);
  if (ra === rb) return true;
  // macOS and Windows file systems usually ignore case.
  return process.platform !== 'linux' && ra.toLowerCase() === rb.toLowerCase();
}

// A test-only hook: THREADBEAR_TEST_THROW=exception|rejection throws one of
// those THREADBEAR_TEST_THROW_MS (default 500) after the runner is listening.
// Only from a checkout (never a release, which is what installed runners
// run) and never on the real data dir, so it can't reach Mike's runner.
export function testThrow(env: NodeJS.ProcessEnv, o: { release: string | undefined; home: string; realHome: string }): { kind: 'exception' | 'rejection'; afterMs: number } | undefined {
  const kind = env.THREADBEAR_TEST_THROW;
  if (kind !== 'exception' && kind !== 'rejection') return undefined;
  if (o.release || samePath(o.home, o.realHome)) return undefined;
  const ms = Number(env.THREADBEAR_TEST_THROW_MS);
  return { kind, afterMs: Number.isFinite(ms) && ms >= 0 ? ms : 500 };
}
