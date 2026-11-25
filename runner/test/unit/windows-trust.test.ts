// Patch trust and the path helpers on Windows (docs/windows-port-plan.md):
// the real form of a path (8.3 short names, which GitHub's runners use for
// TEMP), the spellings Git Bash reads for a script, the program names
// Windows adds an extension to, and the fingerprint cache on NTFS. The pure
// parts run everywhere, pinning what macOS and Linux do; the rest needs
// Windows, and a volume with short names where it says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { makePng } from '../helpers/png.ts';
import { aliasedDir, IS_WINDOWS, NO_SHORT_NAMES, shortPathOf } from '../helpers/short-names.ts';
import { realPath, realPathSync } from '../../src/platform.ts';
import { fingerprint, looksRunnable, programName, windowsSpelling } from '../../src/script-trust.ts';
import { commandFiles, folderKey, liveCommandProblem, mainCheckoutOf, patchHash, PatchTrust } from '../../src/patch-trust.ts';
import { claudeCommands } from '../../src/claude-trust.ts';
import { readShareImage } from '../../src/share-images.ts';
import { sameSubfolder } from '../../src/worktrees.ts';

const ONLY_WINDOWS = { skip: IS_WINDOWS ? false : 'Needs Windows: the spellings and names tested here are Git Bash and NTFS ones' } as const;

const enoent = () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

// ---------------------------------------------------------------- real paths

test('realPathSync: the plain realpath on macOS and Linux, the native one on Windows', () => {
  const plain = (p: string) => `plain:${p}`;
  const native = (p: string) => `native:${p}`;
  assert.equal(realPathSync('/x/y', { platform: 'darwin', plain, native }), 'plain:/x/y');
  assert.equal(realPathSync('/x/y', { platform: 'linux', plain, native }), 'plain:/x/y');
  assert.equal(realPathSync('C:\\x\\y', { platform: 'win32', plain, native }), 'native:C:\\x\\y');
  assert.throws(() => realPathSync('/nope', { platform: 'darwin', plain: enoent, native }), /ENOENT/);
  assert.throws(() => realPathSync('C:\\nope', { platform: 'win32', plain, native: enoent }), /ENOENT/);
});

test("realPath: a path that isn't there is given back on macOS and Linux; on Windows its nearest real folder is made real and the rest kept", () => {
  assert.equal(realPath('/nope/x.txt', { platform: 'darwin', plain: enoent }), '/nope/x.txt');
  assert.equal(realPath('/nope/x.txt', { platform: 'linux', plain: enoent }), '/nope/x.txt');
  // Only the profile folder is there; it has a long name behind RUNNER~1.
  const native = (p: string) => {
    if (p === 'C:\\Users\\RUNNER~1') return 'C:\\Users\\runneradmin';
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  assert.equal(realPath('C:\\Users\\RUNNER~1\\AppData\\Local\\x.txt', { platform: 'win32', native }), 'C:\\Users\\runneradmin\\AppData\\Local\\x.txt');
  // Nothing of it there: as it was.
  assert.equal(realPath('Z:\\nowhere\\x.txt', { platform: 'win32', native: enoent }), 'Z:\\nowhere\\x.txt');
  // What is there is simply made real.
  assert.equal(realPath('C:\\Users\\RUNNER~1', { platform: 'win32', native }), 'C:\\Users\\runneradmin');
  assert.equal(realPath('/a/b', { platform: 'darwin', plain: (p) => `/private${p}` }), '/private/a/b');
});

test('a folder is the same real path by its short name and its long one, which fs.realpathSync leaves apart', { skip: IS_WINDOWS ? false : 'Needs Windows' }, (t) => {
  const dir = aliasedDir();
  if (!dir) return t.skip(NO_SHORT_NAMES);
  assert.notEqual(fs.realpathSync(dir.short), dir.long, 'the JS realpath keeps the short name');
  assert.equal(realPathSync(dir.short), dir.long);
  assert.equal(realPath(path.join(dir.short, 'not', 'there.txt')), path.join(dir.long, 'not', 'there.txt'));
  assert.equal(realPathSync(dir.long.toUpperCase()), dir.long, 'and the case the disk has');
});

// ------------------------------------------------- trust and worktrees by 8.3

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString();
}

function mainAndWorktree(parent: string): { main: string; wt: string } {
  const main = path.join(parent, 'app');
  fs.mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(main, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(main, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  fs.mkdirSync(path.join(main, '.threadbear', 'patches'), { recursive: true });
  fs.writeFileSync(path.join(main, '.threadbear', 'patches', 'tools.ts'), "export default { actions: [{ title: 'Go', run: 'true' }] };\n");
  git(main, 'add', '-A');
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'first');
  const wt = path.join(parent, 'app-threads', 'abc');
  git(main, 'worktree', 'add', '-q', '-b', 'thread/abc', wt);
  return { main, wt };
}

test("a worktree named by its 8.3 short path is still its main checkout: git writes the long names, a cwd may have the short ones", { skip: IS_WINDOWS ? false : 'Needs Windows' }, async (t) => {
  const dir = aliasedDir();
  if (!dir) return t.skip(NO_SHORT_NAMES);
  const { main, wt } = mainAndWorktree(dir.long);
  const shortWt = shortPathOf(wt);
  assert.ok(shortWt && shortWt !== wt, 'the worktree has a short spelling');
  assert.equal(mainCheckoutOf(shortWt), main);
  assert.equal(folderKey(path.join(shortWt, '.threadbear', 'patches', 'tools.ts')), main);

  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json'), claudeHome: dir.long });
  const patch = path.join(main, '.threadbear', 'patches', 'tools.ts');
  trust.trustCurrent([patch]);
  const verdict = await trust.check(path.join(shortWt, '.threadbear', 'patches', 'tools.ts'), 0);
  assert.equal(verdict.trusted, true, 'a patch in the short-named worktree is the main checkout trusted');
  const found = claudeCommands(main, dir.long);
  assert.ok(found);
  trust.trustClaude(main, found.hash);
  assert.deepEqual(trust.checkClaude(shortWt), { trusted: true });
});

test('sameSubfolder relates a cwd and a checkout whichever spelling each has', { skip: IS_WINDOWS ? false : 'Needs Windows' }, (t) => {
  const dir = aliasedDir();
  if (!dir) return t.skip(NO_SHORT_NAMES);
  const top = path.join(dir.long, 'proj');
  const to = path.join(dir.long, 'proj-threads', 'abc');
  fs.mkdirSync(path.join(top, 'runner'), { recursive: true });
  fs.mkdirSync(path.join(to, 'runner'), { recursive: true });
  const shortCwd = shortPathOf(path.join(top, 'runner'));
  assert.ok(shortCwd);
  assert.equal(sameSubfolder(shortCwd, top, to), path.join(to, 'runner'), 'the cwd in short names, the top in long ones');
  assert.equal(sameSubfolder(path.join(top, 'runner'), shortPathOf(top)!, to), path.join(to, 'runner'), 'and the other way round');
});

test("a shared thread's picture is found in its media folder whichever spelling the file and the folder have", { skip: IS_WINDOWS ? false : 'Needs Windows' }, (t) => {
  const dir = aliasedDir();
  if (!dir) return t.skip(NO_SHORT_NAMES);
  const media = path.join(dir.long, 'media');
  fs.mkdirSync(media);
  const file = path.join(media, 'a_picture_with_a_long_name.png');
  fs.writeFileSync(file, makePng(4, 3));
  const shortFile = shortPathOf(file);
  const shortMedia = shortPathOf(media);
  assert.ok(shortFile && shortMedia);
  for (const [given, folder] of [[file, media], [shortFile, media], [file, shortMedia], [shortFile, shortMedia]] as [string, string][]) {
    const read = readShareImage(given, folder);
    assert.ok('bytes' in read, `${given} in ${folder}: ${JSON.stringify('skip' in read ? read.skip : '')}`);
  }
  // And a file in another folder stays out by any spelling.
  const elsewhere = path.join(dir.long, 'a_folder_that_is_not_the_media_folder');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'b_picture_with_a_long_name.png'), makePng(4, 3));
  const outside = shortPathOf(path.join(elsewhere, 'b_picture_with_a_long_name.png'))!;
  assert.deepEqual(readShareImage(outside, shortMedia), { skip: "it isn't in the thread's media folder" });
});

// -------------------------------------------- the spellings of a script's path

function project(files: Record<string, string>): string {
  const folder = path.join(tmpDir(), 'proj');
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), body);
  }
  return folder;
}

const SCRIPT = 'scripts/build-the-thing.sh';

// The ways Git Bash can be handed the repo's script that a Windows
// path.resolve doesn't read as that file.
function spellings(folder: string): Record<string, string> {
  const fwd = folder.replace(/\\/g, '/');
  const letter = fwd[0]!;
  const rest = fwd.slice(2);
  const out: Record<string, string> = {
    'forward slashes': `${fwd}/${SCRIPT}`,
    'backslashes': `${folder}\\${SCRIPT.replace(/\//g, '\\')}`,
    'MSYS /c/': `/${letter.toLowerCase()}${rest}/${SCRIPT}`,
    'MSYS /C/': `/${letter.toUpperCase()}${rest}/${SCRIPT}`,
    'Cygwin /cygdrive/c/': `/cygdrive/${letter.toLowerCase()}${rest}/${SCRIPT}`,
    'admin share on localhost': `//localhost/${letter.toUpperCase()}$${rest}/${SCRIPT}`,
    'admin share on 127.0.0.1': `//127.0.0.1/${letter.toUpperCase()}$${rest}/${SCRIPT}`,
    'extended //?/': `//?/${fwd}/${SCRIPT}`,
    'device //./': `//./${fwd}/${SCRIPT}`,
    'extended with backslashes': `\\\\?\\${folder}\\${SCRIPT.replace(/\//g, '\\')}`,
    'another case': './SCRIPTS/BUILD-THE-THING.SH',
  };
  const short = shortPathOf(path.join(folder, SCRIPT));
  if (short) out['8.3 short names'] = short.replace(/\\/g, '/');
  return out;
}

test('a script run by any spelling Git Bash reads is followed to the file it is, so its changes are hashed', ONLY_WINDOWS, () => {
  const folder = project({ [SCRIPT]: '#!/bin/sh\necho one\n' });
  const real = path.join(folder, SCRIPT);
  for (const [name, spelled] of Object.entries(spellings(folder))) {
    for (const form of [`bash '${spelled}'`, `'${spelled}'`, `cd '${path.dirname(spelled)}' && ./build-the-thing.sh`]) {
      const reach = commandFiles(form, folder);
      assert.equal(reach.problem, undefined, `${name}: ${form}`);
      assert.deepEqual(reach.files.filter((f) => fs.existsSync(f)), [real], `${name}: ${form}`);
    }
  }
});

test("a patch's action that runs the script by any of those spellings asks again when only the script changes", ONLY_WINDOWS, () => {
  const folder = project({ [SCRIPT]: '#!/bin/sh\necho one\n', '.threadbear/patches/p.ts': '' });
  const patch = path.join(folder, '.threadbear', 'patches', 'p.ts');
  for (const [name, spelled] of Object.entries(spellings(folder))) {
    fs.writeFileSync(patch, `export default { actions: [{ title: 'Go', run: ${JSON.stringify(`bash '${spelled}'`)} }] };\n`);
    fs.writeFileSync(path.join(folder, SCRIPT), '#!/bin/sh\necho one\n');
    const before = patchHash(patch);
    assert.equal(before.incomplete, undefined, name);
    fs.writeFileSync(path.join(folder, SCRIPT), '#!/bin/sh\necho EVIL\n');
    assert.notEqual(patchHash(patch).hash, before.hash, `${name}: the script's change is in the hash`);
  }
});

test("a network or device path is refused, wherever it comes up: a live command, and a patch's own action that can't then be trusted", ONLY_WINDOWS, async () => {
  const folder = project({ [SCRIPT]: '#!/bin/sh\necho one\n', '.threadbear/patches/p.ts': '' });
  const patch = path.join(folder, '.threadbear', 'patches', 'p.ts');
  for (const spelled of ['//otherhost/share/x.sh', '\\\\otherhost\\share\\x.sh', '//?/UNC/otherhost/share/x.sh', '//localhost/share/x.sh', '//?/GLOBALROOT/Device/x.sh']) {
    for (const form of [`bash '${spelled}'`, `'${spelled}'`, `cd '${spelled}' && ./x.sh`, `source '${spelled}'`]) {
      // Refused, whichever rule says so first: main's short list refuses
      // bash, a path it can't place and source before it looks at the path.
      assert.ok(liveCommandProblem(form, folder, []), form);
    }
    fs.writeFileSync(patch, `export default { actions: [{ title: 'Go', run: ${JSON.stringify(`bash '${spelled}'`)} }] };\n`);
    const hashed = patchHash(patch);
    assert.match(hashed.incomplete ?? '', /won't follow .*network or device path/, spelled);
    const verdict = await new PatchTrust().check(patch, 0);
    assert.equal(verdict.trusted, false);
    assert.equal(!verdict.trusted && verdict.reason, 'unchecked');
  }
  // Not one, though it starts with slashes: a bare // names no host.
  fs.writeFileSync(patch, "export default { actions: [{ title: 'Go', run: 'true' }, { title: 'Note', run: '// not a path' }] };\n");
  assert.equal(patchHash(patch).incomplete, undefined);
});

test('windowsSpelling: the drive and temp spellings become Windows paths, local network and extended ones too, any other UNC is refused', () => {
  const where = { tmp: 'C:\\Users\\me\\AppData\\Local\\Temp', host: 'MYPC' };
  const same = (v: string, want: string) => assert.deepEqual(windowsSpelling(v, where), { path: want }, v);
  same('/c/Users/me/proj/x.sh', 'C:\\Users\\me\\proj\\x.sh');
  same('/C/Users/me', 'C:\\Users\\me');
  same('/d', 'D:\\');
  same('/d/', 'D:\\');
  same('/cygdrive/e/a/b.sh', 'E:\\a\\b.sh');
  same('/c/Users/me/../you/x', 'C:\\Users\\you\\x');
  same('/C:/Users/me/x.sh', 'C:\\Users\\me\\x.sh');
  same('/tmp', where.tmp);
  same('/tmp/tb/x.sh', `${where.tmp}\\tb\\x.sh`);
  same('//?/C:/Users/me/x.sh', 'C:\\Users\\me\\x.sh');
  same('\\\\?\\C:\\Users\\me\\x.sh', 'C:\\Users\\me\\x.sh');
  same('//./d:/x/y', 'D:\\x\\y');
  same('//localhost/C$/Users/me', 'C:\\Users\\me');
  same('//LOCALHOST/c$/Users', 'C:\\Users');
  same('//127.0.0.1/D$/a', 'D:\\a');
  same('//mypc/C$/a/b', 'C:\\a\\b');
  same('\\\\MYPC\\C$\\a', 'C:\\a');
  // Left as they were: ordinary paths, relative ones, the system's.
  for (const v of ['./x.sh', 'scripts/x.sh', '/usr/bin/bash', '/bin/sh', '/dev/stdin', '/dev/fd/3', '/proc/self/fd/0', 'C:\\Users\\me\\x.sh', 'C:/x/y', '/cygdrive', '/cx/y', '/tmpfile', '//', '// TODO', '']) {
    same(v, v);
  }
  for (const v of ['//otherhost/share/x.sh', '\\\\otherhost\\share\\x.sh', '//?/UNC/otherhost/share/x.sh', '//otherhost/C$/x', '//localhost/share/x.sh', '//?/GLOBALROOT/Device/x', '//./pipe/x', '//x']) {
    assert.match((windowsSpelling(v, where) as { refuse: string }).refuse ?? '', /network or device path/, v);
  }
});

// ---------------------------------------------------- Windows program names

test('programName: on Windows case and the .exe, .cmd, .bat or .com go; on a Mac case goes; elsewhere a name is a name', () => {
  for (const [given, want] of [['node.exe', 'node'], ['NODE.EXE', 'node'], ['npm.cmd', 'npm'], ['Yarn.CMD', 'yarn'], ['setup.bat', 'setup'], ['x.com', 'x'], ['python3.exe', 'python3'], ['bash', 'bash'], ['Rscript.exe', 'rscript'], ['node.exe.exe', 'node.exe'], ['tool.sh', 'tool.sh']]) {
    assert.equal(programName(given!, true), want, given);
    assert.equal(programName(given!, false, false), given, `${given} is itself off Windows and the Mac`);
    // A Mac's disk finds `Env` as env (Grok's review of Daybreak 165).
    assert.equal(programName(given!, false, true), given!.toLowerCase(), `${given} on a Mac`);
  }
});

test('a Windows program name is the program: what node.exe, npm.cmd and the others run is followed or refused as their plain names are', ONLY_WINDOWS, () => {
  const folder = project({
    'package.json': JSON.stringify({ scripts: { build: 'bash ./scripts/main.sh' } }),
    'scripts/main.sh': '. ./lib.sh\n',
    'scripts/lib.sh': 'echo lib\n',
    'scripts/main.js': 'require("./helper.js");\n',
    'scripts/helper.js': 'console.log(1);\n',
    'scripts/x.ps1': 'Write-Output 1\n',
    'scripts/x.bat': '@echo off\r\n',
    'scripts/x.cmd': '@echo off\r\n',
    'scripts/x.py': 'print(1)\n',
    Makefile: 'build:\n\t@./scripts/lib.sh\n',
  });
  const names = (files: string[]) => files.filter((f) => fs.existsSync(f)).map((f) => path.relative(folder, f).replace(/\\/g, '/')).sort();
  // Followed: the same files as the plain name reaches.
  for (const [command, files] of [
    ['node.exe ./scripts/main.js', ['scripts/helper.js', 'scripts/main.js']],
    ['bash.exe ./scripts/main.sh', ['scripts/lib.sh', 'scripts/main.sh']],
    ['sh.exe ./scripts/main.sh', ['scripts/lib.sh', 'scripts/main.sh']],
    ['make.exe build', ['Makefile', 'scripts/lib.sh']],
    ['env.exe bash ./scripts/main.sh', ['scripts/lib.sh', 'scripts/main.sh']],
    ['xargs.exe ./scripts/lib.sh', ['scripts/lib.sh']],
    ['find.exe . -exec ./scripts/lib.sh ;', ['scripts/lib.sh']],
  ] as [string, string[]][]) {
    const reach = commandFiles(command, folder);
    assert.equal(reach.problem, undefined, command);
    // Each, and what Windows could run by name beside them (besideRun).
    const got = names(reach.files);
    for (const f of files) assert.ok(got.includes(f), `${command}: ${f} in ${got.join(', ')}`);
    assert.ok(got.every((f) => files.includes(f) || /\.(bat|cmd|ps1|js)$/.test(f)), `${command}: ${got.join(', ')}`);
  }
  // npm, pnpm and yarn by any name run scripts with cmd.exe on Windows, so
  // they aren't followed (Codex's reviews of the port, 18 Nov 2026).
  for (const command of ['npm.cmd run build', 'NPM.CMD run build', 'pnpm.exe run build', 'yarn.cmd build', 'bun.exe run build', 'npx -c "node main.js"', 'npm', "npm exec --call='node main.js'", 'npm start']) {
    assert.match(commandFiles(command, folder).problem ?? '', /cmd\.exe/, command);
  }
  // Refused, as a language patch trust can't follow: the file it is given is named, but what it loads isn't known.
  for (const [command, program] of [
    ['powershell.exe -File ./scripts/x.ps1', 'powershell'],
    ['powershell ./scripts/x.ps1', 'powershell'],
    ['pwsh.exe -File ./scripts/x.ps1', 'pwsh'],
    ['cmd /c scripts\\x.bat', 'cmd'],
    ['cmd.exe /c ./scripts/x.cmd', 'cmd'],
    ['CMD.EXE /C ./scripts/x.cmd', 'cmd'],
    ['python.exe ./scripts/x.py', 'python'],
    ['py ./scripts/x.py', 'py'],
    ['pythonw.exe ./scripts/x.py', 'pythonw'],
    ['perl.exe -e 1', 'perl'],
    ['ruby.exe -e 1', 'ruby'],
    ['php.exe -r 1', 'php'],
    ['wscript //nologo x.vbs', 'wscript'],
    ['cscript.exe //nologo x.js', 'cscript'],
    ['mshta.exe x.hta', 'mshta'],
    ['wsl.exe ./scripts/main.sh', 'wsl'],
    ['conhost.exe bash ./scripts/main.sh', 'conhost'],
    ['Rscript.exe x.R', 'rscript'],
  ] as [string, string][]) {
    assert.match(commandFiles(command, folder).problem ?? '', new RegExp(`runs ${program}, whose loads patch trust can't follow`), command);
  }
  // Code on the command line is refused through the .exe too.
  assert.match(commandFiles('node.exe -e "require(\'./scripts/helper.js\')"', folder).problem ?? '', /code on its command line/);
  assert.match(commandFiles('node -e "1"', folder).problem ?? '', /code on its command line/);
  // A batch or PowerShell file run directly is code that can't be followed.
  for (const script of ['./scripts/x.bat', './scripts/x.cmd']) assert.match(commandFiles(script, folder).problem ?? '', /isn't a shell script or JavaScript/, script);
});

test('a script in a shebang that names a Windows program is read as that program', ONLY_WINDOWS, () => {
  const folder = project({
    'scripts/a.sh': '#!/usr/bin/env bash.exe\n./scripts/b.sh\n',
    'scripts/b.sh': 'echo b\n',
    'scripts/c.js': '#!/usr/bin/env node.exe\nconsole.log(1);\n',
  });
  const reach = commandFiles('./scripts/a.sh', folder);
  assert.equal(reach.problem, undefined);
  assert.ok(reach.files.some((f) => f.endsWith('b.sh')), 'read as a shell script, so what it runs is followed');
  assert.equal(commandFiles('./scripts/c.js', folder).problem, undefined, 'and a node one as JavaScript');
});

test('looksRunnable: a PowerShell script and a batch file are code on Windows only', () => {
  const dir = tmpDir();
  for (const name of ['x.ps1', 'x.bat', 'x.cmd', 'X.BAT']) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'data\n');
    assert.equal(looksRunnable(f), IS_WINDOWS, name);
    assert.equal(looksRunnable(path.join(dir, `missing-${name}`)), IS_WINDOWS, `${name}, missing`);
  }
  // As before everywhere.
  for (const name of ['x.sh', 'x.mjs', 'x.py']) assert.equal(looksRunnable(path.join(dir, name)), true, name);
  const data = path.join(dir, 'state.json');
  fs.writeFileSync(data, '{}');
  assert.equal(looksRunnable(data), false);
});

// ------------------------------------------------------- the fingerprint cache

// SetFileInformationByHandle can set a file's ChangeTime, which nothing else
// (no utimes, no touch) can: how a program puts back every time a stat shows.
const SET_TIMES = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class PutBack {
  [StructLayout(LayoutKind.Sequential)] public struct FILE_BASIC_INFO { public long CreationTime; public long LastAccessTime; public long LastWriteTime; public long ChangeTime; public uint FileAttributes; }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern SafeFileHandle CreateFileW(string f, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetFileInformationByHandle(SafeFileHandle h, int cls, ref FILE_BASIC_INFO info, uint size);
  public static int Set(string p, long change, long write) {
    var h = CreateFileW(p, 0x100, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (h.IsInvalid) return Marshal.GetLastWin32Error();
    var i = new FILE_BASIC_INFO { ChangeTime = change, LastWriteTime = write };
    return SetFileInformationByHandle(h, 0, ref i, (uint)Marshal.SizeOf(i)) ? 0 : Marshal.GetLastWin32Error();
  }
}
"@
exit [PutBack]::Set($env:PUT_BACK_FILE, [long]$env:PUT_BACK_CHANGE, [long]$env:PUT_BACK_WRITE)
`;

function putTimesBack(file: string, st: fs.Stats): boolean {
  const toFileTime = (ms: number) => String(BigInt(Math.round(ms * 10000)) + 116444736000000000n);
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SET_TIMES, 'utf16le').toString('base64')], {
      stdio: 'pipe',
      windowsHide: true,
      env: { ...process.env, PUT_BACK_FILE: file, PUT_BACK_CHANGE: toFileTime(st.ctimeMs), PUT_BACK_WRITE: toFileTime(st.mtimeMs) },
    });
    return true;
  } catch {
    return false;
  }
}

test('an edit at the same size with every time put back (ChangeTime too) still asks again: Windows reads the bytes on a cache hit', { ...ONLY_WINDOWS, timeout: 60_000 }, async (t) => {
  const folder = project({ 'scripts/check.sh': '#!/bin/sh\necho GOOD\n', '.threadbear/patches/p.ts': "export default { hooks: [{ title: 'H', on: 'turn.end', run: './scripts/check.sh' }] };\n" });
  const patch = path.join(folder, '.threadbear', 'patches', 'p.ts');
  const script = path.join(folder, 'scripts', 'check.sh');
  const trust = new PatchTrust();
  trust.trustCurrent([patch]);
  assert.equal((await trust.check(patch, 0)).trusted, true);

  const before = fs.statSync(script);
  const print = fingerprint(script);
  fs.writeFileSync(script, '#!/bin/sh\necho EVIL\n');
  // A later modified time, so a plain edit shows whatever the clock's grain.
  fs.utimesSync(script, before.atime, new Date(before.mtimeMs + 2000));
  assert.equal(fs.statSync(script).size, before.size, 'the same size');
  assert.notEqual(fingerprint(script), print, 'a plain edit shows in the fingerprint');
  if (!putTimesBack(script, before) || fingerprint(script) !== print) return t.skip("this machine wouldn't put the times back, so the stat can't be made to match");

  const verdict = await trust.check(patch, 0);
  assert.equal(verdict.trusted, false, 'the cached hash is not trusted over the changed bytes');
  assert.equal(!verdict.trusted && verdict.reason, 'changed');
});

// Codex's review of the port onto main (18 Nov 2026).

test('a script that sets HOME, in any form, fails closed, on every platform', () => {
  const folder = project({ 'payload.sh': 'echo one\n' });
  for (const command of [
    'HOME="$PWD"; bash "$HOME/payload.sh"',
    'HOME=/outside bash "$HOME/payload.sh"',
    'export HOME="$PWD"; bash -c \'bash "$HOME/payload.sh"\'',
    "export 'HOME=.'; bash ~/payload.sh",
    "env 'HOME=.' bash ~/payload.sh",
    'read HOME < x; cd; bash payload.sh',
    'for HOME in .; do bash ~/payload.sh; done',
    'export "HOME=$PWD"; bash "$HOME/payload.sh"',
    'printf -v HOME %s "$PWD"; bash "$HOME/payload.sh"',
    "declare 'HOME[0]=0'; bash \"$HOME/payload.sh\"",
    "read -r 'HOME[0]' < home.txt; bash \"$HOME/payload.sh\"",
    'unset HOME; bash ~/payload.sh',
  ]) assert.match(commandFiles(command, folder).problem ?? '', /sets HOME|printf -v/, command);
  // A name reference can write HOME by another name.
  assert.match(commandFiles('declare -n d=HOME; d="$PWD"; bash "$HOME/payload.sh"', folder).problem ?? '', /name reference/);
});

test('a folder of the repo put on PATH in a Git Bash spelling is still the repo\'s', ONLY_WINDOWS, () => {
  const folder = project({ 'bin/payload.exe': 'MZ' });
  const bash = '/' + folder[0]!.toLowerCase() + folder.slice(2).replace(/\\/g, '/');
  assert.ok(commandFiles(`PATH=${bash}/bin:$PATH; payload.exe`, folder).problem, bash);
});

test('a program named by a backslash path is followed as the file it is', ONLY_WINDOWS, () => {
  const folder = project({ 'payload.sh': 'echo one\n' });
  const r = commandFiles(`'${path.join(folder, 'payload.sh')}'`, folder);
  assert.ok(r.files.some((f) => /payload\.sh$/.test(f)), JSON.stringify(r));
  assert.match(commandFiles("'\\\\otherhost\\share\\x.sh'", folder).problem ?? '', /network or device path/);
});

test("a package script isn't followed on Windows: npm runs it with cmd.exe", ONLY_WINDOWS, () => {
  const folder = project({ 'package.json': '{"scripts":{"build":"node ./main.js"}}', 'main.js': '1;\n' });
  assert.match(commandFiles('npm run build', folder).problem ?? '', /cmd\.exe/);
  // Refused either way; the main.js beside it, which Windows could run by
  // name, isn't in the empty list of hashed files either.
  assert.ok(liveCommandProblem('npm run build', folder, []));
  assert.ok(liveCommandProblem('npx convex data', folder, []));
});

test("turning off Git Bash's path conversion fails closed", ONLY_WINDOWS, () => {
  const folder = project({ 'payload.js': '1;\n' });
  for (const name of ['MSYS2_ARG_CONV_EXCL', 'MSYS_NO_PATHCONV']) {
    for (const form of [`${name}='*' node /c/repo/payload.js`, `export '${name}=*'; node /c/repo/payload.js`, `declare -x '${name}=*'; node /c/repo/payload.js`, `env '${name}=*' node /c/repo/payload.js`, `skip='*'; export "${name}=$skip"; node /c/repo/payload.js`, `printf -v ${name} %s 1; export ${name}; node /c/repo/payload.js`]) {
      assert.match(commandFiles(form, folder).problem ?? '', new RegExp(name), form);
    }
  }
});

test('off Windows a backslash in a PATH entry is part of a name, not a package bin folder', { skip: IS_WINDOWS && 'a backslash is a separator there' }, () => {
  const folder = project({ 'bin\\node_modules\\.bin/payload': 'echo one\n' });
  assert.ok(commandFiles('PATH="$PWD/bin\\node_modules\\.bin:$PATH"; payload', folder).problem);
});

test("nothing a patch runs can let cmd.exe run a program from the folder again (Codex's third review)", ONLY_WINDOWS, () => {
  const folder = project({ 'main.js': '1;\n' });
  for (const command of ['unset NoDefaultCurrentDirectoryInExePath; node main.js', 'env -u NoDefaultCurrentDirectoryInExePath node main.js', 'env -i node main.js', 'NoDefaultCurrentDirectoryInExePath= node main.js']) {
    assert.match(commandFiles(command, folder).problem ?? '', /NoDefaultCurrentDirectoryInExePath|env -i/, command);
  }
});

// Codex's fourth review of the port (19 Nov 2026).

test('HOME set by arithmetic or let, or printf or unset worked out as it runs, fails closed, on every platform; reading it is fine', () => {
  const folder = project({ 'payload.sh': 'echo one\n', '0/payload.sh': 'echo two\n' });
  for (const command of [
    ': "$((HOME=0))"; bash "$HOME/payload.sh"',
    ': $(( HOME += 1 )); bash "$HOME/payload.sh"',
    'let HOME=0; bash "$HOME/payload.sh"',
    '(( HOME = 0 )); bash "$HOME/payload.sh"',
    ': $((HOME++)); bash "$HOME/payload.sh"',
  ]) assert.match(commandFiles(command, folder).problem ?? '', /sets HOME/, command);
  for (const command of [
    'option=-v; printf "$1" HOME %s "$PWD"; bash "$HOME/payload.sh"',
    'unset "$1"; bash payload.sh',
  ]) assert.ok(commandFiles(command, folder).problem, command);
  for (const command of ['[ "$HOME" = x ] && bash payload.sh', '[ $HOME = x ] || bash payload.sh', 'printf "%s\\n" "$HOME"; bash payload.sh', 'x=1; local y="$x"; bash payload.sh', ': "${HOME}"; bash payload.sh', '# HOME=0\nbash payload.sh']) {
    assert.equal(commandFiles(command, folder).problem, undefined, command);
  }
});

test('a program a pull drops beside a script, which Windows would run in place of an installed one, changes what is hashed', ONLY_WINDOWS, () => {
  const folder = project({ 'check.sh': 'git status\n' });
  const before = commandFiles('./check.sh', folder).files;
  fs.writeFileSync(path.join(folder, 'git.exe'), 'MZ');
  const after = commandFiles('./check.sh', folder).files;
  assert.ok(after.some((f) => /git\.exe$/i.test(f)), JSON.stringify(after));
  assert.ok(!before.some((f) => /git\.exe$/i.test(f)));
});

test('a cached patch hash looks again when a runnable file turns up beside what it runs', ONLY_WINDOWS, async () => {
  const folder = project({ 'check.sh': 'git status\n', '.threadbear/patches/p.ts': "export default { hooks: [{ title: 'H', on: 'turn.end', run: './check.sh' }] };\n" });
  const patch = path.join(folder, '.threadbear', 'patches', 'p.ts');
  const trust = new PatchTrust();
  trust.trustCurrent([patch]);
  assert.equal((await trust.check(patch, 0)).trusted, true);
  fs.writeFileSync(path.join(folder, 'git.cmd'), '@echo pwned\n');
  const v = await trust.check(patch, 0);
  assert.equal(v.trusted, false);
});

test('the ways round NoDefaultCurrentDirectoryInExePath fail closed on Windows', ONLY_WINDOWS, () => {
  const folder = project({ 'main.js': '1;\n', 'package.json': '{"scripts":{"build":"node main.js"}}' });
  for (const command of [
    'export -n NoDefaultCurrentDirectoryInExePath; git status',
    'declare +x NoDefaultCurrentDirectoryInExePath; git status',
    'env --unset=NoDefaultCurrentDirectoryInExePath git status',
    'env -uNoDefaultCurrentDirectoryInExePath git status',
    'exec -c git status',
    'corepack pnpm run build',
    "node 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js' run build",
  ]) assert.ok(commandFiles(command, folder).problem, command);
});

test('followed JavaScript that starts a program with an environment of its own fails closed on Windows', ONLY_WINDOWS, () => {
  const folder = project({
    'own-env.cjs': "require('node:child_process').execSync('node main.js', { env: { SystemRoot: process.env.SystemRoot } });\n",
    'inherits.cjs': "require('node:child_process').execSync('git status', { stdio: 'inherit' });\nconsole.log(process.env.PATH);\n",
  });
  assert.match(commandFiles('node own-env.cjs', folder).problem ?? '', /environment of its own/);
  assert.equal(commandFiles('node inherits.cjs', folder).problem, undefined);
});

// Codex's sixth review (19 Nov 2026).

test("cd --, CDPATH, find -execdir and let fail closed or are followed, on every platform", () => {
  const folder = project({ 'payload.sh': 'echo root\n', 'sub/payload.sh': 'echo sub\n', 'sub/marker': '' });
  const r = commandFiles('cd -- sub; bash payload.sh', folder);
  assert.equal(r.problem, undefined);
  assert.ok(r.files.some((f) => /sub[\\/]payload\.sh$/.test(f)), JSON.stringify(r.files));
  for (const command of [
    'CDPATH="$PWD/nest"; cd target; bash payload.sh',
    'find sub -name marker -execdir bash payload.sh \;',
    'target=HOME; let "$target=1"; bash "$HOME/payload.sh"',
  ]) assert.ok(commandFiles(command, folder).problem, command);
});

test("a hook's script hashed only as a file beside another isn't taken as followed", ONLY_WINDOWS, async () => {
  const folder = project({
    '.threadbear/patches/p.ts': "export default { hooks: [{ title: 'Check', on: 'turn.end', run: '.' + '/check.js' }] };\n",
    'check.js': '#!/usr/bin/env bash\nbash sub/payload.sh\n',
    'sub/payload.sh': 'echo one\n',
  });
  const patch = path.join(folder, '.threadbear', 'patches', 'p.ts');
  const trust = new PatchTrust();
  trust.trustCurrent([patch]);
  const { loadPatchSet } = await import('../../src/patches.ts');
  const set = await loadPatchSet(folder, tmpDir(), new Map(), [], [], undefined, trust);
  assert.equal(set.hooks.length, 0);
  assert.match(set.patches[0]?.error ?? '', /hook "Check"/);
});
