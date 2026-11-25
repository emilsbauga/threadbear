// Promoting the box image a new box boots (convex/boxImage.ts, Daybreak 171):
// only a GitHub Actions OIDC token from main's box-image workflow in the
// repo BOX_IMAGE_REPO names, made for this deployment and signed by
// GitHub's key, promotes a digest. Tokens here are signed by a key made for
// the test and served as GitHub's from a fake fetch: nothing leaves.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryBackend } from '../helpers/convex-memory.ts';
import { actionCtx } from '../helpers/box-backend.ts';

const boxImage = load('boxImage');
const { flyProvider } = load('boxProviders/fly');
const { fakeFly } = await import('../helpers/fake-fly.ts');

const REPO = 'mikecann/threadbear';
const SITE = 'https://dep.convex.site';
const WORKFLOW = `${REPO}/.github/workflows/box-image.yml@refs/heads/main`;
const SHA = '0123456789abcdef0123456789abcdef01234567';
const IMAGE = `registry.fly.io/tb-boxes@sha256:${'b'.repeat(64)}`;
const now = () => Math.floor(Date.now() / 1000);

const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as { privateKey: CryptoKey; publicKey: CryptoKey };
const other = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as { privateKey: CryptoKey; publicKey: CryptoKey };
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
const JWKS = { keys: [{ ...jwk, kid: 'gh1', use: 'sig', alg: 'RS256' }] };

const b64 = (x: string | Uint8Array) => Buffer.from(x).toString('base64url');
const goodClaims = () => ({
  iss: 'https://token.actions.githubusercontent.com',
  aud: SITE,
  iat: now() - 5,
  nbf: now() - 5,
  exp: now() + 300,
  repository: REPO,
  repository_owner: 'mikecann',
  ref: 'refs/heads/main',
  workflow_ref: WORKFLOW,
  job_workflow_ref: WORKFLOW,
  event_name: 'push',
  sha: SHA,
});
async function sign(claims: Record<string, unknown>, o: { key?: CryptoKey; kid?: string; alg?: string } = {}) {
  const head = b64(JSON.stringify({ alg: o.alg ?? 'RS256', typ: 'JWT', kid: o.kid ?? 'gh1' }));
  const body = b64(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', o.key ?? pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64(sig)}`;
}

const realFetch = globalThis.fetch;
const asked: string[] = [];
globalThis.fetch = (async (url: string) => {
  asked.push(String(url));
  if (String(url) === 'https://token.actions.githubusercontent.com/.well-known/jwks') return new Response(JSON.stringify(JWKS), { status: 200 });
  return new Response('no', { status: 404 });
}) as typeof fetch;
process.on('exit', () => {
  globalThis.fetch = realFetch;
});

const verify = (token: string) => boxImage.verifyPromotion(token, { repo: REPO, audience: SITE, nowS: now() });

test("a token from main's box-image workflow in the trusted repo, for this deployment, checks out with its commit", async () => {
  const claims = goodClaims();
  assert.deepEqual(await verify(await sign(claims)), { commit: SHA, issuedAt: claims.iat });
  // workflow_dispatch on main is the workflow's other way to run.
  assert.equal((await verify(await sign({ ...goodClaims(), event_name: 'workflow_dispatch' }))).commit, SHA);
  // An ordinary job's token may have no job_workflow_ref (that's for reusable
  // workflows): it checks out on workflow_ref alone (Codex's review).
  const { job_workflow_ref: _, ...plain } = goodClaims();
  assert.equal((await verify(await sign(plain))).commit, SHA);
  // GitHub's repo names don't care about case.
  assert.equal((await boxImage.verifyPromotion(await sign(goodClaims()), { repo: 'MikeCann/Threadbear', audience: SITE, nowS: now() })).commit, SHA);
});

test('a token for another repository, branch, workflow, event or deployment promotes nothing', async () => {
  const cases: [string, Record<string, unknown>][] = [
    ['a fork', { repository: 'someone/threadbear', workflow_ref: 'someone/threadbear/.github/workflows/box-image.yml@refs/heads/main', job_workflow_ref: 'someone/threadbear/.github/workflows/box-image.yml@refs/heads/main' }],
    ['a branch', { ref: 'refs/heads/feature', workflow_ref: `${REPO}/.github/workflows/box-image.yml@refs/heads/feature`, job_workflow_ref: `${REPO}/.github/workflows/box-image.yml@refs/heads/feature` }],
    ['a release tag', { ref: 'refs/tags/release/2026-11-23' }],
    ['another workflow', { workflow_ref: `${REPO}/.github/workflows/runner.yml@refs/heads/main`, job_workflow_ref: `${REPO}/.github/workflows/runner.yml@refs/heads/main` }],
    ['a reusable workflow called from another', { job_workflow_ref: `${REPO}/.github/workflows/other.yml@refs/heads/main` }],
    ['no workflow_ref', { workflow_ref: undefined }],
    ['a pull request', { event_name: 'pull_request' }],
    ['another deployment', { aud: 'https://other.convex.site' }],
    ['two audiences', { aud: [SITE, 'https://other.convex.site'] }],
    ['another issuer', { iss: 'https://evil.example' }],
    ['expired', { exp: now() - 600 }],
    ['issued long ago', { iat: now() - 3600 }],
    ['from the future', { iat: now() + 3600 }],
    ['not valid yet', { nbf: now() + 3600 }],
    ['no commit', { sha: 'main' }],
  ];
  for (const [what, change] of cases) {
    await assert.rejects(verify(await sign({ ...goodClaims(), ...change })), boxImage.PromotionRefused, what);
  }
});

test("a token not signed by GitHub's key promotes nothing", async () => {
  const claims = goodClaims();
  await assert.rejects(verify(await sign(claims, { key: other.privateKey })), /signature doesn't check/);
  await assert.rejects(verify(await sign(claims, { kid: 'nope' })), /isn't one of GitHub's/);
  const [h, p] = (await sign(claims)).split('.');
  await assert.rejects(verify(`${b64(JSON.stringify({ alg: 'none', kid: 'gh1' }))}.${p}.`), /RS256/);
  // Claims changed after signing.
  await assert.rejects(verify(`${h}.${b64(JSON.stringify({ ...claims, sha: 'f'.repeat(40) }))}.${(await sign(claims)).split('.')[2]}`), /signature/);
  await assert.rejects(verify('not.a-jwt'), boxImage.PromotionRefused);
  // A signature that isn't base64url is refused as such, not as GitHub being down.
  await assert.rejects(verify(`${h}.${p}.abcde`), boxImage.PromotionRefused);
  // A key GitHub marks for something else doesn't verify a token.
  JWKS.keys[0] = { ...JWKS.keys[0]!, use: 'enc' };
  try {
    await assert.rejects(verify(await sign(claims)), /isn't one of GitHub's/);
  } finally {
    JWKS.keys[0] = { ...JWKS.keys[0]!, use: 'sig' };
  }
});

// The route, with this deployment's settings.
async function route(token: string | null, body: unknown, env: Record<string, string | undefined> = {}) {
  const set = { BOX_IMAGE_REPO: REPO, FLY_APP: 'tb-boxes', CONVEX_SITE_URL: SITE, ...env };
  const was = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  for (const [k, val] of Object.entries(set)) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
  try {
    const b = memoryBackend();
    const req = new Request(`${SITE}/box-image/promote`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
    const res: Response = await (boxImage.promoteRoute as (ctx: unknown, r: Request) => Promise<Response>)(actionCtx(b), req);
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, rows: b.rows('boxImages') };
  } finally {
    for (const [k, val] of Object.entries(was)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  }
}

test('the route promotes a digest of the boxes\' own app, with the commit from the token', async () => {
  const r = await route(await sign(goodClaims()), { image: IMAGE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.rows.length, 1);
  assert.deepEqual({ app: r.rows[0].app, image: r.rows[0].image, commit: r.rows[0].commit }, { app: 'tb-boxes', image: IMAGE, commit: SHA });
});

test('the route refuses a tag, another app, no token, and a deployment not set up for it', async () => {
  const token = await sign(goodClaims());
  for (const image of ['registry.fly.io/tb-boxes:latest', `registry.fly.io/other-app@sha256:${'b'.repeat(64)}`, `ghcr.io/tb-boxes@sha256:${'b'.repeat(64)}`, `registry.fly.io/tb-boxes@sha256:${'B'.repeat(64)}`]) {
    const r = await route(token, { image });
    assert.equal(r.status, 400, image);
    assert.equal(r.rows.length, 0);
  }
  assert.equal((await route(null, { image: IMAGE })).status, 401);
  assert.equal((await route(await sign({ ...goodClaims(), repository: 'evil/threadbear' }), { image: IMAGE })).status, 401);
  for (const unset of ['BOX_IMAGE_REPO', 'FLY_APP', 'CONVEX_SITE_URL']) {
    const r = await route(token, { image: IMAGE }, { [unset]: undefined });
    assert.equal(r.status, 403, unset);
    assert.equal(r.rows.length, 0);
  }
});

test("Fly's adapter never makes a machine from a tag", async () => {
  const fly = fakeFly();
  const p = flyProvider({ token: 'fly-token', app: 'tb-boxes', org: 'my-org', memoryMb: 2048, baseUrl: fly.url, fetch: fly.fetch });
  const spec = { image: 'registry.fly.io/tb-boxes:latest', cpus: 1, memoryMb: 1024, env: {}, name: 'tb-x-1', tags: { tb_box: 'x', tb_attempt: '1', tb_service: 's' }, idempotencyKey: 'x-1' };
  await assert.rejects(p.create(spec), /isn't pinned by digest/);
  assert.equal(fly.seen.length, 0);
});

afterEach(() => {
  asked.length = 0;
});

test('the workflow promotes the digest its own push reported, with an OIDC token, never a tag', async () => {
  const { readFile } = await import('node:fs/promises');
  const wf = await readFile(new URL('../../../.github/workflows/box-image.yml', import.meta.url), 'utf8');
  const latestJob = wf.slice(wf.indexOf('\n  promote:'));
  assert.match(latestJob, /id-token: write/);
  assert.match(latestJob, /DIGEST: \$\{\{ needs\.image\.outputs\.digest \}\}/);
  assert.match(latestJob, /--arg image "\$IMAGE@\$DIGEST"/);
  assert.match(latestJob, /\/box-image\/promote/);
  assert.match(wf, /digest: \$\{\{ steps\.push\.outputs\.digest \}\}/);
  // Only the job that promotes can mint a token.
  assert.equal((wf.match(/id-token: write/g) ?? []).length, 1);
  // Promoted only while this commit is main's head, by GitHub's account,
  // never by anything read from the registry; and the build takes no cache
  // from it, and pushes no `latest` (Daybreak 171's second review).
  assert.match(latestJob, /gh api "repos\/\$REPO\/compare\/\$SHA\.\.\.heads\/main" --jq \.status/);
  assert.match(latestJob, /\*\) echo "::notice::\$\{SHA:0:8\} is \$status of main, so it isn't promoted\."; exit 0 ;;/);
  // A file renamed out of the image counts as a change to it, by its old name (round three).
  assert.match(latestJob, /\.filename, \(\.previous_filename \/\/ empty\)/);
  // The digest the registry answered is checked against the manifest and this build's config.
  assert.match(wf, /imagetools inspect --raw "\$IMAGE@\$digest"/);
  assert.match(wf, /\[ "\$config" = "\$built" \]/);
  const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /--cache-from|BUILDKIT_INLINE_CACHE|:latest/);
  assert.doesNotMatch(latestJob, /docker (pull|inspect)/);
});

test('the same promotion sent again (its answer lost) is done already, an older or other one with the same token is not', async () => {
  const b = memoryBackend();
  const a = { app: 'tb-boxes', image: IMAGE, commit: SHA, issuedAt: 5000 };
  const ctx = actionCtx(b);
  assert.deepEqual(await ctx.runMutation('internal.boxImage.promote', a), { ok: true });
  assert.deepEqual(await ctx.runMutation('internal.boxImage.promote', a), { ok: true });
  assert.equal((await ctx.runMutation('internal.boxImage.promote', { ...a, image: `registry.fly.io/tb-boxes@sha256:${'c'.repeat(64)}` })).ok, false);
  assert.equal((await ctx.runMutation('internal.boxImage.promote', { ...a, issuedAt: 4000 })).ok, false);
  assert.equal(b.rows('boxImages').length, 1);
  assert.equal(b.rows('boxImages')[0].image, IMAGE);
});

test('a big body is refused after 1 KB, before the token is looked at, and a site URL with a slash still matches', async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(64 * 1024));
      if (pulled > 1000) c.close();
    },
  });
  const was = { ...process.env };
  Object.assign(process.env, { BOX_IMAGE_REPO: REPO, FLY_APP: 'tb-boxes', CONVEX_SITE_URL: SITE });
  try {
    const b = memoryBackend();
    const req = new Request(`${SITE}/box-image/promote`, { method: 'POST', headers: { authorization: 'Bearer a' }, body, duplex: 'half' } as RequestInit);
    const res: Response = await (boxImage.promoteRoute as (ctx: unknown, r: Request) => Promise<Response>)(actionCtx(b), req);
    assert.equal(res.status, 413);
    assert.ok(pulled < 5, `read ${pulled} chunks`);
  } finally {
    process.env = was;
  }
  const r = await route(await sign(goodClaims()), { image: IMAGE }, { CONVEX_SITE_URL: `${SITE}/` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
