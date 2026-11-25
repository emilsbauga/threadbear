// A parent for temp folders that remote.sh's guard (scripts/own-folders.sh)
// accepts: every folder from it up to / is root's or ours, with no group or
// other write. A Mac's TMPDIR and a check host's (under the real home) are;
// Linux's /tmp (root's, 1777) isn't, and the preload's test home sits in it
// when TMPDIR is unset. That failed cloud's release build of 6e29292c5 on
// 24 Nov, so there the real home is used (os.homedir() is the test home).
import fs from 'node:fs';
import os from 'node:os';

export function closedChain(dir: string): boolean {
  const uid = process.getuid?.() ?? -1;
  try {
    for (let p = fs.realpathSync(dir); ; p = p.slice(0, Math.max(p.lastIndexOf('/'), 1))) {
      const s = fs.statSync(p);
      if ((s.uid !== 0 && s.uid !== uid) || (s.mode & 0o022) !== 0) return false;
      if (p === '/') return true;
    }
  } catch {
    return false;
  }
}

export function closedTmpParent(): string {
  const tmp = os.tmpdir();
  if (closedChain(tmp)) return tmp;
  let home = '';
  try { home = os.userInfo().homedir; } catch { /* a uid with no passwd entry */ }
  if (home && closedChain(home)) return home;
  throw new Error(`No temp folder here is closed to other accounts (${tmp}${home ? `, ${home}` : ''}); remote.sh would refuse it`);
}
