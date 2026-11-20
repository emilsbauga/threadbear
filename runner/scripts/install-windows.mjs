// Installs the runner on Windows: what install-runner.sh does on a Mac
// (launchd) and Linux (systemd), as a Scheduled Task (windows-task.mjs).
// Run it with the Node 24 the runner should use, from a checkout:
//
//   node scripts/install-windows.mjs --dry-run    say what it would do
//   node scripts/install-windows.mjs              install (or reinstall) and start it
//   node scripts/install-windows.mjs --status     is it there and running
//   node scripts/install-windows.mjs --uninstall  stop it and take the task and tb off
//
// Options: --home DIR (default %LOCALAPPDATA%\Threadbear), --label LABEL,
// --port N, --skip-checks (the release's typecheck and tests, for a commit
// that's already been checked), --allow-branch (a HEAD that isn't main's),
// --force (replace a runner that has threads busy).
//
// The runner runs from a release, never from this checkout: the task
// starts <home>\runner\launch.mjs, which starts the release
// <home>\runner\current names, and the runner follows main and builds the
// next releases itself, as on a Mac. It leaves: the task (in Task
// Scheduler's Threadbear folder, for this user, no admin rights),
// <home>\runner (launch.mjs, releases, task.xml), and <home>\bin\tb.cmd on
// this user's PATH. docs/on-your-mac.md lists them. Needs Git for Windows
// (its bash runs patch actions, checks and tb land) and Claude Code.
//
// Started from Keith's (platima) install-windows.mjs: the PATH handling and
// the tb.cmd text are his.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readCurrentLink } from '../launch.mjs';
import { endTask, schtasks, taskExists, taskName, taskXml, writeXml } from './windows-task.mjs';

const RUNNER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LABEL = 'com.mikerosoft.threadbear.runner';

// ------------------------------------------------------------- tb.cmd

const NON_ASCII = /[^\x00-\x7f]/;
// Folders cmd.exe can name by variable, so a path under one needs no text
// of its own. The longest match wins (%LOCALAPPDATA% is under %USERPROFILE%).
const PATH_VARIABLES = ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ProgramFiles', 'ProgramData'];
const batchLiteral = (s) => s.replace(/%/g, '%%');

function fromEnv(env, name) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

// cmd.exe reads a batch file in the console's code page, not UTF-8, so a
// path with letters outside ASCII (a profile folder called Zoë) is written
// as %VARIABLE%\rest where a variable covers it (Keith found it, 6 Nov).
export function viaVariable(p, env) {
  if (!NON_ASCII.test(p)) return batchLiteral(p);
  let best;
  for (const name of PATH_VARIABLES) {
    const value = fromEnv(env, name);
    if (!value) continue;
    const base = value.replace(/[\\/]+$/, '');
    const covers = p.length >= base.length && p.slice(0, base.length).toLowerCase() === base.toLowerCase() && (p.length === base.length || /[\\/]/.test(p[base.length]));
    if (covers && (!best || base.length > best.base.length)) best = { name, base };
  }
  return best ? `%${best.name}%${batchLiteral(p.slice(best.base.length))}` : batchLiteral(p);
}

// tb.cmd runs the tb of the release `current` names (a file holding its
// id on Windows), with the runner's Node, so it always matches the runner.
// A data dir other than the default is passed on as THREADBEAR_HOME.
export function tbCmdText({ node, home, defaultHome }, env = process.env) {
  const h = viaVariable(home, env);
  const n = viaVariable(node, env);
  const lines = [
    '@echo off',
    'setlocal',
    `set "TB_DATA=${h}"`,
    ...(home.toLowerCase() === defaultHome.toLowerCase() ? [] : ['set "THREADBEAR_HOME=%TB_DATA%"']),
    'set /p TB_RELEASE=<"%TB_DATA%\\runner\\current"',
    `"${n}" "%TB_DATA%\\runner\\releases\\%TB_RELEASE%\\bin\\tb" %*`,
    '',
  ];
  return lines.join('\r\n');
}

// --------------------------------------------------------- the user's PATH

// Any text as a PowerShell expression, whatever is in it.
const psString = (s) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(String(s), 'utf8').toString('base64')}'))`;

function ps(script) {
  // Base64 of UTF-8 back, as powershell.exe writes to a pipe in the OEM
  // code page and would turn José into Jos?.
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@(& { ${script} }) -join [Environment]::NewLine)))`], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return Buffer.from(out.trim(), 'base64').toString('utf8');
}

// This user's PATH as the registry holds it, %VARIABLES% unexpanded:
// [Environment]::GetEnvironmentVariable would expand them, and writing that
// back would quietly rewrite the rest of the PATH (Keith's catch).
export function readUserPath(key = 'Environment') {
  return ps(`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${psString(key)}); if ($k) { $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') }`);
}

// Written as the kind it was (an expandable string, as Windows' own is, if
// there was none). Setting a variable through .NET is what tells running
// programs to read it again, so a throwaway one is set and removed.
export function writeUserPath(value, key = 'Environment') {
  ps(
    `$v = ${psString(value)}; $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${psString(key)}); ` +
      `$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString; ` +
      `if ($k.GetValueNames() -contains 'Path') { $was = $k.GetValueKind('Path'); if ($was -eq 'String') { $kind = $was } }; ` +
      `$k.SetValue('Path', $v, $kind); ` +
      (key === 'Environment' ? `[Environment]::SetEnvironmentVariable('THREADBEAR_PATH_CHANGED','1','User'); [Environment]::SetEnvironmentVariable('THREADBEAR_PATH_CHANGED',$null,'User')` : ''),
  );
}

const sameDir = (a, b) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
export const withDir = (pathValue, dir) => (pathValue.split(';').some((p) => sameDir(p, dir)) ? pathValue : [pathValue, dir].filter(Boolean).join(';'));
export const withoutDir = (pathValue, dir) => pathValue.split(';').filter((p) => p && !sameDir(p, dir)).join(';');

// ------------------------------------------------------------------ main

function deploy(home, label, extra) {
  return spawnSync(process.execPath, [path.join(RUNNER_DIR, 'scripts', 'deploy.mjs'), '--home', home, '--label', label, ...extra], {
    stdio: 'inherit',
    // This Node is the one being installed, which no task names yet.
    env: { ...process.env, THREADBEAR_NODE: process.execPath, THREADBEAR_DEPLOY_NODE_GIVEN: '1' },
  }).status;
}

// This account as Task Scheduler names it (PC\user, or DOMAIN\user):
// whoami's answer, as USERDOMAIN can say WORKGROUP (it did over ssh).
function whoAmI() {
  try {
    const me = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), { encoding: 'utf8', windowsHide: true }).trim();
    if (me.includes('\\')) return me;
  } catch {
    // fall back below
  }
  return `${process.env.COMPUTERNAME || os.hostname()}\\${os.userInfo().username}`;
}

function headCommit() {
  const r = spawnSync('git', ['-C', RUNNER_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function releaseCommit(dir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'releases', id, 'release.json'), 'utf8')).commit;
  } catch {
    return undefined;
  }
}

async function main() {
  const { values: v } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      status: { type: 'boolean' },
      uninstall: { type: 'boolean' },
      home: { type: 'string' },
      label: { type: 'string' },
      port: { type: 'string' },
      'skip-checks': { type: 'boolean' },
      'allow-branch': { type: 'boolean' },
      force: { type: 'boolean' },
    },
  });
  // The data dir, as config.ts's dataDirFor has it.
  const { dataDirFor } = await import('../src/platform.ts');
  const defaultHome = dataDirFor();
  const home = path.resolve(v.home ?? process.env.THREADBEAR_HOME ?? defaultHome);
  const label = v.label ?? DEFAULT_LABEL;
  if (home !== path.resolve(defaultHome) && label === DEFAULT_LABEL && !v.status) {
    console.error(`A data dir other than ${defaultHome} needs its own --label, so it doesn't replace the real runner's task.`);
    return 2;
  }
  const user = whoAmI();
  const task = taskName(label, os.userInfo().username);
  const dir = path.join(home, 'runner');
  const binDir = path.join(home, 'bin');
  const log = path.join(home, 'Logs', 'threadbear-runner.log');

  if (v.status) {
    if (!taskExists(task)) {
      console.log(`The task "${task}" isn't installed.`);
      return 1;
    }
    const q = schtasks(['/Query', '/TN', task, '/FO', 'LIST', '/V']);
    console.log([`Task: ${task}`, ...q.split(/\r?\n/).filter((l) => /^(Status|Last Run Time|Last Result)/i.test(l)), `Release: ${readCurrentLink(dir) ?? 'none'}`].join('\n'));
    return 0;
  }

  if (v.uninstall) {
    console.log(`End and delete the task "${task}", delete ${path.join(binDir, 'tb.cmd')} and take ${binDir} off this user's PATH. The data dir stays.`);
    if (v['dry-run']) return 0;
    if (taskExists(task)) {
      if (!(await endTask(task, home))) console.error("The runner hadn't stopped 45 s after its task was ended; it's left to finish.");
      schtasks(['/Delete', '/TN', task, '/F']);
    }
    fs.rmSync(path.join(binDir, 'tb.cmd'), { force: true });
    const before = readUserPath();
    const after = withoutDir(before, binDir);
    if (after !== before.split(';').filter(Boolean).join(';')) writeUserPath(after);
    console.log('Removed.');
    return 0;
  }

  // What it needs first.
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) {
    console.error(`This is Node ${process.versions.node}; the runner needs 24 or newer. Run this with that Node.`);
    return 1;
  }
  const { gitBash, NO_BASH } = await import('../src/system-tools.ts');
  if (!gitBash()) {
    console.error(NO_BASH);
    return 1;
  }

  const head = headCommit();
  const current = readCurrentLink(dir);
  const keep = current && head && releaseCommit(dir, current) === head;
  const running = taskExists(task);
  console.log(
    [
      keep ? `Keep release ${current}, which was built from HEAD.` : `Build a release from HEAD (${head?.slice(0, 9) ?? 'unknown'})${v['skip-checks'] ? ', without its checks' : ''}.`,
      `Copy launch.mjs to ${dir}.`,
      `${running ? 'Replace' : 'Register'} the Scheduled Task "${task}": at logon, for ${user}, hidden, no admin rights, restarted a minute after it fails.`,
      `  runs: conhost.exe --headless "${process.execPath}" "${path.join(dir, 'launch.mjs')}" --log "${log}"`,
      `Write ${path.join(binDir, 'tb.cmd')} and put ${binDir} on this user's PATH.`,
      `${running ? 'Restart' : 'Start'} it, and wait until the release is marked good.`,
    ].join('\n'),
  );
  if (v['dry-run']) return 0;

  // Replacing a running one stops its threads' turns.
  if (running && !v.force && deploy(home, label, ['--check-idle']) === 1) {
    console.error('Threads are busy on this runner, and reinstalling would stop them. Try again when they finish, or pass --force.');
    return 1;
  }

  fs.mkdirSync(dir, { recursive: true });
  if (!keep) {
    const extra = ['--no-restart', ...(v['skip-checks'] ? ['--skip-checks'] : []), ...(v['allow-branch'] ? ['--allow-branch'] : [])];
    if (deploy(home, label, extra) !== 0) return 1;
  }
  fs.copyFileSync(path.join(RUNNER_DIR, 'launch.mjs'), path.join(dir, 'launch.mjs'));

  const xml = path.join(dir, 'task.xml');
  writeXml(xml, taskXml({ node: process.execPath, launch: path.join(dir, 'launch.mjs'), home: home === path.resolve(defaultHome) ? undefined : home, port: v.port, log, user }));
  // The old runner lets go of the data dir before the new one starts.
  if (running && !(await endTask(task, home))) {
    console.error("The runner that was running hadn't stopped 45 s after its task was ended, so the new one wasn't started. Try again in a minute.");
    return 1;
  }
  schtasks(['/Create', '/TN', task, '/XML', xml, '/F']);

  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'tb.cmd'), tbCmdText({ node: process.execPath, home, defaultHome }));
  const before = readUserPath();
  const after = withDir(before, binDir);
  if (after !== before) writeUserPath(after);

  schtasks(['/Run', '/TN', task]);
  // Waits until it's up on the release and has been marked good.
  if (deploy(home, label, ['--check']) !== 0) return 1;
  console.log(`Installed. Open a new terminal for tb. The log is ${log}.`);
  return 0;
}

// A test that wants only the functions above sets THREADBEAR_INSTALL_NO_RUN.
if (process.env.THREADBEAR_INSTALL_NO_RUN) {
  // imported for its functions
} else if (process.platform !== 'win32') {
  console.error('This installs the runner on Windows. On a Mac or Linux, use scripts/install-runner.sh.');
  process.exitCode = 2;
} else {
  main().then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(String(e?.stderr || e?.message || e).trim());
      process.exitCode = 1;
    },
  );
}
