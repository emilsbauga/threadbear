// The runner's Scheduled Task on Windows: what launchd's LaunchAgent is on
// a Mac and the systemd user service on Linux. install-windows.mjs
// registers it; deploy.mjs checks it and restarts it. Started from Keith's
// (platima) Windows port, onto releases and launch.mjs.
//
// One task per user and label, in a Threadbear folder of Task Scheduler.
// Task names are shared by everyone on the PC, so the user's name is in it.
// It runs at logon, in the user's own session (InteractiveToken, no admin,
// no stored password), through conhost --headless so node has a console
// with no window and nothing flashes up. Task Scheduler restarts it a
// minute after it fails, as launchd does on a Mac.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const TASK_FOLDER = '\\Threadbear\\';

// This user's task for a label. Task Scheduler refuses \ / : * ? " < > |
// in a name; [ and ] are only trouble to PowerShell, which reads them as
// wildcards.
export function taskName(label, username) {
  const clean = (s) => String(s).replace(/[\\/:*?"<>|[\]\r\n\t]/g, '_').trim();
  return `${TASK_FOLDER}${clean(label)} (${clean(username) || 'user'})`;
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlUnescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The task's definition, which install-windows.mjs also keeps beside the
// releases as <home>/runner/task.xml, where deploy.mjs reads what it runs
// (as it reads the plist and the unit file). A task's action has no
// environment of its own, so launch.mjs is given the data dir and port
// (only when they aren't the defaults) and the log file as arguments
// (launch.mjs's launchArgs).
export function taskXml({ node, launch, home, port, log, user, description = 'Threadbear runner: starts at logon and is kept running.' }) {
  const args = [quote(node), quote(launch), ...(home ? ['--home', quote(home)] : []), ...(port ? ['--port', String(port)] : []), ...(log ? ['--log', quote(log)] : [])].join(' ');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xmlEscape(description)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEscape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>conhost.exe</Command>
    <Arguments>--headless ${xmlEscape(args)}</Arguments>
    <WorkingDirectory>${xmlEscape(path.win32.dirname(launch))}</WorkingDirectory>
  </Exec></Actions>
</Task>
`;
}

function quote(s) {
  return /[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s);
}

// What a task.xml runs, as arguments after conhost's own (node, launch.mjs,
// then launch.mjs's), so deploy.mjs can tell a runner on releases from one
// on a checkout. [] when there's no file or it can't be read.
export function taskArgs(xmlFile) {
  let text;
  try {
    text = readXml(xmlFile);
  } catch {
    return [];
  }
  const m = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(text);
  if (!m) return [];
  const words = [];
  for (const w of xmlUnescape(m[1]).matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) words.push(w[1] !== undefined ? w[1].replace(/\\"/g, '"') : w[2]);
  return words[0] === '--headless' ? words.slice(1) : words;
}

// Task Scheduler wants the XML as UTF-16 with a byte-order mark.
export function writeXml(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
}

export function readXml(file) {
  const buf = fs.readFileSync(file);
  return buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le') : buf.toString('utf8');
}

// schtasks by its full path (a folder in the PATH can't stand in for it).
export function schtasksPath(env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'schtasks.exe');
}

export function schtasks(args, env = process.env) {
  return execFileSync(schtasksPath(env), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

export function taskExists(name, env = process.env) {
  try {
    schtasks(['/Query', '/TN', name], env);
    return true;
  } catch {
    return false;
  }
}

// The task's restart: end it (launch.mjs asks the runner to stop over IPC
// as the task's processes go) and run it again.
export function restartArgs(name) {
  return [
    ['/End', '/TN', name],
    ['/Run', '/TN', name],
  ];
}

export function restartCommandText(name) {
  return restartArgs(name)
    .map((a) => `schtasks ${a.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}`)
    .join(' && ');
}

// The runner pid in <home>/run/runner.pid (lock.ts writes { pid, lstart }),
// or undefined.
function lockHolder(home) {
  try {
    const raw = fs.readFileSync(path.join(home, 'run', 'runner.pid'), 'utf8').trim();
    const pid = /^\d+$/.test(raw) ? Number(raw) : JSON.parse(raw).pid;
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Ends the task and waits until its runner has let go of the data dir: End
// kills only conhost.exe, and launch.mjs then stops its runner over IPC
// (watchParent, a couple of seconds, then up to the runner's grace), so a
// /Run straight after it would start a runner the old one's lock refuses
// (Codex's review, 17 Nov 2026). Resolves true once it's gone, false at
// the deadline. `deps` are for tests.
export async function endTask(name, home, { timeoutMs = 45_000, end = (n) => schtasks(['/End', '/TN', n]), holder = lockHolder, alive = pidAlive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const pid = holder(home);
  try {
    end(name);
  } catch {
    // not running
  }
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
  return true;
}
