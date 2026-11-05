import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PiNormalizer } from '../../src/adapters/pi/normalize.ts';
import { fileContext } from '../../src/adapters/context.ts';
import type { AdapterOutput, SessionSink } from '../../src/adapters/types.ts';
import { tmpDir } from '../helpers/fakes.ts';

test('Pi tools keep native names, useful titles and diffs, with unfinished calls closed once', () => {
  const root = tmpDir(), outputs: AdapterOutput[] = [];
  fs.writeFileSync(path.join(root, 'a.txt'), 'before\n');
  const sink: SessionSink = { output: o => outputs.push(o), exited() {}, requestApproval: async () => ({ decision: 'deny' }), requestQuestion: async () => ({ answers: null }) };
  const normalizer = new PiNormalizer(sink, fileContext(root, root, root));
  normalizer.handle({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: { command: 'npm test' } });
  normalizer.handle({ type: 'tool_execution_start', toolCallId: 'e', toolName: 'edit', args: { path: 'a.txt', oldText: 'before', newText: 'after' } });
  normalizer.handle({ type: 'tool_execution_end', toolCallId: 'e', result: { content: [{ type: 'text', text: 'Changed' }] } });
  normalizer.closeOpen(); normalizer.closeOpen();
  const events = outputs.flatMap(o => o.kind === 'event' ? [o.event] : []);
  assert.ok(events.some(e => e.type === 'tool.call' && e.name === 'bash' && e.kind === 'command' && e.title === 'npm test'));
  assert.ok(events.some(e => e.type === 'edit.diff' && e.path === 'a.txt' && e.hunks.length));
  assert.equal(events.filter(e => e.type === 'tool.result' && e.itemId === 'b').length, 1);
  assert.ok(events.some(e => e.type === 'tool.result' && e.itemId === 'b' && !e.ok));
  assert.ok(events.some(e => e.type === 'tool.result' && e.itemId === 'e' && e.ok && e.text === 'Changed'));
});
