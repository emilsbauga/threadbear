// node --test web/src/token.test.ts
// The website's sign-in link (API 81): a one-use code in the fragment, never
// the browser's token, and an old link's token is never kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSignInHash } from './token.ts';

test('a sign-in link gives a one-use code to trade', () => {
  const code = 'tbp_' + 'a1'.repeat(24);
  assert.deepEqual(readSignInHash(`#code=${code}`), { code, oldLink: false });
});

test("an old link's token is never taken as this browser's", () => {
  const read = readSignInHash('#token=tb_0123456789abcdef');
  assert.equal(read.code, undefined);
  assert.equal(read.oldLink, true);
  // A token put where the code goes isn't one either.
  assert.equal(readSignInHash('#code=tb_0123456789abcdef').code, undefined);
});

test('anything else in the fragment is no sign-in at all', () => {
  assert.deepEqual(readSignInHash('#usage'), { code: undefined, oldLink: false });
  assert.deepEqual(readSignInHash(''), { code: undefined, oldLink: false });
  assert.equal(readSignInHash('#code=tbp_<script>').code, undefined);
});

// Daybreak 145: a sign-in link (a #code= any thread's words can link to) never
// replaces a browser's sign-in by itself. With one kept, nothing is claimed or
// kept until you say to swap, and a swap that fails keeps the old one.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)) };
}
Object.assign(globalThis, { localStorage: memoryStorage(), sessionStorage: memoryStorage() });
const { startSignIn, answerPendingSignIn } = await import('./token.ts');
const CODE = 'tbp_' + 'b2'.repeat(24);
const refused = () => true;
const tick = () => new Promise((r) => setTimeout(r, 0));

test('a browser that is signed in claims nothing from a link until you say so, and No keeps it', async () => {
  localStorage.setItem('threadbear.token', 'tb_mine');
  let claims = 0;
  startSignIn(async () => (claims++, { token: 'tb_theirs' }), CODE, refused);
  await tick();
  assert.equal(claims, 0, 'the code was traded before asking');
  assert.equal(localStorage.getItem('threadbear.token'), 'tb_mine');
  await answerPendingSignIn(false);
  assert.equal(claims, 0);
  assert.equal(localStorage.getItem('threadbear.token'), 'tb_mine');
});

test('a swap that the backend refuses keeps the sign-in it had', async () => {
  localStorage.setItem('threadbear.token', 'tb_mine');
  startSignIn(async () => { throw new Error('used'); }, CODE, refused);
  await answerPendingSignIn(true);
  assert.equal(localStorage.getItem('threadbear.token'), 'tb_mine');
  await answerPendingSignIn(false);
});

test('a swap you say yes to signs in with the link', async () => {
  localStorage.setItem('threadbear.token', 'tb_mine');
  startSignIn(async (code) => (assert.equal(code, CODE), { token: 'tb_new' }), CODE, refused);
  await answerPendingSignIn(true);
  assert.equal(localStorage.getItem('threadbear.token'), 'tb_new');
});

test('a browser that is not signed in signs in from the link straight away', async () => {
  localStorage.removeItem('threadbear.token');
  startSignIn(async () => ({ token: 'tb_first' }), CODE, refused);
  await tick();
  assert.equal(localStorage.getItem('threadbear.token'), 'tb_first');
});

test('a second Sign in again press while the first is claiming changes nothing', async () => {
  localStorage.setItem('threadbear.token', 'tb_mine');
  let claims = 0;
  startSignIn(async () => {
    if (claims++) throw new Error('used');
    await tick();
    return { token: 'tb_new' };
  }, CODE, refused);
  await Promise.all([answerPendingSignIn(true), answerPendingSignIn(true)]);
  assert.equal(claims, 1);
  assert.equal(localStorage.getItem('threadbear.token'), 'tb_new');
});
