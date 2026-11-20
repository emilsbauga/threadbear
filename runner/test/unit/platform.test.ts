import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDirFor, exeName, logFileFor } from '../../src/platform.ts';
import { onPath } from '../../src/adapters/acp/agents.ts';

test('the data dir and log keep the Mac names off Windows', () => {
  assert.equal(dataDirFor({ platform: 'darwin', home: '/Users/x' }), '/Users/x/Library/Application Support/Threadbear');
  assert.equal(dataDirFor({ platform: 'linux', home: '/home/x' }), '/home/x/Library/Application Support/Threadbear');
  assert.equal(logFileFor({ platform: 'darwin', home: '/Users/x' }), '/Users/x/Library/Logs/threadbear-runner.log');
});

test('Windows keeps the data dir and log in Local AppData, not Roaming', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
  assert.equal(dataDirFor({ platform: 'win32', home: 'C:\\Users\\x', env }), 'C:\\Users\\x\\AppData\\Local\\Threadbear');
  assert.equal(logFileFor({ platform: 'win32', home: 'C:\\Users\\x', env }), 'C:\\Users\\x\\AppData\\Local\\Threadbear\\Logs\\threadbear-runner.log');
  // No variable: where Windows puts it.
  assert.equal(dataDirFor({ platform: 'win32', home: 'C:\\Users\\x', env: {} }), 'C:\\Users\\x\\AppData\\Local\\Threadbear');
});

test("a test's own home never reaches the real LOCALAPPDATA", () => {
  assert.equal(dataDirFor({ platform: 'win32', home: 'C:\\Temp\\fake' }), 'C:\\Temp\\fake\\AppData\\Local\\Threadbear');
});

test('program names get .exe only on Windows', () => {
  assert.equal(exeName('claude', 'win32'), 'claude.exe');
  assert.equal(exeName('claude', 'darwin'), 'claude');
});

test('onPath splits the PATH the way the platform does', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-onpath-'));
  try {
    const own = process.platform === 'win32' ? 'tool.exe' : 'tool';
    fs.writeFileSync(path.join(dir, own), '');
    fs.chmodSync(path.join(dir, own), 0o755);
    const pathEnv = ['relative', dir].join(path.delimiter);
    assert.equal(onPath('tool', pathEnv), path.join(dir, own));
    assert.equal(onPath('missing', pathEnv), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude Code's PowerShell tool is off on Windows, where the guards read only Bash", async () => {
  const { cliEnv } = await import('../../src/adapters/claude/adapter.ts');
  const account = { id: 'claude-1', provider: 'claude' as const, title: '', configDir: '/acct/claude-1' };
  assert.equal(cliEnv(account, {}, 'win32').CLAUDE_CODE_USE_POWERSHELL_TOOL, '0');
  assert.equal(cliEnv(account, {}, 'darwin').CLAUDE_CODE_USE_POWERSHELL_TOOL, undefined);
});

test("npm and Codex beside the runner's Node: links elsewhere, scripts on Windows", async () => {
  const { npmBeside, codexBeside, runOnNode } = await import('../../src/platform.ts');
  assert.equal(npmBeside('/opt/node/bin/node', 'darwin'), '/opt/node/bin/npm');
  assert.equal(npmBeside('C:\\node\\node.exe', 'win32'), 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js');
  assert.equal(codexBeside('/opt/node/bin/node', 'linux'), '/opt/node/bin/codex');
  assert.equal(codexBeside('C:\\node\\node.exe', 'win32'), 'C:\\node\\node_modules\\@openai\\codex\\bin\\codex.js');
  assert.deepEqual(runOnNode('C:\\n\\npm-cli.js', ['ci'], 'C:\\n\\node.exe'), ['C:\\n\\node.exe', ['C:\\n\\npm-cli.js', 'ci']]);
  assert.deepEqual(runOnNode('/opt/node/bin/npm', ['ci']), ['/opt/node/bin/npm', ['ci']]);
});
