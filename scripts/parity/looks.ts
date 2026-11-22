// The parity run's "looks different" check, on the Mac nightly.sh runs from
// (Mike's main Mac), after the pictures come back: for each scenario, Opus
// is shown the Mac app's picture (the reference) beside the iPhone's,
// Android's and the website's, and says where one draws the thread's
// content differently: a missing note, another order, a card drawn as
// plain text. Not the expected differences between platforms (a narrow
// screen, native controls, fonts, the Mac's sidebar). The words check
// (gallery.mjs) catches a word that's missing; this catches the rest of
// what Mike kept finding by eye (a question not small and grey above its
// answer, a scheduled message's header, a decision card's notes).
//
// Through the runner's small-model pool (runner.json models.pool, the
// Claude pool unless set), on the login with room, as the release notes
// are written: the official CLI in print mode with nothing of Mike's setup
// loaded. Writes looks.json beside the pictures: each scenario's
// differences, or why it couldn't look. Like the rest of the parity run,
// only Mike's setup runs this (docs/parity-run.md): a fork never does.
//
//   node scripts/parity/looks.ts <run dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { loadConfig } from '../../runner/src/config.ts';
import { discoverAccounts } from '../../runner/src/accounts.ts';
import { cliEnv } from '../../runner/src/adapters/claude/adapter.ts';
import { pickInPool } from '../../runner/src/pools.ts';
import { OPUS } from '../../runner/src/models/index.ts';
import { outermostBraces } from '../../runner/src/linear-text.ts';
import type { Account, Pool } from '../../runner/src/protocol.ts';
import { DRAWN, PLATFORMS } from '../../runner/src/draw-parity.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: looks.ts <run dir>');
  process.exit(2);
}
const ROOT = path.resolve(import.meta.dirname, '../..');
const seed = JSON.parse(fs.readFileSync(path.join(dir, 'seed.json'), 'utf8')) as { threads: { name: string }[] };
const OTHERS = [
  ['iPhone', 'iphone'],
  ['Android', 'android'],
  ['Website', 'web'],
] as const;

// What draw-parity.ts says an app leaves out on purpose (a reason other
// than "Not drawn yet."): told to the model as never a difference, so a
// choice like the website's missing phone mark isn't reported each night.
const LABELS: Record<(typeof PLATFORMS)[number], string> = { ios: 'iPhone', android: 'Android', web: 'Website' };
const CHOSEN = Object.values(DRAWN).flatMap((row) =>
  PLATFORMS.flatMap((p) => {
    const d = row[p];
    return typeof d === 'object' && d.no !== 'Not drawn yet.' && !d.no.startsWith('Desktop only') ? [`- ${LABELS[p]} leaves out "${row.what}" on purpose: ${d.no}`] : [];
  }),
);

export type Difference = { surface: string; what: string };
type Look = { name: string; differences: Difference[]; error?: string };

const SYSTEM = `You compare screenshots of one chat thread in Threadbear, an app for running AI agent threads, as drawn by different apps. The first picture is the Mac app: the reference. The others are the same thread on other apps (named before each picture). Your job is to find where another app draws the thread's content differently from the reference, in a way a careful user would call a bug.

Report only clear differences in content or structure inside the thread itself:
- something the reference shows that another app leaves out (a message, a card, a card's note or explanation under an option, a link to open or show something, a picture, a line of status in the thread, a header line on a message);
- something in a different order (options, messages, a card above instead of below a message);
- a card or structured block drawn as plain text, or plain text drawn as a card;
- a part drawn in a clearly different role: e.g. a question shown small and grey above its answer on the reference but as a heading or as the answer's own text elsewhere, a message's header line missing or replaced, a done card's follow-ups shown as plain bullets.

Never report these, they are expected between platforms:
- anything outside the thread: the Mac's sidebar and thread list, its Highlights pane, title bars, status bars, toolbars, back buttons, tab bars;
- warning or offline banners and notices about the machine or runner (e.g. "codex CLI isn't at ...", "runner is offline");
- the message box (composer) and its controls, placeholders, model or account pickers;
- fonts, sizes, colours, spacing, corner radii, icons, line wrapping, widths, dark shades, native control styles (a checkbox vs a radio circle), button wording like "Archive" vs an archive icon;
- a card's own chrome: its heading label ("Decision needed", "Needs you", "Done"), a collapse chevron, an archive button, a free-answer row like "Something else..." (the message box covers it); and a card holding nothing but that chrome (a bare "Done" with Archive) being left out. Its content (questions, options, notes, follow-ups, links, findings) still counts;
- buttons that act on the thread (Send back, Approve, Archive, Retry): not every app has every action, by design;
- a picture the reference itself couldn't load (a grey box saying "Couldn't get it ..."): the run's pictures don't reach every app, so its absence elsewhere isn't a difference;
- collapsed activity rows ("Worked", "Used a tool", tool rows) differing in wording, timings like "0 ms", or being shown vs folded;
- timestamps and dates;
- text cut off at the edge of a picture or scrolled out of view on a smaller screen, if the rest of the picture agrees with it.
${CHOSEN.join('\n')}

When unsure, leave it out: a false alarm costs more than a miss. Most threads have no differences; an empty list is the usual answer.

Answer with JSON only, no prose: {"differences":[{"surface":"<the app's name as given>","what":"<one plain sentence: what the reference shows and what this app does instead>"}]}`;

// The runner's small-model pool and its Claude logins, with their room
// from the live runner where it answers.
function logins(): { pool: Pool; accounts: Account[]; claudePath: string } {
  const cfg = loadConfig(process.env, { readOnly: true });
  const poolId = cfg.models.pool;
  if (!poolId) throw new Error('small model calls are off on this runner (models.pool)');
  let accounts = discoverAccounts(cfg);
  let pools: Pool[] = [];
  try {
    const tb = path.join(ROOT, 'runner/bin/tb');
    const usage = JSON.parse(execFileSync(tb, ['accounts', '--json'], { encoding: 'utf8', timeout: 20000 }));
    const byId = new Map<string, Account>((Array.isArray(usage) ? usage : usage.accounts ?? []).map((a: Account) => [a.id, a]));
    accounts = accounts.map((a) => ({ ...byId.get(a.id), ...a, usage: byId.get(a.id)?.usage ?? a.usage }));
    pools = (JSON.parse(execFileSync(tb, ['pools', '--json'], { encoding: 'utf8', timeout: 20000 })).pools ?? []) as Pool[];
  } catch {
    // No runner to ask: the logins in the order found, without room.
  }
  const pool = pools.find((p) => p.id === poolId) ?? { id: poolId, title: poolId, accountIds: accounts.map((a) => a.id) };
  return { pool, accounts, claudePath: cfg.claudePath };
}

// A smaller JPEG copy: an iPhone shot is 2622 pixels tall, more than the
// model looks at.
function shrink(file: string, tmp: string): string {
  const out = path.join(tmp, path.basename(file).replace(/\.png$/, '.jpg'));
  execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '-Z', '1400', file, '--out', out], { stdio: 'ignore' });
  return out;
}

type Reply = { ok: true; text: string } | { ok: false; limit: boolean; message: string };

function ask(claudePath: string, account: Account, content: unknown[]): Promise<Reply> {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-parity-looks-'));
    const args = [
      '-p', '--model', OPUS,
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--tools', '', '--setting-sources', '', '--disable-slash-commands',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--system-prompt', SYSTEM,
    ];
    const child = spawn(claudePath, args, { cwd, env: cliEnv(account) as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 5 * 60_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-2000)));
    child.on('error', (e) => resolve({ ok: false, limit: false, message: e.message }));
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      const result = out.split('\n').reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m?.type === 'result');
      const text = typeof result?.result === 'string' ? result.result : '';
      if (result && !result.is_error && text) return resolve({ ok: true, text });
      const message = (text || err || `claude exited ${code}`).trim().slice(0, 300);
      resolve({ ok: false, limit: /limit|out of (extra )?usage/i.test(message), message });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}

async function look(i: number, name: string, tmp: string, who: ReturnType<typeof logins>, tried: Set<string>): Promise<Look> {
  const at = (p: string) => path.join(dir, `${p}-${i + 1}.png`);
  if (!fs.existsSync(at('mac'))) return { name, differences: [], error: 'no Mac picture to compare with' };
  const others = OTHERS.filter(([, p]) => fs.existsSync(at(p)));
  if (!others.length) return { name, differences: [] };
  const image = (file: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(shrink(file, tmp)).toString('base64') } });
  const content: unknown[] = [{ type: 'text', text: `The thread: "${name}". Reference, the Mac app:` }, image(at('mac'))];
  for (const [label, p] of others) content.push({ type: 'text', text: `${label}:` }, image(at(p)));
  content.push({ type: 'text', text: `Compare ${others.map(([l]) => l).join(', ')} with the reference. JSON only.` });
  for (;;) {
    const id = pickInPool(who.pool, who.accounts, { provider: 'claude', exclude: [...tried] });
    const account = who.accounts.find((a) => a.id === id);
    if (!account) return { name, differences: [], error: 'no Claude login with room in the small-model pool' };
    const r = await ask(who.claudePath, account, content);
    if (!r.ok) {
      if (r.limit) { tried.add(account.id); continue; }
      return { name, differences: [], error: r.message };
    }
    try {
      const parsed = JSON.parse(outermostBraces(r.text) ?? '') as { differences?: Difference[] };
      const labels = new Set<string>(others.map(([l]) => l));
      const differences = (parsed.differences ?? []).filter((d) => labels.has(d.surface) && typeof d.what === 'string' && d.what.trim());
      return { name, differences };
    } catch {
      return { name, differences: [], error: `an answer that isn't JSON: ${r.text.slice(0, 200)}` };
    }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-parity-shrink-'));
const looks: Look[] = [];
try {
  const who = logins();
  const tried = new Set<string>();
  // Three at a time: sixteen scenarios, each a call of a minute or so.
  const queue = seed.threads.map((t, i) => [i, t.name] as const);
  const all: Look[] = new Array(queue.length);
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) all[next[0]] = await look(next[0], next[1], tmp, who, tried);
  }));
  looks.push(...all);
} catch (e) {
  for (const t of seed.threads) looks.push({ name: t.name, differences: [], error: (e as Error).message });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
fs.writeFileSync(path.join(dir, 'looks.json'), JSON.stringify(looks, null, 2));
for (const l of looks) for (const d of l.differences) console.log(`${l.name}: ${d.surface} looks different: ${d.what}`);
