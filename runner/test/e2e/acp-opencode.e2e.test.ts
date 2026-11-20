// AcpAdapter against the real `opencode acp`, on a free model, with a temp
// home and folder so nothing of the user's is read or written. Skipped when
// OpenCode isn't installed. Costs nothing and needs no login.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AcpAdapter, type AcpSession } from '../../src/adapters/acp/adapter.ts';
import { ACP_AGENTS, opencodeMajor } from '../../src/adapters/acp/agents.ts';
import type { AdapterOutput, QuestionAnswer, QuestionRequest, SessionSink, ToolApprovalRequest } from '../../src/adapters/types.ts';
import type { Account, PermissionMode } from '../../src/protocol.ts';
import { nullLogger } from '../../src/log.ts';
import { ProcessRegistry } from '../../src/proc.ts';

// THREADBEAR_E2E_OPENCODE: another OpenCode to try (a new major) without installing it.
const bin = process.env.THREADBEAR_E2E_OPENCODE || ACP_AGENTS.opencode.findBinary({ home: os.homedir(), pathEnv: process.env.PATH ?? '' });
// THREADBEAR_E2E_OPENCODE_MODEL: another free model, when big-pickle's free use has run out.
const MODEL = process.env.THREADBEAR_E2E_OPENCODE_MODEL || 'opencode/big-pickle';
const roots: string[] = [];
const sessions: AcpSession[] = [];

after(async () => {
  await Promise.all(sessions.map((s) => s.end({ hard: true }).catch(() => undefined)));
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function rig(mode: PermissionMode, deny: boolean, tools: { name: string; description: string; inputSchema: Record<string, z.ZodTypeAny>; handler: () => Promise<{ content: unknown[] }> }[] = [], before?: (cwd: string, root: string) => void, answer?: (r: QuestionRequest) => QuestionAnswer) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-acp-e2e-')));
  roots.push(root);
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  before?.(cwd, root);
  const xdg = Object.fromEntries(['CONFIG', 'DATA', 'STATE', 'CACHE'].map((k) => [`XDG_${k}_HOME`, path.join(root, k.toLowerCase())]));
  Object.values(xdg).forEach((d) => fs.mkdirSync(d));
  // THREADBEAR_E2E_OPENCODE_AUTH: an auth.json to use (linked, never copied), for a paid model.
  if (process.env.THREADBEAR_E2E_OPENCODE_AUTH) {
    fs.mkdirSync(path.join(xdg.XDG_DATA_HOME, 'opencode'), { recursive: true });
    fs.symlinkSync(process.env.THREADBEAR_E2E_OPENCODE_AUTH, path.join(xdg.XDG_DATA_HOME, 'opencode', 'auth.json'));
  }
  const cards: ToolApprovalRequest[] = [];
  const questions: QuestionRequest[] = [];
  const outputs: AdapterOutput[] = [];
  const waiters: (() => void)[] = [];
  const sink: SessionSink = {
    output(o) {
      outputs.push(o);
      if (o.kind === 'result') waiters.splice(0).forEach((f) => f());
    },
    async requestApproval(r) {
      cards.push(r);
      return { decision: deny ? 'deny' : 'allow' };
    },
    async requestQuestion(r) {
      questions.push(r);
      return answer ? answer(r) : { answers: null };
    },
    exited() {},
  };
  const adapter = new AcpAdapter({
    agent: ACP_AGENTS.opencode,
    binary: () => bin,
    registry: new ProcessRegistry(path.join(root, 'run'), nullLogger),
    log: nullLogger,
    env: { PATH: process.env.PATH, HOME: root, ...xdg },
    toolsFor: () => tools as never,
  });
  const account: Account = { id: 'opencode-main', provider: 'opencode', title: 'OpenCode', configDir: root };
  const s = adapter.start({ threadId: 'e2e', cwd, account, model: MODEL, permissionMode: mode, sessionId: 'x', resume: false, mediaDir: path.join(root, 'm'), blobsDir: path.join(root, 'b'), tmpDir: root }, sink) as AcpSession;
  sessions.push(s);
  const turn = (text: string) =>
    new Promise<void>((resolve) => {
      waiters.push(resolve);
      s.send({ id: `t${outputs.length}`, text, images: [] });
    });
  return { root, cwd, cards, questions, outputs, turn, adapter, account };
}

// Plugins that write `marker` as they're imported, in both OpenCode 1's shape
// (a file exporting a function) and 2's (a directory whose index
// default-exports an id and setup): a 1 plugin never runs on 2, so it alone
// proves nothing there. On import, not in setup: 2 imports a plugin before a
// `plugins` rule can turn it off. One claims an `opencode.*` id, which a rule
// turning OpenCode's own plugins back on would match.
function plantPlugins(dir: string, marker: string) {
  const write = `(await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, 'ran');`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.js'), `${write}\nexport const P = async () => { ${write} return {}; };\n`);
  for (const id of ['probe', 'opencode.probe']) {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'index.js'), `${write}\nexport default { id: ${JSON.stringify(id)}, async setup() { ${write} } };\n`);
  }
}

const major = bin ? opencodeMajor(bin) : undefined;

const WRITE = (cwd: string) => `Use your write tool to create ${path.join(cwd, 'a.txt')} containing hi. Do nothing else.`;

describe('ACP threads end to end (real opencode acp)', { concurrency: false, skip: !bin && 'OpenCode is not installed' }, () => {
  test('a repo that says allow everything still gets asked, and its plugin never runs', { timeout: 150_000 }, async () => {
    let marker = '';
    const plant = (cwd: string, root: string) => {
      fs.writeFileSync(path.join(cwd, 'opencode.json'), JSON.stringify({ permission: { '*': 'allow', edit: 'allow', bash: 'allow' }, agent: { build: { permission: { '*': 'allow' } } } }));
      marker = path.join(root, 'plugin-ran');
      plantPlugins(path.join(cwd, '.opencode', 'plugins'), marker);
    };
    if ((major ?? 1) < 2) {
      // OpenCode 1 would import the plugin whatever it's told, so the thread doesn't start.
      assert.throws(() => rig('ask', true, [], plant), /OpenCode plugins/);
      assert.equal(fs.existsSync(marker), false, "the repo's plugin did not run");
      return;
    }
    const r = rig('ask', true, [], plant);
    await r.turn(WRITE(r.cwd));
    assert.ok(r.cards.length >= 1, 'the write asked');
    assert.equal(r.cards[0].name, 'apply_patch');
    assert.equal(fs.existsSync(path.join(r.cwd, 'a.txt')), false, 'denied, so not written');
    assert.equal(fs.existsSync(marker), false, "the repo's plugin did not run");
  });

  test("a plugin in the user's own OpenCode config doesn't run in a thread", { timeout: 150_000 }, async () => {
    const r = rig('full', false);
    const marker = path.join(r.root, 'user-plugin-ran');
    plantPlugins(path.join(r.root, 'config', 'opencode', 'plugins'), marker);
    await r.turn('Reply with just the word pong.');
    assert.equal(fs.existsSync(marker), false, "the user's plugin did not run");
  });

  // OpenCode 2's other commands start a background server (`opencode service`)
  // that outlives them. A thread must not pick up one started without
  // Threadbear's rules. OpenCode 1 has no service, so this is a no-op there.
  test('a background OpenCode service started without the rules does not bypass them', { timeout: 150_000 }, async () => {
    const r = rig('ask', true);
    const { spawnSync } = await import('node:child_process');
    const env = { PATH: process.env.PATH, HOME: r.root, ...Object.fromEntries(['CONFIG', 'DATA', 'STATE', 'CACHE'].map((k) => [`XDG_${k}_HOME`, path.join(r.root, k.toLowerCase())])), OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'allow' }, agent: { build: { permission: { '*': 'allow' } } } }) };
    const started = spawnSync(bin!, ['service', 'start'], { env, timeout: 60_000, encoding: 'utf8' });
    if (started.status === 0) assert.match(spawnSync(bin!, ['service', 'status'], { env, timeout: 30_000, encoding: 'utf8' }).stdout, /127\.0\.0\.1/, 'the service is up');
    try {
      await r.turn(WRITE(r.cwd));
      assert.ok(r.cards.length >= 1, 'the write asked');
      assert.equal(fs.existsSync(path.join(r.cwd, 'a.txt')), false, 'denied, so not written');
    } finally {
      if (started.status === 0) spawnSync(bin!, ['service', 'stop'], { env, timeout: 60_000 });
    }
  });

  // On 1 the user's config folder is still read (its MCP servers start with
  // a session, as they always have); 2 gets an empty one.
  test("the user's own MCP servers don't start on OpenCode 2", { timeout: 150_000, skip: (major ?? 1) < 2 && 'OpenCode 1' }, async () => {
    const r = rig('full', false);
    const marker = path.join(r.root, 'mcp-ran');
    fs.mkdirSync(path.join(r.root, 'config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(r.root, 'config', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { probe: { type: 'local', command: ['/bin/sh', '-c', `echo ran > ${marker}; sleep 5`], enabled: true } } }));
    await r.turn('Reply with just the word pong.');
    assert.equal(fs.existsSync(marker), false, "the user's MCP server did not start");
  });

  // OpenCode 2's question tool asks through a form (elicitation/create);
  // 1 has no question tool over ACP.
  test("the agent's question is a card, and the answer picked reaches it", { timeout: 150_000, skip: (major ?? 1) < 2 && 'OpenCode 1' }, async () => {
    const r = rig('ask', true, [], undefined, (q) => ({ answers: { [q.questions[0].question]: q.questions[0].options.at(-1)?.label ?? '' } }));
    await r.turn('Use your question tool to ask me one question: which colour I prefer, with exactly two options, Red and Blue. After I answer, reply with only the colour I picked.');
    assert.equal(r.questions.length, 1, 'one card');
    assert.equal(r.cards.length, 0, 'asking needs no approval card of its own');
    const picked = r.questions[0].questions[0].options.at(-1)!.label;
    const result = r.outputs.flatMap((o) => (o.kind === 'event' && o.event.type === 'tool.result' ? [String((o.event as { text?: string }).text)] : [])).join('\n');
    assert.ok(result.includes('User has answered your questions') && result.includes(`="${picked}"`), `OpenCode's tool says what was picked: ${result}`);
  });

  test('Full writes with no card', { timeout: 150_000 }, async () => {
    const r = rig('full', true);
    await r.turn(WRITE(r.cwd));
    assert.equal(r.cards.length, 0);
    assert.equal(fs.existsSync(path.join(r.cwd, 'a.txt')), true);
  });

  test('the threadbear tools reach the agent over HTTP, with its bearer token', { timeout: 150_000 }, async () => {
    let called = 0;
    const r = rig('ask', true, [
      {
        name: 'say_code_word',
        description: 'Returns the code word. Read-only.',
        inputSchema: {},
        handler: async () => {
          called++;
          return { content: [{ type: 'text', text: 'the code word is mango' }] };
        },
      },
    ]);
    await r.turn('Call the threadbear say_code_word tool and tell me the code word it returns.');
    assert.equal(called > 0 || r.cards.some((c) => c.name.endsWith('say_code_word')), true, 'it reached the tool (the gate may have asked first)');
    assert.equal(r.cards.filter((c) => !c.name.startsWith('mcp__threadbear__')).length, 0, "the agent's own request doesn't double up the gate's");
  });

  test('models come from a real session', { timeout: 60_000 }, async () => {
    const r = rig('full', false);
    // After the session's first turn: OpenCode sets up its database on a first
    // run, and two processes doing that at once in one new home can collide.
    await r.turn('Reply with just the word pong.');
    const models = await r.adapter.models(r.account);
    assert.ok(models.some((m) => m.id === MODEL));
  });
});
