// The thread a held Codex version starts (manager.ts heldBack), so the
// Updates panel says it's being looked into rather than leaving Mike with an
// orange line, "Update anyway" and no way to tell whether that's safe.
//
// Mike, 20 Nov 2026, on 0.171.0 held for "server request currentTime/read":
// "It shouldn't kind of just leave me in the lurch like this." That one was
// harmless (Codex stopped asking the client for the time), and the fix was a
// line in surface.ts; the runner checks a held version again once per start,
// so landing that line is what installs it.
import path from 'node:path';

export type HeldBack = { version: string; current?: string; missing: string[]; added: string[] };

export function heldBackTitle(h: HeldBack): string {
  return `Codex ${h.version} held back: is the protocol change safe?`;
}

export function heldBackBrief(h: HeldBack, home: string): string {
  const tools = path.join(home, 'tools', 'codex');
  const binary = (v: string) => `node "${path.join(tools, v, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')}"`;
  const added = h.added.length ? `\n\nIt also has these that the runner doesn't know (they don't hold anything back): ${h.added.join(', ')}.` : '';
  const diff = h.current
    ? `Both versions are kept: ${binary(h.current)} (the one running) and ${binary(h.version)}. \`<codex> app-server generate-ts --experimental --out <dir>\` writes each one's protocol offline, and comparing the two folders shows what changed.`
    : `${binary(h.version)} is kept; \`<codex> app-server generate-ts --experimental --out <dir>\` writes its protocol offline.`;
  return `Threadbear's update check held Codex ${h.version} back${h.current ? ` and kept ${h.current} running` : ''}: its app-server protocol no longer has ${h.missing.join(', ')}, which the runner's list in runner/src/adapters/codex/surface.ts says it relies on.${added}

Threadbear started this thread in the background so I'm not left to guess whether "Update anyway" is safe. The Updates panel shows it as being looked into, with a link here.

1. ${diff} Read Codex's notes for it too: https://github.com/openai/codex/releases/tag/rust-v${h.version}
2. For each missing item, find what the runner did with it (runner/src/adapters/codex/: approvals.ts, normalize.ts, adapter.ts) and what, if anything, replaced it. Say plainly whether anything I use stops working.
3. Nothing lost (Codex just stopped sending something the runner only answered, say): take it off the required lists in surface.ts with a line on why, keeping any handling older versions still need. Something lost: adapt the adapter to the new protocol, keeping the running version working, with a test.
4. Land it on main the usual way (AGENTS.md). The runner restarts on main, puts the held version through the check again, and installs it by itself once nothing is missing. Watch \`tb status\` until the runner is on your commit, then "${path.join(tools, 'state.json')}" until its current says ${h.version} (a restarted runner checks within a minute).
5. Once it's on ${h.version}, call end_turn with needs "nothing" and archive: true, with a two-line summary of what changed and whether it mattered. Only leave it for me if it needs my decision (a feature Codex took away that I'd notice), or it still fails after a real attempt.`;
}
