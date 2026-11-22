// Experiment loadEndTurn: end_turn is listed with anthropic/alwaysLoad, so
// Claude Code puts it in every request rather than behind ToolSearch.
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

test('on, end_turn is always loaded and the other tools still wait for ToolSearch', () => {
  const ts = tools({ loadEndTurn: () => true });
  assert.equal(meta(ts, 'end_turn'), true);
  assert.equal(ts.filter((t) => t._meta?.['anthropic/alwaysLoad']).length, 1);
});

test('off, or for Codex, end_turn is listed as before', () => {
  assert.equal(meta(tools({}), 'end_turn'), undefined);
  assert.equal(meta(tools({ loadEndTurn: () => false }), 'end_turn'), undefined);
  assert.equal(meta(tools({ loadEndTurn: () => true, provider: 'codex' }), 'end_turn'), undefined);
});

test('both forms of end_turn take it (one reply and bullets)', () => {
  assert.equal(meta(tools({ loadEndTurn: () => true, oneReply: () => true }), 'end_turn'), true);
  assert.equal(meta(tools({ loadEndTurn: () => true, oneReply: () => false }), 'end_turn'), true);
});

test('the server the runner builds lists end_turn with it, for Claude Code to read', () => {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3' });
  const build = (on: boolean) => threadbearMcpServer(h.runner, thread.id, undefined, undefined, undefined, () => true, undefined, () => true, undefined, undefined, undefined, () => on);
  const registered = (on: boolean) => (build(on).instance as unknown as { _registeredTools: Record<string, { _meta?: Record<string, unknown> }> })._registeredTools.end_turn?._meta?.['anthropic/alwaysLoad'];
  assert.equal(registered(true), true);
  assert.equal(registered(false), undefined);
});
