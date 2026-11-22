// The runner runs on Linux too. A macOS-only tool path (/usr/sbin/lsof,
// /bin/zsh) failed a fresh Ubuntu runner's pre-install tests and stopped
// the Hetzner runner updating (5 Nov 2026). These tests catch the next one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitBash, installPathFromRegistry, loginShell, missingBashNotice, NO_BASH, plainShell } from '../../src/system-tools.ts';
import { lsofPath } from '../../src/handover.ts';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src');

// Every absolute tool path the runner's code names, and why it's fine on
// Linux. "everywhere": a path both macOS and Ubuntu have. Anything else
// says what keeps it off Linux (a platform check, or a failure that's
// already handled), and the files it may appear in.
// It doesn't see a name built at run time (`'/bin/' + name`) or a bare
// name left to PATH (`spawn('zsh')`); those want a reviewer's eye.
const KNOWN: Record<string, { everywhere: true } | { linux: string; files: string[] }> = {
  '/bin/sh': { everywhere: true },
  '/bin/ps': { everywhere: true },
  '/bin/ls': { linux: 'only on darwin, for its access lists (aclProblem)', files: ['shell-allowlist.ts'] },
  '/bin/bash': { everywhere: true },
  '/usr/bin/bash': { linux: 'one of the shells loginShell looks for', files: ['system-tools.ts'] },
  '/bin/zsh': { linux: 'only on darwin; Linux gets loginShell()', files: ['system-tools.ts'] },
  '/usr/sbin/lsof': { linux: "lsofPath's Mac place", files: ['handover.ts'] },
  '/usr/bin/lsof': { linux: "lsofPath's Linux place", files: ['handover.ts'] },
  '/usr/bin/sips': { linux: 'behind MAC; ImageMagick on Linux', files: ['images.ts'] },
  '/usr/bin/qlmanage': { linux: 'behind MAC; rsvg-convert on Linux, or ffmpeg for a review clip', files: ['images.ts', 'review-media.ts'] },
  '/usr/sbin/system_profiler': { linux: 'behind a darwin check', files: ['machine.ts'] },
  '/usr/bin/vm_stat': { linux: 'behind a darwin check; /proc/meminfo on Linux', files: ['runner-stats.ts'] },
  '/usr/bin/sw_vers': { linux: 'behind a darwin check; /etc/os-release on Linux', files: ['runner-stats.ts'] },
  '/usr/sbin/ioreg': { linux: 'behind a darwin check', files: ['presence.ts'] },
  '/usr/bin/osascript': { linux: 'the Mac screen check, only started on darwin (main.ts)', files: ['mac-screen.ts'] },
  '/usr/bin/sandbox-exec': { linux: "a failed sample counts as not stuck", files: ['frozen-cli.ts'] },
  '/usr/bin/sample': { linux: "a failed sample counts as not stuck", files: ['frozen-cli.ts'] },
  '/usr/bin/open': { linux: "rejects with Couldn't open", files: ['runner.ts'] },
  '/usr/bin/nice': { everywhere: true },
  '/usr/sbin/taskpolicy': { linux: 'behind a darwin check: the secret check is Mac only, and inBackground skips it off a Mac', files: ['secret-check.ts', 'background.ts'] },
  '/usr/bin/xcrun': { linux: 'behind a darwin check: the secret check is Mac only', files: ['secret-check.ts'] },
  '/usr/bin/pmset': { linux: 'behind darwin checks: the secret check and keeping awake are Mac only', files: ['secret-check.ts', 'keep-awake.ts'] },
  '/usr/bin/codesign': { linux: 'behind a darwin check: only a Mac checks who signed a binary', files: ['agents.ts'] },
  '/usr/bin/caffeinate': { linux: 'behind a darwin check: keeping awake is Mac only', files: ['keep-awake.ts'] },
  '/usr/bin/lockf': { linux: 'behind a darwin check; flock on Linux', files: ['worktrees.ts'] },
  '/usr/bin/python3': { linux: 'only when it exists (fs.existsSync), else python3 on the PATH', files: ['year-token-maker.ts'] },
};

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}

test('every absolute tool path in src is known to work, or be kept off, on Linux', () => {
  const unknown: string[] = [];
  for (const file of sources(SRC)) {
    const rel = path.relative(SRC, file);
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      // Comments name paths too (Codex's `/bin/zsh -lc` wrapper); only code runs them.
      const code = line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, '');
      for (const m of code.matchAll(/['"`](\/(?:usr\/)?(?:local\/)?(?:s?bin|libexec)\/[\w.-]+)/g)) {
        const known = KNOWN[m[1]];
        if (!known) unknown.push(`${rel}:${i + 1} runs ${m[1]}, which this test doesn't know. Is it on Linux? If not, look it up by platform (src/system-tools.ts, or lsofPath in handover.ts) and add it to KNOWN.`);
        else if (!('everywhere' in known) && !known.files.includes(path.basename(rel))) {
          unknown.push(`${rel}:${i + 1} runs ${m[1]}, which isn't on Linux (${known.linux}, in ${known.files.join(', ')}). Go through src/system-tools.ts, or keep it behind a platform check and add the file to KNOWN.`);
        }
      }
    });
  }
  assert.deepEqual(unknown, []);
});

const has = (...files: string[]) => (f: string) => files.includes(f);

test("the login shell: zsh on a Mac; on Linux, $SHELL if it's POSIX-style, else bash, else sh", () => {
  assert.deepEqual(loginShell({ platform: 'darwin', executable: () => false }), ['/bin/zsh', '-lc']);
  assert.deepEqual(loginShell({ platform: 'linux', executable: has('/bin/bash'), env: { SHELL: '/usr/bin/zsh' } }), ['/bin/bash', '-lc']);
  assert.deepEqual(loginShell({ platform: 'linux', executable: has('/bin/bash', '/usr/bin/zsh'), env: { SHELL: '/usr/bin/zsh' } }), ['/usr/bin/zsh', '-lc']);
  assert.deepEqual(loginShell({ platform: 'linux', executable: has('/bin/bash', '/usr/bin/fish'), env: { SHELL: '/usr/bin/fish' } }), ['/bin/bash', '-lc']);
  assert.deepEqual(loginShell({ platform: 'linux', executable: () => false, env: {} }), ['/bin/sh', '-lc']);
});

test('the lsof and login shell this machine picks are really there', () => {
  // Handovers between runners need lsof, which Windows hasn't got.
  if (process.platform !== 'win32') assert.ok(fs.existsSync(lsofPath()), `no lsof at ${lsofPath()}`);
  assert.ok(fs.existsSync(loginShell()[0]), `no shell at ${loginShell()[0]}`);
  // On Windows that is a Git Bash, not the stand-in that says there isn't one.
  if (process.platform === 'win32') assert.match(loginShell()[0], /bash\.exe$/i, NO_BASH);
});

test('the plain shell is sh -c on a Mac and on Linux, whatever is installed; gitBash is only for Windows', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    assert.deepEqual(plainShell({ platform, executable: () => false }), ['/bin/sh', '-c']);
    assert.equal(gitBash({ platform, executable: () => true }), undefined);
    assert.equal(missingBashNotice({ platform, executable: () => false }), undefined);
  }
});

// A machine with these files, and the registry values it has (none, unless it says).
const machine = (files: string[], env: NodeJS.ProcessEnv = {}, registry: Record<string, string> = {}) => ({
  platform: 'win32' as const,
  executable: (f: string) => files.includes(f),
  env,
  registry: (key: string) => registry[key],
});

const PROGRAM_FILES = 'C:\\Program Files';
const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

test('Git Bash on Windows: the variable, the places Git installs to, a git on the PATH, then the registry; never a bash on the PATH alone', () => {
  const env = { ProgramFiles: PROGRAM_FILES, 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  // The variable wins when it points at a bash.
  assert.equal(gitBash(machine(['D:\\mine\\bash.exe', BASH], { ...env, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\mine\\bash.exe' })), 'D:\\mine\\bash.exe');
  assert.equal(gitBash(machine([BASH], { ...env, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\gone\\bash.exe' })), BASH, 'and is skipped when it points at nothing');
  // Where Git installs to.
  assert.equal(gitBash(machine([BASH], env)), BASH);
  assert.equal(gitBash(machine(['C:\\Program Files\\Git\\usr\\bin\\bash.exe'], env)), 'C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  assert.equal(gitBash(machine(['C:\\Program Files (x86)\\Git\\bin\\bash.exe'], env)), 'C:\\Program Files (x86)\\Git\\bin\\bash.exe');
  assert.equal(gitBash(machine(['C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'], env)), 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  // A Git put anywhere is found by its git.exe on the PATH: in its cmd or bin
  // folder, or one further in (mingw64\bin).
  for (const dir of ['cmd', 'bin', 'mingw64\\bin']) {
    const m = machine([`D:\\tools\\Git\\${dir}\\git.exe`, 'D:\\tools\\Git\\bin\\bash.exe'], { PATH: `C:\\Windows\\System32;"D:\\tools\\Git\\${dir}"` });
    assert.equal(gitBash(m), 'D:\\tools\\Git\\bin\\bash.exe', dir);
  }
  assert.equal(gitBash(machine(['D:\\tools\\Git\\cmd\\git.exe', 'D:\\tools\\Git\\usr\\bin\\bash.exe'], { Path: 'D:\\tools\\Git\\cmd' })), 'D:\\tools\\Git\\usr\\bin\\bash.exe', 'usr\\bin too, and the PATH spelt Path');
  // The registry's InstallPath, for a Git that isn't on the PATH.
  assert.equal(gitBash(machine(['E:\\Apps\\Git\\bin\\bash.exe'], {}, { 'HKLM\\SOFTWARE\\GitForWindows': 'E:\\Apps\\Git' })), 'E:\\Apps\\Git\\bin\\bash.exe');
  assert.equal(gitBash(machine(['F:\\Mine\\Git\\bin\\bash.exe'], {}, { 'HKCU\\SOFTWARE\\GitForWindows': 'F:\\Mine\\Git' })), 'F:\\Mine\\Git\\bin\\bash.exe');
  // A bash.exe on the PATH alone is System32's WSL launcher as often as not: not used.
  assert.equal(gitBash(machine(['C:\\Windows\\System32\\bash.exe'], { ...env, PATH: 'C:\\Windows\\System32' })), undefined);
  assert.equal(gitBash(machine([], env)), undefined);
});

test('with no Git Bash, the shell is one that says so and exits 127, never cmd.exe taking -c and doing nothing', () => {
  const none = machine([], { PATH: 'C:\\Windows\\System32' });
  const have = machine([BASH], { ProgramFiles: PROGRAM_FILES });
  assert.equal(missingBashNotice(none), NO_BASH);
  assert.match(NO_BASH, /^Git for Windows \(bash\) is not installed/);
  assert.equal(missingBashNotice(have), undefined);
  assert.deepEqual(plainShell(have), [BASH, '-c']);
  assert.deepEqual(loginShell(have), [BASH, '-lc']);
  for (const shell of [plainShell(none), loginShell(none)]) {
    assert.notEqual(path.basename(shell[0]!).toLowerCase(), 'cmd.exe');
    // Started the way every caller starts a shell: the program, its flag, the command.
    const r = spawnSync(shell[0]!, [...shell.slice(1), 'echo it-ran'], { encoding: 'utf8' });
    assert.equal(r.status, 127);
    assert.equal(r.stdout, '', 'the command did not run');
    assert.match(r.stderr, /Git for Windows \(bash\) is not installed/);
  }
});

test("Git for Windows' recorded InstallPath is read from the real registry, read only", { skip: process.platform === 'win32' ? false : 'Needs Windows' }, (t) => {
  const root = installPathFromRegistry('HKLM\\SOFTWARE\\GitForWindows', process.env) ?? installPathFromRegistry('HKCU\\SOFTWARE\\GitForWindows', process.env);
  if (!root) return t.skip('Git for Windows has recorded no InstallPath on this machine');
  assert.ok(fs.existsSync(path.win32.join(root, 'bin')), `${root} has no bin folder`);
  // And a probe that brings that registry finds a bash with no other hint.
  const found = gitBash({ platform: 'win32', env: {}, executable: (f) => fs.existsSync(f), registry: (key) => installPathFromRegistry(key, process.env) });
  assert.match(found ?? '', /bash\.exe$/i);
  assert.equal(installPathFromRegistry('HKLM\\SOFTWARE\\NoSuchThingHere', process.env), undefined);
});
