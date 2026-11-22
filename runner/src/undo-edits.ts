// Putting back the files an agent changed, from the thread's own edit.diff
// events, for an edit of an earlier message (docs/protocol/threads.md, "Editing a
// message") when the CLI has no checkpoints of its own: every Codex thread,
// and Claude sessions from before checkpoints were on.
//
// Each diff is reversed against the file as it is now, newest change
// first. A file is only written once all of its hunks fit; one that has
// changed since in a way a diff doesn't fit (Mike edited it, a shell
// command did) is left exactly as it is and reported, never half undone.
import fs from 'node:fs';
import path from 'node:path';
import type { Hunk, PersistedEvent, RewoundFiles } from './protocol.ts';

type Change = { itemId: string; path: string; hunks: Hunk[]; seq: number };

// The changes in `events` (already the cut range, in seq order) that
// happened: each item's latest diff per file (a later edit.diff for the
// same item and path replaces it), for items whose tool.result said ok. A
// change with no result yet was cut off before it ran, or can't be told
// apart from one that was.
export function appliedChanges(events: PersistedEvent[]): Change[] {
  const ok = new Set<string>();
  for (const e of events) if (e.type === 'tool.result' && e.ok) ok.add(e.itemId);
  const byKey = new Map<string, Change>();
  for (const e of events) {
    if (e.type !== 'edit.diff' || !ok.has(e.itemId)) continue;
    const key = `${e.itemId}\u0000${e.path}`;
    const had = byKey.get(key);
    byKey.set(key, { itemId: e.itemId, path: e.path, hunks: e.hunks, seq: had?.seq ?? e.seq });
  }
  return [...byKey.values()].sort((a, b) => a.seq - b.seq);
}

// Reverses the changes, newest first. Paths are resolved against cwd.
export function undoChanges(changes: Change[], cwd: string): Omit<RewoundFiles, 'how'> {
  const undone: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  // Several changes to one file are undone together, so a file is either
  // put all the way back or left alone.
  const byFile = new Map<string, Change[]>();
  for (const c of changes) {
    const file = path.resolve(cwd, c.path);
    byFile.set(file, [...(byFile.get(file) ?? []), c]);
  }
  for (const [file, list] of byFile) {
    try {
      const r = undoFile(file, [...list].sort((a, b) => b.seq - a.seq));
      if ('reason' in r) failed.push({ path: file, reason: r.reason });
      else undone.push(file);
    } catch (e) {
      failed.push({ path: file, reason: (e as Error).message });
    }
  }
  return { undone, failed };
}

type FileState = { exists: boolean; lines: string[]; trailingNewline: boolean };

function undoFile(file: string, newestFirst: Change[]): { ok: true } | { reason: string } {
  let state = read(file);
  for (const c of newestFirst) {
    const next = reverse(state, c.hunks);
    if (!next) return { reason: "It has changed since, so the agent's edit no longer fits. Left as it is." };
    state = next;
  }
  if (!state.exists) {
    if (fs.existsSync(file)) fs.rmSync(file);
    return { ok: true };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, state.lines.join('\n') + (state.trailingNewline && state.lines.length ? '\n' : ''));
  return { ok: true };
}

function read(file: string): FileState {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { exists: false, lines: [], trailingNewline: true };
  }
  if (text === '') return { exists: true, lines: [], trailingNewline: true };
  const trailingNewline = text.endsWith('\n');
  const lines = (trailingNewline ? text.slice(0, -1) : text).split('\n');
  return { exists: true, lines, trailingNewline };
}

// The file before one change, from the file after it. Null when the
// change's new lines aren't where they should be (or anywhere).
export function reverse(state: FileState, hunks: Hunk[]): FileState | null {
  const olds = hunks.map((h) => h.lines.filter((l) => !l.startsWith('+')).map((l) => l.slice(1)));
  const news = hunks.map((h) => h.lines.filter((l) => !l.startsWith('-')).map((l) => l.slice(1)));
  const created = hunks.length > 0 && hunks.every((h, i) => h.oldLines === 0 && olds[i].length === 0);
  const deleted = hunks.length > 0 && hunks.every((h, i) => h.newLines === 0 && news[i].length === 0);
  if (deleted) {
    // The change deleted the file (or emptied it): make it again, unless
    // something else is in it now.
    if (state.exists && state.lines.length) return null;
    return { exists: true, lines: olds.flat(), trailingNewline: true };
  }
  if (!state.exists) return null;
  if (created && hunks.length === 1 && same(state.lines, news[0])) {
    // The change made the file, and it still holds just what was written.
    return { exists: false, lines: [], trailingNewline: true };
  }
  let lines = [...state.lines];
  // Bottom up, so an earlier hunk's place isn't moved by a later one.
  for (let i = hunks.length - 1; i >= 0; i--) {
    const at = find(lines, news[i], Math.max(0, hunks[i].newStart - 1));
    if (at < 0) return null;
    lines = [...lines.slice(0, at), ...olds[i], ...lines.slice(at + news[i].length)];
  }
  return { exists: true, lines, trailingNewline: state.trailingNewline };
}

// Where `block` sits in `lines`: at `near` if it's there, else the nearest
// place it is. An empty block sits at `near`.
function find(lines: string[], block: string[], near: number): number {
  if (block.length === 0) return Math.min(near, lines.length);
  const fits = (at: number) => at >= 0 && at + block.length <= lines.length && block.every((l, j) => lines[at + j] === l);
  for (let d = 0; d <= lines.length; d++) {
    if (fits(near - d)) return near - d;
    if (fits(near + d)) return near + d;
  }
  return -1;
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}
