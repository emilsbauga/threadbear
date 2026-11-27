import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, RELAY } from '../helpers/convex-memory.ts';

type Route = { path: string; handler: (ctx: unknown, req: Request) => Promise<Response> };
const relay = load('http', RELAY).__default as { routes: Route[] };
const backend = load('http').__default as { routes: Route[] };

function streamed(path: string, chunks: string[], headers: Record<string, string> = {}) {
  let read = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (read === chunks.length) return c.close();
      c.enqueue(new TextEncoder().encode(chunks[read++]!));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const request = new Request(`https://example.test${path}`, { method: 'POST', body, duplex: 'half', headers } as RequestInit);
  return { request, read: () => read, cancelled: () => cancelled };
}

for (const [router, path, cap] of [[relay, '/register', 16_000], [backend, '/relay/verify', 1024]] as const) {
  test(`${path} cancels a chunked body before consuming later chunks`, async () => {
    const r = streamed(path, [' '.repeat(cap), 'x', 'never read']);
    const response = await router.routes.find((x) => x.path === path)!.handler({}, r.request);
    assert.equal(response.status, 413);
    assert.equal(r.read(), 2);
    assert.equal(r.cancelled(), true);
  });
  test(`${path} counts UTF-8 bytes and ignores a dishonest small content length`, async () => {
    const r = streamed(path, ['é'.repeat(cap), 'never read'], { 'content-length': '1' });
    assert.equal((await router.routes.find((x) => x.path === path)!.handler({}, r.request)).status, 413);
    assert.equal(r.read(), 1);
    assert.equal(r.cancelled(), true);
  });
}

test('a valid nonce still reaches its one-use check', async () => {
  const nonce = 'a'.repeat(48);
  let checked = false;
  const route = backend.routes.find((x) => x.path === '/relay/verify')!;
  const response = await route.handler({ runMutation: async (_fn: unknown, args: unknown) => { assert.deepEqual(args, { nonce }); checked = true; return true; } }, new Request('https://example.test/relay/verify', { method: 'POST', body: JSON.stringify({ nonce }) }));
  assert.equal(response.status, 200);
  assert.equal(checked, true);
});

test('a minimal valid registration still completes its callback and registers', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { const r = new Response(JSON.stringify({ ok: true })); Object.defineProperty(r, 'url', { value: String(url) }); return r; };
  try {
    const ctx = { runQuery: async () => true, runMutation: async (fn: unknown) => String(fn).endsWith('startCheck') ? { check: 'check' } : String(fn).endsWith('registerVerified') ? { installId: 'i_test', installKey: 'k_test' } : null };
    const response = await relay.routes.find((x) => x.path === '/register')!.handler(ctx, new Request('https://example.test/register', { method: 'POST', body: JSON.stringify({ deployment: 'https://small-1.convex.site', nonce: 'a'.repeat(48) }) }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { installId: 'i_test', installKey: 'k_test' });
  } finally { globalThis.fetch = original; }
});
