// The login a dev runner (scripts/dev-runner.sh) and the end-to-end tests
// use when TB_E2E_ACCOUNT names none. It was always claude-main, until that
// login's Max lapsed on 16 Nov 2026 on Mike's Mac and every dev-runner thread
// and e2e run there failed its turns. Now: the first Claude login the runner
// itself would offer (runner.json hiddenLogins left out) that has no note and
// whose plan hasn't ended, else claude-main, which in most copies is the only
// login and works. A login the runner learned from a turn can't run (a
// refusal its data dir's sign-in-refusals.json still holds: claude-1 on 26
// Nov 2026, its org had turned Claude Code off) is skipped too.
// `node src/test-login.ts` prints it.
import { discoverAccounts } from './accounts.ts';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { REFUSALS_FILE, heldRefusals } from './sign-in-state.ts';
import type { Account } from './protocol.ts';

export function pickTestLogin(accounts: Account[]): string {
  return accounts.find((a) => a.provider === 'claude' && !a.planEnded && !a.note && !a.signedOut)?.id ?? 'claude-main';
}

// Reads the runner.json (and refusals) THREADBEAR_HOME names (a thread's own runner), else
// the real data dir's, for hiddenLogins and accountNotes; never writes it.
export function testLogin(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.TB_E2E_ACCOUNT?.trim();
  if (named) return named;
  try {
    const cfg = loadConfig({ ...env }, { readOnly: true });
    const refused = heldRefusals(path.join(cfg.home, REFUSALS_FILE), Date.now());
    return pickTestLogin(discoverAccounts(cfg).map((a) => (refused.has(a.id) ? { ...a, signedOut: true } : a)));
  } catch {
    return 'claude-main';
  }
}

if (import.meta.main) console.log(testLogin());
