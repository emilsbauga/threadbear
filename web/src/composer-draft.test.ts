// node --test web/src/composer-draft.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFailed, withoutSent } from './composer-draft.ts';

test('a failed message comes back into an empty composer, or above what is there', () => {
  assert.equal(withFailed('', 'First '), 'First');
  assert.equal(withFailed('Second', 'First'), 'First\n\nSecond');
  assert.equal(withFailed('Second', '  '), 'Second');
});

test('two failures in one update both come back', () => {
  assert.equal(withFailed(withFailed('', 'A'), 'B'), 'B\n\nA');
});

test('a send landing takes out only its own words', () => {
  assert.equal(withoutSent('Second', 'Second'), '');
  // The first failed while the second was still sending: it stays.
  assert.equal(withoutSent(withFailed('Second', 'First'), 'Second'), 'First');
  assert.equal(withoutSent('Something else', 'Second'), 'Something else');
});
