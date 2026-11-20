// Box mode's categorical quiesce (src/box-procs.ts): before a stopping save
// copies anything, every other process the box started is killed, sparing
// the runner, its ancestors, PID 1, what was there at boot, and the dead.
// Fake process tables only: nothing here signals a real process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { BoxProcesses, listProcs, type Proc } from '../../src/box-procs.ts';

const P = (pid: number, ppid: number, start = String(pid), alive = true): Proc => ({ pid, ppid, start, alive });

test('a stopping save kills everything alive but the runner, its ancestors, PID 1 and the baseline, a reused pid included', async () => {
  // 1 init, 7 the provider's ssh server, 40 the entrypoint, 50 the runner: the baseline the first start took.
  const baseline = new BoxProcesses({ self: 50, list: () => [P(1, 0), P(7, 1), P(40, 1), P(50, 40), P(9, 1, '9', false)] }).capture();
  assert.deepEqual(baseline.map((b) => b.pid), [1, 7, 40, 50], 'only the live ones');
  // Since: the CLI and its shell, a setup's child reparented to init, a
  // dead one, and a process that took the ssh server's pid after it went.
  let procs = [P(1, 0), P(40, 1), P(50, 40), P(60, 50), P(61, 60), P(70, 1), P(80, 50, '80', false), P(7, 1, 'later')];
  const killed: number[] = [];
  const box = new BoxProcesses({ self: 50, baseline, list: () => procs, kill: (pid, sig) => (assert.equal(sig, 'SIGKILL'), killed.push(pid), (procs = procs.filter((p) => p.pid !== pid))), sleep: async () => {} });
  assert.equal(await box.stopOthers(), 4);
  assert.deepEqual(killed.sort((a, b) => a - b), [7, 60, 61, 70]);
});

test('after a restart the baseline is the first start\'s, so an agent\'s process that outlived the old runner is killed', async () => {
  const baseline = [{ pid: 1, start: '1', cmd: '/init' }, { pid: 7, start: '7', cmd: 'hallpass' }, { pid: 40, start: '40', cmd: 'entrypoint' }];
  // The new runner is 52 (under the same entrypoint); 51 ran under the old one, which is gone.
  let procs = [P(1, 0), P(7, 1), P(40, 1), P(52, 40), P(51, 1)];
  const killed: number[] = [];
  const box = new BoxProcesses({ self: 52, baseline, list: () => procs, kill: (pid) => (killed.push(pid), (procs = procs.filter((p) => p.pid !== pid))), sleep: async () => {} });
  assert.equal(await box.stopOthers(), 1);
  assert.deepEqual(killed, [51]);
});

test('it looks again until nothing new is left, and says so if something won\'t stop', async () => {
  let procs = [P(1, 0), P(50, 1)];
  let forks = 2;
  const killed: number[] = [];
  const box = new BoxProcesses({
    self: 50,
    baseline: [{ pid: 1, start: '1', cmd: '' }],
    list: () => procs,
    kill: (pid) => {
      killed.push(pid);
      procs = procs.filter((p) => p.pid !== pid);
      // A process forking as it dies, twice.
      if (forks-- > 0) procs.push(P(100 + forks, 1));
    },
    sleep: async () => {},
  });
  procs.push(P(60, 50));
  assert.equal(await box.stopOthers(), 3);
  assert.deepEqual(killed, [60, 101, 100]);
  // One that never goes.
  const stuck = new BoxProcesses({ self: 50, list: () => [P(1, 0), P(50, 1), P(66, 1)], kill: () => {}, sleep: async () => {} });
  await assert.rejects(stuck.stopOthers(3), /wouldn't stop \(66\)/);
});

test("the process table is read from /proc: a name with spaces and parens, a zombie leader with a live thread, and its command", () => {
  const root = tmpDir('tb-proc-');
  const statLine = (pid: number, comm: string, state: string, ppid: number, start: number) => `${pid} (${comm}) ${[state, String(ppid), ...Array(17).fill('0'), String(start), '0'].join(' ')}\n`;
  const proc = (pid: number, comm: string, state: string, ppid: number, start: number, tasks: string[] = [], cmd = '') => {
    fs.mkdirSync(path.join(root, String(pid), 'task'), { recursive: true });
    fs.writeFileSync(path.join(root, String(pid), 'stat'), statLine(pid, comm, state, ppid, start));
    if (cmd) fs.writeFileSync(path.join(root, String(pid), 'cmdline'), cmd.split(' ').join('\0') + '\0');
    tasks.forEach((ts, i) => {
      const tid = pid + i;
      fs.mkdirSync(path.join(root, String(pid), 'task', String(tid)));
      fs.writeFileSync(path.join(root, String(pid), 'task', String(tid), 'stat'), statLine(tid, comm, ts, ppid, start));
    });
  };
  proc(1, 'init', 'S', 0, 1, ['S'], '/sbin/init');
  proc(42, 'node (box) x', 'R', 1, 12345, ['R']);
  // Its leader exited, a thread of it still runs: alive, and killed by its group's id.
  proc(43, 'leader', 'Z', 42, 12400, ['Z', 'R']);
  // Wholly dead.
  proc(44, 'gone', 'Z', 42, 12500, ['Z']);
  fs.mkdirSync(path.join(root, 'self'));
  assert.deepEqual(listProcs(root), [
    { pid: 1, ppid: 0, start: '1', alive: true, cmd: '/sbin/init' },
    { pid: 42, ppid: 1, start: '12345', alive: true },
    { pid: 43, ppid: 42, start: '12400', alive: true },
    { pid: 44, ppid: 42, start: '12500', alive: false },
  ]);
});
