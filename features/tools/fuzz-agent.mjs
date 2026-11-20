#!/usr/bin/env node
// An exploratory bug hunt: a cheap model uses the GPUI app like a person
// (through the scripted control, against the mock runner's demo threads) and
// reports what looks broken. Part of the overnight fuzzing experiment
// (~/dev/me/misc/threadbear-fuzz on Mike's Mac).
//
//   node features/tools/fuzz-agent.mjs --model claude:claude-haiku-5-5 \
//     [--id <dev-app id>] [--area sidebar] [--steps 25] [--out DIR] [--max-input 400000]
//   node features/tools/fuzz-agent.mjs --model opencode:deepseek-v4.1-flash-free ...
//
// Needs a running instance: desktop/scripts/dev-app.sh start --mock [--id NAME].
// Each step the model gets what the window shows (`dump`), the labelled
// controls with their points (`labels`), and what its last commands said; it
// answers with one JSON object: a note, up to three commands, maybe a bug.
// The harness also checks after every step that the app is alive and hasn't
// hung or panicked, and logs everything to <out>/session.jsonl with the
// model's token use and cost.
//
// The model never gets a shell: it can only send automation commands, and
// only the ones listed in ALLOWED (no `panic`, `stall`, `quit`, data-dir or
// live-runner switches).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const devApp = path.join(root, 'desktop/scripts/dev-app.sh');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const model = args.model ?? 'claude:claude-haiku-5-5';
const steps = Number(args.steps ?? 25);
const maxInput = Number(args['max-input'] ?? 400000);
const id = args.id;
const out = args.out ?? path.join(os.tmpdir(), `fuzz-agent-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const logFile = path.join(out, 'session.jsonl');
const log = (o) => fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');

// Commands a person's actions map to. Everything else is refused.
const ALLOWED = new Set(['click', 'click-at', 'label-point', 'open', 'select', 'type', 'send', 'return', 'escape', 'arrow', 'tab',
  'menu-key', 'scroll', 'bottom', 'search', 'archive', 'undo-archive', 'snooze', 'menu', 'expand', 'collapse', 'settings',
  'panel', 'mode', 'zoom', 'appearance', 'resize', 'size', 'hover', 'new', 'focus', 'waitFor', 'link', 'press-button',
  'decide', 'rename', 'context-menus', 'open-archived', 'menus', 'menu-item', 'app-menu', 'peek', 'chip', 'composer-menu', 'tab']);

// ---- the app ----------------------------------------------------------------
function app(...cmdArgs) {
  const r = spawnSync(devApp, [...cmdArgs, ...(id ? ['--id', id] : [])], { encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr ? `\n${r.stderr}` : ''), timedOut: r.error?.code === 'ETIMEDOUT' };
}
const doCmd = (cmd) => app('do', JSON.stringify(cmd), '--timeout', '15');
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n…(${s.length - n} more characters cut)` : s);

function screen() {
  const dump = app('dump');
  const labels = doCmd({ cmd: 'labels' });
  let list = labels.out.replace(/^labels\s*/, '').trim();
  try {
    const parsed = JSON.parse(list);
    list = parsed.slice(0, 140).map((l) => `${l.role ?? '?'} "${l.label.replace(/\n/g, ' / ')}" at ${l.x},${l.y}${l.disabled ? ' (disabled)' : ''}`).join('\n');
  } catch { list = clip(list, 3000); }
  return { dump: clip(dump.out.trim(), 6000), labels: list, alive: dump.ok };
}

function health() {
  const status = app('status');
  const hangs = doCmd({ cmd: 'hangs' });
  const crashes = doCmd({ cmd: 'crashes' });
  return { status: clip(status.out.trim(), 400), hangs: clip(hangs.out.trim(), 600), crashes: clip(crashes.out.trim(), 600), responsive: hangs.ok && !hangs.timedOut };
}

// ---- the models -------------------------------------------------------------
// claude: one `claude -p` process per session, fed one message per step over
// stream-json, with no tools, no settings, no MCP and our own system prompt,
// so a step costs its own text and not Mike's whole setup.
function claudeBackend(name, system) {
  const p = spawn('claude', ['-p', '--model', name, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
    '--system-prompt', system], { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir() });
  let buf = '';
  let waiting = null;
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'result' && waiting) {
        const u = ev.usage ?? {};
        const w = waiting; waiting = null;
        w({ text: ev.result ?? '', cost: ev.total_cost_usd ?? 0, input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 });
      }
    }
  });
  p.stderr.on('data', () => {});
  let lastCost = 0;
  return {
    async ask(text) {
      const r = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('model timed out')), 180000);
        waiting = (v) => { clearTimeout(t); resolve(v); };
        p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
      });
      // A stream-json result's cost is the session's so far.
      const step = { ...r, cost: r.cost - lastCost };
      lastCost = r.cost;
      return step;
    },
    close() { p.stdin.end(); p.kill(); },
  };
}

// opencode: Mike's OpenCode CLI, whose free models only answer through its
// own client. Every tool denied and no plugins, MCP or project config, as the
// delegate skill's read-only seat; the session id carries the conversation.
function opencodeBackend(name, system) {
  const oc = process.env.OPENCODE_BIN ?? path.join(os.homedir(), '.opencode/bin/opencode');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-oc-'));
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-oc-config-'));
  // Each tool by name: a blanket `"*": "deny"` makes OpenCode's free models
  // answer FreeUsageLimitError (18 Nov), though named denials don't.
  const deny = Object.fromEntries(['bash', 'edit', 'write', 'read', 'glob', 'grep', 'list', 'webfetch', 'websearch', 'task', 'todowrite', 'skill', 'external_directory'].map((t) => [t, 'deny']));
  const cfg = JSON.stringify({ permission: deny, mcp: {}, plugins: ['-*', 'opencode.*'] });
  let session = null;
  let first = true;
  return {
    async ask(text) {
      const msg = first ? `${system}\n\n---\n\n${text}` : text;
      first = false;
      const runArgs = ['run', '--standalone', '--archived', '-m', `opencode/${name}`, '--format', 'json', ...(session ? ['--session', session] : []), msg];
      const r = await new Promise((resolve) => {
        const p = spawn('taskpolicy', ['-b', oc, ...runArgs], { cwd: scratch, env: { ...process.env, OPENCODE_PURE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG: '', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_CONFIG_CONTENT: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
        let o = ''; let e = '';
        p.stdout.on('data', (d) => { o += d; });
        p.stderr.on('data', (d) => { e += d; });
        const t = setTimeout(() => p.kill(), 240000);
        p.on('close', () => { clearTimeout(t); resolve({ o, e }); });
      });
      let textOut = ''; let input = 0; let output = 0; let cost = 0; let error = '';
      for (const line of r.o.split('\n')) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.sessionID && !session) session = ev.sessionID;
        if (ev.type === 'text') textOut += ev.part?.text ?? '';
        if (ev.type === 'step_finish') { const tk = ev.part?.tokens ?? {}; input += (tk.input ?? 0) + (tk.cache?.read ?? 0); output += (tk.output ?? 0) + (tk.reasoning ?? 0); cost += ev.part?.cost ?? 0; }
        if (ev.type === 'error') error = JSON.stringify(ev.error).slice(0, 300);
      }
      if (!textOut && error) throw new Error(error);
      if (!textOut) throw new Error(`no answer: ${clip(r.e, 300)}`);
      return { text: textOut, input, output, cost };
    },
    close() { fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(config, { recursive: true, force: true }); },
  };
}

// ---- the brief --------------------------------------------------------------
const features = fs.readFileSync(path.join(root, 'docs/gpui-port/features.md'), 'utf8');
function areaBrief(area) {
  const sections = features.split(/^## /m).slice(1);
  const pick = sections.find((s) => s.toLowerCase().includes(area.toLowerCase())) ?? sections[3];
  const title = pick.split('\n')[0];
  const rows = pick.split('\n').filter((l) => l.startsWith('| `')).map((l) => {
    const c = l.split('|').map((x) => x.trim());
    return `- ${c[2]}: ${c[3]}`;
  });
  return `${title}\n${rows.join('\n')}`;
}
const area = args.area ?? 'Sidebar and inbox';
const system = fs.readFileSync(path.join(here, 'fuzz-agent-prompt.md'), 'utf8');

function parseReply(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

// ---- the loop ---------------------------------------------------------------
const [kind, name] = model.split(':');
const backend = kind === 'opencode' ? opencodeBackend(name, system) : claudeBackend(name, system);
const totals = { input: 0, output: 0, cost: 0, steps: 0, badReplies: 0, refused: 0, cmdErrors: 0, reports: 0 };
const started = Date.now();
log({ kind: 'start', model, area, steps, id });

let feedback = `Your area this session:\n${areaBrief(area)}\n\nThe app has just started with its demo threads.`;
try {
  for (let i = 1; i <= steps; i++) {
    const s = screen();
    if (!s.alive) { log({ kind: 'harness', problem: 'app not answering dump', detail: s.dump }); break; }
    const prompt = `${feedback}\n\nStep ${i} of ${steps}.\n\n## What the window shows (dump)\n${s.dump}\n\n## Labelled controls (role "label" at x,y)\n${s.labels}`;
    let reply;
    try { reply = await backend.ask(prompt); } catch (e) { log({ kind: 'model-error', step: i, error: String(e) }); totals.badReplies++; if (totals.badReplies > 3) break; feedback = 'Your last answer did not arrive. Answer with the JSON object only.'; continue; }
    totals.input += reply.input; totals.output += reply.output; totals.cost += reply.cost; totals.steps = i;
    const j = parseReply(reply.text);
    log({ kind: 'step', step: i, reply: reply.text.slice(0, 4000), input: reply.input, output: reply.output, cost: reply.cost });
    if (!j) { totals.badReplies++; feedback = 'That was not a JSON object. Answer with one JSON object only, as the instructions say.'; continue; }
    if (j.bug) { totals.reports++; log({ kind: 'report', step: i, bug: j.bug, screen: s.dump.slice(0, 3000) }); }
    const results = [];
    for (const cmd of (Array.isArray(j.actions) ? j.actions : []).slice(0, 3)) {
      if (!cmd || typeof cmd !== 'object' || !ALLOWED.has(cmd.cmd)) { totals.refused++; results.push(`${JSON.stringify(cmd)} -> refused: not an allowed command`); continue; }
      const r = doCmd(cmd);
      if (!r.ok) totals.cmdErrors++;
      results.push(`${JSON.stringify(cmd)} -> ${r.timedOut ? 'TIMED OUT (the app did not answer in 15 s)' : clip(r.out.trim(), 500)}`);
      log({ kind: 'cmd', step: i, cmd, ok: r.ok, timedOut: r.timedOut, out: r.out.slice(0, 1000) });
    }
    const h = health();
    // `hangs ok {"stalls":[]}` and `crashes ok {"panics":[]}` are the quiet answers.
    const stalled = !/"stalls":\[\]/.test(h.hangs);
    const panicked = !/"panics":\[\]/.test(h.crashes);
    if (!h.responsive || stalled || panicked) { log({ kind: 'harness', step: i, health: h, stalled, panicked }); totals.harness = (totals.harness ?? 0) + 1; }
    feedback = `Your note: ${j.note ?? ''}\n\nWhat your commands said:\n${results.join('\n') || '(none sent)'}`;
    if (j.done) break;
    if (totals.input > maxInput) { log({ kind: 'stop', why: 'input token cap' }); break; }
  }
} finally {
  backend.close();
  totals.seconds = Math.round((Date.now() - started) / 1000);
  log({ kind: 'end', totals });
  fs.writeFileSync(path.join(out, 'totals.json'), JSON.stringify({ model, area, ...totals }, null, 2));
  console.log(JSON.stringify({ model, area, out, ...totals }));
}
