import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/fakes.ts';
import { nullLogger } from '../../src/log.ts';
import {
  StuckJobs,
  QUIET_MS,
  SWEEP_MS,
  cpuTime,
  isCliFor,
  parseLsof,
  parsePs,
  waitsOnUserMs,
  WAIT_GRACE_MS,
  type BackgroundShell,
  type Probe,
  type TaskFile,
} from '../../src/stuck-jobs.ts';

const MIN = 60_000;

// Output files and shells the test sets by hand.
class FakeProbe implements Probe {
  files = new Map<string, TaskFile>();
  shellsBySession = new Map<string, BackgroundShell[]>();
  async taskFile(_sessionId: string, taskId: string) {
    return this.files.get(taskId);
  }
  async shells(sessionIds: string[]) {
    return new Map(sessionIds.map((s) => [s, this.shellsBySession.get(s) ?? []] as [string, BackgroundShell[]]));
  }
}

function setUp() {
  const h = makeHarness();
  const probe = new FakeProbe();
  const jobs = new StuckJobs({ host: h.runner, clock: h.clock, log: nullLogger, home: h.home, probe });
  const { thread } = h.runner.create({ text: 'Cut the interview', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  return { h, probe, jobs, thread, s };
}

// The idle thread's CLI session, which its shells are listed under.
const session = (h: ReturnType<typeof makeHarness>) => {
  const [idle] = h.runner.idleBackground();
  assert.ok(idle, 'the thread is idle with background work');
  return idle.sessionId;
};

const nudges = (h: ReturnType<typeof makeHarness>, threadId: string) =>
  h.events(threadId).filter((e) => e.type === 'user.message' && e.origin === 'runner').map((e) => String(e.text));

const waiter = { id: 'b1', type: 'local_bash', kind: 'shell' as const, description: 'until ! pgrep -f snip2.py; do sleep 3; done' };

test('an idle thread whose shell has sat quiet and idle gets one message about it', async () => {
  const { h, probe, jobs, thread, s } = setUp();
  s.out({ kind: 'tasks', tasks: [waiter] });
  s.result('completed');
  const started = h.clock.now();
  probe.files.set('b1', { startedAt: started, lastOutputAt: started });
  probe.shellsBySession.set(session(h), [{ taskId: 'b1', cpuSeconds: 0.5, commands: ['zsh', 'sleep'] }]);

  // Not yet half an hour.
  h.clock.advance(20 * MIN);
  await jobs.sweep();
  assert.deepEqual(nudges(h, thread.id), []);

  // Old and quiet enough, but the first look only notes its CPU.
  h.clock.advance(15 * MIN);
  await jobs.sweep();
  assert.deepEqual(nudges(h, thread.id), []);

  // Barely any CPU since: stuck.
  probe.shellsBySession.set(session(h), [{ taskId: 'b1', cpuSeconds: 0.9, commands: ['zsh', 'sleep'] }]);
  h.clock.advance(5 * MIN);
  await jobs.sweep();
  const said = nudges(h, thread.id);
  assert.equal(said.length, 1);
  assert.match(said[0], /stuck-job check/);
  assert.match(said[0], /snip2\.py.*\(shell, 40 min, running zsh, sleep\)/);
  assert.match(said[0], /ask the user in end_turn/);

  // Once only, even after the turn it started has ended.
  s.result('completed');
  h.clock.advance(10 * MIN);
  await jobs.sweep();
  assert.equal(nudges(h, thread.id).length, 1);
});

test('a shell still using CPU, or still writing output, is left alone', async () => {
  const { h, probe, jobs, thread, s } = setUp();
  s.out({ kind: 'tasks', tasks: [{ id: 'b2', type: 'local_bash', kind: 'shell', description: 'xcodebuild | tail -5' }] });
  s.result('completed');
  const started = h.clock.now();
  probe.files.set('b2', { startedAt: started, lastOutputAt: started });
  probe.shellsBySession.set(session(h), [{ taskId: 'b2', cpuSeconds: 100, commands: ['zsh', 'xcodebuild'] }]);
  h.clock.advance(35 * MIN);
  await jobs.sweep();
  probe.shellsBySession.set(session(h), [{ taskId: 'b2', cpuSeconds: 400, commands: ['zsh', 'xcodebuild'] }]);
  h.clock.advance(5 * MIN);
  await jobs.sweep();
  assert.deepEqual(nudges(h, thread.id), []);

  // Idle CPU but it wrote output a minute ago.
  probe.files.set('b2', { startedAt: started, lastOutputAt: h.clock.now() - MIN });
  probe.shellsBySession.set(session(h), [{ taskId: 'b2', cpuSeconds: 400, commands: ['zsh', 'xcodebuild'] }]);
  h.clock.advance(5 * MIN);
  await jobs.sweep();
  assert.deepEqual(nudges(h, thread.id), []);
});

test('a sub-agent whose transcript has gone quiet counts; a monitor never does', async () => {
  const { h, probe, jobs, thread, s } = setUp();
  s.out({
    kind: 'tasks',
    tasks: [
      { id: 'a1', type: 'local_agent', kind: 'agent', description: 'James interview round 1 cut' },
      { id: 'm1', type: 'monitor', kind: 'monitor', description: 'Watch the deploy' },
    ],
  });
  s.result('completed');
  const started = h.clock.now();
  probe.files.set('a1', { startedAt: started, lastOutputAt: started + 2 * MIN });
  probe.files.set('m1', { startedAt: started, lastOutputAt: started });
  h.clock.advance(QUIET_MS + 3 * MIN);
  await jobs.sweep();
  const said = nudges(h, thread.id);
  assert.equal(said.length, 1);
  assert.match(said[0], /James interview round 1 cut \(sub-agent, 33 min\)/);
  assert.doesNotMatch(said[0], /deploy/);
});

test('a thread with a turn going is not looked at', async () => {
  const { h, probe, jobs, thread, s } = setUp();
  s.out({ kind: 'tasks', tasks: [{ id: 'a1', type: 'local_agent', kind: 'agent', description: 'Long research' }] });
  probe.files.set('a1', { startedAt: h.clock.now(), lastOutputAt: h.clock.now() });
  h.clock.advance(QUIET_MS + MIN);
  await jobs.sweep();
  assert.deepEqual(nudges(h, thread.id), []);
});

test('start() looks every few minutes until stopped', async () => {
  const { h, probe, jobs, thread, s } = setUp();
  s.out({ kind: 'tasks', tasks: [{ id: 'a1', type: 'local_agent', kind: 'agent', description: 'Long research' }] });
  s.result('completed');
  probe.files.set('a1', { startedAt: h.clock.now(), lastOutputAt: h.clock.now() });
  jobs.start();
  for (let i = 0; i < 7; i++) {
    h.clock.advance(SWEEP_MS);
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(nudges(h, thread.id).length, 1);
  jobs.stop();
});

test('ps, lsof and CLI matching', () => {
  assert.equal(cpuTime('0:00.52'), 0.52);
  assert.equal(cpuTime('12:03.50'), 723.5);
  assert.equal(cpuTime('1:02:03.00'), 3723);
  assert.equal(cpuTime('2-01:00:00.00'), 2 * 86_400 + 3600);
  assert.deepEqual(parsePs('  9896 39636   0:00.52    01:05 /bin/zsh -c source x\n39636 30110 1:02.00 1-02:00:00 /Users/m/.local/bin/claude --resume=abc\n'), [
    { pid: 9896, ppid: 39636, cpuSeconds: 0.52, ageSeconds: 65, command: '/bin/zsh -c source x' },
    { pid: 39636, ppid: 30110, cpuSeconds: 62, ageSeconds: 86_400 + 7200, command: '/Users/m/.local/bin/claude --resume=abc' },
  ]);
  assert.deepEqual([...parseLsof('p9896\nf1\nn/private/tmp/claude-501/p/s/tasks/bwjre5i4r.output\np12\nf1\nn/dev/null\n')], [
    [9896, '/private/tmp/claude-501/p/s/tasks/bwjre5i4r.output'],
    [12, '/dev/null'],
  ]);
  const id = 'df8b9dea-7e3f-48d1-bf21-4bf82ca08719';
  assert.ok(isCliFor(`/Users/m/.local/bin/claude --output-format stream-json --resume=${id} --setting-sources=user`, id));
  assert.ok(isCliFor(`claude --session-id ${id}`, id));
  // A background shell reading another task's output names the session too.
  assert.ok(!isCliFor(`/bin/zsh -c source /Users/m/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'cat /tmp/claude-501/p/${id}/tasks/b.output'`, id));
});

test('a browserbear handoff --wait is left alone until its own timeout, then counts', async () => {
  const { h, probe, jobs, thread, s } = setUp();
  const handoff = { id: 'b2', type: 'local_bash', kind: 'shell' as const, description: 'Wait for Mike to sign in' };
  s.out({ kind: 'tasks', tasks: [handoff] });
  s.result('completed');
  const started = h.clock.now();
  probe.files.set('b2', { startedAt: started, lastOutputAt: started });
  // The script sleeps ten minutes before the handoff starts.
  const handoffStarted = started + 10 * MIN;
  const shell = (cpuSeconds: number): BackgroundShell => ({
    taskId: 'b2',
    cpuSeconds,
    commands: ['zsh', 'node'],
    processes: [
      { command: "/bin/zsh -c source /x/shell-snapshots/snapshot-zsh.sh && eval 'sleep 600; browserbear handoff 12 --wait --timeout 3600'", startedAt: started },
      { command: 'node /Users/m/.local/bin/browserbear handoff 12 --wait --timeout 3600', startedAt: handoffStarted },
    ],
  });
  probe.shellsBySession.set(session(h), [shell(0.1)]);

  // Quiet and idle for 70 minutes, well past 30, but the handoff said it'd
  // wait an hour from when it started.
  for (let i = 0; i < 14; i++) {
    h.clock.advance(5 * MIN);
    await jobs.sweep();
  }
  assert.deepEqual(nudges(h, thread.id), []);

  // Past its timeout and the grace: it should have exited, so it's stuck.
  h.clock.advance(handoffStarted + 60 * MIN + WAIT_GRACE_MS - h.clock.now());
  await jobs.sweep();
  probe.shellsBySession.set(session(h), [shell(0.2)]);
  h.clock.advance(5 * MIN);
  await jobs.sweep();
  assert.equal(nudges(h, thread.id).length, 1);
});

test('a stuck loop whose shell text only mentions a handoff still counts', async () => {
  const { h, probe, jobs, thread, s } = setUp();
  s.out({ kind: 'tasks', tasks: [waiter] });
  s.result('completed');
  const started = h.clock.now();
  probe.files.set('b1', { startedAt: started, lastOutputAt: started });
  const line = "/bin/zsh -c source /x/shell-snapshots/snapshot-zsh.sh && eval 'false && browserbear handoff 12 --wait --timeout 86400; while true; do sleep 3; done'";
  const shell = (cpuSeconds: number): BackgroundShell => ({
    taskId: 'b1',
    cpuSeconds,
    commands: ['zsh', 'sleep'],
    processes: [{ command: line, startedAt: started }, { command: 'sleep 3', startedAt: h.clock.now() }],
  });
  probe.shellsBySession.set(session(h), [shell(0.1)]);
  h.clock.advance(35 * MIN);
  await jobs.sweep();
  probe.shellsBySession.set(session(h), [shell(0.3)]);
  h.clock.advance(5 * MIN);
  await jobs.sweep();
  assert.equal(nudges(h, thread.id).length, 1);
});

test('which command lines wait on the user, and for how long', () => {
  assert.equal(waitsOnUserMs('node /Users/m/.local/bin/browserbear handoff 12 --wait --timeout 3600'), 3600_000);
  assert.equal(waitsOnUserMs('node /x/browserbear/cli.mjs handoff https://a.b --until-url *done*'), 20 * MIN);
  assert.equal(waitsOnUserMs('/opt/homebrew/bin/node /x/browserbear handoff 3 --wait --timeout nope'), 20 * MIN);
  // Read as browserbear reads its flags: anywhere, the last one winning.
  assert.equal(waitsOnUserMs('node /x/browserbear --timeout 7200 handoff 12 --wait'), 7200_000);
  assert.equal(waitsOnUserMs('node /x/browserbear handoff 12 --wait --timeout 1800 --timeout 7200'), 7200_000);
  assert.equal(waitsOnUserMs('node /x/browserbear --until-text Payment complete handoff 12 --timeout 7200'), 7200_000);
  assert.equal(waitsOnUserMs('node --no-warnings /x/browserbear handoff 12 --wait'), 20 * MIN);
  // Inline node code that only mentions it.
  assert.equal(waitsOnUserMs("node -e /* /x/browserbear handoff 12 --wait --timeout 86400 */ setInterval(()=>{},1000)"), undefined);
  assert.equal(waitsOnUserMs('node -e x /x/browserbear handoff 12 --wait'), undefined);
  // Not waiting, not browserbear, or only a shell's text naming it: judged as usual.
  assert.equal(waitsOnUserMs('node /x/browserbear handoff 12'), undefined);
  assert.equal(waitsOnUserMs('node /x/browserbear snapshot 12 --wait'), undefined);
  assert.equal(waitsOnUserMs('sleep 3600'), undefined);
  assert.equal(waitsOnUserMs("/bin/zsh -c eval 'browserbear handoff 12 --wait --timeout 86400'"), undefined);
  assert.equal(waitsOnUserMs('until ! pgrep -f snip2.py; do sleep 3; done'), undefined);
});

test('a loop that keeps starting handoffs is judged once the first one would have timed out', async () => {
  const { h, probe, jobs, thread, s } = setUp();
  s.out({ kind: 'tasks', tasks: [waiter] });
  s.result('completed');
  const started = h.clock.now();
  probe.files.set('b1', { startedAt: started, lastOutputAt: started });
  let cpu = 0;
  // Each look sees a freshly started handoff under the loop.
  const look = async () => {
    cpu += 0.1;
    probe.shellsBySession.set(session(h), [
      { taskId: 'b1', cpuSeconds: cpu, commands: ['zsh', 'node'], processes: [{ command: 'node /x/browserbear handoff 12 --wait --timeout 3600', startedAt: h.clock.now() - MIN }] },
    ]);
    await jobs.sweep();
  };
  // The deadline is set at the first look that finds it quiet (30 min),
  // from the handoff seen then: 29 + 60 + 5 = 94 min. Without it, every
  // new handoff would put it off again, for good.
  for (let i = 0; i < 18; i++) {
    h.clock.advance(5 * MIN);
    await look();
  }
  assert.deepEqual(nudges(h, thread.id), []);
  for (let i = 0; i < 2; i++) {
    h.clock.advance(5 * MIN);
    await look();
  }
  assert.equal(nudges(h, thread.id).length, 1);
});
