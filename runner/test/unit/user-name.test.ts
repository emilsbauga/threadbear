import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstName, USER_NAME, userLine } from '../../src/user-name.ts';
import { buildThreadbearTools, FILING_PROJECTS, patchesLine, SHOWING_THE_USER } from '../../src/threadbear-mcp.ts';
import { ALREADY_ENDED, ARCHIVE_ADDED, SNOOZE_ADDED, CODEX_END_TURN_DESCRIPTION, END_TURN_DESCRIPTION, endTurnDescription, NARRATION_ONLY, NO_REPLY, tryFirstNudge, plainCardNudge } from '../../src/needs.ts';
import { dynamicToolSpecs, NAMESPACE_DESCRIPTION, TOOL_GUIDANCE } from '../../src/adapters/codex/tools.ts';
import { SYSTEM } from '../../src/librarian.ts';
import { EXPLAIN_SYSTEM } from '../../src/explain.ts';
import { WAKE_SYSTEM } from '../../src/wake-when.ts';
import { WROTE_INSTEAD } from '../../src/runner.ts';
import { makeHarness } from '../helpers/fakes.ts';

test('the user line is the first word of the account name, or nothing', () => {
  assert.equal(firstName('Mike Cann\n'), 'Mike');
  assert.equal(firstName('  '), undefined);
  assert.equal(userLine('Sam'), 'The user is Sam. ');
  assert.equal(userLine(''), '');
});

// Threadbear runs on other people's Macs too, so what an agent or a
// background model reads says "the user", and only userLine names them.
// This caught the 56 "Mike"s that were there until 30 Oct.
test('nothing an agent reads names Mike, apart from the user line', () => {
  const named = USER_NAME ? userLine() : '';
  const strip = (s: string) => (named ? s.split(named).join('') : s);
  const h = makeHarness();
  // Codex's, as only those have a schema to write out (Claude's end_turn is
  // listed by its MCP server); Claude's own descriptions are checked below.
  const tools = buildThreadbearTools(h.runner, 'self', Date.now, undefined, undefined, undefined, { provider: 'codex' });
  const claude = [false, true].flatMap((oneReply) => buildThreadbearTools(h.runner, 'self', Date.now, undefined, undefined, undefined, { oneReply: () => oneReply }).map((t) => t.description));
  const texts: [string, string][] = [
    ['SHOWING_THE_USER', SHOWING_THE_USER],
    ['FILING_PROJECTS', FILING_PROJECTS],
    ['patchesLine', patchesLine('/x/docs/guide.md', () => true)],
    ['END_TURN_DESCRIPTION', END_TURN_DESCRIPTION],
    ['CODEX_END_TURN_DESCRIPTION', CODEX_END_TURN_DESCRIPTION],
    ['message end_turn', endTurnDescription('claude', false)],
    ['message Codex end_turn', endTurnDescription('codex', false)],
    ['ALREADY_ENDED', ALREADY_ENDED],
    ['ARCHIVE_ADDED', ARCHIVE_ADDED],
    ['SNOOZE_ADDED', SNOOZE_ADDED],
    ['NARRATION_ONLY', NARRATION_ONLY],
    ['NO_REPLY', NO_REPLY],
    ['tryFirstNudge', tryFirstNudge()],
    ['plainCardNudge', plainCardNudge()],
    ['NAMESPACE_DESCRIPTION', NAMESPACE_DESCRIPTION],
    ['TOOL_GUIDANCE', TOOL_GUIDANCE],
    ['librarian SYSTEM', SYSTEM],
    ['EXPLAIN_SYSTEM', [EXPLAIN_SYSTEM].flat().join('\n')],
    ['WAKE_SYSTEM', [WAKE_SYSTEM].flat().join('\n')],
    ['WROTE_INSTEAD', WROTE_INSTEAD],
    // Every tool's description and its arguments', nested ones too.
    ['tools', JSON.stringify(dynamicToolSpecs(tools))],
    ['Claude tools', claude.join('\n')],
  ];
  for (const [name, text] of texts) assert.doesNotMatch(strip(text), /\bMike\b/, name);
});
