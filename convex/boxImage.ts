// Which image a new box boots (docs/virtual-runners.md, "The box image";
// Daybreak 171, 23 Nov 2026). A box is handed a boot token that trades for
// its login's year-long Claude token, the thread's key and its save, so the
// image that gets it must be exactly the bytes main's workflow built and
// tested, never whatever a registry tag points at by then: anyone who can
// push to the boxes' Fly app (its image token, or the registry itself) can
// move `:latest`.
//
// So a box only ever boots an image pinned by digest
// (`registry.fly.io/<app>@sha256:...`, boxProviders/types.ts PINNED_IMAGE):
//
// - A virtual runner given an image names it by digest (setRunnerService
//   refuses a tag).
// - One given none follows main: its row keeps `registry.fly.io/<FLY_APP>:latest`
//   as the sign for that, and each new box boots the digest last promoted
//   here for FLY_APP, never the tag. With none promoted, no box is made.
// - Promoting is .github/workflows/box-image.yml's `latest` job, after the
//   image it built passed its smoke test and the runner's tests: it posts
//   the digest its own push returned to /box-image/promote with a GitHub
//   Actions OIDC token, which only a run of that workflow on main in the
//   repo BOX_IMAGE_REPO names can get, made for this deployment
//   (its audience is CONVEX_SITE_URL). No shared secret: the Fly token that
//   pushes images can't promote one, so a stolen push token or a moved tag
//   reaches no box. What can still promote is a change to main's workflow,
//   or GitHub itself, which the runner already trusts as main.
// - Promotions only go forward: one from a token issued no later than the
//   last one's is refused, so a replayed token can't put an older image back.
import { v } from 'convex/values';
import { httpAction, internalMutation, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import { isPinnedImage } from './boxProviders/types';
import { readCapped } from './uploads';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;
export const PROMOTING_WORKFLOW = '.github/workflows/box-image.yml';
const MAIN = 'refs/heads/main';
// GitHub's tokens last 5 to 10 minutes; one older than this is refused too.
const MAX_TOKEN_AGE_S = 15 * 60;
const SKEW_S = 60;

/** The image a virtual runner made without one keeps: the sign it follows main (bootImage). */
export function followMainImage(app: string): string {
  return `registry.fly.io/${app}:latest`;
}

/**
 * What a new box of a virtual runner with this image boots: the image itself
 * if pinned by digest, the digest promoted for FLY_APP if it follows main,
 * else nothing, with why.
 */
export async function bootImage(ctx: QueryCtx, image: string, app = process.env.FLY_APP?.trim()): Promise<{ image: string } | { why: string }> {
  if (isPinnedImage(image)) return { image };
  if (app && image === followMainImage(app)) {
    const promoted = await ctx.db.query('boxImages').withIndex('by_app', (q) => q.eq('app', app)).unique();
    if (promoted && isPinnedImage(promoted.image)) return { image: promoted.image };
    return { why: `No box image has been promoted for ${app} yet: main's box-image workflow promotes one once its image passes its tests (docs/virtual-runners.md).` };
  }
  return { why: `The virtual runner's image ${image.slice(0, 120)} isn't pinned by digest (name@sha256:...), so no box is made from it: give it the image's digest (boxes:setRunnerService).` };
}

export const promote = internalMutation({
  args: { app: v.string(), image: v.string(), commit: v.string(), issuedAt: v.number() },
  returns: v.union(v.object({ ok: v.literal(true) }), v.object({ ok: v.literal(false), why: v.string() })),
  handler: async (ctx, a) => {
    if (!isPinnedImage(a.image)) return { ok: false as const, why: 'not pinned by digest' };
    const was = await ctx.db.query('boxImages').withIndex('by_app', (q) => q.eq('app', a.app)).unique();
    // The same promotion again (a retry whose answer was lost) is done already.
    if (was && was.issuedAt === a.issuedAt && was.image === a.image && was.commit === a.commit) return { ok: true as const };
    if (was && was.issuedAt >= a.issuedAt) return { ok: false as const, why: `the image promoted already (${was.commit.slice(0, 8)}) came with a token as new or newer` };
    const row = { app: a.app, image: a.image, commit: a.commit, issuedAt: a.issuedAt, promotedAt: Date.now() };
    if (was) await ctx.db.replace('boxImages', was._id, row);
    else await ctx.db.insert('boxImages', row);
    return { ok: true as const };
  },
});

type Claims = Record<string, unknown>;
export class PromotionRefused extends Error {}

function b64url(part: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(part) || part.length % 4 === 1) throw new PromotionRefused('the token is not base64url');
  const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function json(part: string): Claims {
  const x = JSON.parse(new TextDecoder().decode(b64url(part))) as unknown;
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new PromotionRefused('the token is not a JWT');
  return x as Claims;
}

/**
 * Checks a GitHub Actions OIDC token is from PROMOTING_WORKFLOW running on
 * main in `repo`, for `audience`, now, and signed by GitHub's key. Returns
 * the commit it ran on and when it was issued; throws PromotionRefused.
 */
export async function verifyPromotion(token: string, o: { repo: string; audience: string; nowS: number; fetch?: typeof fetch }): Promise<{ commit: string; issuedAt: number }> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new PromotionRefused('the token is not a JWT');
  let header: Claims;
  let c: Claims;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = json(parts[0]!);
    c = json(parts[1]!);
    signature = b64url(parts[2]!);
  } catch (e) {
    throw e instanceof PromotionRefused ? e : new PromotionRefused('the token is not a JWT');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new PromotionRefused('the token is not signed RS256 with a key id');
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
  const num = (k: string) => (typeof c[k] === 'number' && Number.isFinite(c[k]) ? (c[k] as number) : NaN);
  if (str('iss') !== GITHUB_ISSUER) throw new PromotionRefused('the token is not from GitHub Actions');
  const aud = c.aud;
  if (!(aud === o.audience || (Array.isArray(aud) && aud.length === 1 && aud[0] === o.audience))) throw new PromotionRefused('the token is for another audience');
  const exp = num('exp');
  const iat = num('iat');
  if (!(exp > o.nowS - SKEW_S)) throw new PromotionRefused('the token has expired');
  if (!(iat <= o.nowS + SKEW_S && o.nowS - iat <= MAX_TOKEN_AGE_S)) throw new PromotionRefused('the token is too old, or from the future');
  if (c.nbf !== undefined && !(num('nbf') <= o.nowS + SKEW_S)) throw new PromotionRefused('the token is not valid yet');
  const repository = str('repository');
  if (!repository || repository.toLowerCase() !== o.repo.toLowerCase()) throw new PromotionRefused(`the token is from ${repository || 'no repository'}, not ${o.repo}`);
  if (str('ref') !== MAIN) throw new PromotionRefused(`the token is from ${str('ref') || 'no ref'}, not main`);
  const want = `${repository}/${PROMOTING_WORKFLOW}@${MAIN}`;
  // job_workflow_ref is there for a job from a reusable workflow: if there,
  // it must be this one too, so no other workflow's job can stand in.
  if (str('workflow_ref') !== want || (c.job_workflow_ref !== undefined && str('job_workflow_ref') !== want)) throw new PromotionRefused(`the token is from another workflow (${str('workflow_ref') || 'none'})`);
  if (!['push', 'workflow_dispatch'].includes(str('event_name'))) throw new PromotionRefused(`the token is from a ${str('event_name') || 'no'} event`);
  const commit = str('sha');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new PromotionRefused('the token names no commit');

  const got = await (o.fetch ?? fetch)(JWKS_URL, { redirect: 'error' });
  if (!got.ok) throw new Error(`GitHub's keys: ${got.status}`);
  const keys = ((await got.json()) as { keys?: unknown }).keys;
  const jwk = Array.isArray(keys) ? (keys as Claims[]).find((k) => k && k.kid === header.kid && k.kty === 'RSA' && (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === 'RS256')) : undefined;
  if (!jwk || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw new PromotionRefused("the token's key isn't one of GitHub's");
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new PromotionRefused("the token's signature doesn't check");
  return { commit, issuedAt: iat };
}

const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** POST /box-image/promote, `Authorization: Bearer <OIDC token>`, `{ image }`. */
export const promoteRoute = httpAction(async (ctx, request) => {
  const repo = process.env.BOX_IMAGE_REPO?.trim();
  const app = process.env.FLY_APP?.trim();
  const audience = process.env.CONVEX_SITE_URL?.trim().replace(/\/+$/, '');
  if (!repo || !app || !audience) return reply(403, { error: 'This deployment promotes no box images: BOX_IMAGE_REPO and FLY_APP must be set on it.' });
  const auth = request.headers.get('authorization') ?? '';
  const token = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(auth)?.[1];
  if (!token) return reply(401, { error: 'no token' });
  // Read no further than 1 KB, before anything else: the route answers anyone.
  const body = await readCapped(request, 1024);
  if (body === 'tooBig') return reply(413, { error: 'too long' });
  if (body === 'broken') return reply(400, { error: 'unreadable' });
  const raw = await body.text();
  let image: unknown;
  try {
    image = (JSON.parse(raw) as { image?: unknown }).image;
  } catch {
    return reply(400, { error: 'not JSON' });
  }
  const prefix = `registry.fly.io/${app}@sha256:`;
  if (typeof image !== 'string' || !image.startsWith(prefix) || !isPinnedImage(image)) return reply(400, { error: `image must be ${prefix}<64 hex>` });
  let proof: { commit: string; issuedAt: number };
  try {
    proof = await verifyPromotion(token, { repo, audience, nowS: Math.floor(Date.now() / 1000) });
  } catch (e) {
    if (e instanceof PromotionRefused) return reply(401, { error: e.message });
    return reply(503, { error: 'could not check the token now; try again' });
  }
  const r = await ctx.runMutation(internal.boxImage.promote, { app, image, ...proof });
  return r.ok ? reply(200, { ok: true, image, commit: proof.commit }) : reply(409, { error: r.why });
});
