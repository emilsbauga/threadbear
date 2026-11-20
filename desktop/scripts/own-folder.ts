// A folder only this account can change, made in a temp folder or one given
// by a setting, or an error saying why not. Shared by the GPUI dev-app's state
// folder (Daybreak 116, 13 Nov) and the spec driver's kept evidence
// (features/support/gpui.ts, Daybreak 149, 17 Nov).
//
// On Linux /tmp is everyone's: another account can make the folder first, or,
// in a parent without the sticky bit, rename ours away and put its own in its
// place, with symlinks inside that our writes then follow. So the folder is
// made here or was, isn't a symlink, is ours, and nobody else can write to it;
// its parent and every folder above that are ours or root's and, if others
// can write to them, sticky. One that
// fails is refused, never repaired: chmod on someone else's folder doesn't make
// what they've already put in it safe. macOS's TMPDIR is per-user already, so
// there nothing changes.
import fs from 'node:fs';
import path from 'node:path';

export type OwnFolderOptions = {
  /** What to tell them to change when it's refused, as `set <hint> to a folder of your own`. */
  hint: string;
  /** In a parent others can write to, add `-<uid>` to the name so two accounts don't collide. */
  uidSuffix?: boolean;
  /** Others may read and list it (0755); still never write. Default: 0700 only. */
  othersMayRead?: boolean;
  /** Make the parent first, as `mkdir -p` would (for a folder named by a setting). */
  makeParent?: boolean;
};

export function ownFolder(parentPath: string, name: string, o: OwnFolderOptions): string {
  if (o.makeParent) fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });
  const parent = fs.realpathSync(parentPath);
  const uid = process.getuid?.();
  // Windows has no uids, and its temp folder is the user's own.
  if (uid === undefined) {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  // The parent and every folder above it: another account that can rename any of them can swap
  // the whole tree under ours after it's checked (TB_SPEC_EVIDENCE=/tmp/shared/mine/evidence,
  // with /tmp/shared anyone's; Codex's review of Daybreak 149).
  for (let at = parent; ; at = path.dirname(at)) {
    const st = fs.statSync(at);
    // Writable by others without the sticky bit, anyone could rename our folder away and put theirs in its place.
    if ((st.mode & 0o022) !== 0 && !(st.mode & 0o1000)) throw new Error(`${at} can be changed by other accounts and isn't sticky: set ${o.hint} to a folder of your own`);
    // A sticky folder's owner can still rename anyone's folder in it, so it has to be root's or ours.
    if (st.uid !== uid && st.uid !== 0) throw new Error(`${at} belongs to someone else: set ${o.hint} to a folder of your own`);
    if (path.dirname(at) === at) break;
  }
  const shared = (fs.statSync(parent).mode & 0o022) !== 0;
  const dir = path.join(parent, shared && o.uidSuffix ? `${name}-${uid}` : name);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const s = fs.lstatSync(dir);
  const others = o.othersMayRead ? 0o022 : 0o077;
  if (!s.isDirectory() || s.uid !== uid || (s.mode & others) !== 0) {
    const want = o.othersMayRead ? "this account's own that only it can write to" : "this account's own (mode 700)";
    throw new Error(`${dir} isn't a folder of ${want}, so it's not used: remove it if it's yours, or set ${o.hint} to a folder of your own`);
  }
  return dir;
}
