// Mike's runner: the weekly key that signs releases while he's away from
// the Mac (release-keys.ts, "Releases signed by a weekly key"). Mike, 25
// Nov 2026: "realistically I'm not checking these anyway", so a release
// shouldn't wait for his Touch ID; renewing once a week is fine, as long
// as a starred thread makes sure he can't miss it.
//
// The key and its certificate live in <home>/runner/: release-delegate
// (a plain ed25519 key) and release-delegate-cert.pub, made together by
// renewDelegate with one Touch ID on the release key, good for
// DELEGATE_DAYS. Upstream.publishOnce renews it when it has RENEW_AHEAD_MS
// left and Mike is at the Mac, and starts the reminder thread when it has
// REMIND_AHEAD_MS left and still hasn't been renewed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DELEGATE_DAYS, keyFilesHash, keyOf, keysIn, KEYS_EXTENSION, parseCert, type ReleaseCert, withAuthorities } from './release-keys.ts';

export const RENEW_AHEAD_MS = 3 * 24 * 60 * 60_000;
export const REMIND_AHEAD_MS = 36 * 60 * 60_000;
// The least it must have left to sign with: forks take a weekly key's
// release only within its week, and look every six hours, more when a Mac
// sleeps. A release with less goes out signed by the release key, and one
// made before goes out again, under that day's name (lastLapsing).
export const SIGN_MARGIN_MS = 2 * 24 * 60 * 60_000;

export function delegatePaths(home: string): { key: string; cert: string; state: string } {
  const dir = path.join(home, 'runner');
  return { key: path.join(dir, 'release-delegate'), cert: path.join(dir, 'release-delegate-cert.pub'), state: path.join(dir, 'release-delegate.json') };
}

// The weekly key's certificate as it's kept, if there is one and its key is
// beside it.
export function currentCert(home: string): ReleaseCert | undefined {
  const { key, cert } = delegatePaths(home);
  try {
    if (!fs.existsSync(key)) return undefined;
    const [, b64] = fs.readFileSync(cert, 'utf8').trim().split(/\s+/);
    return b64 ? parseCert(Buffer.from(b64, 'base64')) : undefined;
  } catch {
    return undefined;
  }
}

// The weekly key's certificate if it's fit to sign a release whose key
// files are `signers` and `revoked` (release-signers' and
// release-keys-revoked's text): its key file is the one it certifies (two
// runners renewing at once, or a crash between the renames, could leave
// them apart), the release key made it (not one from before a change of
// signingKey), it vouches for those key files, and it isn't revoked there.
// Undefined otherwise, which counts as no key at all: renewed when Mike's
// next at the Mac, and the release key signs meanwhile.
export function usableCert(home: string, signingKey: string, signers: string, revoked: string): ReleaseCert | undefined {
  const c = currentCert(home);
  if (!c) return undefined;
  try {
    // The private key itself, as that's what signs (ssh-keygen -y reads its
    // public half): a .pub beside it could be another renewal's.
    const own = spawnSync('ssh-keygen', ['-y', '-f', delegatePaths(home).key], { encoding: 'utf8', timeout: 10_000 });
    if (own.status !== 0 || keyOf(own.stdout) !== c.key) return undefined;
    if (keyOf(fs.readFileSync(signingKey.endsWith('.pub') ? signingKey : `${signingKey}.pub`, 'utf8')) !== c.ca) return undefined;
  } catch {
    return undefined;
  }
  if (c.keys !== keyFilesHash(signers, revoked)) return undefined;
  return keysIn(revoked).includes(c.key) ? undefined : c;
}

type DelegateState = { remindThread?: string };

export function readDelegateState(home: string): DelegateState {
  try {
    const s = JSON.parse(fs.readFileSync(delegatePaths(home).state, 'utf8')) as DelegateState;
    return typeof s.remindThread === 'string' ? { remindThread: s.remindThread } : {};
  } catch {
    return {};
  }
}

export function writeDelegateState(home: string, s: DelegateState): void {
  const file = delegatePaths(home).state;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
}

export type Run = (cmd: string, args: string[], opts?: { env?: Record<string, string>; timeoutMs?: number; input?: Buffer }) => Promise<{ code: number; stdout: string; stderr: string }>;

// In its own process group, so a deadline also stops what it started
// (ssh-sk-helper, and the Touch ID prompt with it).
export const runCommand: Run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const group = process.platform !== 'win32';
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...opts.env }, detached: group });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, opts.timeoutMs ?? 60_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e) => (clearTimeout(timer), reject(new Error(`${cmd} could not run: ${e.message}`))));
    child.on('close', (code) => (clearTimeout(timer), resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr })));
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? Buffer.alloc(0));
  });

// Makes a new weekly key and has the release key certify it (one Touch ID
// for a Secure Enclave key), then checks it the way a fork will before
// putting it in place: a signature made with it verifies against
// `signers` (release-signers' text) with the release key as authority.
// That catches the Secure Enclave's empty signatures (release/2026-11-19).
// Returns the certificate, or throws saying why.
export async function renewDelegate(o: { home: string; signingKey: string; provider?: string; signers: string; revoked: string; now: number; timeoutMs: number; run?: Run }): Promise<ReleaseCert> {
  const run = o.run ?? runCommand;
  const { key, cert } = delegatePaths(o.home);
  fs.mkdirSync(path.dirname(key), { recursive: true });
  const dir = fs.mkdtempSync(path.join(path.dirname(key), 'release-delegate-new-'));
  fs.chmodSync(dir, 0o700);
  try {
    const caPub = fs.readFileSync(o.signingKey.endsWith('.pub') ? o.signingKey : `${o.signingKey}.pub`, 'utf8');
    const ca = keyOf(caPub);
    if (!ca) throw new Error("the release key's .pub can't be read");
    const principalLine = o.signers.split('\n').find((l) => keyOf(l) === ca);
    if (!principalLine) throw new Error('the release key is not in release-signers');
    const principal = principalLine.trim().split(/\s+/)[0]!;
    const fresh = path.join(dir, 'key');
    const made = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'threadbear-release-weekly', '-f', fresh]);
    if (made.code !== 0) throw new Error(`ssh-keygen couldn't make a key: ${made.stderr.trim().slice(0, 200)}`);
    const stamp = new Date(o.now).toISOString().slice(0, 16);
    const keys = keyFilesHash(o.signers, o.revoked);
    const signed = await run('ssh-keygen', ['-q', '-s', o.signingKey, '-I', `threadbear-release-weekly-${stamp}`, '-n', principal, '-V', `-10m:+${DELEGATE_DAYS}d`, '-O', 'clear', '-O', `extension:${KEYS_EXTENSION}=${keys}`, `${fresh}.pub`], {
      timeoutMs: o.timeoutMs,
      ...(o.provider ? { env: { SSH_SK_PROVIDER: o.provider } } : {}),
    });
    if (signed.code !== 0) throw new Error(signed.code === 124 ? 'Touch ID was not given in time' : `the release key didn't certify it: ${signed.stderr.trim().slice(0, 200)}`);
    const made64 = fs.readFileSync(`${fresh}-cert.pub`, 'utf8').trim().split(/\s+/)[1] ?? '';
    const c = parseCert(Buffer.from(made64, 'base64'));
    if (!c || c.ca !== ca || !c.principals.includes(principal) || c.keys !== keys) throw new Error("the certificate isn't the release key's for this principal and these key files");
    // Signed once and checked as a fork checks a release.
    const msg = path.join(dir, 'probe');
    fs.writeFileSync(msg, 'threadbear release key probe\n');
    const sig = await run('ssh-keygen', ['-Y', 'sign', '-f', `${fresh}-cert.pub`, '-n', 'git', msg], { env: { SSH_AUTH_SOCK: '' } });
    if (sig.code !== 0) throw new Error(`the new key couldn't sign: ${sig.stderr.trim().slice(0, 200)}`);
    const allowed = path.join(dir, 'signers');
    fs.writeFileSync(allowed, withAuthorities(o.signers));
    const ok = await run('ssh-keygen', ['-Y', 'verify', '-f', allowed, '-I', principal, '-n', 'git', '-s', `${msg}.sig`], { input: fs.readFileSync(msg) });
    if (ok.code !== 0) throw new Error(`a signature with the new key doesn't verify: ${(ok.stderr || ok.stdout).trim().slice(0, 200)}`);
    // The key first, then its certificate: a crash between leaves a key
    // without a matching certificate, which currentCert's caller finds
    // doesn't sign (the check before a push), and the next renewal replaces.
    fs.renameSync(fresh, key);
    fs.renameSync(`${fresh}.pub`, `${key}.pub`);
    fs.renameSync(`${fresh}-cert.pub`, cert);
    return c;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
