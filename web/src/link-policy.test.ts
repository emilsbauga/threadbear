// node --test web/src/link-policy.test.ts
// What a link from a thread may become on the website (link-policy.ts,
// Daybreak finding 139): a web page opens, another app's link asks first,
// and what isn't an address is its words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLink } from './link-policy.ts';

const BASE = 'https://threadbear.example/t/abc';

test('a web page with a host opens as a link', () => {
  for (const href of ['https://docs.example.com/a?b=1#c', 'http://localhost:3000/', 'HTTPS://Example.com']) assert.equal(classifyLink(href, BASE).kind, 'web', href);
  // This site's own pages, and a protocol-relative address, are web pages too.
  assert.deepEqual(classifyLink('/t/xyz', BASE), { kind: 'web', url: 'https://threadbear.example/t/xyz' });
  assert.deepEqual(classifyLink('//other.example/x', BASE), { kind: 'web', url: 'https://other.example/x' });
});

test("another app's link asks first, naming its whole address", () => {
  for (const [href, scheme] of [
    ['mailto:boss@example.com?subject=Resign&body=I%20quit', 'mailto'],
    ['slack://open?team=T0&id=C0', 'slack'],
    ['intent://scan/#Intent;scheme=zxing;package=com.example;end', 'intent'],
    ['x-apple.systempreferences:com.apple.preference.security', 'x-apple.systempreferences'],
    ['tel:+15555550100', 'tel'],
    ['threadbear://pair?token=x', 'threadbear'],
  ]) {
    const got = classifyLink(href, BASE);
    assert.equal(got.kind, 'ask', href);
    assert.equal(got.kind === 'ask' && got.scheme, scheme);
    assert.equal(got.kind === 'ask' && got.url, href);
  }
});

test('what runs in the page or reads files is never a link', () => {
  for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', 'blob:https://threadbear.example/1', 'about:blank', 'view-source:https://x.example', 'https://', '']) {
    assert.equal(classifyLink(href, BASE).kind, 'never', JSON.stringify(href));
  }
});

test("an address too long to show whole isn't a link", () => {
  assert.equal(classifyLink('https://example.com/' + 'a'.repeat(3000), BASE).kind, 'never');
  assert.equal(classifyLink('slack://open?x=' + 'a'.repeat(3000), BASE).kind, 'never');
});
