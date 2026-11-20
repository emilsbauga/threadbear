// Threadbear's own Codex copies (src/updates/codex.ts): `current` is a link,
// and on Windows a file naming the version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexCopies } from '../../src/updates/codex.ts';

function copies(platform: NodeJS.Platform): { c: CodexCopies; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-cur-'));
  for (const v of ['0.1.0', '0.2.0']) {
    const pkg = path.join(dir, v, 'node_modules', '@openai', 'codex');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: v }));
  }
  const c = new CodexCopies({ dir, platform, npmPath: 'npm', exec: async () => ({ code: 0, stdout: '', stderr: '' }), env: {}, tmpDir: dir, now: () => 0 } as unknown as ConstructorParameters<typeof CodexCopies>[0]);
  return { c, dir };
}

test("on Windows, current is a file naming the version, and Codex starts from that version's folder", () => {
  const { c, dir } = copies('win32');
  try {
    assert.equal(c.currentVersion(), undefined);
    c.activate('0.1.0');
    assert.equal(fs.lstatSync(path.join(dir, 'current')).isSymbolicLink(), false);
    assert.equal(c.currentVersion(), '0.1.0');
    assert.equal(c.currentLink, path.join(dir, '0.1.0'));
    c.activate('0.2.0');
    assert.equal(c.currentVersion(), '0.2.0');
    assert.equal(c.state().previous, '0.1.0');
    // A file naming something that isn't a version there counts for nothing.
    fs.writeFileSync(path.join(dir, 'current'), '..\\elsewhere\n');
    assert.equal(c.currentVersion(), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('elsewhere current stays a link Codex starts through', { skip: process.platform === 'win32' ? 'symlinks need a privilege on Windows' : false }, () => {
  const { c, dir } = copies('darwin');
  try {
    c.activate('0.1.0');
    assert.equal(fs.readlinkSync(path.join(dir, 'current')), '0.1.0');
    assert.equal(c.currentLink, path.join(dir, 'current'));
    assert.equal(c.currentVersion(), '0.1.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("on Windows a version some program is running from isn't cleaned up, whatever case its command line uses", () => {
  const { c, dir } = copies('win32');
  try {
    for (const v of ['0.3.0', '0.4.0']) {
      const pkg = path.join(dir, v, 'node_modules', '@openai', 'codex');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: v }));
    }
    c.activate('0.4.0');
    const running = `${path.join(dir, '0.1.0').toUpperCase()}${path.sep}node_modules\\x\\codex.exe app-server\r\n`;
    const removed = c.cleanup(1, [], running);
    assert.ok(!removed.includes('0.1.0'), `0.1.0 was in use: ${removed}`);
    assert.ok(removed.includes('0.2.0') && removed.includes('0.3.0'), String(removed));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("npm's install gets the inherited PATH however Windows spells it, after the runner's Node", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-path-'));
  try {
    let seen: NodeJS.ProcessEnv | undefined;
    const c = new CodexCopies({ dir, npmPath: path.join(path.dirname(process.execPath), 'npm'), exec: async (_f: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => ((seen = o.env), { code: 1, stdout: '', stderr: '' }), env: { Path: 'C:\\Git\\cmd', OTHER: '1' }, tmpDir: dir, now: () => 0 } as unknown as ConstructorParameters<typeof CodexCopies>[0]);
    await (c as unknown as { install(v: string): Promise<unknown> }).install('0.1.0').catch(() => {});
    assert.ok(seen, 'npm ran');
    assert.deepEqual(Object.keys(seen!).filter((k) => k.toUpperCase() === 'PATH'), ['PATH']);
    assert.equal(seen!.PATH, `${path.dirname(process.execPath)}${path.delimiter}C:\\Git\\cmd`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a codexPath that's npm's codex.cmd starts the package beside it", async () => {
  const { resolveCodexBinary } = await import('../../src/adapters/codex/appserver.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-cmd-'));
  try {
    const pkg = path.join(dir, 'node_modules', '@openai', 'codex');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    fs.writeFileSync(path.join(pkg, 'bin', 'codex.js'), '');
    fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\n');
    const b = resolveCodexBinary(path.join(dir, 'codex.cmd'), '/node');
    assert.equal(b.command, '/node');
    assert.equal(b.args[0], fs.realpathSync(path.join(pkg, 'bin', 'codex.js')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
