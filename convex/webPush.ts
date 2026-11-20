"use node";
// Web Push for the F-Droid build's UnifiedPush notifications (API 93): the
// message encryption of RFC 8291 (aes128gcm, RFC 8188) and the VAPID
// signature of RFC 8292, done here with node:crypto rather than a package.
// runner/test/unit/web-push.test.ts checks the encryption against RFC 8291's
// own worked example, byte for byte. push.ts sends with these; only Node
// files may import this.
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Resolver } from 'node:dns/promises';

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

// One record of at most this many bytes; a sealed notification is far smaller.
export const RECORD_SIZE = 4096;
// The longest plaintext every push service and the phone's connector (Google
// Tink, which caps the whole body at 4096 bytes) will take: RFC 8291 section
// 4's 3993, the 4096-byte body less the 86-byte header (salt, record size,
// key id length, the 65-byte key), the 0x02 delimiter and the 16-byte tag.
export const WEB_PUSH_PLAINTEXT_MAX = 4096 - 86 - 1 - 16;

/**
 * Encrypts `plaintext` for one subscription: `uaPublic` is its p256dh (an
 * uncompressed P-256 point) and `authSecret` its 16-byte auth. Returns the
 * whole request body: salt, record size, this message's own public key, then
 * the ciphertext. `asPrivate` and `salt` are for the test vector only; each
 * real message gets a fresh key pair and salt.
 */
export function encryptWebPush(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, fixed?: { asPrivate: Buffer; salt: Buffer }): Buffer {
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  if (plaintext.length > WEB_PUSH_PLAINTEXT_MAX) throw new Error('too long for one web push record');
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  // RFC 8291 section 3.4: the shared secret, mixed with the auth secret and
  // both public keys, then RFC 8188's key and nonce from the salt.
  const prkKey = hmac(authSecret, ecdh.computeSecret(uaPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = fixed?.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // The one (and so last) record ends with the delimiter 0x02, no padding.
  const ct = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

/** This deployment's VAPID key pair as a JWK's coordinates, base64url. */
export type VapidKey = { x: string; y: string; d: string };

/** The VAPID public key the phone registers with: the uncompressed point, base64url. */
export const vapidPublic = (k: Pick<VapidKey, 'x' | 'y'>) =>
  Buffer.concat([Buffer.from([4]), Buffer.from(k.x, 'base64url'), Buffer.from(k.y, 'base64url')]).toString('base64url');

/**
 * The Authorization header for a push to `endpoint` (RFC 8292): an ES256 JWT
 * for the endpoint's origin, good for 12 hours, and the public key.
 */
export function vapidAuthorization(endpoint: string, key: VapidKey, subject: string, now = Date.now()): string {
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  const head = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const pk = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', ...key }, format: 'jwk' });
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key: pk, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${sig.toString('base64url')}, k=${vapidPublic(key)}`;
}

type Resolve = (host: string, opts: { all: true }, cb: (err: Error | null, addrs: LookupAddress[]) => void) => void;

// The name's A and AAAA records through c-ares rather than getaddrinfo: the
// system lookup runs on libuv's four worker threads and can't be cancelled,
// so a few endpoints whose DNS stalls could hold them all and queue the
// relay's and Apple's own lookups behind them (Codex's second review). c-ares
// has its own sockets and gives up by itself (3 s, twice). Only when it can't
// run at all here (no resolver it can reach) does it fall back to the system
// lookup.
const cares: Resolve = (host, opts, cb) => {
  const r = new Resolver({ timeout: 3000, tries: 2 });
  Promise.allSettled([r.resolve4(host), r.resolve6(host)]).then(([a, b]) => {
    const addrs: LookupAddress[] = [
      ...(a.status === 'fulfilled' ? a.value.map((address) => ({ address, family: 4 })) : []),
      ...(b.status === 'fulfilled' ? b.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (addrs.length) return cb(null, addrs);
    const why = [a, b].map((x) => (x.status === 'rejected' ? (x.reason as { code?: string })?.code : undefined));
    // Both said the name has no such record: there's nothing to connect to.
    if (why.every((c) => c === 'ENOTFOUND' || c === 'ENODATA')) return cb(Object.assign(new Error(`no address for ${host}`), { code: 'ENOTFOUND' }), []);
    (dnsLookup as unknown as Resolve)(host, opts, cb);
  });
};

/**
 * The `lookup` push.ts gives node:https for a UnifiedPush endpoint: it
 * resolves the name and refuses if any address it gets is private
 * (webPushEndpoint.ts privateAddress, as `isPrivate`), so the socket only ever connects to an
 * address that was checked, in the same lookup. `isPrivate` is that check,
 * passed in (this file imports nothing of the backend's, so the runner's
 * tests can load it); `resolve` is for tests.
 */
export function pinnedLookup(isPrivate: (ip: string) => boolean, resolve: Resolve = cares) {
  return (host: string, opts: { all?: boolean; family?: number }, cb: (...a: unknown[]) => void) => {
    resolve(host, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs?.length || addrs.some((a) => isPrivate(a.address))) return cb(Object.assign(new Error('resolves to a private address'), { code: 'EPRIVATE' }));
      if (opts.all) cb(null, addrs);
      else cb(null, addrs[0].address, addrs[0].family);
    });
  };
}
