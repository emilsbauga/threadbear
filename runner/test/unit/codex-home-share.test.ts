// An extra Codex login (codex-N, its own CODEX_HOME) gets ~/.codex's
// instructions, hooks, skills and config.toml as links, and its hooks the
// trust Codex says they have in ~/.codex (codex-home-share.ts). codex-1 on
// the M5 ran without any of them until 23 Nov 2026. Later cases are from the
// Codex and Gemini reviews that day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookTrust, onlyProjectTrust, shareCodexHome, type MainHook } from '../../src/codex-home-share.ts';

function homes() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-share-')));
  const main = path.join(root, '.codex');
  const login = path.join(root, 'Accounts', 'codex-1');
  fs.mkdirSync(path.join(main, 'skills', '.system'), { recursive: true });
  fs.mkdirSync(path.join(main, 'skills', 'delegate'), { recursive: true });
  fs.mkdirSync(path.join(main, 'skills', 'render-box'), { recursive: true });
  fs.mkdirSync(path.join(login, 'skills', '.system'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Mike\n');
  fs.symlinkSync(path.join(root, 'CLAUDE.md'), path.join(main, 'AGENTS.md'));
  fs.writeFileSync(path.join(main, 'hooks.json'), '{"hooks":{}}');
  fs.writeFileSync(path.join(main, 'config.toml'), 'model = "gpt-6.1-sol"\n\n[mcp_servers.connectors]\nurl = "https://example.test/mcp"\n');
  fs.writeFileSync(path.join(login, 'auth.json'), '{}');
  fs.writeFileSync(path.join(login, 'config.toml'), '\n[projects."/Users/me/dev/thing"]\ntrust_level = "trusted"\n');
  return { root, main, login };
}

const linkOf = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false });

test('a fresh login gets links to the main home, its own files untouched', () => {
  const { main, login } = homes();
  const report = shareCodexHome(main, login, 'file', '2026-11-23');
  assert.deepEqual(report.skipped, []);
  for (const name of ['AGENTS.md', 'hooks.json', 'config.toml']) assert.equal(fs.readlinkSync(path.join(login, name)), path.join(main, name));
  assert.equal(fs.readFileSync(path.join(login, 'AGENTS.md'), 'utf8'), '# Mike\n');
  assert.equal(fs.readlinkSync(path.join(login, 'skills', 'delegate')), path.join(main, 'skills', 'delegate'));
  assert.equal(fs.readlinkSync(path.join(login, 'skills', 'render-box')), path.join(main, 'skills', 'render-box'));
  // Codex's own system skills stay the login's, as do its tokens.
  assert.ok(!fs.lstatSync(path.join(login, 'skills', '.system')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(login, 'auth.json'), 'utf8'), '{}');
  // The trust-only config.toml Codex wrote is kept beside the link.
  assert.match(fs.readFileSync(path.join(login, 'config.toml.before-share-2026-11-23'), 'utf8'), /trust_level/);
  // Once shared, a second pass changes nothing.
  assert.deepEqual(shareCodexHome(main, login, 'file', '2026-11-23'), { changes: [], skipped: [] });
});

test("a login's own config.toml with settings, or its own AGENTS.md, is left alone", () => {
  const { main, login } = homes();
  fs.writeFileSync(path.join(login, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  fs.writeFileSync(path.join(login, 'AGENTS.md'), '# its own\n');
  const report = shareCodexHome(main, login, 'file');
  assert.equal(fs.readFileSync(path.join(login, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "keyring"\n');
  assert.equal(fs.readFileSync(path.join(login, 'AGENTS.md'), 'utf8'), '# its own\n');
  assert.equal(report.skipped.length, 2);
  assert.equal(fs.readlinkSync(path.join(login, 'hooks.json')), path.join(main, 'hooks.json'));
});

test('the main home itself, or a link to it, is never touched', () => {
  const { root, main } = homes();
  assert.deepEqual(shareCodexHome(main, main, 'file'), { changes: [], skipped: [] });
  const alias = path.join(root, 'alias');
  fs.symlinkSync(main, alias);
  assert.deepEqual(shareCodexHome(main, alias, 'file'), { changes: [], skipped: [] });
  assert.deepEqual(hookTrust([{ key: `${path.join(main, 'hooks.json')}:stop:0:0`, trustStatus: 'trusted', currentHash: 'sha256:a' }], main, alias), {});
});

test("a skill deleted from the main home loses its link; the login's own skills stay", () => {
  const { main, login } = homes();
  fs.mkdirSync(path.join(login, 'skills', 'mine'));
  shareCodexHome(main, login, 'file');
  fs.rmSync(path.join(main, 'skills', 'render-box'), { recursive: true });
  const report = shareCodexHome(main, login, 'file');
  assert.ok(!fs.existsSync(path.join(login, 'skills', 'render-box')));
  assert.ok(fs.existsSync(path.join(login, 'skills', 'mine')));
  assert.equal(report.changes.length, 1);
});

test("hooks get the trust Codex reports for the main home, under the login's own path", () => {
  const { main, login } = homes();
  const hooks: MainHook[] = [
    { key: `${path.join(main, 'hooks.json')}:pre_tool_use:0:0`, trustStatus: 'trusted', currentHash: 'sha256:aaa' },
    { key: `${path.join(main, 'hooks.json')}:session_start:0:0`, trustStatus: 'trusted', currentHash: 'sha256:bbb', enabled: false },
    // Changed since it was trusted, never trusted, or another file's.
    { key: `${path.join(main, 'hooks.json')}:stop:0:0`, trustStatus: 'modified', currentHash: 'sha256:ccc' },
    { key: `${path.join(main, 'hooks.json')}:stop:1:0`, trustStatus: 'untrusted', currentHash: 'sha256:ddd' },
    { key: '/repo/.codex/hooks.json:stop:0:0', trustStatus: 'trusted', currentHash: 'sha256:eee' },
  ];
  // Not shared yet: the login's hooks aren't the main ones, so no trust.
  assert.deepEqual(hookTrust(hooks, main, login), {});
  shareCodexHome(main, login, 'file');
  assert.deepEqual(hookTrust(hooks, main, login), {
    'hooks.state': {
      [`${path.join(login, 'hooks.json')}:pre_tool_use:0:0`]: { trusted_hash: 'sha256:aaa' },
      [`${path.join(login, 'hooks.json')}:session_start:0:0`]: { trusted_hash: 'sha256:bbb', enabled: false },
    },
  });
});

test("a hooks.json of the login's own gets no trust from the main home", () => {
  const { main, login } = homes();
  fs.writeFileSync(path.join(login, 'hooks.json'), '{"hooks":{}}');
  shareCodexHome(main, login, 'file');
  assert.deepEqual(hookTrust([{ key: `${path.join(main, 'hooks.json')}:stop:0:0`, trustStatus: 'trusted', currentHash: 'sha256:a' }], main, login), {});
});

test('onlyProjectTrust knows the file Codex writes on a fresh login', () => {
  assert.ok(onlyProjectTrust('[projects."/a"]\ntrust_level = "trusted"\n\n[projects.\'/b\']\ntrust_level = "untrusted"\n'));
  assert.ok(!onlyProjectTrust('model = "x"\n[projects."/a"]\ntrust_level = "trusted"\n'));
  assert.ok(!onlyProjectTrust('[projects."/a"]\ntrust_level = "trusted"\n[mcp_servers.x]\ncommand = "y"\n'));
});

test("a config.toml moved aside never replaces an earlier one, and comes back if the link can't be made", () => {
  const { main, login } = homes();
  shareCodexHome(main, login, 'file', '2026-11-23');
  // Codex made a new trust-only file in its place, the same day.
  fs.unlinkSync(path.join(login, 'config.toml'));
  fs.writeFileSync(path.join(login, 'config.toml'), '[projects."/b"]\ntrust_level = "trusted"\n');
  shareCodexHome(main, login, 'file', '2026-11-23');
  assert.match(fs.readFileSync(path.join(login, 'config.toml.before-share-2026-11-23'), 'utf8'), /thing/);
  assert.match(fs.readFileSync(path.join(login, 'config.toml.before-share-2026-11-23-2'), 'utf8'), /"\/b"/);
  // A link refused (as on Windows without the right): the file stays.
  fs.unlinkSync(path.join(login, 'config.toml'));
  fs.writeFileSync(path.join(login, 'config.toml'), '[projects."/c"]\ntrust_level = "trusted"\n');
  const real = fs.symlinkSync;
  (fs as { symlinkSync: typeof fs.symlinkSync }).symlinkSync = () => {
    throw new Error('EPERM: operation not permitted');
  };
  try {
    assert.equal(shareCodexHome(main, login, 'file', '2026-11-24').skipped.length, 1);
  } finally {
    (fs as { symlinkSync: typeof fs.symlinkSync }).symlinkSync = real;
  }
  assert.ok(!fs.lstatSync(path.join(login, 'config.toml')).isSymbolicLink());
  assert.match(fs.readFileSync(path.join(login, 'config.toml'), 'utf8'), /"\/c"/);
  assert.ok(!fs.existsSync(path.join(login, 'config.toml.before-share-2026-11-24')));
});

test("a main home keeping its sign-in in the Keychain doesn't send the login there; not knowing leaves config.toml be", () => {
  const { main, login } = homes();
  // Codex couldn't be asked: nothing done to config.toml, the rest shared.
  shareCodexHome(main, login, undefined);
  assert.ok(!fs.lstatSync(path.join(login, 'config.toml')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(login, 'hooks.json')).isSymbolicLink());
  fs.unlinkSync(path.join(login, 'config.toml'));
  shareCodexHome(main, login, 'file');
  assert.ok(fs.lstatSync(path.join(login, 'config.toml')).isSymbolicLink());
  // Now keyring: the link goes, and stays gone.
  shareCodexHome(main, login, 'keyring');
  assert.equal(linkOf(path.join(login, 'config.toml')), undefined);
  assert.equal(shareCodexHome(main, login, 'keyring').skipped.length, 1);
});

test('a link whose file left the main home goes too', () => {
  const { main, login } = homes();
  shareCodexHome(main, login, 'file');
  fs.unlinkSync(path.join(main, 'AGENTS.md'));
  const report = shareCodexHome(main, login, 'file');
  assert.equal(linkOf(path.join(login, 'AGENTS.md')), undefined);
  assert.equal(report.changes.length, 1);
});

test("a skills file where the folder should be doesn't stop the rest", () => {
  const { main, login } = homes();
  fs.rmSync(path.join(login, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(login, 'skills'), 'not a folder');
  const report = shareCodexHome(main, login, 'file');
  assert.equal(report.skipped.length, 1);
  assert.equal(fs.readlinkSync(path.join(login, 'hooks.json')), path.join(main, 'hooks.json'));
});

test('a config.toml Codex saves while it is being moved aside is kept, not dropped', () => {
  const { main, login } = homes();
  const cfg = path.join(login, 'config.toml');
  const real = fs.linkSync;
  (fs as { linkSync: typeof fs.linkSync }).linkSync = (from, to) => {
    real(from, to);
    // Codex saves its settings in place (write, then rename over).
    fs.writeFileSync(`${cfg}.tmp`, 'model = "mine"\n');
    fs.renameSync(`${cfg}.tmp`, cfg);
  };
  try {
    assert.equal(shareCodexHome(main, login, 'file', '2026-11-23').skipped.length, 1);
  } finally {
    (fs as { linkSync: typeof fs.linkSync }).linkSync = real;
  }
  assert.ok(!fs.lstatSync(cfg).isSymbolicLink());
  assert.equal(fs.readFileSync(cfg, 'utf8'), 'model = "mine"\n');
  // The next pass sees settings of its own and leaves it.
  assert.equal(shareCodexHome(main, login, 'file').skipped.length, 1);
  assert.ok(!fs.lstatSync(cfg).isSymbolicLink());
});
