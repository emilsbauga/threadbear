// The website's pages refuse to be framed by another site (convex/http.ts,
// NO_FRAMES): framed out of sight, a thread's app link and then the Open
// button of the site's own "Open this in another app?" question could be
// clicked through a page laid over them (Daybreak 139, cross-lab review,
// 17 Nov 2026). Bundles the real convex/http.ts with the real Convex router
// and static-hosting client, then serves the home page, a deep link, a
// script and a shared page (/s/) through their real handlers with a fake ctx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(ROOT, 'package.json'));
// esbuild comes with the repo's own packages, which a runner's release
// build (runner/ only, src/update.ts) doesn't install: there it's skipped.
let esbuild: typeof import('esbuild') | undefined;
try {
  esbuild = require('esbuild') as typeof import('esbuild');
} catch {
  esbuild = undefined;
}

type Handler = (ctx: unknown, request: Request) => Promise<Response>;
type Router = { lookup: (path: string, method: 'GET') => readonly [{ _handler: Handler }, string, string] | null };

async function router(): Promise<Router> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-no-frames-'));
  const out = path.join(dir, 'http.mjs');
  await esbuild!.build({ entryPoints: [path.join(ROOT, 'convex/http.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent', nodePaths: [path.join(ROOT, 'node_modules')] });
  try {
    return (await import(pathToFileURL(out).href)).default as Router;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HTML = '<!doctype html><html><head><title>Threadbear</title></head><body></body></html>';

// What the handlers read: the page from storage, no shared thread's card.
const ctx = {
  runQuery: async (_fn: unknown, args: { path?: string; slug?: string }) => {
    if (args.slug !== undefined) return null;
    const isJs = args.path?.endsWith('.js');
    return { appStorageId: 'file', contentType: isJs ? 'text/javascript' : 'text/html; charset=utf-8', etag: '"e"' };
  },
  storage: { get: async () => new Blob([HTML]) },
};

test("every page of the site says no other site may frame it, the shared page's too", { skip: !esbuild && "the repo's packages aren't installed" }, async () => {
  const http = await router();
  for (const p of ['/', '/t/abc', '/projects/r/p', '/assets/index.js', '/s/some-slug']) {
    const hit = http.lookup(p, 'GET');
    assert.ok(hit, `no route for ${p}`);
    const res = await hit[0]._handler(ctx, new Request(`https://site.example${p}`));
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', p);
    assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'", p);
    // And the response is otherwise what the handler made.
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
    if (!p.endsWith('.js')) assert.match(await res.text(), /<title>Threadbear<\/title>/, p);
  }
});
