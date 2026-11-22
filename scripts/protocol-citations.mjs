#!/usr/bin/env node
// Citations of the runner protocol, `docs/protocol/<file>.md, "Section"`,
// across the repo: finding them, checking each names a section that's in
// that file, and pointing the old form at the single file
// (`docs/protocol.md, "Section"`, from before the split by
// scripts/split-protocol.mjs) at the file the section is in now.
//
//   node scripts/protocol-citations.mjs           rewrite the old form
//   node scripts/protocol-citations.mjs --check   list citations that don't resolve
//
// A section is a heading, or a bold label starting a paragraph or a list
// item (`**One reply.**`), as both are cited. runner/test/unit/
// protocol-citations.test.ts runs the check, so a renamed section fails the
// landing that renames it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INDEX = 'docs/protocol.md';
export const DIR = 'docs/protocol';

// Between the file and the name: a comma or colon, spaces, a bracket, or a
// line break into the next line of the same comment.
const LEADER = String.raw`[ \t]*(?:\/\/\/?|#|\*|--|<!--)?[ \t]*`;
const GAP = String.raw`(?:[ \t]+|\r?\n${LEADER})`;
const NAME = String.raw`"((?:[^"\n]|\r?\n${LEADER}){1,120}?)"`;
// `docs/protocol.md` or `docs/protocol/<file>.md` (or without `docs/`),
// maybe in backticks, then `, "Name"`, `: "Name"`, ` ("Name"` or
// `, Heading, "Bold"`.
const CITE = new RegExp(String.raw`((?:docs\/)?protocol(?:\/([a-z0-9-]+))?\.md)(\x60?)([,:]?${GAP}?\(?)(?:([A-Z][\w' ()-]{1,60}?),${GAP})?${NAME}`, 'g');

const squash = (s) => s.replace(new RegExp(String.raw`\r?\n${LEADER}`, 'g'), ' ').replace(/\s+/g, ' ').trim();

// { name -> file } for the sections of the protocol as it is in `root`:
// file is the path of the file the name is a heading or bold label in.
// A name in more than one file is listed under each.
export function sections(root) {
  const out = new Map();
  const add = (name, rel, heading) => {
    out.set(name, [...new Set([...(out.get(name) ?? []), rel])]);
    if (heading) HEADS.add(`${name}\0${rel}`);
  };
  const files = [INDEX];
  const dir = path.join(root, ...DIR.split('/'));
  if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir).sort()) if (n.endsWith('.md')) files.push(`${DIR}/${n}`);
  for (const rel of files) {
    const p = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(p)) continue;
    let fence = false;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (/^ {0,3}(```|~~~)/.test(line)) fence = !fence;
      if (fence) continue;
      const h = /^#{1,6}\s+(.*?)\s*$/.exec(line);
      const b = /^\s*(?:[-*]\s+)?\*\*([^*]+?)\*\*/.exec(line);
      for (const name of [h?.[1], b?.[1].replace(/[.:]$/, '').trim()]) {
        if (!name) continue;
        add(name, rel, name === h?.[1]);
        // `**Before the challenge (old clients).**` is cited without the brackets.
        const bare = name.replace(/\s*\([^)]*\)$/, '');
        if (bare && bare !== name) add(bare, rel, name === h?.[1]);
      }
    }
  }
  return out;
}

// The citations in `text`: { at, end, path, file, name, part } where `file`
// is the cited docs/protocol/<file>.md (undefined for the single file),
// `name` the section (squashed onto one line) and `part` a heading named
// before it (`Projects, "Parts"`).
export function citations(text) {
  const out = [];
  for (const m of text.matchAll(CITE)) {
    out.push({ at: m.index, end: m.index + m[1].length, path: m[1], file: m[2], name: squash(m[6]), part: m[5] });
  }
  return out;
}

// Names that are headings, as `name\0file`: a heading beats a bold label
// of the same name elsewhere (`**Patches.**` in a project's list).
const HEADS = new Set();

// Which file a cited name is in, by the sections map: undefined if it's in
// none, or in several and none of them is the one heading by that name or
// the one `part` names.
export function resolve(map, name, part) {
  const where = map.get(name);
  if (!where?.length) return undefined;
  if (where.length === 1) return where[0];
  const heads = where.filter((w) => HEADS.has(`${name}\0${w}`));
  if (heads.length === 1 && !part) return heads[0];
  const narrowed = part ? where.filter((w) => (map.get(part) ?? []).includes(w)) : [];
  if (narrowed.length === 1) return narrowed[0];
  return heads.length === 1 ? heads[0] : undefined;
}

// The file a citation's name is in: as a section; else as a term in the
// section it names first (`Sync, "quickAsk"`); else the one file with it in
// backticks (`runner.profile`, a method).
export function locate(root, map, name, part) {
  const as = resolve(map, name, part);
  if (as) return as;
  const outer = part ? resolve(map, part) : undefined;
  if (outer && read(root, outer).includes(name)) return outer;
  const files = [...new Set([...map.values()].flat())].filter((rel) => read(root, rel).includes(`\`${name}\``));
  return files.length === 1 ? files[0] : undefined;
}

const cache = new Map();
function read(root, rel) {
  const key = `${root}\0${rel}`;
  if (!cache.has(key)) cache.set(key, fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'));
  return cache.get(key);
}

// `text` with each old-form citation pointing at the file its section is in.
export function rewrite(text, map, root) {
  let out = '';
  let last = 0;
  for (const c of citations(text)) {
    if (c.file !== undefined) continue;
    const to = locate(root, map, c.name, c.part);
    if (!to || to === INDEX) continue;
    const target = c.path.startsWith('docs/') ? to : to.replace(/^docs\//, '');
    out += text.slice(last, c.at) + target;
    last = c.end;
  }
  return out + text.slice(last);
}

// Files that cite it as examples, in their tests of the split itself.
const SELF = ['runner/test/unit/format-tool.test.ts', 'runner/test/unit/protocol-split.test.ts', 'runner/test/unit/protocol-citations.test.ts', 'scripts/protocol-citations.mjs', 'scripts/split-protocol.mjs'];

// Tracked text files that might cite it: not the protocol itself, not
// pictures or lock files, and not the frozen Swift app (scripts/
// swift-freeze.sh: its citations keep the old form, which still reads),
// the finished plans in docs/archive/, which are history, or the
// experiments' table (docs/experiments.md and the files it's made from),
// a row a line, where any rewrite conflicts with a branch adding a row.
export function trackedFiles(root) {
  // Links (ios/ shares the Swift app's files that way) are the file they point at.
  let all;
  try {
    const listed = execFileSync('git', ['-C', root, 'ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
    all = listed.filter((l) => !l.startsWith('120000 ')).map((l) => l.slice(l.indexOf('\t') + 1));
  } catch {
    // A copy without its git folder (a check host's): every file but builds.
    all = walk(root, '');
  }
  const frozen = (f) => f.startsWith('app/') || f.startsWith('dock/') || f.startsWith('docs/archive/') || f === 'docs/experiments.md' || f.startsWith('runner/src/experiments/') || SELF.includes(f);
  return all.filter((f) => f !== INDEX && !f.startsWith(`${DIR}/`) && !frozen(f) && /\.(ts|tsx|mts|mjs|js|cjs|swift|rs|kt|kts|md|sh|json|toml|yml|yaml|feature|html|css|txt)$/.test(f) && !/(^|\/)package-lock\.json$/.test(f));
}



const SKIP = new Set(['.git', 'node_modules', 'target', '.build', 'build', 'dist', 'DerivedData', '.fixtures', '.gradle']);
function walk(root, rel) {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory() && !SKIP.has(e.name)) out.push(...walk(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

// Citations that don't resolve: [{ file, line, cite, why }].
export function check(root) {
  const map = sections(root);
  const bad = [];
  for (const f of trackedFiles(root)) {
    const p = path.join(root, ...f.split('/'));
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    if (!text.includes('protocol')) continue;
    for (const c of citations(text)) {
      const line = text.slice(0, c.at).split('\n').length;
      const cite = `${c.path}, "${c.name}"`;
      if (c.file === undefined) {
        // The old form still reads (the index says where each section
        // went), as branches made before the split carry it.
        if (!map.has(c.name) && !locate(root, map, c.name, c.part)) bad.push({ file: f, line, cite, why: `no section "${c.name}" in the protocol` });
        continue;
      }
      const rel = `${DIR}/${c.file}.md`;
      if (!fs.existsSync(path.join(root, ...rel.split('/')))) bad.push({ file: f, line, cite, why: `there's no ${rel}` });
      else if (!(map.get(c.name) ?? []).includes(rel) && locate(root, map, c.name, c.part) !== rel) {
        const elsewhere = map.get(c.name);
        bad.push({ file: f, line, cite, why: elsewhere ? `"${c.name}" is in ${elsewhere.join(', ')}` : `no section "${c.name}" in ${rel}` });
      }
    }
  }
  return bad;
}

function main(argv) {
  const root = argv.find((a) => !a.startsWith('--')) ?? process.cwd();
  if (argv.includes('--check')) {
    const bad = check(root);
    for (const b of bad) process.stdout.write(`${b.file}:${b.line}: ${b.cite}: ${b.why}\n`);
    return bad.length ? 1 : 0;
  }
  const map = sections(root);
  let n = 0;
  for (const f of trackedFiles(root)) {
    const p = path.join(root, ...f.split('/'));
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    if (!text.includes('protocol.md')) continue;
    const next = rewrite(text, map, root);
    if (next !== text) {
      fs.writeFileSync(p, next);
      n++;
    }
  }
  process.stdout.write(`Rewrote citations in ${n} files.\n`);
  return 0;
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
if (process.argv[1] && real(path.resolve(process.argv[1])) === real(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
