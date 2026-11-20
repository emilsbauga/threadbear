// The website's pages from the address (web/src/route-path.ts). A bad %
// escape used to throw while the app loaded, so it never showed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePath } from './route-path.ts';

test('each page from its address', () => {
  assert.deepEqual(parsePath('/'), { page: 'list' });
  assert.deepEqual(parsePath('/new'), { page: 'new' });
  assert.deepEqual(parsePath('/t/th%201'), { page: 'thread', threadId: 'th 1' });
  assert.deepEqual(parsePath('/s/my-slug/'), { page: 'share', slug: 'my-slug' });
  // A project's page names its runner (Daybreak 141); the id alone, from before, has none.
  assert.deepEqual(parsePath('/projects/laptop000001/p_1'), { page: 'projects', runnerId: 'laptop000001', id: 'p_1' });
  assert.deepEqual(parsePath('/projects/p_1'), { page: 'projects', id: 'p_1' });
  assert.deepEqual(parsePath('/usage'), { page: 'usage' });
});

test('a bad escape is the list, not an error that stops the app loading', () => {
  for (const p of ['/s/%zz', '/t/%E0%A4%A', '/projects/%zz', '/projects/%zz/p', '/projects/r/%zz']) assert.deepEqual(parsePath(p), { page: 'list' }, p);
});

test('/machines is the Machines page, with or without a trailing slash', () => {
  assert.deepEqual(parsePath('/machines'), { page: 'machines' });
  assert.deepEqual(parsePath('/machines/'), { page: 'machines' });
  assert.deepEqual(parsePath('/machines/x'), { page: 'list' });
});
