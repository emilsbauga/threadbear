// node --test web/src/picture-chips.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNotionCard, pastedOf, pictureNumber, remarkPictureChips, splitMarkers } from './picture-chips.ts';

test('markers become links, the words around them stay', () => {
  const pieces = splitMarkers('[Picture 1] like [Picture 12], ok');
  assert.deepEqual(
    pieces.map((p) => p.url ?? p.value),
    ['picture:1', ' like ', 'picture:12', ', ok'],
  );
});

test('only a real marker counts', () => {
  for (const text of ['[picture 1]', '[Picture 0]', '[Picture]', 'Picture 1', '[Picture 1000]']) {
    assert.deepEqual(
      splitMarkers(text).map((p) => p.type),
      ['text'],
      text,
    );
  }
});

test('pictureNumber reads only its own addresses', () => {
  assert.equal(pictureNumber('picture:3'), 3);
  assert.equal(pictureNumber('picture:x'), undefined);
  assert.equal(pictureNumber('https://example.com/picture:3'), undefined);
});

test('code and links keep the marker as typed', () => {
  const tree = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'see [Picture 1]' },
          { type: 'inlineCode', value: '[Picture 2]' },
          { type: 'link', url: 'https://x', children: [{ type: 'text', value: '[Picture 3]' }] },
        ],
      },
      { type: 'code', value: '[Picture 4]' },
    ],
  };
  remarkPictureChips()(tree);
  const para = tree.children[0]!.children!;
  assert.deepEqual(
    para.map((n: { type: string; url?: string }) => n.url ?? n.type),
    ['text', 'picture:1', 'inlineCode', 'https://x'],
  );
  assert.equal(tree.children[1]!.value, '[Picture 4]');
});

test('a message gets its own pasted pictures, and those it does not place go under it', () => {
  const pics = [
    { seq: 5, src: 'picture:1', url: 'a' },
    { seq: 5, src: 'picture:2', url: 'b' },
    { seq: 9, src: 'picture:1', url: 'other message' },
    { seq: 5, src: '/x/shown.png', url: 'an agent picture' },
    { seq: 5, url: 'no src' },
  ];
  const { byNumber, unplaced } = pastedOf(pics, 5, 'this [Picture 1] please');
  assert.deepEqual([...byNumber], [[1, 'a'], [2, 'b']]);
  assert.deepEqual(unplaced.map((p) => p.url), ['b']);
});

test("a Notion card's address is one on Notion's own domains, as the phones read it", () => {
  assert.equal(isNotionCard('https://www.notion.so/1a2b3c4d5e6f40718293a4b5c6d7e8f9'), true);
  assert.equal(isNotionCard('https://mike.notion.site/Board-1a2b'), true);
  assert.equal(isNotionCard('https://notion.so.example.com/x'), false);
  assert.equal(isNotionCard('http://www.notion.so/x'), false);
  assert.equal(isNotionCard('https://example.com/notion.so/x'), false);
});
