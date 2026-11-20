// A shared thread's page, /s/<slug> (convex/http.ts): index.html with the
// thread's title and card tags, from convex/shareCard.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeDecode, withCard } from '../../../convex/shareCard.ts';

const PAGE = '<html><head><title>Threadbear</title><script src="/app.js"></script></head><body></body></html>';
const URL_ = new URL('https://site.example/s/abc');

test("a title with $' or $& in it is put in as written, not as pieces of the page", () => {
  for (const title of ["Price is $'5", 'Use $& here', 'Before $` after', 'Group $1']) {
    const out = withCard(PAGE, { title, description: '' }, URL_);
    const shown = title.replace(/&/g, '&amp;');
    assert.ok(out.includes(`<title>${shown} · Threadbear</title>`), out);
    assert.ok(out.includes(`<meta property="og:title" content="${shown}" />`), out);
    assert.equal(out.split('<script src="/app.js">').length, 2, 'the page appears once');
  }
});

test('the card tags escape the thread\'s words', () => {
  const out = withCard(PAGE, { title: '<b>"hi"</b> & co', description: 'a <i>reply</i>', image: 'https://img.example/a.png?x=1&y=2' }, URL_);
  assert.ok(out.includes('<title>&lt;b&gt;&quot;hi&quot;&lt;/b&gt; &amp; co · Threadbear</title>'));
  assert.ok(out.includes('content="a &lt;i&gt;reply&lt;/i&gt;"'));
  assert.ok(out.includes('content="https://img.example/a.png?x=1&amp;y=2"'));
  assert.ok(out.includes('<meta name="twitter:card" content="summary_large_image" />'));
});

test('a bad escape in a link is no slug, not an error', () => {
  assert.equal(safeDecode('%zz'), '');
  assert.equal(safeDecode('%E0%A4%A'), '');
  assert.equal(safeDecode('my%20thread'), 'my thread');
});
