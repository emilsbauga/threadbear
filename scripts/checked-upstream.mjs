// Whether setup can build the runner's first release without its typecheck
// and unit tests (scripts/setup.mjs, step 8), worked out apart from doing it
// so runner/test/unit/checked-upstream.test.ts can check it. Node built-ins
// only, like setup.
//
// The checks are worth running on code nobody has checked. Mike's main only
// moves to a commit a landing's check passed (check.sh, on his check hosts),
// so on his code, as his repo has it, they only say again what they said
// there, and take an hour on a busy Mac. On Tinker Desk's second account
// (19 Nov 2026) they took 58 minutes, then failed on something about that
// Mac, and a newcomer can't fix that and gets no runner.
//
// So they're left out when HEAD is a commit Mike's main has (a remote whose
// URL is his; not his other branches, like the unlanded cloud/ ones). The release is built from HEAD, never
// the files as they are (deploy.mjs), so that's the code that runs.
// His main is fetched fresh for it: a ref already here can be stale, or a
// fork's main left behind when the remote was pointed at his (Codex's
// review). Anything else runs them: a commit of their own, or a copy that
// can't tell (no remote of his, or a fetch that fails).
//
//   checkedUpstream({ repo, mikesRepo })
//     repo       the checkout
//     mikesRepo  Mike's repo's URL, in any form git takes
//   returns { checked: true, remote } or { checked: false, why }
import { spawnSync } from 'node:child_process';

// The same key setup compares remotes by: host/owner/name, lower case.
export const repoKey = (url) => url.trim().replace(/^git@([^:]+):/, '$1/').replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, '').replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase();

function git(repo, args, timeout = 30_000) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

export function checkedUpstream({ repo, mikesRepo }) {
  const head = git(repo, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (!head.ok) return { checked: false, why: 'no commit checked out' };
  const mikes = repoKey(mikesRepo);
  const remotes = git(repo, ['remote']).out.split('\n').filter(Boolean)
    .filter((name) => { const url = git(repo, ['config', '--get', `remote.${name}.url`]); return url.ok && repoKey(url.out) === mikes; });
  if (!remotes.length) return { checked: false, why: "no remote is Mike's repo" };
  let fetched = false;
  for (const remote of remotes) {
    const main = `refs/remotes/${remote}/main`;
    if (!git(repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', remote, `+refs/heads/main:${main}`], 120_000).ok) continue;
    fetched = true;
    if (git(repo, ['merge-base', '--is-ancestor', head.out, main]).ok) return { checked: true, remote };
  }
  return { checked: false, why: fetched ? "HEAD isn't a commit Mike's main has" : "couldn't fetch Mike's main" };
}
