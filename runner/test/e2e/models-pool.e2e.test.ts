// Real end-to-end check for small jobs on a Claude pool (docs/protocol.md,
// "Settings and models"): a fresh runner with its small jobs on a pool
// holding only the test login (TB_E2E_ACCOUNT, else src/test-login.ts's pick), answers models.run through the real
// claude CLI on Haiku, records the login it ran on, and leaves no session
// behind in the login's config dir (so the Agent Archive never sees these
// calls as threads). Tiny prompts and a temp runner data dir. Run with
// `npm run test:e2e`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { RunnerClient } from '../../src/client.ts';
import { testLogin } from '../../src/test-login.ts';
import { projectDirName } from '../../src/transcripts.ts';
import { ledgerPath } from '../../src/models/ledger.ts';

const ACCOUNT = testLogin();
const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');

type Ev = Record<string, any>;

let root: string;
let home: string;
let runner: ChildProcess;
let client: RunnerClient;
let runnerOutput = '';
let accounts: Ev[] = [];

async function startRunner(): Promise<void> {
  runner = spawn(process.execPath, ['src/main.ts'], {
    cwd: RUNNER_DIR,
    env: {
      ...process.env,
      THREADBEAR_HOME: home,
      THREADBEAR_PORT: '0',
      THREADBEAR_LOG: path.join(root, 'runner.log'),
      THREADBEAR_DEBUG: '1',
      THREADBEAR_CLI_UPDATES: 'off', THREADBEAR_TOKEN_TALLY: 'off',
      THREADBEAR_FOLLOW_MAIN: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`runner didn't start:\n${runnerOutput}`)), 15_000);
    runner.stdout!.on('data', (d) => {
      runnerOutput += d;
      const m = /listening on (\d+)/.exec(runnerOutput);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    runner.stderr!.on('data', (d) => (runnerOutput += d));
    runner.once('exit', (code) => reject(new Error(`runner exited ${code}:\n${runnerOutput}`)));
  });
  const token = fs.readFileSync(path.join(home, 'secrets', 'runner-token'), 'utf8').trim();
  client = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, token);
  accounts = (await client.call('hello', { client: 'e2e', version: '1' })).accounts;
}

describe('small jobs on a Claude pool, end to end', { concurrency: false }, () => {
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-models-pool-'));
    home = path.join(root, 'home');
    assert.ok(!home.includes('Application Support/Threadbear'));
    await startRunner();
  });

  after(async () => {
    client?.close();
    if (runner && runner.exitCode === null) {
      const exited = new Promise((r) => runner.once('exit', r));
      runner.kill('SIGTERM');
      await exited;
    }
    if (process.env.TB_E2E_KEEP) console.log(`kept ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  });

  test('a title comes back from Haiku on the pool login, with no session left behind', async () => {
    const account = accounts.find((a) => a.id === ACCOUNT);
    assert.ok(account, `${ACCOUNT} is a login here`);
    await client.call('pools.save', { pools: [{ id: 'e2e', title: 'E2E', accountIds: [ACCOUNT] }] });
    await client.call('settings.update', { models: { pool: 'e2e' } });

    const projects = path.join(account.configDir, 'projects');
    const before = new Set(fs.existsSync(projects) ? fs.readdirSync(projects) : []);
    const started = Date.now();
    const r = await client.call('models.run', {
      job: 'generate',
      system: 'Write a title of 3 to 6 words for a chat that starts with this message. Answer with the title only.',
      text: 'Should the librarian run Haiku on one of my Claude logins rather than through an API key?',
    });
    const ms = Date.now() - started;
    assert.equal(r.ok, true, r.message);
    assert.ok(typeof r.value === 'string' && r.value.trim().length > 0 && r.value.length < 80, `a short title: ${r.value}`);
    assert.equal(r.model, `claude-haiku-5-5 on ${ACCOUNT}`);
    assert.ok(ms < 30_000, `took ${ms} ms`);

    const lines = fs.readFileSync(ledgerPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = lines.at(-1);
    assert.equal(last.accountId, ACCOUNT);
    assert.equal(last.ok, true);
    assert.equal(last.costUsd, undefined, 'nothing spent');

    // No session for the CLI's folder, and no new project folder at all.
    const cliDir = fs.realpathSync(path.join(home, 'models', 'cli'));
    assert.equal(fs.existsSync(path.join(projects, projectDirName(cliDir))), false, 'no session saved for the call');
    const added = (fs.existsSync(projects) ? fs.readdirSync(projects) : []).filter((n) => !before.has(n) && n.includes('models-cli'));
    assert.deepEqual(added, []);
  });
});
