// Small-model calls on a Codex login (models/codex-oneshot.ts): isolated
// `codex exec` flags, JSONL parsing, usage-limit detection, structured output
// schema temp-file cleanup, stdin-only prompt, and fail-closed tool guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { codexAsker, codexExecArgs, isCodexUsageLimit, readCodexReply } from '../../src/models/codex-oneshot.ts';
import type { Account } from '../../src/protocol.ts';
import { skipOnWindows } from '../helpers/platform.ts';

function codexAcct(id: string, dir: string): Account {
  return { id, provider: 'codex', title: id, configDir: dir };
}

test('codexExecArgs isolates the call from user config, rules, sessions, MCP and tools', () => {
  const args = codexExecArgs({ model: 'gpt-6-luna', system: 'Name it', cwd: '/tmp/empty', outputSchemaPath: '/tmp/s.json' });
  assert.equal(args[0], 'exec');
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args.at(-1), '-', 'prompt is read from stdin, never argv');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('-C') + 1], '/tmp/empty');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-luna');
  assert.equal(args[args.indexOf('--output-schema') + 1], '/tmp/s.json');
  const configs = args.flatMap((a, i) => (a === '-c' ? [args[i + 1]] : []));
  for (const want of [
    'approval_policy="never"',
    'web_search="disabled"',
    'model_reasoning_effort="low"',
    'apps._default.enabled=false',
    'mcp_servers={}',
    'features.shell_tool=false',
    'features.unified_exec=false',
    'features.code_mode_host=false',
    'features.multi_agent=false',
    'features.hooks=false',
    'features.plugins=false',
    'features.apps=false',
  ]) {
    assert.ok(configs.includes(want), want);
  }
  const instr = configs.find((c) => c.startsWith('instructions='));
  assert.ok(instr && instr.includes('Name it') && instr.includes('Do not use any tools'));
});

test('readCodexReply parses answers, ignores benign code-mode notice, reads usage, limits, errors and fails closed on tools', () => {
  const okOut = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled.' } }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Title here' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 12 } }),
  ].join('\n');
  assert.deepEqual(readCodexReply(okOut, '', 0), { ok: true, text: 'Title here', inputTokens: 1200, outputTokens: 12 });

  const limitOut = [
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'usageLimitExceeded: You have hit your usage limit.' } }),
  ].join('\n');
  const lim = readCodexReply(limitOut, '', 1);
  assert.equal(lim.ok, false);
  assert.equal(!lim.ok && lim.limit, true);

  const errOut = JSON.stringify({ type: 'error', message: 'not signed in' });
  const err = readCodexReply(errOut, '', 1);
  assert.equal(err.ok, false);
  assert.equal(!err.ok && err.limit, false);
  assert.match(!err.ok ? err.message : '', /not signed in/);

  const toolOut = [
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'done' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
  const tool = readCodexReply(toolOut, '', 0);
  assert.equal(tool.ok, false);
  assert.match(!tool.ok ? tool.message : '', /tried to use a tool \(command_execution\)/);

  assert.equal(isCodexUsageLimit('HTTP status 429 Too Many Requests'), true);
  assert.equal(isCodexUsageLimit('error on line 429 of input'), false);
});

function fakeCodex(dir: string): string {
  const file = path.join(dir, 'codex');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (input === 'hang') return setInterval(() => {}, 1000);
  if (input === 'tool') {
    console.log(JSON.stringify({ type: 'turn.started' }));
    console.log(JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution' } }));
    // Keep alive briefly so the parent's runtime kill is exercised.
    return setInterval(() => {}, 1000);
  }
  const args = process.argv.slice(2);
  const schemaIdx = args.indexOf('--output-schema');
  const schemaPath = schemaIdx >= 0 ? args[schemaIdx + 1] : null;
  const schema = schemaPath ? JSON.parse(fs.readFileSync(schemaPath, 'utf8')) : null;
  const seen = { input, args, codexHome: process.env.CODEX_HOME ?? null, cwd: process.cwd(), schemaPath, schema };
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: JSON.stringify(seen) } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 42, output_tokens: 7 } }));
});
`,
    { mode: 0o755 },
  );
  return file;
}

test(
  'codexAsker passes prompt via stdin, sets CODEX_HOME, cleans up output schema, kills on tool item, and times out',
  skipOnWindows('fake codex binary is a POSIX script'),
  async () => {
    const dir = tmpDir();
    const bin = fakeCodex(dir);
    const added: number[] = [];
    const removed: number[] = [];
    const registry = { add: (pid: number) => added.push(pid), remove: (pid: number) => removed.push(pid) };
    const ask = codexAsker({ codexBinary: () => bin, registry });
    const cwd = path.join(dir, 'models', 'cli');
    const account = codexAcct('codex-1', path.join(dir, 'codex-1'));
    const schema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false };

    const r = await ask({ account, system: 'Classify', user: 'secret thread\ntext', jsonSchema: schema, cwd, timeoutMs: 10_000 });
    assert.ok(r.ok, !r.ok ? r.message : '');
    const seen = JSON.parse(r.text);
    assert.equal(seen.input, 'secret thread\ntext');
    assert.ok(!seen.args.includes('secret thread\ntext'), 'prompt is never passed in argv');
    assert.equal(seen.codexHome, account.configDir);
    assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(cwd));
    assert.deepEqual(seen.schema, schema);
    assert.ok(seen.schemaPath && !seen.schemaPath.startsWith(cwd), 'schema file stays outside the empty cwd');
    assert.equal(fs.existsSync(seen.schemaPath), false, 'schema temp file is cleaned up');
    assert.equal(r.inputTokens, 42);
    assert.equal(r.outputTokens, 7);
    assert.equal(added.length, 1);
    assert.deepEqual(removed, added);

    // Runtime tool-call guard kills the process and fails closed without waiting for timeout.
    const toolRes = await ask({ account, user: 'tool', cwd, timeoutMs: 10_000 });
    assert.equal(toolRes.ok, false);
    assert.equal(!toolRes.ok && toolRes.timedOut, false);
    assert.match(!toolRes.ok ? toolRes.message : '', /tried to use a tool \(command_execution\)/);
    assert.equal(removed.length, 2);

    // Timeout stops a hanging process.
    const hung = await ask({ account, user: 'hang', cwd, timeoutMs: 300 });
    assert.equal(!hung.ok && hung.timedOut, true);
    assert.equal(removed.length, 3);
  },
);
