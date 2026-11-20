// The login a dev runner (scripts/dev-runner.sh) and the end-to-end tests
// use when TB_E2E_ACCOUNT names none. It was always claude-main, until that
// login's Max lapsed on 16 Nov 2026 on Mike's Mac and every dev-runner thread
// and e2e run there failed its turns. Now: the first Claude login the runner
// itself would offer (runner.json hiddenLogins left out) that has no note and
// whose plan hasn't ended, else claude-main, which in most copies is the only
// login and works. Signed-out logins can't be told from here (the runner
// learns that from a turn), so they aren't skipped.
// `node src/test-login.ts` prints it.
import { discoverAccounts } from './accounts.ts';
import { loadConfig } from './config.ts';
import type { Account } from './protocol.ts';

export function pickTestLogin(accounts: Account[]): string {
  return accounts.find((a) => a.provider === 'claude' && !a.planEnded && !a.note && !a.signedOut)?.id ?? 'claude-main';
}

// Reads the runner.json THREADBEAR_HOME names (a thread's own runner), else
// the real data dir's, for hiddenLogins and accountNotes; never writes it.
export function testLogin(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.TB_E2E_ACCOUNT?.trim();
  if (named) return named;
  try {
    return pickTestLogin(discoverAccounts(loadConfig({ ...env }, { readOnly: true })));
  } catch {
    return 'claude-main';
  }
}

if (import.meta.main) console.log(testLogin());
