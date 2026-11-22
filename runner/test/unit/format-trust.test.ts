// What tb land will run from a branch's .git-blame-ignore-revs (Codex
// Security finding 151, 21 Nov 2026): a format command only main's own list
// has, byte for byte, with config main has, and never over a tree that
// brings its own toolchain. Each test's command leaves a marker file where it
// would run, so "not run" is checked on disk. Real git in temp repos, as
// format-tool.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, commit, makeBranch, makeRepo, sh } from '../helpers/worktrees-harness.ts';
import { land } from '../../src/worktrees.ts';
import { crossings, remakeOwn, TreeFormatter } from '../../src/format-replay.ts';

const SCRIPT = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'split-protocol.mjs'), 'utf8');
const SUBJECT = 'Split docs/protocol.md into a file per area, moving text only';
const entry = (command: string, subject = SUBJECT) => `# format-subject: ${subject}\n# format-tool: ${command}\n# format-paths: docs/protocol.md docs/protocol\n# format-config: scripts/split-protocol.mjs\n`;
const TRUSTED = entry('node scripts/split-protocol.mjs');
const DOC = ['# Runner protocol (v1)', '', 'Intro.', '', '## Auth', '', 'A token.', '', '## Needs you', '', 'The card.', '', '## Patches', '', 'A patch file.', ''].join('\n');

// A main with the split script, and the list as given (none by default:
// the branch is the first to bring a tool in).
function setup(list?: string) {
  const { root, main } = makeRepo();
  commit(main, { 'docs/protocol.md': DOC, 'scripts/split-protocol.mjs': SCRIPT, ...(list ? { '.git-blame-ignore-revs': list } : {}) }, 'Protocol and the script');
  const marker = path.join(root, 'ran');
  return { main, marker };
}

// The branch's tool commit: the real split, made by hand, with the list as
// the branch writes it.
function splitOn(dir: string, list: string, subject = SUBJECT) {
  fs.writeFileSync(path.join(dir, '.git-blame-ignore-revs'), list);
  sh(dir, 'git add .git-blame-ignore-revs && (git diff --cached --quiet || git commit -qm "List the split")');
  sh(dir, 'node scripts/split-protocol.mjs');
  sh(dir, `git add -A docs && git commit -qm "${subject}"`);
}

const mainMoves = (main: string) => commit(main, { 'docs/protocol.md': DOC.replace('A patch file.', 'A patch file, on main.') }, 'Main edits patches');

test('a branch that adds a format command main has never listed: tb land stops and runs nothing', async () => {
  const { main, marker } = setup();
  const t = makeBranch(main);
  splitOn(t.path, entry(`touch ${marker}; node scripts/split-protocol.mjs`));
  mainMoves(main);
  const before = sh(main, 'git rev-parse main');
  const r = await remakeOwn(main, 'main', t.branch);
  assert.ok(r && !r.ok && 'untrusted' in r, JSON.stringify(r));
  assert.equal(r.untrusted[0].why, 'unlisted');
  assert.ok(r.untrusted[0].command.includes(marker));
  const c = capture();
  assert.notEqual(await land(t, c.opts), 0);
  assert.equal(fs.existsSync(marker), false, 'the branch\'s command ran');
  assert.match(c.err.join('\n'), /doesn't list, so it wasn't run here and nothing landed/);
  assert.ok(c.err.join('\n').includes(JSON.stringify(`touch ${marker}; node scripts/split-protocol.mjs`)), 'the whole command is shown');
  assert.equal(sh(main, 'git rev-parse main'), before);
});

test('a branch that changes the command of an entry main does list is stopped the same way', async () => {
  const { main, marker } = setup(TRUSTED);
  const t = makeBranch(main);
  splitOn(t.path, entry(`node scripts/split-protocol.mjs && touch ${marker}`));
  mainMoves(main);
  const c = capture();
  assert.notEqual(await land(t, c.opts), 0);
  assert.equal(fs.existsSync(marker), false);
  // And its paths or config count as much as its command.
  const t2 = makeBranch(main, 'paths123');
  splitOn(t2.path, TRUSTED.replace('docs/protocol.md docs/protocol', 'docs'));
  commit(main, { 'docs/protocol.md': DOC.replace('The card.', 'The card, on main.') }, 'Main edits the card');
  const r = await remakeOwn(main, 'main', t2.branch);
  assert.ok(r && !r.ok && 'untrusted' in r, JSON.stringify(r));
});

test('main\'s exact command with a config script the branch changed first is never run', async () => {
  const { main, marker } = setup(TRUSTED);
  const t = makeBranch(main);
  commit(t.path, { 'scripts/split-protocol.mjs': `import * as markIt from 'node:fs';\nmarkIt.writeFileSync(${JSON.stringify(marker)}, '');\n${SCRIPT.replace(/^#!.*\n/, "")}` }, 'Tweak the script');
  splitOn(t.path, TRUSTED);
  fs.rmSync(marker, { force: true });
  mainMoves(main);
  const r = await remakeOwn(main, 'main', t.branch);
  assert.ok(r && !r.ok && 'untrusted' in r, JSON.stringify(r));
  assert.equal(r.untrusted[0].why, 'config');
  const c = capture();
  assert.notEqual(await land(t, c.opts), 0);
  assert.equal(fs.existsSync(marker), false);
});

test('main\'s exact recipe is still made again on a main that moved on', async () => {
  const { main } = setup(TRUSTED);
  const t = makeBranch(main);
  splitOn(t.path, TRUSTED);
  mainMoves(main);
  const c = capture();
  assert.equal(await land(t, c.opts), 0, c.err.join('\n'));
  assert.match(c.out.join('\n'), /Made .* again on main/);
  assert.match(sh(main, 'git show main:docs/protocol/patches.md'), /A patch file, on main\./);
});

test('an unlisted tool commit already made on main as it is runs nothing, and lands only once its command is asked for by id', async () => {
  const { main, marker } = setup();
  mainMoves(main);
  const t = makeBranch(main);
  const command = `touch ${marker}; node scripts/split-protocol.mjs`;
  splitOn(t.path, entry(command));
  assert.equal(await remakeOwn(main, 'main', t.branch), undefined);
  // Landing it would make the command main's, run by later landings
  // (Gemini's review): shown, and refused without its id.
  const before = sh(main, 'git rev-parse main');
  const c = capture();
  assert.notEqual(await land(t, c.opts), 0);
  const said = c.err.join('\n');
  assert.ok(said.includes(JSON.stringify(command)), said);
  const id = /--allow-format ([0-9a-f]{12})/.exec(said)?.[1];
  assert.ok(id, said);
  assert.equal(sh(main, 'git rev-parse main'), before);
  const wrong = capture();
  assert.notEqual(await land(t, { ...wrong.opts, allowFormat: '000000000000' }), 0);
  const ok = capture();
  assert.equal(await land(t, { ...ok.opts, allowFormat: id }), 0, ok.err.join('\n'));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(sh(main, 'git log --format=%s -1'), SUBJECT);
});

test('a branch that only adds a list entry for a commit already on main is asked about too', async () => {
  const { main } = setup(TRUSTED);
  const t = makeBranch(main);
  commit(t.path, { '.git-blame-ignore-revs': TRUSTED + `\n# format-subject: Protocol and the script\n# format-command: touch /tmp/x\n# format-paths: docs\n` }, 'List an old commit');
  const c = capture();
  assert.notEqual(await land(t, c.opts), 0);
  assert.match(c.err.join('\n'), /changes what later tb lands run/);
  // Nor can it name another commit for a recipe main trusts: a new subject,
  // or an id changed (Gemini's third review).
  const t3 = makeBranch(main, 'subject1');
  commit(t3.path, { '.git-blame-ignore-revs': TRUSTED + entry('node scripts/split-protocol.mjs', 'Refresh protocol index') }, 'Same recipe, new subject');
  const c3 = capture();
  assert.notEqual(await land(t3, c3.opts), 0);
  const t4 = makeBranch(main, 'idmoved1');
  commit(t4.path, { '.git-blame-ignore-revs': TRUSTED + 'a'.repeat(40) + '\n' }, 'Fill in an id');
  const c4 = capture();
  assert.equal(await land(t4, c4.opts), 0, c4.err.join('\n'));
  const t5 = makeBranch(main, 'idmoved2');
  commit(t5.path, { '.git-blame-ignore-revs': TRUSTED + 'b'.repeat(40) + '\n' }, 'Move the id');
  const c5 = capture();
  assert.notEqual(await land(t5, c5.opts), 0);
  // A list change that adds no command (a comment, an id filled in) isn't.
  const t2 = makeBranch(main, 'comment1');
  commit(t2.path, { '.git-blame-ignore-revs': '# A comment\n' + TRUSTED }, 'Comment');
  const c2 = capture();
  assert.equal(await land(t2, c2.opts), 0, c2.err.join('\n'));
});

test('a branch that changes a format tool\'s own script lands only once that\'s asked for by id, with every name shown escaped', async () => {
  const { main } = setup(TRUSTED);
  const t = makeBranch(main);
  commit(t.path, { 'scripts/split-protocol.mjs': SCRIPT + '\n// changed\n' }, 'Change the script');
  const c = capture();
  assert.notEqual(await land(t, c.opts), 0);
  const said = c.err.join('\n');
  assert.match(said, /config file "scripts\/split-protocol\.mjs" changed/);
  const id = /--allow-format ([0-9a-f]{12})/.exec(said)![1];
  // An id for other contents doesn't do.
  commit(t.path, { 'scripts/split-protocol.mjs': SCRIPT + '\n// changed again\n' }, 'Again');
  const c2 = capture();
  assert.notEqual(await land(t, { ...c2.opts, allowFormat: id }), 0);
  const id2 = /--allow-format ([0-9a-f]{12})/.exec(c2.err.join('\n'))![1];
  assert.notEqual(id2, id);
  const ok = capture();
  assert.equal(await land(t, { ...ok.opts, allowFormat: id2 }), 0, ok.err.join('\n'));
  // A path with an escape in it is shown as a JSON string, so it can't redraw the line.
  const t2 = makeBranch(main, 'escape12');
  commit(t2.path, { '.git-blame-ignore-revs': TRUSTED + '\n# format-subject: S\n# format-command: true\n# format-paths: docs\u001b[2K\n' }, 'Escape');
  const c3 = capture();
  assert.notEqual(await land(t2, c3.opts), 0);
  assert.ok(!c3.err.join('\n').includes('\u001b'), 'the escape went out raw');
  assert.match(c3.err.join('\n'), /format-command "true" over "docs\\u001b\[2K"/);
});

test('crossing onto a stack never takes a format commit from the waiting branches, even one main lists by subject', async () => {
  const { main, marker } = setup();
  // Main lists a format commit by subject that isn't on main yet.
  commit(main, { '.git-blame-ignore-revs': entry('node scripts/split-protocol.mjs', 'Split later') }, 'List it ahead');
  const p = sh(main, 'git rev-parse HEAD');
  const w = makeBranch(main, 'waiting2');
  commit(w.path, { 'scripts/split-protocol.mjs': `import * as markIt from 'node:fs';\nmarkIt.writeFileSync(${JSON.stringify(marker)}, '');\n${SCRIPT.replace(/^#!.*\n/, '')}` }, 'Script');
  commit(w.path, { 'docs/protocol.md': DOC + 'w\n' }, 'Split later');
  const stacked = sh(w.path, 'git rev-parse HEAD');
  const t = makeBranch(main, 'mine5678');
  commit(t.path, { 'docs/protocol.md': DOC + 'mine\n' }, 'Mine');
  assert.deepEqual(await crossings(main, sh(t.path, 'git rev-parse HEAD'), stacked, p), []);
  assert.equal(fs.existsSync(marker), false);
});

test('crossing onto a stack of waiting branches takes its commands from main\'s list, not theirs', async () => {
  const { main, marker } = setup();
  const p = sh(main, 'git rev-parse HEAD');
  // A waiting branch, not landed, stacked on main: it lists a command and has its commit.
  const w = makeBranch(main, 'waiting1');
  commit(w.path, { '.git-blame-ignore-revs': `# format-subject: Cleanup\n# format-command: touch ${marker}\n# format-paths: docs\n` }, 'List');
  commit(w.path, { 'docs/protocol.md': DOC + 'w\n' }, 'Cleanup');
  const stacked = sh(w.path, 'git rev-parse HEAD');
  const t = makeBranch(main, 'mine1234');
  commit(t.path, { 'docs/protocol.md': DOC + 'mine\n' }, 'Mine');
  const tip = sh(t.path, 'git rev-parse HEAD');
  assert.equal((await crossings(main, tip, stacked)).length, 1, 'as before: the stack\'s own list');
  assert.deepEqual(await crossings(main, tip, stacked, p), []);
  assert.equal(fs.existsSync(marker), false);
});

test('a trusted command isn\'t run over a tree that brings its own toolchain file, cargo config or a link', { skip: process.platform === 'win32' }, async () => {
  for (const [name, add] of [
    ['toolchain', (d: string) => commit(d, { 'docs/protocol/rust-toolchain': '[toolchain]\npath = "./evil"\n' }, 'Toolchain')],
    ['cargo', (d: string) => commit(d, { 'docs/protocol/.cargo/config.toml': '[alias]\nfmt = "run"\n' }, 'Cargo config')],
    ['mise', (d: string) => commit(d, { 'docs/mise.toml': '[env]\n_.source = "./evil.sh"\n' }, 'Mise')],
    // A Mac's disk ignores case, so cargo opens these as .cargo and rust-toolchain.toml (Codex's review).
    ['CARGO', (d: string) => commit(d, { 'docs/protocol/.CARGO/config.toml': '[alias]\nfmt = "run"\n' }, 'Upper cargo')],
    ['TOOLCHAIN', (d: string) => commit(d, { 'docs/RUST-TOOLCHAIN.toml': '[toolchain]\npath = "./evil"\n' }, 'Upper toolchain')],
    // mise's other names (Gemini's review).
    ['misedir', (d: string) => commit(d, { 'docs/mise/config.toml': '[env]\n_.source = "./evil.sh"\n' }, 'Mise dir')],
    ['dotconfig', (d: string) => commit(d, { 'docs/.config/mise.toml': '[env]\n_.source = "./evil.sh"\n' }, 'Dot config')],
    ['rtx', (d: string) => commit(d, { 'docs/.rtx.toml': '[env]\n_.source = "./evil.sh"\n' }, 'Rtx')],
    ['multi', (d: string) => commit(d, { 'docs/mise.dev.local.toml': '[env]\n_.source = "./evil.sh"\n' }, 'Multi')],
    ['link', (d: string) => sh(d, 'mkdir -p docs/protocol && ln -s /tmp docs/protocol/out && git add docs/protocol/out && git commit -qm Link')],
  ] as const) {
    const { main, marker } = setup();
    // A format command on main that leaves a marker, over docs/.
    const list = `# format-subject: Format docs\n# format-command: touch ${marker}\n# format-paths: docs\n`;
    commit(main, { '.git-blame-ignore-revs': list }, 'List');
    const p = sh(main, 'git rev-parse HEAD');
    const t = makeBranch(main, `steer${name.slice(0, 3)}`);
    add(t.path);
    commit(t.path, { 'docs/protocol.md': DOC + 'more\n' }, 'Edit');
    const tip = sh(t.path, 'git rev-parse HEAD');
    commit(main, { 'docs/x.md': 'formatted\n' }, 'Format docs');
    const cross = await crossings(main, tip, 'main');
    assert.equal(cross.length, 1, name);
    // Main's own tree it runs over...
    const f = new TreeFormatter(main, cross);
    await f.format(sh(main, `git rev-parse ${p}^{tree}`));
    assert.equal(fs.existsSync(marker), true, `${name}: the command runs at all`);
    fs.rmSync(marker);
    // ...the branch's, never.
    const out = await f.format(sh(main, `git rev-parse ${tip}^{tree}`));
    assert.equal(fs.existsSync(marker), false, `${name}: ran over the branch's tree`);
    assert.match(out.failed.join(' '), /wasn't run on this tree/, name);
  }
});
