// The docs site's search (site/src/docs-search.js, issue #32): its index is the real guide cut at
// every heading (searchEntries in site/scripts/docs.mjs), and every result opens where it should.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain .mjs without types
import { readGuide, searchEntries, slugify } from '../../../site/scripts/docs.mjs';
// @ts-expect-error plain .js without types
import { href, nth, parts, search, snippet } from '../../../site/src/docs-search.js';

const repo = join(fileURLToPath(import.meta.url), '../../../..');
const guide = readGuide(repo);
const entries = searchEntries(guide);

test('the index covers every docs page, cut at its headings, as plain words', () => {
  const paths = new Set(entries.map((e: any) => e.path));
  assert.ok(paths.has('/docs'));
  for (const s of guide.sections) assert.ok(paths.has(`/docs/${s.slug}`), s.slug);
  for (const e of entries) {
    assert.doesNotMatch(e.text, /<!--|\*\*|\]\(/, `${e.path}#${e.anchor} still has Markdown in it`);
    if (e.heading) assert.equal(e.anchor, slugify(e.anchor), e.heading);
  }
});

test('every anchor in the index is a heading id on its built page', () => {
  // markdown() gives a ### heading the id slugify(raw heading); the index must use the same.
  for (const s of guide.sections) {
    const raw = [...s.body.matchAll(/^#{3,6} (.+)$/gm)].map((m) => slugify(m[1]));
    for (const e of entries.filter((x: any) => x.path === `/docs/${s.slug}` && x.anchor)) {
      assert.ok(raw.includes(e.anchor), `${e.anchor} isn't a heading on /docs/${s.slug}`);
    }
  }
});

test('a heading match comes before a mention in the text, and every word has to match', () => {
  const sample = [
    { path: '/docs/a', page: 'Threads', heading: '', anchor: '', text: 'Pins live in the Highlights rail.' },
    { path: '/docs/b', page: 'Highlights', heading: 'Pins', anchor: 'pins', text: 'A pin keeps a file to hand.' },
    { path: '/docs/c', page: 'Other', heading: 'Unrelated', anchor: 'unrelated', text: 'Nothing here.' },
  ];
  assert.deepEqual(search(sample, 'pins').map((r: any) => r.entry.path), ['/docs/b', '/docs/a']);
  assert.deepEqual(search(sample, 'pins rail').map((r: any) => r.entry.path), ['/docs/a']);
  assert.deepEqual(search(sample, '   '), []);
  assert.deepEqual(search(sample, 'zzz'), []);
});

test('the real guide finds what Wayne asked about', () => {
  for (const [query, path] of [['patches', '/docs/patches'], ['schedule', '/docs/schedules'], ['projects', '/docs/projects']]) {
    const top = search(entries, query).slice(0, 3).map((r: any) => r.entry.path);
    assert.ok(top.includes(path), `${query}: ${top.join(', ')}`);
  }
});

test('the snippet is cut around the match, at word gaps, and marks the words', () => {
  const text = `${'lead '.repeat(40)}the needle is here ${'tail '.repeat(40)}`.trim();
  const cut = snippet(text, text.indexOf('needle'));
  assert.ok(cut.startsWith('…') && cut.endsWith('…') && cut.includes('needle'), cut);
  assert.doesNotMatch(cut, /…\S*ea\b|…ad\b/);
  assert.deepEqual(parts('Pin the pin', 'pin'), [['Pin', true], [' the ', false], ['pin', true]]);
});

test('a result links to its heading, with the matched words as a text fragment', () => {
  const entry = { path: '/docs/x', page: 'X', heading: 'Y', anchor: 'y', text: 'Run tb-land, then wait. More words here.' };
  assert.equal(href(entry, entry.text.indexOf('land')), '/docs/x#y:~:text=tb%2Dland%2C%20then%20wait');
  assert.equal(href(entry, -1), '/docs/x#y');
  assert.equal(href({ ...entry, anchor: '' }, 0), '/docs/x#:~:text=Run%20tb%2Dland%2C%20then%20wait');
});

test('the page is told which time the matched word comes up, to scroll to that one', () => {
  const text = 'A pin, then Pins, then the pin we want.';
  assert.deepEqual(nth(text, text.lastIndexOf('pin')), { word: 'pin', count: 2 });
  assert.deepEqual(nth(text, 0), { word: 'a', count: 0 });
});
