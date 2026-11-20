// A card only this runner's own app can allow, on a runner with no app
// (app-seen.ts): refused at once with what to do instead, never put up as a
// card the phone and other Macs could only deny (Mike, 18 Nov 2026: "What's
// the point in having this box if the only option is to deny?").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { APP_SEEN_DAYS, AppSeen, noAppToAllow } from '../../src/app-seen.ts';
import { toIndexRow } from '../../src/thread-index.ts';
import { remoteAllowRefused, REMOTE_ALLOW_REFUSED } from '../../src/tools.ts';

const DAY = 24 * 60 * 60_000;

test('app-seen: an app here lately counts, and the file keeps it across a restart', () => {
  const home = tmpDir();
  let now = 1_000_000;
  const a = new AppSeen(home, () => now);
  assert.equal(a.recently(), false, 'never seen');
  a.mark();
  assert.equal(a.recently(), true);
  now += (APP_SEEN_DAYS - 1) * DAY;
  assert.equal(new AppSeen(home, () => now).recently(), true, 'read back after a restart');
  now += 2 * DAY;
  assert.equal(new AppSeen(home, () => now).recently(), false, 'too long ago');
});

test('app-seen: an app seen by the runner that took over counts for a draining one', () => {
  const home = tmpDir();
  let now = 1_000_000;
  const draining = new AppSeen(home, () => now);
  assert.equal(draining.recently(), false);
  new AppSeen(home, () => now).mark();
  assert.equal(draining.recently(), true);
});

test('app-seen: a file that is not one leaves it unseen', () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'app-seen.json'), '{"at":"yesterday"}');
  assert.equal(new AppSeen(home, () => 0).recently(), false);
});

function setup(appCanAllow: boolean | undefined) {
  const h = makeHarness(tmpDir());
  if (appCanAllow !== undefined) h.runner.appCanAllow = () => appCanAllow;
  h.runner.ownName = 'Dell XPS';
  const { thread } = h.runner.create({ text: 'Fix the runner update', permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  return { h, id: thread.id, s };
}

const SCHEDULE = { name: 'mcp__threadbear__schedule_message', title: 'Run a shell command as you before each run: tb status', input: { text: 'look again', cron: '*/5 * * * *', check: 'tb status' } };

test('app-seen: with no app, a threadbear tool\'s own card is refused at once, saying what to do instead', async () => {
  const { h, id } = setup(false);
  const a = await h.runner.requestAgentApproval(id, SCHEDULE);
  assert.equal(a.decision, 'deny');
  assert.equal(a.noApp, true);
  assert.match(a.message!, /^Not done: Run a shell command as you before each run: tb status\. /);
  assert.match(a.message!, /\(Dell XPS\)/);
  assert.match(a.message!, /Do it a way that doesn't need the OK/);
  const ev = h.events(id);
  assert.equal(ev.filter((e) => e.type === 'approval.requested').length, 0, 'no card');
  assert.ok(ev.some((e) => e.type === 'system.note' && /^Not asked: Run a shell command/.test(e.text) && /Dell XPS/.test(e.text)));
  assert.equal(h.runner.get(id).needsYou, false);
});

test('app-seen: with an app, or with nothing said (tests, an older main), the card goes up as before', async () => {
  for (const can of [true, undefined]) {
    const { h, id } = setup(can);
    void h.runner.requestAgentApproval(id, SCHEDULE);
    await tick();
    assert.equal(h.events(id).filter((e) => e.type === 'approval.requested').length, 1, String(can));
  }
});

test('app-seen: with no app, a CLI card only the Mac could allow is refused, and one the phone can allow still goes up', async () => {
  const { h, id, s } = setup(false);
  const signal = new AbortController().signal;
  // An edit shows only its path off the Mac: only the Mac allows one.
  const edit = await s.sink.requestApproval({ toolUseId: 'tu-1', name: 'Edit', title: 'Edit notes.md', input: { file_path: '/w/notes.md', old_string: 'a', new_string: 'b' }, canAlwaysAllow: false, signal });
  assert.equal(edit.decision, 'deny');
  assert.match(edit.message!, /^Not done: Edit notes\.md\. /);
  // A short command reads whole on the phone, which can allow it.
  void s.sink.requestApproval({ toolUseId: 'tu-2', name: 'Bash', title: 'Run a command', input: { command: 'ls' }, canAlwaysAllow: false, signal });
  await tick();
  const cards = h.events(id).filter((e) => e.type === 'approval.requested');
  assert.deepEqual(cards.map((c) => c.name), ['Bash']);
});

test('app-seen: a plan is still put up, as its card does more than allow', async () => {
  const { h, id, s } = setup(false);
  void s.sink.requestApproval({ toolUseId: 'tu-plan', name: 'ExitPlanMode', title: 'Finish the plan', input: { plan: '...' }, canAlwaysAllow: false, signal: new AbortController().signal });
  await tick();
  assert.equal(h.events(id).filter((e) => e.type === 'approval.requested').length, 1);
});

test('app-seen: the refusal names the runner when it can', () => {
  assert.match(noAppToAllow('Edit x'), /connected straight to this runner can allow/);
  assert.match(noAppToAllow('Edit x', 'bruce'), /this runner \(bruce\)/);
});

test('a Deny-only card names where it can be allowed', () => {
  assert.equal(remoteAllowRefused('Dell XPS'), "It can't be shown in full here, so only the Threadbear app on Dell XPS can allow it.");
  assert.equal(remoteAllowRefused(), REMOTE_ALLOW_REFUSED);
});

test('a thread\'s sidebar row carries its mode, for a backend that takes it', () => {
  const { h, id } = setup(true);
  const t = h.runner.get(id);
  assert.equal(toIndexRow(t).permissionMode, 'ask');
  assert.equal(toIndexRow(t, true, true, true, true, false).permissionMode, undefined);
});
