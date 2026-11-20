// The login dev runners and the end-to-end tests use when TB_E2E_ACCOUNT
// names none (src/test-login.ts). claude-main's Max lapsed on 16 Nov 2026,
// and every dev-runner thread and e2e run on Mike's Mac kept landing on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Account } from '../../src/protocol.ts';
import { pickTestLogin, testLogin } from '../../src/test-login.ts';
import { tmpDir } from '../helpers/fakes.ts';

const claude = (id: string, more: Partial<Account> = {}): Account => ({ id, provider: 'claude', title: id, configDir: `/tmp/${id}`, ...more });

test('the first Claude login that works: not plan-ended, noted or another provider', () => {
  assert.equal(pickTestLogin([claude('claude-main'), claude('claude-2')]), 'claude-main');
  assert.equal(
    pickTestLogin([
      { id: 'codex-main', provider: 'codex', title: 'c', configDir: '/tmp/c' },
      claude('claude-main', { planEnded: true }),
      claude('claude-2', { note: 'Work only' }),
      claude('claude-3', { signedOut: true }),
      claude('claude-4'),
    ]),
    'claude-4',
  );
  // Nothing better: claude-main, as before (a fork's only login).
  assert.equal(pickTestLogin([claude('claude-main', { planEnded: true })]), 'claude-main');
  assert.equal(pickTestLogin([]), 'claude-main');
});

test('TB_E2E_ACCOUNT wins; otherwise discovery, honouring runner.json hiddenLogins and accountNotes', () => {
  const root = tmpDir('tb-testlogin-');
  const home = path.join(root, 'data');
  const main = path.join(root, 'dot-claude');
  const accts = path.join(root, 'Accounts');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(main);
  for (const n of ['claude-2', 'claude-3', 'claude-4']) fs.mkdirSync(path.join(accts, n), { recursive: true });
  fs.writeFileSync(path.join(root, 'claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'm@example.com', organizationType: 'claude_max', billingType: 'none' } }));
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ hiddenLogins: ['claude-2'], accountNotes: { 'claude-3': 'Work only' } }));
  const env = { HOME: root, PATH: '', THREADBEAR_HOME: home, THREADBEAR_CLAUDE_MAIN_DIR: main, THREADBEAR_CLAUDE_MAIN_JSON: path.join(root, 'claude.json'), THREADBEAR_ACCOUNTS_DIR: accts };
  assert.equal(testLogin(env), 'claude-4');
  assert.equal(testLogin({ ...env, TB_E2E_ACCOUNT: 'claude-2' }), 'claude-2');
  // Reading only: no runner.json is made where there was none.
  fs.rmSync(path.join(home, 'runner.json'));
  testLogin(env);
  assert.equal(fs.existsSync(path.join(home, 'runner.json')), false);
});
