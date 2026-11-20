// The Bash check of the secrets guard (src/secrets-guard.ts) on the ways a thread's shell on
// Windows can spell the runner's data folder. None of these commands contains the words
// runner-token, which the guard refuses on sight, so each one is held back (or let through) by
// the spelling of the folder alone. They run on any system: a spelling that is wrong for the
// machine is still a spelling someone could send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { denySecrets } from '../../src/secrets-guard.ts';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guard-')));
const deny = (command: string) => denySecrets('Bash', { command }, home);

test('the variables every thread is given, in each shell\'s spelling, name the data folder', () => {
  for (const command of [
    'Get-Content $env:THREADBEAR_HOME\\secrets\\*',
    'Get-Content $env:THREADBEAR_HOME\\secrets\\convex-deploy.env',
    'type %THREADBEAR_HOME%\\secrets\\*',
    'type %THREADBEAR_HOME%\\secrets\\convex-deploy.env',
    'cat $THREADBEAR_RUNNER_HOME/secrets/convex-deploy.env',
    'cat "${THREADBEAR_RUNNER_HOME}/secrets/convex-deploy.env"',
    'Get-Content $env:THREADBEAR_RUNNER_HOME\\secrets\\convex-deploy.env',
    'type %THREADBARE_HOME%\\secrets\\convex-deploy.env',
  ]) assert.ok(deny(command), command);
});

test('a path is the same path in other letters, as the file system sees it', () => {
  const upper = home.toUpperCase();
  assert.ok(deny(`type ${upper}\\SECRETS\\convex-deploy.env`), 'upper case, backslashes');
  assert.ok(deny(`type ${upper.replace(/\\/g, '/')}/Secrets/convex-deploy.env`), 'mixed case, forward slashes');
  assert.ok(deny('type %APPDATA%\\threadbear\\SECRETS\\convex-deploy.env'), '%APPDATA% with a different case');
  assert.ok(deny('Get-Content $env:APPDATA\\Threadbear\\secrets\\convex-deploy.env'), '$env:APPDATA');
});

test('a short (8.3) name or a UNC share of the same drive names the same folder', () => {
  assert.ok(deny('type C:\\Users\\me\\AppData\\Roaming\\THREAD~1\\SECRET~1\\convex-deploy.env'), 'THREAD~1 and SECRET~1');
  assert.ok(deny('type C:\\Users\\me\\AppData\\Roaming\\Threadbear\\secrets\\RUNNER~1'), 'RUNNER~1 is the token file');
  assert.ok(deny('type C:\\Users\\me\\AppData\\Roaming\\THREAD~1\\*'), 'THREAD~1 with a wildcard');
  if (/^[A-Za-z]:\\/.test(home)) {
    const unc = `\\\\localhost\\${home[0]!.toLowerCase()}$\\${home.slice(3)}\\secrets\\convex-deploy.env`;
    assert.ok(deny(`type ${unc}`), unc);
    assert.ok(deny(`type \\\\?\\${home}\\secrets\\convex-deploy.env`), 'a \\\\?\\ prefix');
  }
});

test('a short name counts only beside the data folder: Git revisions that look like one are left alone', () => {
  for (const command of ['git show runner~1', 'git diff feature/runner~1', 'git log runner~2..HEAD', 'git rev-parse HEAD~1 runner~3', 'type C:\\work\\THREAD~1\\notes.txt']) {
    assert.equal(deny(command), undefined, command);
  }
  // From inside the secrets folder, the short name of the token file is the token file.
  assert.ok(denySecrets('Bash', { command: 'type RUNNER~1' }, home, path.join(home, 'secrets')), 'run from the secrets folder');
  assert.equal(denySecrets('Bash', { command: 'git show runner~1' }, home, os.tmpdir()), undefined, 'the same words from anywhere else');
  assert.ok(deny(`type ${home}\\secrets\\RUNNER~1`), "in the data folder's own secrets folder");
});

test('ordinary commands that only look near it are left alone', () => {
  for (const command of [
    'ls secrets',
    'git status',
    'dir C:\\work\\proj\\secrets',
    'Get-ChildItem C:\\work',
    'type C:\\work\\proj\\README.md',
    'echo hello',
    'node -e "console.log(1)"',
    'type C:\\work\\THREAD~1\\notes.txt',
    'git grep -n secrets src',
  ]) assert.equal(deny(command), undefined, command);
});

// What main's guard adds to Keith's (18 Nov 2026): the data folder's home on
// Windows since the Dell moved over (%LOCALAPPDATA%\Threadbear), the escapes
// of PowerShell and cmd, Git Bash's /c/ drives, and the forms Windows opens a
// file tool's path by.

test('the data folder under %LOCALAPPDATA%, in each shell\'s spelling', () => {
  for (const command of [
    'type %LOCALAPPDATA%\\Threadbear\\secrets\\convex-deploy.env',
    'Get-Content $env:LOCALAPPDATA\\Threadbear\\secrets\\convex-deploy.env',
    'Get-Content ${env:LOCALAPPDATA}\\Threadbear\\secrets\\convex-deploy.env',
    'cat "$LOCALAPPDATA/Threadbear/secrets/convex-deploy.env"',
    'cat /c/Users/me/AppData/Local/Threadbear/secrets/convex-deploy.env',
    'type C:\\Users\\me\\AppData\\Local\\Threadbear\\secrets\\convex-deploy.env',
    'Get-Content ${env:THREADBEAR_HOME}\\secrets\\convex-deploy.env',
    // A wildcard after the data folder reaches the same files without the word.
    'type %LOCALAPPDATA%\\Threadbear\\s*\\*',
    'Get-ChildItem $env:LOCALAPPDATA\\Threadbear\\secr* | Get-Content',
    'cat /c/Users/me/AppData/Local/Threadbear/sec*/*',
  ]) assert.ok(deny(command), command);
});

test("PowerShell's backtick and cmd's caret don't hide the folder", () => {
  for (const command of [
    'Get-Content $env:LOCALAPPDATA\\Thread`bear\\se`crets\\convex-deploy.env',
    'type %LOCALAPPDATA%\\Thread^bear\\sec^rets\\convex-deploy.env',
    // The token file's name, the same way (built from parts, as in the Mac file).
    `type secrets\\${['run', 'ner-tok', 'en'].join('`')}`,
    `type secrets\\${['run', 'ner-tok', 'en'].join('^')}`,
  ]) assert.ok(deny(command), command);
});

test('a share of the drive, forward slashes or the long form, is the drive', () => {
  if (!/^[A-Za-z]:\\/.test(home)) return;
  const rest = home.slice(3).replace(/\\/g, '/');
  const drive = home[0]!.toLowerCase();
  for (const command of [
    `cat //localhost/${drive}$/${rest}/secrets/convex-deploy.env`,
    `type \\\\?\\UNC\\localhost\\${drive}$\\${home.slice(3)}\\secrets\\convex-deploy.env`,
    `type \\\\127.0.0.1\\${drive}$\\${home.slice(3)}\\secrets\\convex-deploy.env`,
    `type \\\\${os.hostname()}\\${drive}$\\${home.slice(3)}\\secrets\\convex-deploy.env`,
    `cat /${drive}/${rest}/secrets/convex-deploy.env`,
  ]) assert.ok(deny(command), command);
});

test('a PowerShell tool, if Claude has one, is checked as Bash is', () => {
  assert.ok(denySecrets('PowerShell', { command: 'Get-Content $env:THREADBEAR_HOME\\secrets\\convex-deploy.env' }, home));
  assert.equal(denySecrets('PowerShell', { command: 'Get-ChildItem C:\\work' }, home), undefined);
});

test("a file tool's path is the file Windows would open", { skip: path.sep !== '\\' && 'Windows paths' }, () => {
  const secrets = path.join(home, 'secrets');
  const drive = home[0]!.toLowerCase();
  for (const file_path of [
    // A name's stream: $INDEX_ALLOCATION on a folder is the folder, $DATA on a file the file.
    `${secrets}::$INDEX_ALLOCATION\\convex-deploy.env`,
    `${secrets}\\convex-deploy.env::$DATA`,
    `${secrets}:stream`,
    // Dots and spaces on a name's end are dropped.
    `${secrets}.\\convex-deploy.env`,
    `${secrets} . \\convex-deploy.env`,
    // The long form, and a share of the drive.
    `\\\\?\\${secrets}\\convex-deploy.env`,
    `\\\\.\\${secrets}\\convex-deploy.env`,
    `\\\\localhost\\${drive}$\\${secrets.slice(3)}\\convex-deploy.env`,
    `\\\\?\\UNC\\localhost\\${drive}$\\${secrets.slice(3)}\\convex-deploy.env`,
    // In other letters.
    `${secrets.toUpperCase()}\\convex-deploy.env`,
  ]) {
    assert.ok(denySecrets('Read', { file_path }, home), file_path);
    assert.ok(denySecrets('Edit', { file_path }, home), file_path);
  }
  // From the data folder itself, a search reaches the secrets whatever it asks for.
  assert.ok(denySecrets('Grep', { path: `${home}.`, pattern: 'x' }, home), 'Grep from the data folder, with a dot');
  // Not the secrets folder: a neighbour whose name only starts the same.
  assert.equal(denySecrets('Read', { file_path: `${secrets}-old\\notes.txt` }, home), undefined);
  assert.equal(denySecrets('Read', { file_path: path.join(home, 'runner.json') }, home), undefined);
});

test('the variables in PowerShell\'s $(...) and cmd\'s delayed !X! (Codex\'s review)', () => {
  for (const command of [
    `powershell.exe -NoProfile -Command 'Get-Content "$($env:THREADBEAR_HOME)\\secrets\\convex-deploy.env"'`,
    `MSYS_NO_PATHCONV=1 cmd.exe /V:ON /C 'type "!THREADBEAR_HOME!\\secrets\\convex-deploy.env"'`,
    `powershell -c "Get-Content ([Environment]::GetEnvironmentVariable('THREADBEAR_HOME') + '\\secrets\\convex-deploy.env')"`,
    `cmd /V:ON /C "dir !THREADBEAR_RUNNER_HOME!\\s*"`,
  ]) assert.ok(deny(command), command);
});

test('short names count only where they would be the data folder\'s (Codex\'s review)', () => {
  for (const command of ['git diff runner~1 -- src/secrets.ts', 'git log runner~2 -- secrets/', 'echo $THREADBEAR_HOME; ls ./secrets', 'type C:\\work\\THREAD~1\\notes.txt']) {
    assert.equal(deny(command), undefined, command);
  }
  for (const command of ['type %LOCALAPPDATA%\\THREAD~1\\secrets\\x.env', 'cat /c/Users/me/AppData/Local/THREAD~1/secrets/x.env', 'type C:\\Users\\me\\AppData\\Local\\THREAD~1\\s*', 'type secrets\\RUNNER~1']) {
    assert.ok(deny(command), command);
  }
});

test('on Windows a file tool doesn\'t reach through a share (Codex\'s review)', { skip: path.sep !== '\\' && 'Windows paths' }, () => {
  for (const file_path of ['\\\\localhost\\Profile\\AppData\\Local\\Threadbear\\secrets\\x', '\\\\192.168.1.77\\c$\\x', '\\\\?\\UNC\\server\\share\\x', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\x']) {
    assert.ok(denySecrets('Read', { file_path }, home), file_path);
    assert.ok(denySecrets('Grep', { path: file_path, pattern: 'x' }, home), file_path);
  }
});

test("a data folder somewhere else, by its short name (Codex's second review)", () => {
  // D:\TB Data is TBDATA~1 to Windows, and THREAD~1 counts wherever it is.
  const moved = path.join(path.dirname(home), 'TB Data');
  const g = (command: string) => denySecrets('Bash', { command }, moved);
  assert.ok(g(`powershell.exe -NoProfile -Command 'Get-Content D:\\TBDATA~1\\secrets\\convex-deploy.env'`));
  assert.ok(g('cat /d/TBDATA~2/sec*'));
  assert.ok(g('type D:\\THREAD~1\\secrets\\x.env'));
  assert.equal(g('type D:\\TBDATA~1\\notes.txt'), undefined);
  // A short name keeps three letters of its extension (Codex's third review).
  const dotted = (command: string) => denySecrets('Bash', { command }, path.join(path.dirname(home), 'Threadbear.data'));
  assert.ok(dotted(`powershell.exe -NoProfile -Command 'Get-Content D:\\THREAD~1.DAT\\secrets\\convex-deploy.env'`));
  assert.ok(dotted('cat /d/THREAD~2.DAT/s*'));
  // The stem is from the name before its extension: D:\TB.data is TB~1.DAT.
  const tb = (command: string) => denySecrets('Bash', { command }, path.join(path.dirname(home), 'TB.data'));
  assert.ok(tb(`powershell.exe -NoProfile -Command 'Get-Content D:/TB~1.DAT/secrets/convex-deploy.env'`));
});

test("on Windows a Grep with no path from a share is refused (Codex's second review)", { skip: path.sep !== '\\' && 'Windows paths' }, () => {
  const cwd = '\\\\localhost\\Profile\\AppData\\Local\\Threadbear\\secrets';
  assert.ok(denySecrets('Grep', { pattern: '.', output_mode: 'content' }, home, cwd));
  assert.ok(denySecrets('Glob', { pattern: '*' }, home, cwd));
});
