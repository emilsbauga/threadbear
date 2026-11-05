import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiBridge } from '../../src/adapters/pi/bridge.ts';
import { z } from 'zod';
import type { SessionSink } from '../../src/adapters/types.ts';

const moduleUrl = new URL('../../src/adapters/pi/extension.mjs', import.meta.url).href;
const extension = await import(moduleUrl);
const endName = 'mcp__threadbear__end_turn', deleteName = 'mcp__threadbear__delete_thread';

test('compact context handles loopback hosts and preserves actual schema properties/constraints', () => {
  for (const baseUrl of ['http://localhost:1234/v1', 'http://127.0.0.1/v1', 'http://[::1]:1234/v1']) assert.equal(extension.compactToolContext({ baseUrl, contextWindow: 100000 }), true);
  assert.equal(extension.compactToolContext({ baseUrl: 'https://127.0.0.1.example.com', contextWindow: 100000 }), false);
  assert.equal(extension.compactToolContext(undefined), false);
  const schema = { type: 'object', description: 'Object docs', properties: { description: { type: 'string', description: 'Field docs', minLength: 3 } }, required: ['description'] };
  assert.deepEqual(extension.withoutDescriptions(schema), { type: 'object', properties: { description: { type: 'string', minLength: 3 } }, required: ['description'] });
  assert.equal(schema.description, 'Object docs', 'full schemas are not mutated');
});

async function setup(t: { after(fn: () => Promise<void>): void }, toolContext?: 'auto' | 'compact' | 'full', searchAvailable = true) {
  const handlers = new Map<string, Function>(), definitions = new Map<string, any>();
  let active = ['read', 'bash', 'edit', 'write'], approvals = 0, deleted = false;
  const sink: SessionSink = { output() {}, exited() {}, requestQuestion: async () => ({ answers: null }), requestApproval: async () => { approvals++; return { decision: 'deny' }; } };
  const bridge = new PiBridge({ toolContext, tools: [
    { name: 'end_turn', description: 'Full completion guidance', inputSchema: { headline: z.string().describe('The headline text') }, handler: async () => ({ content: [] }) },
    { name: 'delete_thread', description: 'Full deletion guidance', inputSchema: {}, handler: async () => { deleted = true; return { content: [] }; } },
  ], sink, cwd: () => '/work', mode: () => 'full', rules: () => [], addRules() {} });
  t.after(() => bridge.close());
  const { url, token } = await bridge.start();
  const oldUrl = process.env.THREADBEAR_PI_BRIDGE_URL, oldToken = process.env.THREADBEAR_PI_BRIDGE_TOKEN;
  process.env.THREADBEAR_PI_BRIDGE_URL = url; process.env.THREADBEAR_PI_BRIDGE_TOKEN = token;
  let loading = true;
  try {
    await extension.default({
      registerTool: (tool: any) => definitions.set(tool.name, tool),
      on: (name: string, fn: Function) => handlers.set(name, fn),
      getActiveTools: () => { assert.equal(loading, false, 'Pi action methods are unavailable during extension loading'); return active; },
      getAllTools: () => [...(searchAvailable ? [{ name: 'tool_search' }] : []), ...definitions.values()],
      setActiveTools: (names: string[]) => { active = names; },
    });
    loading = false;
  } finally {
    for (const [key, value] of [['THREADBEAR_PI_BRIDGE_URL', oldUrl], ['THREADBEAR_PI_BRIDGE_TOKEN', oldToken]]) if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  return { definitions, active: () => active, prompt: (model: unknown) => handlers.get('before_agent_start')!({}, { model }), activate: (name: string) => { active.push(name); }, approvals: () => approvals, deleted: () => deleted, hook: handlers.get('tool_call')! };
}

test('Pi auto compacts only local or sub-70K models, and restores full definitions on larger models', async t => {
  const h = await setup(t);
  const large = { baseUrl: 'https://openrouter.ai/api/v1', contextWindow: 70000 };
  h.prompt(large);
  assert.ok(h.active().includes(deleteName));
  assert.equal(h.definitions.get(endName).description, 'Full completion guidance');
  h.prompt({ ...large, contextWindow: 69999 });
  assert.ok(h.active().includes('read') && h.active().includes('tool_search') && h.active().includes(endName));
  assert.ok(!h.active().includes(deleteName));
  assert.equal(h.definitions.get(deleteName).exposure, 'deferred');
  assert.equal(h.definitions.get(endName).parameters.properties.headline.description, undefined);
  h.activate(deleteName); h.prompt({ ...large, contextWindow: 32000 });
  assert.ok(!h.active().includes(deleteName), 'next prompt sheds previously loaded tools');
  h.prompt({ baseUrl: 'http://127.0.0.1:1234/v1', contextWindow: 262144 });
  assert.equal(h.definitions.get(deleteName).exposure, 'deferred');
  h.prompt(large);
  assert.ok(h.active().includes(deleteName));
  assert.equal(h.definitions.get(endName).parameters.properties.headline.description, 'The headline text');
  h.prompt({ baseUrl: 'https://openrouter.ai/api/v1' });
  assert.ok(h.active().includes(deleteName), 'unknown remote context stays full');
});

test('Pi without native tool search retains its full tools', async t => {
  const h = await setup(t, 'auto', false);
  h.prompt({ baseUrl: 'http://localhost:1234/v1', contextWindow: 32000 });
  assert.ok(h.active().includes(deleteName));
  assert.ok(!h.active().includes('tool_search'));
  assert.equal(h.definitions.get(endName).description, 'Full completion guidance');
});

test('Pi tool-context overrides and discovered-tool approvals retain the original policy', async t => {
  const full = await setup(t, 'full');
  full.prompt({ baseUrl: 'http://localhost:1234/v1', contextWindow: 32000 });
  assert.ok(full.active().includes(deleteName));
  const compact = await setup(t, 'compact');
  compact.prompt({ baseUrl: 'https://openrouter.ai/api/v1', contextWindow: 1000000 });
  assert.ok(!compact.active().includes(deleteName));
  assert.equal(await compact.hook({ toolName: 'tool_search', input: { query: 'delete_thread' }, toolCallId: 'search' }, {}), undefined);
  assert.equal(compact.approvals(), 0, 'pure tool discovery does not ask for approval');
  await assert.rejects(compact.definitions.get(deleteName).execute('delete', {}, new AbortController().signal), /denied/i);
  assert.equal(compact.approvals(), 1);
  assert.equal(compact.deleted(), false, 'full mode still gates always-ask tools after discovery');
});
