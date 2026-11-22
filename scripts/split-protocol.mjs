#!/usr/bin/env node
// docs/protocol.md, a file per area. By 20 Nov 2026 the runner protocol was
// one file of 8,765 lines (about 156k tokens) that every agent was told to
// read and none could. This splits it into docs/protocol/<file>.md, one per
// area, moving each section as it is (only links that point elsewhere change
// to keep working), and leaves docs/protocol.md as the index: what the
// protocol is, the rules for all of it, and which file each section is in.
//
// Run from the top of a checkout, `node scripts/split-protocol.mjs`:
// - On the old single file it splits it. Every section goes to the file its
//   heading is mapped to below; a heading not in the map goes with the
//   section before it, so a branch that added one comes across too.
// - On a tree already split it only remakes the index's table of sections
//   from the files' headings (run it after adding or renaming a section);
//   with nothing to change, it changes nothing. `--check` says whether it
//   would change anything, and exits 1 if so.
//
// It's deterministic and only reads docs/protocol.md and docs/protocol/, as
// the split commit is listed in .git-blame-ignore-revs as a format commit
// (runner/src/format-replay.ts): work made on the single file before it is
// carried across by running this on each of its commits, so its edits land
// in the right new file by themselves. So: node's own modules only, and the
// map below only ever gains headings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INDEX = 'docs/protocol.md';
export const DIR = 'docs/protocol';
const MARK = '<!-- sections: made by scripts/split-protocol.mjs from the headings below and in docs/protocol/; run it again after adding or renaming one -->';
const END = '<!-- /sections -->';

// Each file and the sections that go in it, in the order the single file had
// them. `file: null` stays in the index: the rules that apply everywhere.
export const FILES = [
  { file: null, sections: ['Runner protocol (v1)', 'Ordering and reconnects', 'Older and newer clients'] },
  { file: 'connection', title: 'Connection, auth and requests', sections: ['Auth', 'Requests (app to runner)', 'Warm start', 'Models and effort across providers', 'Notifications (runner to app)'] },
  { file: 'types', title: 'Types', sections: ['Types'] },
  { file: 'events', title: 'Events, design reviews and reply buttons', sections: ['Events', 'Design reviews', 'Reviews on the phone', 'Reply buttons'] },
  { file: 'needs-you', title: 'Needs you: the card a turn ends with', sections: ['Needs you'] },
  {
    file: 'updates',
    title: 'Updates and restarts',
    sections: ['Runner updates', "Mike's releases", 'Your changes to the old app', 'Restarts', 'App restarts', 'Handovers', 'Stopped background work', 'Stuck background jobs', 'Background wait loops', 'Frozen CLIs', "A dialog on a Mac's screen"],
  },
  {
    file: 'settings',
    title: 'Agents, settings and pools',
    sections: ['ACP agents', 'Settings and models', 'Standing instructions', 'Shared memory', 'Explain', 'Hibernate in words', 'Usage history', 'Sandboxed threads (taken out)', 'Pools'],
  },
  {
    file: 'threads',
    title: 'Threads and turns',
    sections: [
      'Pictures in a message',
      'Queued calls',
      'Plan first',
      'Slash commands',
      'Context breakdown',
      'Editing a message',
      'Who started a thread',
      'Who archived a thread',
      'Search',
      'What Mike last asked',
      'What Mike first asked',
      'Loose ends',
      'Nested threads',
      'A quiet inbox',
      'Inbox guess',
      'Secrets',
    ],
  },
  { file: 'patches', title: 'Patches', sections: ['Patches', 'The Convex panel'] },
  { file: 'trust', title: "Trusting a folder's patches and hooks", sections: ["Trusting a folder's patches", "Trusting a folder's Claude Code hooks"] },
  { file: 'panels', title: 'Highlights, panels and connectors', sections: ['Highlights', 'Worktrees', 'Showing panels', 'The Browser panel', 'Pull requests', 'Connectors'] },
  { file: 'projects', title: 'Projects and schedules', sections: ['Projects', 'Project tasks', 'Schedules', 'Recipes'] },
  { file: 'runners', title: "Other runners' threads and sharing", sections: ["Other runners' threads", "Other runners' threads through the backend", 'Asking another runner', 'Sharing'] },
  { file: 'moves', title: 'Moving threads, sync and devices', sections: ['Moving a thread to another runner', 'Sync', 'Devices'] },
  { file: 'keys', title: 'Runner keys and virtual runners', sections: ['Runner keys', 'Virtual runners'] },
  { file: 'boxes', title: 'Boxes', sections: ['Box keys', 'Box mode'] },
  { file: 'tools', title: 'Tools for agents', sections: ['Tools for agents'] },
];

// Heading -> file (null for the index).
export const MAP = new Map(FILES.flatMap((f) => f.sections.map((s) => [s, f.file])));

// The level each mapped heading has (2 unless listed): a heading only moves
// text to its file at that level, so a branch's `### Events` inside another
// section stays in that section.
const LEVEL = new Map([
  ['Runner protocol (v1)', 1],
  ...[
    'Design reviews', 'Reply buttons', 'Warm start', 'Models and effort across providers', "Mike's releases", 'Your changes to the old app', 'App restarts', 'Handovers',
    'Stopped background work', 'Stuck background jobs', 'Background wait loops', 'Frozen CLIs', "A dialog on a Mac's screen", "Trusting a folder's patches",
    "Trusting a folder's Claude Code hooks", 'The Convex panel', 'Worktrees', 'The Browser panel', 'Project tasks', 'Virtual runners', 'Box keys', 'Box mode',
  ].map((n) => [n, 3]),
  ['Reviews on the phone', 4],
]);
export const levelOf = (name) => LEVEL.get(name) ?? 2;

// ------------------------------------------------------------------ lines

// Lines with their own endings, so a file with CRLF stays CRLF.
function lines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const bare = (line) => line.replace(/\r?\n$/, '');

// The headings outside code fences: { at, level, name }.
export function headings(ls) {
  const out = [];
  let fence;
  ls.forEach((l, at) => {
    const s = bare(l);
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(s);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(s)) fence = undefined;
      return;
    }
    if (fence) return;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(s);
    if (h) out.push({ at, level: h[1].length, name: h[2] });
  });
  return out;
}

// GitHub's anchor for a heading.
export function slug(name) {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

// ------------------------------------------------------------------ splitting

const fileOf = (f) => (f === null ? INDEX : `${DIR}/${f}.md`);

// The single file as { relative path -> text }. Every line of it is in
// exactly one of them, as it was but for links: a relative one gets `../`,
// and `(#anchor)` names the file its heading went to.
export function split(text) {
  const ls = lines(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const hs = headings(ls);
  // Sections: from each heading to the next. Anything before the first
  // heading goes with the index.
  const parts = [];
  let file = null;
  if (!hs.length || hs[0].at > 0) parts.push({ file: null, name: undefined, lines: ls.slice(0, hs.length ? hs[0].at : ls.length) });
  hs.forEach((h, i) => {
    if (MAP.has(h.name) && h.level === levelOf(h.name)) file = MAP.get(h.name);
    parts.push({ file, name: h.name, level: h.level, lines: ls.slice(h.at, i + 1 < hs.length ? hs[i + 1].at : ls.length) });
  });
  const where = new Map();
  // `#auth` is the first heading of that name, as GitHub numbers the rest.
  for (const p of parts) if (p.name !== undefined && !where.has(slug(p.name))) where.set(slug(p.name), p.file);
  // Links outside code: not in a fence, nor in backticks on the line.
  const fixAll = (ls, from) => {
    let fence;
    return ls.map((l) => {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(bare(l));
      if (f) {
        if (!fence) fence = f[1];
        else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = undefined;
        return l;
      }
      if (fence) return l;
      // Code spans as CommonMark has them: a run of backticks to the next
      // run of the same length.
      let outText = '';
      let rest = l;
      for (;;) {
        const open = /`+/.exec(rest);
        if (!open) break;
        const close = new RegExp(`(?<!\`)${open[0]}(?!\`)`).exec(rest.slice(open.index + open[0].length));
        if (!close) break;
        const end = open.index + open[0].length + close.index + open[0].length;
        outText += fixLink(rest.slice(0, open.index), from, where) + rest.slice(open.index, end);
        rest = rest.slice(end);
      }
      return outText + fixLink(rest, from, where);
    });
  };

  const out = new Map();
  for (const f of FILES) {
    if (f.file === null) continue;
    const mine = parts.filter((p) => p.file === f.file);
    if (!mine.length) continue;
    const body = trimEnd(fixAll(mine.flatMap((p) => p.lines), f.file), eol);
    out.set(fileOf(f.file), header(f, eol) + body.join(''));
  }
  // The index: what came before the first section and the index's own
  // sections, with the table of where the rest went after the first.
  const own = parts.filter((p) => p.file === null);
  // The top: whatever came before the title, and the title's own part.
  const first = [];
  while (own.length && (own[0].name === undefined || own[0].level === 1) && !first.some((p) => p.level === 1)) first.push(own.shift());
  const top = trimEnd(fixAll(first.flatMap((p) => p.lines), null), eol);
  const rest = trimEnd(fixAll(own.flatMap((p) => p.lines), null), eol);
  const sections = new Map();
  for (const f of FILES) sections.set(f.file, []);
  for (const p of parts) if (p.name !== undefined && p.level > 1) sections.get(p.file).push(p.name);
  const table = tableBlock(sections, eol);
  out.set(INDEX, [...top, eol, table, ...(rest.length ? [eol, ...rest] : [])].join(''));
  return out;
}

function header(f, eol) {
  return `# Runner protocol: ${f.title}${eol}${eol}Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.${eol}${eol}`;
}

// Without blank lines at the end, ending with a line ending.
function trimEnd(ls, eol) {
  const out = [...ls];
  while (out.length && bare(out[out.length - 1]).trim() === '') out.pop();
  if (out.length && !/\n$/.test(out[out.length - 1])) out[out.length - 1] += eol;
  return out;
}

// A link in a line that moved from docs/ to docs/protocol/ (`from` is the
// file it's in now, null for the index).
export function fixLink(line, from, where) {
  return line.replace(/(?<=\[[^\]]*)\]\(([^()\s]+)(\s+"[^"]*")?\)/g, (all, target, title = '') => {
    if (target.startsWith('#')) {
      const to = where.get(target.slice(1));
      if (to === undefined || to === from) return all;
      if (to === null) return `](../protocol.md${target}${title})`;
      return from === null ? `](protocol/${to}.md${target}${title})` : `](${to}.md${target}${title})`;
    }
    if (from === null) return all;
    // Relative paths only: not a URL, a scheme (button:, file:), / or ~.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || /^[/~]/.test(target)) return all;
    // A path: a file with an extension or a folder, not `fns[0](arg)`.
    if (!/(\.[a-z0-9]+(#[^)]*)?|\/)$/i.test(target)) return all;
    return `](../${target}${title})`;
  });
}

// ------------------------------------------------------------------ the index's table

function tableBlock(sections, eol) {
  const rows = [];
  for (const [file, names] of sections) {
    if (!names.length) continue;
    const where = file === null ? 'this page' : `[${file}.md](protocol/${file}.md)`;
    rows.push(`| ${where} | ${names.join(', ')} |`);
  }
  return [
    MARK,
    '## Where each section is',
    '',
    'The rest of the protocol is in docs/protocol/, a file per area. A section is cited by its file and name: `docs/protocol/needs-you.md, "Needs you"`.',
    '',
    'It was all this one file once. Work made on that comes across by itself in `tb land`, each edit into the file its section went to; by hand, scripts/replay-over-format.sh does the same (docs/bringing-in-updates.md says how with an older copy of it). Never keep the old file in a conflict: put the edit in its section\'s file.',
    '',
    '| File | Sections |',
    '| --- | --- |',
    ...rows,
    END,
    '',
  ].join(eol);
}

// The sections of a tree already split, by file, from their headings: the
// index's own first, then the files in the map's order, then any others.
function sectionsNow(root, indexText) {
  const sections = new Map();
  const outside = lines(indexText.replace(blockRe(), ''));
  sections.set(null, headings(outside).filter((h) => h.level > 1).map((h) => h.name));
  const dir = path.join(root, ...DIR.split('/'));
  const known = FILES.map((f) => f.file).filter((f) => f !== null);
  const there = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)) : [];
  const order = [...known.filter((f) => there.includes(f)), ...there.filter((f) => !known.includes(f)).sort()];
  for (const f of order) {
    const ls = lines(fs.readFileSync(path.join(dir, `${f}.md`), 'utf8'));
    sections.set(f, headings(ls).filter((h) => h.level > 1).map((h) => h.name));
  }
  return sections;
}

function blockRe() {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${esc(MARK)}[\\s\\S]*?${esc(END)}\\r?\\n?`);
}

export const isSplit = (indexText) => indexText.includes(MARK);

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the whole tree

// What running it on the tree at `root` would write: { relative path -> text }
// for each file that changes. Nothing for a tree without the protocol.
export function plan(root) {
  // Never through a link: a branch could point one anywhere on the machine
  // that runs this (a landing's temp copy), to read or to write.
  for (const rel of ['docs', INDEX, DIR]) if (isLink(path.join(root, ...rel.split('/')))) throw new Error(`${rel} is a link: not following it`);
  const dirAt = path.join(root, ...DIR.split('/'));
  if (fs.existsSync(dirAt)) for (const n of fs.readdirSync(dirAt)) if (isLink(path.join(dirAt, n))) throw new Error(`${DIR}/${n} is a link: not following it`);
  const index = path.join(root, ...INDEX.split('/'));
  if (!fs.existsSync(index)) return new Map();
  const text = fs.readFileSync(index, 'utf8');
  const splitting = !isSplit(text);
  const want = splitting ? split(text) : new Map([[INDEX, text.replace(blockRe(), () => tableBlock(sectionsNow(root, text), text.includes('\r\n') ? '\r\n' : '\n'))]]);
  // Splitting over files that are there already would write over whatever
  // was in them: refuse, and the crossing leaves that commit as it was.
  if (splitting) {
    const dir = path.join(root, ...DIR.split('/'));
    const there = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')) : [];
    if (there.length) throw new Error(`${DIR}/${there[0]} is there already, beside the single ${INDEX}: not splitting over it`);
  }
  const changes = new Map();
  for (const [rel, body] of want) {
    const p = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== body) changes.set(rel, body);
  }
  return changes;
}

function main(argv) {
  const check = argv.includes('--check');
  const root = argv.find((a) => !a.startsWith('--')) ?? process.cwd();
  let changes;
  try {
    changes = plan(root);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  if (check) {
    for (const rel of changes.keys()) process.stdout.write(`${rel} is out of date: run node scripts/split-protocol.mjs\n`);
    return changes.size ? 1 : 0;
  }
  for (const [rel, body] of changes) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
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
