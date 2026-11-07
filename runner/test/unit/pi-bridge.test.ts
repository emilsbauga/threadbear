import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { PiBridge } from '../../src/adapters/pi/bridge.ts';
import type { SessionSink } from '../../src/adapters/types.ts';

test('Pi bridge authenticates, validates and asks before tools; denied calls never execute', async t => {
  let calls = 0, approvals = 0, allow = false;
  const rules = new Set<string>();
  const sink: SessionSink = { output() {}, exited() {}, requestQuestion: async () => ({ answers: null }), requestApproval: async () => { approvals++; return { decision: allow ? 'allowAlways' : 'deny' }; } };
  const bridge = new PiBridge({ tools: [{ name: 'change', description: 'Change', inputSchema: { value: z.string() }, handler: async args => { calls++; return { content: [{ type: 'text', text: args.value }] }; } }], sink, cwd: () => '/work', mode: () => 'ask', rules: () => rules, addRules: added => added.forEach(r => rules.add(r)) });
  t.after(() => bridge.close());
  const { url, token } = await bridge.start();
  assert.equal((await fetch(url + '/tools')).status, 403);
  const call = (route: string, body: unknown) => fetch(url + route, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) }).then(r => r.json());
  const defs = await fetch(url + '/tools', { headers: { authorization: 'Bearer ' + token } }).then(r => r.json()) as any;
  assert.equal(defs.tools[0].name, 'mcp__threadbear__change');
  assert.equal((await call('/tool', { name: 'change', input: { value: 1 }, id: 'bad' }) as any).success, false);
  assert.equal(approvals, 0);
  assert.equal((await call('/tool', { name: 'change', input: { value: 'no' }, id: 'one' }) as any).success, false);
  assert.equal(calls, 0); allow = true;
  assert.equal((await call('/tool', { name: 'change', input: { value: 'yes' }, id: 'two' }) as any).success, true);
  assert.equal((await call('/tool', { name: 'change', input: { value: 'again' }, id: 'three' }) as any).success, true);
  assert.equal(calls, 2); assert.equal(approvals, 2);
});

test('Pi native rules cover exact cwd/input, while full mode still asks for always-ask tools', async t => {
  let mode: 'full' | 'ask' = 'ask', approvals = 0, cwd = '/a';
  const rules = new Set<string>();
  const sink: SessionSink = { output() {}, exited() {}, requestQuestion: async () => ({ answers: null }), requestApproval: async () => { approvals++; return { decision: 'allowAlways' }; } };
  const bridge = new PiBridge({ tools: [{ name: 'delete_thread', description: 'Delete', inputSchema: {}, handler: async () => ({ content: [] }) }], sink, cwd: () => cwd, mode: () => mode, rules: () => rules, addRules: added => added.forEach(r => rules.add(r)) });
  t.after(() => bridge.close()); const { url, token } = await bridge.start();
  const call = (route: string, data: unknown) => fetch(url + route, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(data) }).then(r => r.json()) as Promise<any>;
  assert.equal((await call('/approve', { name: 'read', input: { path: '/file' } })).allow, true);
  for (let i = 0; i < 2; i++) await call('/approve', { name: 'bash', input: { command: 'test' }, id: 'b' });
  assert.equal(approvals, 1); cwd = '/b'; await call('/approve', { name: 'bash', input: { command: 'test' }, id: 'b' }); assert.equal(approvals, 2);
  mode = 'full'; await call('/tool', { name: 'delete_thread', input: {}, id: 'delete' }); assert.equal(approvals, 3);
});

test('closing the Pi bridge cancels a pending approval', { timeout: 15_000 }, async t => {
  let aborted = false;
  const started = Promise.withResolvers<void>();
  const sink: SessionSink = { output() {}, exited() {}, requestQuestion: async () => ({ answers: null }), requestApproval: req => new Promise(resolve => { req.signal.addEventListener('abort', () => { aborted = true; resolve({ decision: 'expired' }); }); started.resolve(); }) };
  const bridge = new PiBridge({ tools: [], sink, cwd: () => '/work', mode: () => 'ask', rules: () => [], addRules() {} });
  const { url, token } = await bridge.start();
  t.after(() => bridge.close());
  const pending = fetch(url + '/approve', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ name: 'write', input: {}, id: 'pending' }) }).catch(() => null);
  await started.promise; await bridge.close(); await pending;
  assert.equal(aborted, true);
});

test('Pi edits to code Threadbear runs always ask and never save an allow rule', async t => {
  const requests: { canAlwaysAllow: boolean; title: string }[] = [];
  const rules = new Set<string>();
  const sink: SessionSink = { output() {}, exited() {}, requestQuestion: async () => ({ answers: null }), requestApproval: async req => { requests.push(req); return { decision: 'allowAlways' }; } };
  const bridge = new PiBridge({ tools: [], sink, cwd: () => '/work', mode: () => 'ask', runsAsCode: file => file === '/work/setup.ts', rules: () => rules, addRules: added => added.forEach(r => rules.add(r)) });
  t.after(() => bridge.close());
  const { url, token } = await bridge.start();
  for (const file of ['.threadbear/patches/actions.ts', 'setup.ts']) {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(url + '/approve', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ name: 'write', input: { path: file, content: 'changed' } }) });
      assert.equal((await response.json() as { allow: boolean }).allow, true);
    }
  }
  assert.equal(requests.length, 4);
  assert.ok(requests.every(req => !req.canAlwaysAllow && req.title.includes('runs this file as code')));
  assert.equal(rules.size, 0);
});
