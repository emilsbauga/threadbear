// Web Push for the F-Droid build's UnifiedPush notifications (convex/webPush.ts,
// convex/webPushEndpoint.ts, API 93). The encryption is checked against RFC
// 8291's own worked example (Appendix A) byte for byte, so the phone's
// UnifiedPush connector, which follows the RFC, can open what we send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptWebPush, vapidAuthorization, vapidPublic, WEB_PUSH_PLAINTEXT_MAX } from '../../../convex/webPush.ts';
import { AUTH_SECRET, P256DH, endpointProblem, privateAddress } from '../../../convex/webPushEndpoint.ts';

const b = (s: string) => Buffer.from(s, 'base64url');

// RFC 8291, Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// The receiving side, written from the RFC, for messages with a random key and salt.
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): Buffer {
  const hmac = (k: Buffer, d: Buffer) => crypto.createHmac('sha256', k).update(d).digest();
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const prkKey = hmac(auth, ecdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const rec = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(rec[rec.length - 1], 2, 'the last record ends with 0x02');
  return rec.subarray(0, rec.length - 1);
}

test('encryption matches RFC 8291 Appendix A exactly', () => {
  const out = encryptWebPush(Buffer.from(RFC.plaintext), b(RFC.uaPublic), b(RFC.auth), { asPrivate: b(RFC.asPrivate), salt: b(RFC.salt) });
  assert.equal(out.toString('base64url'), RFC.body);
});

test('a real message (fresh key and salt) opens on the phone side, and differs every time', () => {
  const text = JSON.stringify({ threadId: 'th-1', e: 'c2VhbGVk' });
  const one = encryptWebPush(Buffer.from(text), b(RFC.uaPublic), b(RFC.auth));
  const two = encryptWebPush(Buffer.from(text), b(RFC.uaPublic), b(RFC.auth));
  assert.notEqual(one.toString('hex'), two.toString('hex'));
  assert.equal(decrypt(one, b(RFC.uaPrivate), b(RFC.uaPublic), b(RFC.auth)).toString(), text);
  assert.equal(one.readUInt32BE(16), 4096);
});

test('bad keys and oversized messages are refused', () => {
  assert.throws(() => encryptWebPush(Buffer.from('x'), b(RFC.uaPublic).subarray(1), b(RFC.auth)));
  assert.throws(() => encryptWebPush(Buffer.from('x'), b(RFC.uaPublic), b(RFC.auth).subarray(1)));
  assert.throws(() => encryptWebPush(Buffer.alloc(WEB_PUSH_PLAINTEXT_MAX + 1), b(RFC.uaPublic), b(RFC.auth)));
  // The longest allowed makes a body of exactly 4096 bytes (RFC 8291 section 4; Tink's cap).
  assert.equal(WEB_PUSH_PLAINTEXT_MAX, 3993);
  assert.equal(encryptWebPush(Buffer.alloc(WEB_PUSH_PLAINTEXT_MAX), b(RFC.uaPublic), b(RFC.auth)).length, 4096);
  // A key that isn't an uncompressed point is refused at registration.
  assert.doesNotMatch('A'.repeat(87), P256DH);
  assert.match(RFC.uaPublic, P256DH);
  assert.match(RFC.auth, AUTH_SECRET);
});

test('the VAPID header is an ES256 JWT for the endpoint origin, signed by the key it names', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  const key = { x: jwk.x, y: jwk.y, d: jwk.d };
  const now = Date.UTC(2026, 10, 19);
  const h = vapidAuthorization('https://ntfy.sh/upAbC123?up=1', key, 'https://threadbear.mikecann.app', now);
  const m = h.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(m, h);
  assert.deepEqual(JSON.parse(b(m[1]).toString()), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(b(m[2]).toString()), { aud: 'https://ntfy.sh', exp: now / 1000 + 12 * 3600, sub: 'https://threadbear.mikecann.app' });
  assert.equal(m[4], vapidPublic(key));
  assert.equal(b(m[4]).length, 65);
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b(m[3])));
});

test('endpoints: public https only', () => {
  for (const ok of ['https://ntfy.sh/upAbC123?up=1', 'https://push.example.com:8443/x', 'https://[2606:4700::1111]/x', 'https://8.8.8.8/x']) assert.equal(endpointProblem(ok), null, ok);
  const bad = [
    'http://ntfy.sh/x', 'ftp://ntfy.sh/x', 'not a url', 'https://user:pw@ntfy.sh/x',
    'https://localhost/x', 'https://foo.localhost/x', 'https://printer.local/x', 'https://db.internal/x', 'https://LOCALHOST./x',
    'https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://172.16.0.1/x', 'https://192.168.1.10/x', 'https://169.254.169.254/latest',
    'https://100.100.1.1/x', 'https://0.0.0.0/x', 'https://[::1]/x', 'https://[::]/x', 'https://[fd00::1]/x', 'https://[fe80::1]/x',
    'https://[::ffff:10.0.0.1]/x', 'https://[::ffff:a00:1]/x', 'https://[64:ff9b::7f00:1]/x', 'https://' + 'a'.repeat(1100) + '.com/',
    // From the cross-lab review: IPv4-compatible, local NAT64, SIIT, site-local, 6to4, Teredo, and IPv4 in other spellings.
    'https://[::127.0.0.1]/x', 'https://[64:ff9b:1::a00:1]/x', 'https://[::ffff:0:a00:1]/x', 'https://[fec0::1]/x', 'https://[2002:7f00:1::1]:8443/x', 'https://[2001:0:4136:e378::1]/x',
    'https://2130706433/x', 'https://0x7f.1/x', 'https://127.1/x', 'https://0177.0.0.1/x',
  ];
  for (const no of bad) assert.notEqual(endpointProblem(no), null, no);
});

test('resolved addresses: private ones are caught, public ones pass', () => {
  for (const p of ['10.0.0.1', '127.0.0.53', '172.31.255.255', '192.168.0.1', '169.254.0.1', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', 'fc00::1', 'fe80::abcd', '::ffff:192.168.1.1', '2001:db8::1']) assert.ok(privateAddress(p), p);
  for (const p of ['64:ff9b:1::a00:1', 'fec0::1', '2002:a00:1::1', '2001::1', '2001:1ff::1', '::a00:1', '::ffff:0:a00:1', '2001:db8::1', 'garbage', '1.2.3']) assert.ok(privateAddress(p), p);
  for (const p of ['8.8.8.8', '1.1.1.1', '159.69.1.1', '172.32.0.1', '2606:4700:4700::1111', '2a01:4f9:c010::1', '2001:4860::8888']) assert.equal(privateAddress(p), false, p);
});

test("the endpoint's name is checked in the same lookup the connection uses", async () => {
  const { pinnedLookup } = await import('../../../convex/webPush.ts');
  const run = (answers: { address: string; family: number }[], all: boolean) => new Promise<unknown[]>((done) => {
    pinnedLookup(privateAddress, (_h, _o, cb) => cb(null, answers))('push.example.com', { all }, (...a: unknown[]) => done(a));
  });
  // Public: handed on, as one address or all of them.
  assert.deepEqual(await run([{ address: '8.8.8.8', family: 4 }], false), [null, '8.8.8.8', 4]);
  assert.deepEqual(await run([{ address: '8.8.8.8', family: 4 }, { address: '2606:4700::1', family: 6 }], true), [null, [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700::1', family: 6 }]]);
  // Any private answer (a rebinding name, a mixed record set) refuses the lot.
  for (const answers of [[{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '::1', family: 6 }], []]) {
    const [err] = await run(answers, true);
    assert.ok(err instanceof Error, JSON.stringify(answers));
  }
});
