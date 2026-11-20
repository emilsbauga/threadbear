// The web runtime (features/web-runtime.feature): the GPUI app's Chromium,
// installed on request and checked against its pinned build.
import { After, Given, Then, When } from '@cucumber/cucumber';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ThreadbearWorld } from '../support/world.ts';

/** The dump's `webRuntime` (desktop/gpui/src/web_runtime.rs). */
export type WebRuntimeInfo = { state: string; words: string; percent?: number | null; notNow: boolean; engine: string };
export const webRuntime = (d: unknown) => (d as { webRuntime?: WebRuntimeInfo | null }).webRuntime;

/** Unpacking 330 MB takes a while on a busy Tinker Desk. */
const INSTALL_SECONDS = 600;

// The step's own time, as the default 90 seconds is less than unpacking
// takes on a loaded Tinker Desk (it ran out there on 11 Nov).
When('I install the web runtime', { timeout: (INSTALL_SECONDS + 60) * 1000 }, async function (this: ThreadbearWorld) {
  // The pinned build downloaded once (support/world.ts skips this scenario
  // without one), handed over as a download would be, and checked the same.
  await this.app.do({ cmd: 'webRuntime', do: 'install', archive: process.env.TB_WEB_RUNTIME_ARCHIVE, wait: INSTALL_SECONDS }, INSTALL_SECONDS + 30);
});

When("I install the web runtime from a file that isn't the pinned build", async function (this: ThreadbearWorld) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-not-the-build-')), 'cef_binary_minimal.tar.bz2');
  fs.writeFileSync(file, 'Not Chromium, whatever the name says.');
  await this.app.do({ cmd: 'webRuntime', do: 'install', archive: file, wait: 60 }, 90);
});

Then("the web runtime says it's installed", async function (this: ThreadbearWorld) {
  await this.until('the web runtime installed', (d) => webRuntime(d)?.state === 'ready', 30_000);
});

Then("the web runtime isn't installed", async function (this: ThreadbearWorld) {
  await this.until('the web runtime not installed', (d) => ['missing', 'failed'].includes(webRuntime(d)?.state ?? ''));
});

Then("the web runtime says the download didn't match the pinned build", async function (this: ThreadbearWorld) {
  await this.until('a refused download', (d) => webRuntime(d)?.state === 'failed' && /didn't match the pinned build/.test(webRuntime(d)?.words ?? ''));
});

Then('the web runtime draws a page with no window', async function (this: ThreadbearWorld) {
  const out = JSON.parse(await this.app.do({ cmd: 'webRuntime', do: 'smoke', wait: 90 }, 120)) as { ok: boolean; width: number; height: number };
  // 400 by 120 CSS pixels, at twice that on a Retina screen's scale.
  if (!out.ok || out.width !== 800 || out.height !== 240) throw new Error(`The page's picture was ${JSON.stringify(out)}`);
});

Then('Settings says the web runtime is {string}', async function (this: ThreadbearWorld, words: string) {
  await this.until(`Settings saying the web runtime is "${words}"`, (d) => (d as { settingsWindow?: { webRuntime?: string } | null }).settingsWindow?.webRuntime === words);
});

// A stand-in for a handover's old copy: a process that's alive, named in the
// profile's lock as Chromium names its own ("<host>-<pid>").
let holder: ChildProcess | undefined;

After(function () {
  holder?.kill();
  holder = undefined;
});

Given("another process has the web runtime's profile", function (this: ThreadbearWorld) {
  const root = process.env.THREADBEAR_WEB_RUNTIME_DIR;
  if (!root) throw new Error('no web runtime folder for this scenario');
  const profile = process.env.THREADBEAR_WEB_PROFILE_DIR || path.join(root, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  holder = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
  const lock = path.join(profile, 'SingletonLock');
  fs.rmSync(lock, { force: true });
  fs.symlinkSync(`${os.hostname()}-${holder.pid}`, lock);
});

When('something needs the web runtime', async function (this: ThreadbearWorld) {
  // Asks for Chromium and gives up waiting after a second: it's meant to
  // be waiting still.
  await this.app.do({ cmd: 'webRuntime', do: 'start', wait: 1 }, 30).catch(() => {});
});

Then('the web runtime waits for that process', async function (this: ThreadbearWorld) {
  const engine = `waiting for pid ${holder?.pid}`;
  await this.until(`the web runtime ${engine}`, (d) => webRuntime(d)?.engine === engine);
  // And still is a few seconds on, rather than having tried and failed.
  await new Promise((r) => setTimeout(r, 3000));
  await this.until(`the web runtime still ${engine}`, (d) => webRuntime(d)?.engine === engine);
});

When('that process quits', function () {
  holder?.kill();
  holder = undefined;
});
