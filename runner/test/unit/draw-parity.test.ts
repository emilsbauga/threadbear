// Every kind of thing the desktop app draws in a thread or the inbox says
// whether the iPhone, Android and the website draw it too (src/draw-parity.ts),
// so a card built on the desktop can't quietly never reach the phones: the
// Waiting section, the done card's follow-ups, a decision card's per-answer
// notes, scheduled messages and more each did (34 reports by 21 Nov 2026).
//
// The kinds are read from desktop/core, not listed by hand: a new one there
// fails this test until its row is pasted in, and the failure gives the line.
// Each "yes" is checked too: its sign (the name the platform's code uses for
// it, the wire name unless the row says otherwise) must appear in that
// platform's own code, so a "yes" nobody built fails as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRAWN, FAMILIES, PLATFORMS, pasteLine, signFor, type Platform } from '../../src/draw-parity.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CORE = path.join(ROOT, 'desktop/core/src');
const REGISTRY = 'runner/src/draw-parity.ts';

function read(rel: string): string {
  return fs.readFileSync(path.join(CORE, rel), 'utf8');
}

// The block that starts at the first match of `start`: up to the closing
// brace at that line's indent.
function block(src: string, start: RegExp, where: string): string {
  const m = start.exec(src);
  assert.ok(m, `${where}: couldn't find ${start} (the test reads the desktop's kinds from there; point it at where they moved)`);
  const lineStart = src.lastIndexOf('\n', m.index) + 1;
  const indent = /^\s*/.exec(src.slice(lineStart))![0];
  const end = src.indexOf(`\n${indent}}`, m.index);
  return src.slice(m.index, end === -1 ? undefined : end);
}

function all(src: string, re: RegExp): string[] {
  return [...src.matchAll(re)].map((m) => m[1]!);
}

function variants(src: string, name: string, where: string): string[] {
  const body = block(src, new RegExp(`pub enum ${name}\\b[^{]*\\{`), where);
  return body
    .split('\n')
    .slice(1)
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('#'))
    .map((l) => /^\s+([A-Z]\w*)\s*(?:[,({]|$)/.exec(l)?.[1])
    .filter((v): v is string => !!v);
}

// The wire keys a decoder reads: `string(c, "key")`, `c.get("key")` and friends.
function decodedKeys(body: string): string[] {
  return all(body, /(?:\(c, |\bc\s*\.get\()"(\w+)"/g);
}

// Fields every row carries that are plumbing, not something drawn.
const PLUMBING = new Set(['message.itemId', 'message.text', 'message.message', 'turn.turnId']);

/** Every kind the desktop draws, by family, read from desktop/core. */
function desktopKinds(): string[] {
  const row = read('reducer/row.rs');
  const event = read('reducer/event.rs');
  const sidebar = read('sidebar.rs');
  const kinds: Record<string, string[]> = {
    row: all(block(row, /impl RowKind \{/, 'reducer/row.rs'), /RowKind::\w+ => "(\w+)"/g),
    origin: all(row, /origin\.as_deref\(\) == Some\("(\w+)"\)/g),
    message: decodedKeys(block(event, /impl TextFields \{/, 'reducer/event.rs')),
    ask: decodedKeys(block(block(event, /impl Ask \{/, 'reducer/event.rs'), /pub fn decode\(/, 'reducer/event.rs Ask::decode')),
    // A turn's end: the footer, the needs-you and done cards, and the done
    // card's loose ends (which come on the thread's summary, not the event).
    turn: [...decodedKeys(block(event, /impl TurnCompletion \{/, 'reducer/event.rs')), ...(/pub struct LooseEnds\b/.test(event) ? ['looseEnds'] : [])],
    section: all(read('inbox.rs'), /\("(\w+)", "[A-Z][\w ]*", \w+\)/g),
    status: variants(sidebar, 'RowStatus', 'sidebar.rs'),
    look: all(block(sidebar, /pub struct RowLook \{/, 'sidebar.rs'), /pub (\w+): bool/g),
    block: [...all(read('rich_block.rs'), /RichKind::\w+ => "([a-z]+)"/g), ...all(read('draft_block.rs'), /DraftKind::\w+ => "([a-z]+)"/g)],
    link: all(block(read('reply_links.rs'), /pub fn thread_link\(/, 'reply_links.rs'), /"(\w+)" =>/g),
    mark: variants(read('link_marks.rs'), 'LinkMark', 'link_marks.rs'),
  };
  const out = new Set<string>();
  for (const [family, names] of Object.entries(kinds)) {
    assert.ok(names.length > 0, `found no ${family} kinds in desktop/core: the test's reader for them needs pointing at where they moved`);
    for (const n of names) if (!PLUMBING.has(`${family}.${n}`)) out.add(`${family}.${n}`);
  }
  return [...out];
}

// Each platform's own code (not its tests), as one string per file.
const CODE: Record<Platform, { roots: string[]; ext: RegExp; skip?: RegExp }> = {
  ios: { roots: ['ios/Threadbear', 'ios/ThreadbearKit/Sources/ThreadbearKit'], ext: /\.swift$/ },
  android: { roots: ['android-native/kit/src/main', 'android-native/app/src/main'], ext: /\.kt$/ },
  web: { roots: ['web/src'], ext: /\.tsx?$/, skip: /\.test\.tsx?$/ },
};

function code(p: Platform): string | null {
  const { roots, ext, skip } = CODE[p];
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (ext.test(e.name) && !skip?.test(e.name)) parts.push(fs.readFileSync(f, 'utf8'));
    }
  };
  const there = roots.map((r) => path.join(ROOT, r)).filter((d) => fs.existsSync(d));
  if (there.length === 0) return null;
  there.forEach(walk);
  return parts.join('\n');
}

const hasDesktop = fs.existsSync(CORE);

test('everything the desktop draws has a row saying where else it is drawn, and nothing else does', { skip: !hasDesktop && 'no desktop/ in this copy' }, () => {
  const kinds = desktopKinds();
  const missing = kinds.filter((k) => !(k in DRAWN));
  assert.ok(
    missing.length === 0,
    `The desktop draws ${missing.length === 1 ? 'a kind' : 'kinds'} with no row in ${REGISTRY}. ` +
      `Paste ${missing.length === 1 ? 'this line' : 'these lines'} into DRAWN there, ` +
      `as it is. That's all that's needed; if an app draws it too, you can say 'yes' for it instead, ` +
      `or give the real reason it doesn't, then run \`npm run parity-docs\` in runner/:\n\n` +
      missing.map((k) => `  ${pasteLine(k)}`).join('\n') +
      '\n',
  );
  const gone = Object.keys(DRAWN).filter((k) => !kinds.includes(k));
  assert.deepEqual(gone, [], `The desktop no longer draws these: take their lines out of DRAWN in ${REGISTRY}, then run \`npm run parity-docs\` in runner/`);
});

test('every row says what it is, and every no says why as a sentence', () => {
  for (const [kind, row] of Object.entries(DRAWN)) {
    assert.ok(kind.split('.')[0]! in FAMILIES, `${kind}: its family (before the dot) is one of ${Object.keys(FAMILIES).join(', ')}`);
    assert.ok(row.what.trim(), `${kind}: says what it is`);
    for (const p of PLATFORMS) {
      const w = row[p];
      if (w !== 'yes') assert.ok(w.no.trim().endsWith('.'), `${kind}: ${p}'s no says why, as a sentence ending in a full stop (${REGISTRY})`);
    }
  }
});

for (const p of PLATFORMS) {
  const src = code(p);
  test(`a ${p} yes is drawn by ${p}'s code`, { skip: src === null && `no ${p} code in this copy` }, () => {
    const lies: string[] = [];
    for (const [kind, row] of Object.entries(DRAWN)) {
      if (row[p] !== 'yes') continue;
      const sign = signFor(kind, row, p);
      if (!new RegExp(`\\b${sign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(src!)) lies.push(`  ${kind}: says yes, but "${sign}" isn't in ${CODE[p].roots.join(' or ')}`);
    }
    assert.ok(
      lies.length === 0,
      `In ${REGISTRY}, ${p} says yes to these, but its code doesn't have the name it would use for them:\n${lies.join('\n')}\n\n` +
        `Either build it there, change the row's ${p} to { no: 'why, in plain words.' }, or if ${p} draws it under another name, ` +
        `give the row sign: { ${p}: 'thatName' }.\n`,
    );
  });
}

// docs/parity.md's second table is made from DRAWN with the first: parity.test.ts checks it.
