// Deterministic Pi wire fixture. No model, credentials or external services.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const config = process.env.PI_CODING_AGENT_DIR;
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(path.join(config, 'launch.json'), JSON.stringify({ args, cwd: process.cwd(), telemetry: process.env.PI_TELEMETRY, offline: process.env.PI_OFFLINE }));
const id = option(args.includes('--session') ? '--session' : '--session-id');
const file = path.join(option('--session-dir'), id + '.jsonl');
if (args.includes('--session') && !fs.existsSync(file)) {
  process.stderr.write('Session not found\n');
  process.exit(2);
}
const history = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const response = (c, data = {}) => out({ type: 'response', id: c.id, command: c.type, success: true, data });
const mode = process.env.PI_RPC_TEST_MODE || (args.includes('--fixture-mode') ? option('--fixture-mode') : '');
let active = false;
let dialogMessage;
function finish(message) {
  out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'final thought' }, { type: 'text', text: 'final:' + message }] } });
  out({ type: 'agent_end', willRetry: false });
  active = false;
  out({ type: 'agent_settled', aborted: false });
}
async function command(c) {
  fs.appendFileSync(path.join(config, 'commands.jsonl'), JSON.stringify(c) + '\n');
  if (c.type === 'get_available_models') {
    if (mode === 'models-hang') return;
    if (mode === 'models-malformed') return response(c, { models: 'invalid' });
    return response(c, { models: [
      { provider: 'openrouter', id: 'vendor/one', name: 'Model One', headers: { authorization: 'private fixture' } },
      { provider: 'openrouter', id: 'vendor/two', name: 'Model Two' },
      { provider: 'other', id: 'not-this-profile', name: 'Other' },
      { provider: 'openrouter', id: 'vendor/one', name: 'Duplicate' },
      { provider: 'openrouter', id: '' }, null,
    ] });
  }
  if (c.type === 'get_state') {
    if (mode === 'startup-hang') return;
    if (mode === 'malformed') return process.stdout.write('not json\n');
    if (mode === 'oversized') return process.stdout.write('x'.repeat(4096));
    if (mode === 'mismatch') return out({ type: 'response', id: c.id, command: 'wrong', success: true });
    process.stderr.write('private diagnostic, not RPC\n');
    return response(c, { sessionId: id, model: { id: option('--model') }, isStreaming: false });
  }
  if (c.type === 'prompt') {
    if (c.message === 'reject') return out({ type: 'response', id: c.id, command: c.type, success: false, error: 'Rejected prompt' });
    if (c.message === 'crash') process.exit(7);
    if (c.message === 'orphan') {
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', process.stdout, process.stderr] });
      process.exit(7);
    }
    history.push({ text: c.message, images: c.images });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(history));
    active = true;
    out({ type: 'agent_start' });
    out({ type: 'message_start', message: { role: 'assistant', content: [] } });
    out({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'partial thought' } });
    out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'partial:' + c.message } });
    if (c.message.startsWith('settled-before-ack')) {
      finish(c.message);
      await new Promise(r => setTimeout(r, 25));
      fs.writeFileSync(path.join(config, 'ack-marker'), 'ready');
      return response(c, { disposition: 'started' });
    }
    response(c, { disposition: 'started' });
    if (c.message === 'question' || c.message === 'question-hang') {
      dialogMessage = c.message;
      out({ type: 'extension_ui_request', id: 'dialog', method: 'confirm', title: 'Continue?', message: 'This is a Pi question.' });
      return;
    }
    if (c.message === 'hang') return;
    if (c.message === 'retry') {
      out({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'temporary failure' } });
      out({ type: 'agent_end', willRetry: true });
      await new Promise(r => setTimeout(r, 50));
      out({ type: 'agent_start' });
      out({ type: 'message_start', message: { role: 'assistant', content: [] } });
    }
    return finish(c.message);
  }
  if (c.type === 'abort') {
    if (mode === 'abort-hang') return;
    if (active) {
      active = false;
      out({ type: 'agent_settled', aborted: true });
    }
  }
  if (c.type === 'extension_ui_response') {
    if (active) finish(`${dialogMessage}:${c.confirmed ? 'yes' : 'no'}`);
    return;
  }
  response(c);
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (line) void command(JSON.parse(line));
  }
});
process.stdin.on('end', () => mode === 'end-hang' ? setInterval(() => {}, 1000) : process.exit(0));
