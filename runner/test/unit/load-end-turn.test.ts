// end_turn is listed with anthropic/alwaysLoad, so Claude Code puts it in
// every request rather than behind ToolSearch (a turn always ends with it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/fakes.ts';
import { threadbearMcpServer } from '../../src/adapters/claude/threadbear.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';

function tools(opts: Parameters<typeof buildThreadbearTools>[6]) {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3' });
  return buildThreadbearTools(h.runner, thread.id, Date.now, undefined, undefined, undefined, opts);
}
const meta = (ts: ReturnType<typeof tools>, name: string) => ts.find((t) => t.name === name)?._meta?.['anthropic/alwaysLoad'];

test('end_turn is always loaded and the other tools still wait for ToolSearch', () => {
  const ts = tools({});
  assert.equal(meta(ts, 'end_turn'), true);
  assert.equal(ts.filter((t) => t._meta?.['anthropic/alwaysLoad']).length, 1);
});

test('for Codex, end_turn is listed as before', () => {
  assert.equal(meta(tools({ provider: 'codex' }), 'end_turn'), undefined);
});

test('both forms of end_turn take it (one reply and bullets)', () => {
  assert.equal(meta(tools({ oneReply: () => true }), 'end_turn'), true);
  assert.equal(meta(tools({ oneReply: () => false }), 'end_turn'), true);
});

test('the server the runner builds lists end_turn with it, for Claude Code to read', () => {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3' });
  const server = threadbearMcpServer(h.runner, thread.id, undefined, undefined, undefined, () => true, undefined, () => true);
  const registered = (server.instance as unknown as { _registeredTools: Record<string, { _meta?: Record<string, unknown> }> })._registeredTools.end_turn?._meta?.['anthropic/alwaysLoad'];
  assert.equal(registered, true);
});
