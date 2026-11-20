// The What's new page's cards for a fork's Updates panel (src/changelog.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANGELOG_SITES, changelogFor, readFeed } from '../../src/changelog.ts';
import { commit, git, signedTag, upstreamFor, world } from '../helpers/upstream-harness.ts';

const SITE = 'https://threadbear.mikecann.app';

const feed = {
  releases: [
    {
      release: '2026-11-16',
      highlights: [{ kind: 'changed', title: 'Pick who reviews code', text: 'Settings lists them in order.', media: { type: 'image', src: 'code-reviewers.webp' } }],
      added: 1,
      changed: 3,
      fixed: 6,
    },
    {
      release: '2026-11-14',
      highlights: [
        { kind: 'added', title: 'Open Anything', text: 'Press it and type.', media: { type: 'clip', src: 'open-anything.mp4', poster: 'open-anything.webp' } },
        // Each of these is left out, and only it.
        { kind: 'removed', title: 'A kind there is no such thing as', text: 'x', media: { type: 'image', src: 'a.webp' } },
        { kind: 'added', title: 'A picture outside its folder', text: 'x', media: { type: 'image', src: '../../evil.webp' } },
        { kind: 'added', title: 'A clip as its own picture', text: 'x', media: { type: 'clip', src: 'a.mp4', poster: 'a.mp4' } },
        { kind: 'added', title: 'Elsewhere', text: 'x', media: { type: 'image', src: 'https://evil.example/a.webp' } },
        { kind: 'added', title: '', text: 'x', media: { type: 'image', src: 'a.webp' } },
        { kind: 'added', title: 'x'.repeat(121), text: 'x', media: { type: 'image', src: 'a.webp' } },
      ],
      added: 4,
      changed: -2,
      fixed: 'seven',
    },
    { release: '2026-11-12', highlights: [], added: 2, changed: 0, fixed: 0 },
  ],
};

test("readFeed: the releases asked for, in their order, each card checked and pointed at the site's own files", () => {
  const got = readFeed(SITE, feed, ['release/2026-11-16', 'release/2026-11-15', 'release/2026-11-14']);
  assert.deepEqual(got, {
    page: `${SITE}/changelog`,
    releases: [
      {
        tag: 'release/2026-11-16',
        link: `${SITE}/changelog#2026-11-16`,
        highlights: [{ kind: 'changed', title: 'Pick who reviews code', text: 'Settings lists them in order.', picture: `${SITE}/media/changelog/2026-11-16/code-reviewers.webp` }],
        added: 1,
        changed: 3,
        fixed: 6,
      },
      // 15 Nov has no entry (yet), so it isn't here and the panel shows its notes.
      {
        tag: 'release/2026-11-14',
        link: `${SITE}/changelog#2026-11-14`,
        highlights: [{ kind: 'added', title: 'Open Anything', text: 'Press it and type.', picture: `${SITE}/media/changelog/2026-11-14/open-anything.webp`, clip: true }],
        added: 4,
        changed: 0,
        fixed: 0,
      },
    ],
  });
});

test('readFeed: nothing for a feed that has none of them, or that is not a feed', () => {
  assert.equal(readFeed(SITE, feed, ['release/2026-11-15']), undefined);
  for (const bad of [null, 'x', {}, { releases: 'x' }, { releases: [{ release: '../x' }] }]) assert.equal(readFeed(SITE, bad, ['release/2026-11-16']), undefined);
});

test("changelogFor: only Mike's repo has a page; anyone else's releases keep their notes", async () => {
  let asked = '';
  const get = async (site: string) => {
    asked = site;
    return feed;
  };
  assert.equal(CHANGELOG_SITES['github.com/mikecann/threadbear'], SITE);
  assert.equal((await changelogFor('github.com/mikecann/threadbear', ['release/2026-11-16'], get))?.releases.length, 1);
  assert.equal(asked, SITE);
  asked = '';
  assert.equal(await changelogFor('github.com/someone/threadbear', ['release/2026-11-16'], get), undefined);
  assert.equal(asked, '');
});

test("a fork's available release carries the page's cards for the releases main doesn't have, and a page that can't be read changes nothing else", async () => {
  const w = world();
  commit(w.mike, 'b.txt', 'Second');
  signedTag(w.mike, 'release/2026-10-30', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');

  const asked: string[][] = [];
  const cards = { page: `${SITE}/changelog`, releases: [{ tag: 'release/2026-10-30', link: `${SITE}/changelog#2026-10-30`, highlights: [], added: 1, changed: 0, fixed: 0 }] };
  let s = await upstreamFor(w.theirs, w.home, undefined, {
    changelog: async (_key: string, tags: string[]) => {
      asked.push(tags);
      return cards;
    },
  }).check();
  assert.equal(s.state, 'available');
  assert.deepEqual(s.release?.changelog, cards);
  assert.deepEqual(asked, [['release/2026-10-30']]);

  s = await upstreamFor(w.theirs, w.home, undefined, {
    changelog: async () => {
      throw new Error('offline');
    },
  }).check();
  assert.equal(s.state, 'available');
  assert.equal(s.release?.tag, 'release/2026-10-30');
  assert.equal(s.release?.changelog, undefined);

  // Nothing to bring in, nothing to ask the page.
  git(w.theirs, 'merge', '-q', '--no-edit', 'refs/threadbear/upstream/2026-10-30');
  asked.length = 0;
  s = await upstreamFor(w.theirs, w.home, undefined, { changelog: async (_k: string, tags: string[]) => (asked.push(tags), cards) }).check();
  assert.equal(s.state, 'idle');
  assert.deepEqual(asked, []);
});
