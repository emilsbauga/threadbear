// Replacing and revoking the key Mike's releases are signed with
// (docs/protocol/updates.md, "Mike's releases"; security review finding 3, 9 Nov
// 2026). Setup pins the key once (<home>/upstream-signers) and a change to
// the repo's copy never replaces it, so a new key has to come the way a
// release does: signed by a key the fork already trusts.
//
// A release's commit carries the key list as files, covered by its signed
// tag like the rest of the commit:
//   scripts/release-signers        the keys that sign releases, one
//                                  allowed-signers line each (as setup pins)
//   scripts/release-keys-revoked   keys that must never count again, one
//                                  public key per line
//
// The newest release a fork accepts (signed by a pinned key, its commit on
// upstream's main) is read for both, and:
// - A key in release-signers that isn't pinned waits ADD_DELAY_MS from when
//   this runner first saw it, then joins the pinned file. A key that leaked
//   could announce one of its own, so the wait is the owner's (and Mike's)
//   time to see it in the log and revoke the key that announced it, which
//   drops the waiting one with it.
// - A key in release-keys-revoked comes out of the pinned file at once and
//   is kept in <home>/upstream-revoked, which ssh-keygen is handed on every
//   check (-r), and which setup and a later announcement can never undo. A
//   key can only be revoked by a release signed with that key itself or
//   with one pinned after it, so a leaked old key can't revoke the key that
//   replaced it.
//
// Mike's rotation, then: add the new key to scripts/release-signers and let
// a release signed with the old key carry it; after the wait, sign with the
// new key; then list the old key in scripts/release-keys-revoked.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ADD_DELAY_MS = 7 * 24 * 60 * 60_000;
export const SIGNERS_FILE = 'scripts/release-signers';
export const REVOKED_FILE = 'scripts/release-keys-revoked';

const KEY_TYPE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function revokedPath(home: string): string {
  return path.join(home, 'upstream-revoked');
}

// Weekly keys revoked (never pinned ones): checked only for signatures
// made with a certificate, kept apart so a release can't block a key it
// doesn't know yet from ever being pinned.
export function weeklyRevokedPath(home: string): string {
  return `${revokedPath(home)}-weekly`;
}

export function keyStatePath(home: string): string {
  return path.join(home, 'upstream-keys.json');
}

// "type base64" from an allowed-signers line or a public key line, or
// undefined. Options before the key (namespaces="git") are passed over; a
// quoted option with spaces in it isn't something Mike's files have.
export function keyOf(line: string): string | undefined {
  const words = line.trim().split(/\s+/);
  if (!words[0] || words[0].startsWith('#')) return undefined;
  for (let i = 0; i + 1 < words.length; i++) {
    if (KEY_TYPE.test(words[i]!) && B64.test(words[i + 1]!)) return `${words[i]} ${words[i + 1]}`;
  }
  return undefined;
}

export function keysIn(text: string): string[] {
  return [...new Set(text.split('\n').map(keyOf).filter((k): k is string => Boolean(k)))];
}

// The key that made an SSH signature (git's armored SSHSIG): the public key
// is in the signed blob, right after the magic and the version.
export function signerKey(armor: string): string | undefined {
  const body = armor.replace(/-----(BEGIN|END) SSH SIGNATURE-----/g, '').replace(/\s+/g, '');
  let buf: Buffer;
  try {
    buf = Buffer.from(body, 'base64');
  } catch {
    return undefined;
  }
  if (buf.length < 14 || buf.subarray(0, 6).toString('latin1') !== 'SSHSIG') return undefined;
  const len = buf.readUInt32BE(10);
  const blob = buf.subarray(14, 14 + len);
  if (blob.length !== len || len < 4) return undefined;
  const typeLen = blob.readUInt32BE(0);
  const type = blob.subarray(4, 4 + typeLen).toString('latin1');
  if (type === CERT_TYPE) return parseCert(blob)?.ca;
  return KEY_TYPE.test(type) ? `${type} ${blob.toString('base64')}` : undefined;
}

// Releases signed by a weekly key (Mike, 25 Nov 2026: a release waited
// days for his Touch ID whenever he was away from the Mac). His Touch ID
// key, as a certificate authority, signs an OpenSSH certificate for a
// plain ed25519 key that's good for DELEGATE_DAYS; the runner signs each
// day's release with that, unattended, and asks for a touch once a week
// to make the next (release-delegate.ts). A fork takes such a signature
// from any pinned key as the authority (authoritiesFile), checked at the
// time the tag says it was made (certVerifyArgs), which has to be the day
// its name says: so a weekly key that leaks is good for the days its
// certificate covers, and the releases it could have signed are named for
// those days, never newer than one made after it ran out. A leaked one is
// revoked the usual way (its own public key in release-keys-revoked), and
// revoking the authority's key stops every certificate it made.
export const CERT_TYPE = 'ssh-ed25519-cert-v01@openssh.com';
export const DELEGATE_DAYS = 8;

export type ReleaseCert = { key: string; ca: string; principals: string[]; validAfter: number; validBefore: number; keys?: string };

// The certificate extension that carries keyFilesHash: the release key
// vouches, with its one touch, for the key files every release the weekly
// key signs must have (Codex's review, 25 Nov 2026). So a weekly key can't
// announce or revoke a key, and each release it signs carries the whole
// list, so a fork that was away takes every change from the next one.
export const KEYS_EXTENSION = 'threadbear-keys@threadbear';

export function keyFilesHash(signers: string, revoked: string): string {
  return createHash('sha256').update(signers).update('\0').update(revoked).digest('hex');
}

// An ed25519 certificate's fields (PROTOCOL.certkeys), times in ms, or
// undefined for anything else (only the runner's own kind is read).
export function parseCert(blob: Buffer): ReleaseCert | undefined {
  let at = 0;
  const str = (): Buffer => {
    if (at + 4 > blob.length) throw new Error('short');
    const n = blob.readUInt32BE(at);
    if (at + 4 + n > blob.length) throw new Error('short');
    const out = blob.subarray(at + 4, at + 4 + n);
    at += 4 + n;
    return out;
  };
  const u64 = (): bigint => {
    if (at + 8 > blob.length) throw new Error('short');
    const v = blob.readBigUInt64BE(at);
    at += 8;
    return v;
  };
  try {
    if (str().toString('latin1') !== CERT_TYPE) return undefined;
    str(); // nonce
    const pk = str();
    if (pk.length !== 32) return undefined;
    u64(); // serial
    if (at + 4 > blob.length) return undefined;
    const kind = blob.readUInt32BE(at); // 1 user, 2 host
    at += 4;
    if (kind !== 1) return undefined;
    str(); // key id
    const packed = str();
    const principals: string[] = [];
    for (let i = 0; i < packed.length; ) {
      const n = packed.readUInt32BE(i);
      principals.push(packed.subarray(i + 4, i + 4 + n).toString('utf8'));
      i += 4 + n;
    }
    const ms = (v: bigint) => (v > BigInt(Number.MAX_SAFE_INTEGER) / 1000n ? Number.MAX_SAFE_INTEGER : Number(v) * 1000);
    const validAfter = ms(u64());
    const validBefore = ms(u64());
    str(); // critical options
    const exts = str();
    let keys: string | undefined;
    for (let i = 0; i + 4 <= exts.length; ) {
      const n = exts.readUInt32BE(i);
      const name = exts.subarray(i + 4, i + 4 + n).toString('latin1');
      i += 4 + n;
      const m = exts.readUInt32BE(i);
      const data = exts.subarray(i + 4, i + 4 + m);
      i += 4 + m;
      // Its value is itself a string inside the data.
      if (name === KEYS_EXTENSION && data.length >= 4) keys = data.subarray(4, 4 + data.readUInt32BE(0)).toString('latin1');
    }
    str(); // reserved
    const caBlob = str();
    const caType = caBlob.subarray(4, 4 + caBlob.readUInt32BE(0)).toString('latin1');
    if (!KEY_TYPE.test(caType)) return undefined;
    const plain = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519', 'latin1'), Buffer.from([0, 0, 0, 32]), pk]);
    return { key: `ssh-ed25519 ${plain.toString('base64')}`, ca: `${caType} ${caBlob.toString('base64')}`, principals, validAfter, validBefore, ...(keys ? { keys } : {}) };
  } catch {
    return undefined;
  }
}

// The key blob an SSH signature names (a plain key or a certificate).
function signatureBlob(armor: string): Buffer | undefined {
  const body = armor.replace(/-----(BEGIN|END) SSH SIGNATURE-----/g, '').replace(/\s+/g, '');
  const buf = Buffer.from(body, 'base64');
  if (buf.length < 14 || buf.subarray(0, 6).toString('latin1') !== 'SSHSIG') return undefined;
  const len = buf.readUInt32BE(10);
  const blob = buf.subarray(14, 14 + len);
  return blob.length === len && len >= 4 ? blob : undefined;
}

// The certificate an SSH signature was made with, if it was.
export function signatureCert(armor: string): ReleaseCert | undefined {
  const blob = signatureBlob(armor);
  return blob ? parseCert(blob) : undefined;
}

// Whether the signature was made with a certificate of any kind: one
// parseCert can't read (another key type) would skip the date check, so
// sshVerified refuses it.
export function signedWithCert(armor: string): boolean {
  const blob = signatureBlob(armor);
  if (!blob) return false;
  const n = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + n).toString('latin1').endsWith('-cert-v01@openssh.com');
}

// An allowed-signers file's text with each key also trusted as an
// authority for certificates naming the same principal, for the git
// namespace only.
export function withAuthorities(text: string): string {
  const out = text.split('\n').filter((l) => l.trim());
  for (const line of [...out]) {
    const key = keyOf(line);
    const principal = line.trim().split(/\s+/)[0];
    if (key && principal && !principal.startsWith('#')) out.push(`${principal} cert-authority,namespaces="git" ${key}`);
  }
  return out.join('\n') + '\n';
}

// ssh-keygen's options for checking a certificate-made signature on the
// tag `name` (release/YYYY-MM-DD) dated `date` (its tagger line): at that
// time, which must fall on the day its name says, in UTC. Undefined when
// it doesn't, which fails the check.
// Not a tag dated ahead of `now` either (an hour's slack for clocks): forks
// keep the newest name and never go back, so a leaked key mustn't be able
// to name one for days to come and shut out the release that revokes it.
// The name must be a real day: Date.UTC turns 2027-00-05 into 5 Dec 2026,
// a time the key may have covered, under a name sorting after December's.
export function certVerifyArgs(name: string, date: string | undefined, now = Date.now()): string[] | undefined {
  const day = /^release\/(\d{4})-(\d{2})-(\d{2})$/.exec(name);
  const t = date ? Date.parse(date) : NaN;
  if (!day || !Number.isFinite(t) || t > now + 3_600_000) return undefined;
  // Nor a name after UTC's today, even in its last hour (Codex's review).
  if (`${day[1]}-${day[2]}-${day[3]}` > new Date(now).toISOString().slice(0, 10)) return undefined;
  // The UTC day, exactly: with time zones' slack a key could name
  // tomorrow's release today and shut out today's (Codex's review). Mike's
  // runner signs with the weekly key only when its local day is UTC's.
  if (new Date(t).toISOString().slice(0, 10) !== `${day[1]}-${day[2]}-${day[3]}`) return undefined;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return ['-O', `verify-time=${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`];
}

type Pending = { key: string; by: string; seenAt: number; tag: string };
type KeyState = { pending: Pending[] };

function readState(home: string): KeyState {
  try {
    const s = JSON.parse(fs.readFileSync(keyStatePath(home), 'utf8')) as KeyState;
    return { pending: Array.isArray(s.pending) ? s.pending.filter((p) => typeof p?.key === 'string' && typeof p.by === 'string' && typeof p.seenAt === 'number') : [] };
  } catch {
    return { pending: [] };
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

export function readRevoked(home: string): string[] {
  try {
    return keysIn(fs.readFileSync(revokedPath(home), 'utf8'));
  } catch {
    return [];
  }
}

export function readWeeklyRevoked(home: string): string[] {
  try {
    return keysIn(fs.readFileSync(weeklyRevokedPath(home), 'utf8'));
  } catch {
    return [];
  }
}

export type KeyChange = { added: string[]; revoked: string[]; waiting: string[]; refused: string[] };

// One runner at a time changes the key files (a runner handing over to the
// next runs two checks at once): both reading the same files and writing
// what each worked out could put a revoked key back (Codex's review, 9 Nov
// 2026). A lock older than LOCK_STALE_MS was left by a runner that died.
const LOCK_STALE_MS = 60_000;
export class KeysBusy extends Error {}

// The lock is a file holding its owner ("pid random"), written whole
// before link() puts it in place, so it never exists without one. It's
// taken over only when its owner is gone (that pid isn't running), by
// moving it aside and checking it was still that owner's: two runners
// finding the same dead lock can't both end up in, and neither can take a
// live one (Codex's review). At most two runners share a data folder (one
// handing over to the next); a third arriving inside the moment a lock is
// moved aside and given back could slip in, which needs three at once and
// a runner that died holding the lock, so it isn't guarded further.
function ownerAlive(owner: string | undefined): boolean {
  const pid = Number(owner?.split(' ')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function withKeyLock<T>(home: string, fn: () => T): T {
  const lock = path.join(home, 'upstream-keys.lock');
  const me = `${process.pid} ${Math.random().toString(36).slice(2)}`;
  const busy = () => new KeysBusy('another runner is changing the release keys');
  const take = (): boolean => {
    const tmp = `${lock}.${me.replace(' ', '-')}`;
    fs.writeFileSync(tmp, me);
    try {
      fs.linkSync(tmp, lock);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };
  if (!take()) {
    const owner = readOwner(lock);
    // One whose owner can't be read is left for LOCK_STALE_MS (it may be
    // a lock from an older runner), then counts as dead.
    let old = false;
    try {
      old = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
    } catch {
      old = true;
    }
    if (owner ? ownerAlive(owner) : !old) throw busy();
    const aside = `${lock}.dead-${me.replace(' ', '-')}`;
    try {
      fs.renameSync(lock, aside);
    } catch {
      throw busy();
    }
    if (readOwner(aside) !== owner) {
      // Someone took it between the look and the move: put it back only if
      // the place is still free, never over a newer lock.
      try {
        fs.linkSync(aside, lock);
      } catch {
        // taken again meanwhile; theirs stands
      }
      fs.rmSync(aside, { recursive: true, force: true });
      throw busy();
    }
    fs.rmSync(aside, { recursive: true, force: true });
    if (!take()) throw busy();
  }
  try {
    return fn();
  } finally {
    if (readOwner(lock) === me) fs.rmSync(lock, { force: true });
  }
}

// Applies what a verified release's commit says about the keys (above).
// `signer` is the key that signed that release, `announced` the keys in its
// release-signers, `revoke` those in its release-keys-revoked.
// A weekly key's release counts as its authority's (signerKey): the key
// files it changes are the ones that key vouched for (KEYS_EXTENSION).
// onlyRevoke: from an older release than the newest, read for its
// revocations alone.
export function applyKeyChanges(o: { home: string; signers: string; signer: string; announced: string[]; revoke: string[]; tag: string; now: number; onlyRevoke?: boolean }): KeyChange {
  return withKeyLock(o.home, () => applyLocked(o));
}

function applyLocked(o: { home: string; signers: string; signer: string; announced: string[]; revoke: string[]; tag: string; now: number; onlyRevoke?: boolean }): KeyChange {
  const out: KeyChange = { added: [], revoked: [], waiting: [], refused: [] };
  let lines = fs.readFileSync(o.signers, 'utf8').split('\n').filter((l) => l.trim());
  const revoked = new Set(readRevoked(o.home));
  const state = readState(o.home);
  // Each key's place as the file was when this began: taking keys out as
  // it goes mustn't move a newer key below the signer (Codex's review:
  // C revoking A, B and then D got D too).
  const rank = new Map<string, number>();
  lines.forEach((l, i) => {
    const k = keyOf(l);
    if (k && !rank.has(k)) rank.set(k, i);
  });
  const at = (k: string) => rank.get(k) ?? -1;
  const pinnedNow = (k: string) => lines.some((l) => keyOf(l) === k);
  const signerAt = at(o.signer);
  if (signerAt < 0) return out; // only a pinned key's release says anything

  const weekly = new Set(readWeeklyRevoked(o.home));
  const weeklyBefore = weekly.size;
  for (const r of o.revoke) {
    if (revoked.has(r)) continue;
    const waiting = state.pending.find((p) => p.key === r);
    // A key never pinned nor waiting is a weekly key's, or nobody's: any
    // pinned key's release may revoke it, for certificates only.
    if (at(r) < 0 && !waiting) {
      if (r.startsWith('ssh-ed25519 ') && !weekly.has(r)) {
        weekly.add(r);
        out.revoked.push(r);
      }
      continue;
    }
    // Itself, or a key pinned after it; one still waiting, by the key that
    // announced it or a later one.
    const may = (r === o.signer || (at(r) >= 0 ? signerAt > at(r) : waiting ? at(waiting.by) >= 0 && signerAt >= at(waiting.by) : false));
    if (!may) {
      if (at(r) >= 0 || waiting) out.refused.push(r);
      continue;
    }
    revoked.add(r);
    out.revoked.push(r);
    lines = lines.filter((l) => keyOf(l) !== r);
    // What it announced and is still waiting goes with it.
    state.pending = state.pending.filter((p) => p.key !== r && p.by !== r);
  }

  // The principal of the first real key line (a comment above it isn't one).
  const principal = lines.find((l) => keyOf(l))?.trim().split(/\s+/)[0] || 'threadbear-releases';
  for (const a of o.onlyRevoke ? [] : o.announced) {
    if (revoked.has(a) || pinnedNow(a) || state.pending.some((p) => p.key === a)) continue;
    if (revoked.has(o.signer)) continue;
    state.pending.push({ key: a, by: o.signer, seenAt: o.now, tag: o.tag });
  }
  const still: Pending[] = [];
  for (const p of state.pending) {
    if (revoked.has(p.key) || revoked.has(p.by) || !pinnedNow(p.by)) continue; // its announcer is gone
    // Only the newest release's look lets a waiting key in, after its own
    // revocations: an older one's first could pin a key the newest revokes
    // above the key revoking it (Gemini's review, 25 Nov 2026).
    if (!o.onlyRevoke && o.now - p.seenAt >= ADD_DELAY_MS) {
      lines.push(`${principal} namespaces="git" ${p.key}`);
      out.added.push(p.key);
    } else {
      still.push(p);
      out.waiting.push(p.key);
    }
  }
  state.pending = still;

  writeAtomic(o.signers, lines.join('\n') + '\n');
  writeAtomic(revokedPath(o.home), [...revoked].join('\n') + (revoked.size ? '\n' : ''));
  writeAtomic(keyStatePath(o.home), JSON.stringify(state, null, 2) + '\n');
  if (weekly.size !== weeklyBefore) writeAtomic(weeklyRevokedPath(o.home), [...weekly].join('\n') + '\n');
  return out;
}
