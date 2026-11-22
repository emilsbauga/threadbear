// docs/protocol.md, a file per area (scripts/split-protocol.mjs): the split
// moves every line once and rewords nothing, a heading it hasn't seen goes
// with the section before it, and once split the index's table is current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
type Split = {
  split: (text: string) => Map<string, string>;
  plan: (root: string) => Map<string, string>;
  isSplit: (text: string) => boolean;
  headings: (lines: string[]) => { at: number; level: number; name: string }[];
  MAP: Map<string, string | null>;
  FILES: { file: string | null; title?: string; sections: string[] }[];
};
const sp = (await import(pathToFileURL(path.join(ROOT, 'scripts', 'split-protocol.mjs')).href)) as Split;

const lines = (t: string) => t.split(/\r?\n/);

// Every non-blank line of `old` is in exactly one of the outputs, in the
// order it had, once the made-up parts (each file's title and the index's
// table) are left out and links read as they were.
function assertLossless(old: string, out: Map<string, string>): void {
  const unlink = (l: string) =>
    l
      .replace(/\]\((?:\.\.\/protocol\.md|protocol\/[\w-]+\.md|[\w-]+\.md)(#[^)]+)\)/g, ']($1)')
      .replace(/\]\(\.\.\/([^)]+)\)/g, ']($1)');
  const want = lines(old).filter((l) => l.trim());
  const pos = new Map<string, number[]>();
  want.forEach((l, i) => pos.set(l, [...(pos.get(l) ?? []), i]));
  const used = new Set<number>();
  for (const [rel, text] of out) {
    let body = lines(text);
    if (rel === 'docs/protocol.md') {
      const a = body.findIndex((l) => l.startsWith('<!-- sections:'));
      const b = body.indexOf('<!-- /sections -->');
      assert.ok(a >= 0 && b > a, 'the index has its table');
      body = [...body.slice(0, a), ...body.slice(b + 1)];
    } else {
      assert.match(body[0], /^# Runner protocol: /);
      body = body.slice(3);
    }
    let last = -1;
    for (const l of body.filter((x) => x.trim()).map(unlink)) {
      const at = (pos.get(l) ?? []).find((i) => !used.has(i) && i > last);
      assert.ok(at !== undefined, `${rel}: ${JSON.stringify(l.slice(0, 80))} isn't a line of the old file, or is out of order`);
      used.add(at);
      last = at;
    }
  }
  const lost = want.filter((_, i) => !used.has(i));
  assert.deepEqual(lost.slice(0, 5), [], `${lost.length} lines of the old file went nowhere`);
}

const DOC = [
  '# Runner protocol (v1)',
  '',
  'Intro.',
  '',
  '## Auth',
  '',
  'See [Handovers](#handovers) and [machines.md](machines.md).',
  '',
  '```sh',
  '## Not a heading',
  '```',
  '',
  '## Never heard of',
  '',
  'Goes with Auth.',
  '',
  '### Handovers',
  '',
  'Back to [Auth](#auth), [x](https://example.com/a.md), [b](button:x).',
  '',
  '## Older and newer clients',
  '',
  'Either side first; [Auth](#auth).',
  '',
].join('\n');

test('the split moves each line once, a new heading with the one before, links still pointing where they did', () => {
  const out = sp.split(DOC);
  assert.deepEqual([...out.keys()].sort(), ['docs/protocol.md', 'docs/protocol/connection.md', 'docs/protocol/updates.md']);
  assertLossless(DOC, out);
  const conn = out.get('docs/protocol/connection.md')!;
  assert.match(conn, /See \[Handovers\]\(updates\.md#handovers\) and \[machines\.md\]\(\.\.\/machines\.md\)\./);
  assert.match(conn, /```sh\n## Not a heading\n```/);
  assert.match(conn, /## Never heard of\n\nGoes with Auth\.\n$/);
  assert.match(out.get('docs/protocol/updates.md')!, /Back to \[Auth\]\(connection\.md#auth\), \[x\]\(https:\/\/example\.com\/a\.md\), \[b\]\(button:x\)\./);
  const index = out.get('docs/protocol.md')!;
  assert.match(index, /Either side first; \[Auth\]\(protocol\/connection\.md#auth\)\./);
  assert.match(index, /\| \[connection\.md\]\(protocol\/connection\.md\) \| Auth, Never heard of \|/);
  assert.match(index, /\| this page \| Older and newer clients \|/);
});

test('a subheading with a mapped name stays in its section; text before the title stays on top', () => {
  const doc = '<!-- note -->\n\n' + DOC.replace('Goes with Auth.\n', 'Goes with Auth.\n\n#### Handovers\n\nStill Auth.\n');
  const out = sp.split(doc);
  assertLossless(doc, out);
  assert.match(out.get('docs/protocol/connection.md')!, /#### Handovers\n\nStill Auth\./);
  assert.match(out.get('docs/protocol.md')!, /^<!-- note -->\n\n# Runner protocol \(v1\)\n\nIntro\.\n\n<!-- sections:/);
  assert.match(sp.split(DOC.replace('Inline `[x](y.md)` and', '')).get('docs/protocol/connection.md')!, /machines\.md\]\(\.\.\/machines\.md\)/);
});

test('links in code are left alone', () => {
  const doc = DOC.replace('Goes with Auth.', 'Goes with Auth: `[x](y.md)`, fns[0](arg).\n\n```\n[a](b.md)\n```');
  const conn = sp.split(doc).get('docs/protocol/connection.md')!;
  assert.match(conn, /`\[x\]\(y\.md\)`, fns\[0\]\(arg\)\./);
  assert.match(conn, /```\n\[a\]\(b\.md\)\n```/);
});

test('CRLF stays CRLF, and on a tree already split it changes nothing', () => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  const out = sp.split(crlf);
  for (const [rel, text] of out) assert.ok(!/[^\r]\n/.test(text), `${rel} is CRLF throughout`);
  const dir = tmpDir('tb-split-');
  for (const [rel, text] of out) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  assert.deepEqual([...sp.plan(dir).keys()], []);
  // A section added to a file afterwards: only the index's table changes.
  fs.appendFileSync(path.join(dir, 'docs/protocol/updates.md'), '\r\n## Later\r\n\r\nNew.\r\n');
  const again = sp.plan(dir);
  assert.deepEqual([...again.keys()], ['docs/protocol.md']);
  assert.match(again.get('docs/protocol.md')!, /\| \[updates\.md\]\(protocol\/updates\.md\) \| Handovers, Later \|\r\n/);
});

test('every heading of docs/protocol.md has a file, or, once split, the index lists every section', () => {
  const text = fs.readFileSync(path.join(ROOT, 'docs', 'protocol.md'), 'utf8');
  // A conflict over the split resolved by keeping the old single file would
  // undo it quietly: once docs/protocol/ is there, this is the index.
  if (fs.existsSync(path.join(ROOT, 'docs', 'protocol'))) {
    assert.ok(sp.isSplit(text), "docs/protocol.md is the index now: put the edit in its section's file in docs/protocol/ (node scripts/split-protocol.mjs on the old file shows which)");
  }
  if (!sp.isSplit(text)) {
    // The map is what the split commit runs with: a heading missing from it
    // still goes somewhere (with the one before), but say where on purpose.
    const missing = sp.headings(text.split('\n').map((l) => `${l}\n`)).filter((h) => !sp.MAP.has(h.name)).map((h) => h.name);
    assert.deepEqual(missing, [], 'add these to FILES in scripts/split-protocol.mjs');
    assertLossless(text, sp.split(text));
    return;
  }
  const stale = [...sp.plan(ROOT).keys()];
  assert.deepEqual(stale, [], 'the index is out of date: run node scripts/split-protocol.mjs');
});

test('each file the map names is under 1,000 lines once split', () => {
  const text = fs.readFileSync(path.join(ROOT, 'docs', 'protocol.md'), 'utf8');
  const files = sp.isSplit(text)
    ? fs.readdirSync(path.join(ROOT, 'docs', 'protocol')).map((n) => [n, fs.readFileSync(path.join(ROOT, 'docs', 'protocol', n), 'utf8')] as const)
    : [...sp.split(text)].map(([rel, t]) => [rel, t] as const);
  for (const [name, t] of files) assert.ok(lines(t).length < 1000, `${name} has ${lines(t).length} lines: split it by moving sections to another file in FILES`);
});

test('never through a link, and #anchors go to the first heading of the name', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir('tb-split-link-');
  const outside = path.join(tmpDir('tb-split-out-'), 'secret.md');
  fs.writeFileSync(outside, 'not yours\n');
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.symlinkSync(outside, path.join(dir, 'docs', 'protocol.md'));
  assert.throws(() => sp.plan(dir), /is a link/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'not yours\n');
  const doc = DOC.replace('Goes with Auth.', 'Goes with Auth.\n\n### Auth\n\nA second.').replace('Either side first; [Auth](#auth).', 'Either side first; [Auth](#auth), `` `[x](y.md)` ``.');
  const index = sp.split(doc).get('docs/protocol.md')!;
  assert.match(index, /\[Auth\]\(protocol\/connection\.md#auth\), `` `\[x\]\(y\.md\)` ``\./);
});
