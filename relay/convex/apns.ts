"use node";
// Sends one notification to Apple with Mike's push key, the way the main
// backend's convex/push.ts does (the helpers are copied from there; keep the
// two in step). Env: APNS_KEY_P8 (the .p8 body), APNS_KEY_ID, APNS_TEAM_ID,
// APNS_TOPIC (com.mikecann.threadbear).
import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';

type ApnsConfig = { key: string; keyId: string; teamId: string; topic: string };

function apnsConfig(): ApnsConfig | null {
  const { APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC } = process.env;
  if (!APNS_KEY_P8 || !APNS_KEY_ID || !APNS_TEAM_ID || !APNS_TOPIC) return null;
  return { key: toPem(APNS_KEY_P8), keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID, topic: APNS_TOPIC };
}

function toPem(raw: string): string {
  const s = raw.replace(/\\n/g, '\n').trim();
  if (s.includes('BEGIN PRIVATE KEY')) return s;
  const body = s.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
let cachedJwt: { token: string; issuedAt: number; keyId: string } | null = null;

function providerToken(cfg: ApnsConfig, nowMs = Date.now()): string {
  if (cachedJwt && cachedJwt.keyId === cfg.keyId && nowMs - cachedJwt.issuedAt < 50 * 60_000) return cachedJwt.token;
  const iat = Math.floor(nowMs / 1000);
  const input = `${b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }))}.${b64url(JSON.stringify({ iss: cfg.teamId, iat }))}`;
  const signature = sign('sha256', Buffer.from(input), { key: createPrivateKey(cfg.key), dsaEncoding: 'ieee-p1363' });
  const token = `${input}.${b64url(signature)}`;
  cachedJwt = { token, issuedAt: nowMs, keyId: cfg.keyId };
  return token;
}

type Sent = { status: number; reason?: string };

// One push to Apple. An alert at priority 10; a background push (the
// silent "clear" below) must say so and go at priority 5, or Apple refuses it.
async function post(cfg: ApnsConfig, environment: 'sandbox' | 'production', deviceToken: string, payload: string, kind: 'alert' | 'background'): Promise<Sent> {
  const host = environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  const session = http2.connect(host);
  session.on('error', () => {});
  try {
    return await new Promise<Sent>((resolve) => {
      const req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken(cfg)}`,
        'apns-topic': cfg.topic,
        'apns-push-type': kind,
        'apns-priority': kind === 'alert' ? '10' : '5',
        'content-type': 'application/json',
      });
      let status = 0;
      let body = '';
      req.setEncoding('utf8');
      req.on('response', (h) => (status = Number(h[':status'] ?? 0)));
      req.on('data', (c: string) => (body += c));
      req.on('end', () => {
        let reason: string | undefined;
        try {
          reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
        } catch {
          reason = body || undefined;
        }
        resolve({ status, ...(reason ? { reason } : {}) });
      });
      req.on('error', (e) => resolve({ status: 0, reason: e.message }));
      req.setTimeout(10_000, () => {
        req.close();
        resolve({ status: 0, reason: 'timeout' });
      });
      req.end(payload);
    });
  } finally {
    session.close();
  }
}

const vEnvironment = v.union(v.literal('sandbox'), v.literal('production'));
const vSent = v.object({ status: v.number(), reason: v.optional(v.string()) });

// The relay can't read what it forwards: an encrypted notification goes to
// the phone with a stand-in alert and mutable-content, and the app's
// notification extension decrypts `e` into the real title and text with a
// key only the phone and its own backend have.
export const send = internalAction({
  args: { deviceToken: v.string(), environment: vEnvironment, threadId: v.string(), encrypted: v.optional(v.string()), title: v.optional(v.string()), body: v.optional(v.string()) },
  returns: vSent,
  handler: async (_ctx, a): Promise<Sent> => {
    const cfg = apnsConfig();
    if (!cfg) return { status: 0, reason: 'relay not configured' };
    const aps = a.encrypted
      ? { alert: { title: 'Threadbear', body: 'A thread needs you' }, sound: 'default', 'mutable-content': 1, 'thread-id': a.threadId }
      : { alert: { title: a.title ?? 'Threadbear', body: a.body ?? 'A thread needs you' }, sound: 'default', 'thread-id': a.threadId };
    const payload = JSON.stringify({ aps, threadId: a.threadId, ...(a.encrypted ? { e: a.encrypted } : {}) });
    return await post(cfg, a.environment, a.deviceToken, payload, 'alert');
  },
});

// A silent push that tells the app to take down a thread's notifications:
// the thread no longer needs the person (seen on the Mac, answered,
// archived). No alert, so an app from before this shows nothing. `clear`
// rather than `threadId`, so nothing reads it as a thread to open.
export const clear = internalAction({
  args: { deviceToken: v.string(), environment: vEnvironment, threadId: v.string() },
  returns: vSent,
  handler: async (_ctx, a): Promise<Sent> => {
    const cfg = apnsConfig();
    if (!cfg) return { status: 0, reason: 'relay not configured' };
    return await post(cfg, a.environment, a.deviceToken, JSON.stringify({ aps: { 'content-available': 1 }, clear: a.threadId }), 'background');
  },
});
