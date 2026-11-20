// Real git in temp repos for the box tests (box-mode.test.ts,
// box-save.test.ts): a bare repo standing in for GitHub, and a cloner that
// takes a local path, as cloneRepo only clones https and ssh addresses.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './fakes.ts';
import type { Cloner } from '../../src/box-mode.ts';
import { SHELL } from './platform.ts';

// Commits need a name, and the user's own git config mustn't reach the temp
// repos. Each test file runs in its own process.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

export function sh(cwd: string, cmd: string): string {
  return execFileSync(SHELL[0], [SHELL[1], cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A bare repo at <tmp>/proj.git: main, with a runner/ folder, and a `dev`
// branch. `patch` adds a worktree patch on main.
export function originRepo(opts: { patch?: string } = {}): string {
  const root = fs.realpathSync(tmpDir('tb-box-origin-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  sh(work, 'git init -q -b main && printf "node_modules\\n" > .gitignore && echo one > README.md && mkdir runner && echo a > runner/a.txt');
  if (opts.patch) {
    fs.mkdirSync(path.join(work, '.threadbear', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(work, '.threadbear', 'patches', 'checks.ts'), opts.patch);
  }
  sh(work, 'git add -A && git commit -qm init');
  sh(work, 'git checkout -q -b dev && echo dev > dev.txt && git add -A && git commit -qm dev && git checkout -q main');
  const bare = path.join(root, 'proj.git');
  sh(root, `git clone -q --bare work ${bare}`);
  return bare;
}

export const localClone: Cloner = async (url, to) => {
  execFileSync('git', ['clone', '-q', url, to], { stdio: 'ignore' });
  return { ok: true };
};
