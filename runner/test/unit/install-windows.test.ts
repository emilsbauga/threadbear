// The Windows install (scripts/install-windows.mjs, scripts/windows-task.mjs):
// the parts that are plain functions, on any platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error .mjs, no types
import { restartCommandText, taskArgs, taskName, taskXml, writeXml, readXml } from '../../scripts/windows-task.mjs';

process.env.THREADBEAR_INSTALL_NO_RUN = '1';
// @ts-expect-error .mjs, no types
const { tbCmdText, viaVariable, withDir, withoutDir } = await import('../../scripts/install-windows.mjs');

test("the task is this user's, in Threadbear's folder, with nothing Task Scheduler refuses", () => {
  assert.equal(taskName('com.mikerosoft.threadbear.runner', 'mikec'), '\\Threadbear\\com.mikerosoft.threadbear.runner (mikec)');
  assert.equal(taskName('a/b', 'x:y'), '\\Threadbear\\a_b (x_y)');
});

test('task.xml says what it runs, and deploy.mjs reads it back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-task-'));
  try {
    const launch = 'C:\\Users\\Zoë Q\\AppData\\Local\\Threadbear\\runner\\launch.mjs';
    const xml = taskXml({ node: 'C:\\Program Files\\nodejs\\node.exe', launch, log: 'C:\\Users\\Zoë Q\\AppData\\Local\\Threadbear\\Logs\\threadbear-runner.log', user: 'PC\\Zoë & co' });
    assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(xml, /<Hidden>true<\/Hidden>/);
    assert.match(xml, /<UserId>PC\\Zoë &amp; co<\/UserId>/);
    const file = path.join(dir, 'task.xml');
    writeXml(file, xml);
    assert.deepEqual([...fs.readFileSync(file).subarray(0, 2)], [0xff, 0xfe]);
    assert.equal(readXml(file), xml);
    assert.deepEqual(taskArgs(file), ['C:\\Program Files\\nodejs\\node.exe', launch, '--log', 'C:\\Users\\Zoë Q\\AppData\\Local\\Threadbear\\Logs\\threadbear-runner.log']);
    // A sandbox's data dir and port go along too.
    writeXml(file, taskXml({ node: 'n.exe', launch: 'C:\\l.mjs', home: 'C:\\h', port: '8899', user: 'u' }));
    assert.deepEqual(taskArgs(file), ['n.exe', 'C:\\l.mjs', '--home', 'C:\\h', '--port', '8899']);
    assert.deepEqual(taskArgs(path.join(dir, 'missing.xml')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the restart is an end and a run', () => {
  assert.equal(restartCommandText('\\Threadbear\\l (u)'), 'schtasks /End /TN "\\Threadbear\\l (u)" && schtasks /Run /TN "\\Threadbear\\l (u)"');
});

test("tb.cmd runs the current release's tb, naming a non-ASCII profile by variable", () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Zoë\\AppData\\Local', USERPROFILE: 'C:\\Users\\Zoë' };
  const home = 'C:\\Users\\Zoë\\AppData\\Local\\Threadbear';
  const text = tbCmdText({ node: 'C:\\Program Files\\nodejs\\node.exe', home, defaultHome: home }, env);
  assert.ok(!/[^\x00-\x7f]/.test(text), text);
  assert.match(text, /^@echo off\r\n/);
  assert.match(text, /set "TB_DATA=%LOCALAPPDATA%\\Threadbear"\r\n/);
  assert.match(text, /set \/p TB_RELEASE=<"%TB_DATA%\\runner\\current"/);
  assert.match(text, /"C:\\Program Files\\nodejs\\node.exe" "%TB_DATA%\\runner\\releases\\%TB_RELEASE%\\bin\\tb" %\*/);
  assert.doesNotMatch(text, /THREADBEAR_HOME/);
  // Another data dir is passed on.
  assert.match(tbCmdText({ node: 'n', home: 'D:\\tb', defaultHome: home }, env), /set "THREADBEAR_HOME=%TB_DATA%"/);
  // A % in a path can't start a variable.
  assert.equal(viaVariable('C:\\100%\\x', env), 'C:\\100%%\\x');
});

test("the PATH gets tb's folder once, and loses only that", () => {
  assert.equal(withDir('%USERPROFILE%\\bin;C:\\x', 'C:\\tb\\bin'), '%USERPROFILE%\\bin;C:\\x;C:\\tb\\bin');
  assert.equal(withDir('C:\\TB\\bin\;C:\\x', 'C:\\tb\\bin'), 'C:\\TB\\bin\;C:\\x');
  assert.equal(withDir('', 'C:\\tb\\bin'), 'C:\\tb\\bin');
  assert.equal(withoutDir('%USERPROFILE%\\bin;C:\\tb\\bin;C:\\x', 'c:\\TB\\bin'), '%USERPROFILE%\\bin;C:\\x');
});
