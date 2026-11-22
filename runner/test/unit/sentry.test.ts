// Only the installed runner reports to Sentry: a release on the real data
// dir. Dev runners, tests and sandbox installs never do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultHome } from '../../src/config.ts';
import { cleanError, ERROR_CLASSES, errorKind, logLineEvent, safeFields, scrubEvent, scrubForSentry, sentryOptions, sentryWanted, useSentryMask } from '../../src/sentry.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';

const RELEASE_ID = '20261029T012558Z-3e0bd5d';
const MIKES = 'https://github.com/mikecann/threadbear.git';

test("a release of Mike's repo on the real data dir reports", () => {
  assert.equal(sentryWanted(defaultHome(), {}, RELEASE_ID, MIKES), true);
  assert.equal(sentryWanted(defaultHome(), {}, RELEASE_ID, 'git@github.com:mikecann/threadbear.git'), true);
});

test("someone's fork, or a copy with no origin, never reports to Mike's Sentry", () => {
  assert.equal(sentryWanted(defaultHome(), {}, RELEASE_ID, 'https://github.com/someone/threadbear.git'), false);
  assert.equal(sentryWanted(defaultHome(), {}, RELEASE_ID, undefined), false);
});

test('a runner from a checkout never reports, even on the real data dir', () => {
  assert.equal(sentryWanted(defaultHome(), {}, undefined, MIKES), false);
});

test('a release on another data dir (a sandbox install, a test) never reports', () => {
  assert.equal(sentryWanted(tmpDir(), {}, RELEASE_ID, MIKES), false);
});

test('THREADBEAR_SENTRY=off and NODE_ENV=test turn it off', () => {
  assert.equal(sentryWanted(defaultHome(), { THREADBEAR_SENTRY: 'off' }, RELEASE_ID, MIKES), false);
  assert.equal(sentryWanted(defaultHome(), { NODE_ENV: 'test' }, RELEASE_ID, MIKES), false);
});

test('only the named fields of a log line go, the error as its kind alone', () => {
  const fields = { error: 'x'.repeat(1200), threadId: 't1', pid: 4, prompt: 'private words', file: '/Users/someone/notes.md', nested: { a: 1 }, method: 'm'.repeat(300) };
  // Before main.ts has handed over the known secret values, only numbers and the error's kind.
  assert.deepEqual(Object.keys(safeFields(fields)).sort(), ['error', 'pid']);
  useSentryMask((t) => t);
  const out = safeFields(fields);
  assert.deepEqual(Object.keys(out).sort(), ['error', 'method', 'pid', 'threadId']);
  assert.equal(out.error, 'Error');
  assert.equal((out.method as string).length, 200);
  assert.equal(safeFields({ error: "TypeError: Cannot read properties of undefined (reading 'secret words')" }).error, 'TypeError');
  assert.equal(safeFields({ error: "Error: ENOENT: no such file or directory, open '/Users/x/private.md'" }).error, 'Error (ENOENT)');
  assert.equal(safeFields({ error: 'Error: git fetch failed: fatal: EXAMPLESECRETKEY rejected' }).error, 'Error', "a capitals word isn't a code");
});

test('a WARN line goes as a warning, grouped by its message with ids taken out', () => {
  const now = 1_000_000;
  const a = logLineEvent('warning', 'could not tell 6f1c2d3e-1111-4222-8333-944445555666 the app restarted', { error: 'Thread not found: x' }, now);
  assert.equal(a?.level, 'warning');
  assert.equal(a?.title, 'could not tell <id> the app restarted');
  assert.deepEqual(a?.fingerprint, ['runner-log', 'warning', 'could not tell <id> the app restarted']);
  // Another thread's id is the same fault, inside the hour: nothing more.
  assert.equal(logLineEvent('warning', 'could not tell 0a0b0c0d-1111-4222-8333-944445555666 the app restarted', undefined, now + 1000), null);
  // An hour on it goes again.
  assert.ok(logLineEvent('warning', 'could not tell 0a0b0c0d-1111-4222-8333-944445555666 the app restarted', undefined, now + 60 * 60_000));
});

test('a WARN and an ERROR with the same text are separate issues', () => {
  const now = 2_000_000;
  assert.ok(logLineEvent('error', 'phone command failed (both levels)', undefined, now));
  assert.ok(logLineEvent('warning', 'phone command failed (both levels)', undefined, now));
});

test('model limits and Convex sync network blips are never sent', () => {
  assert.equal(logLineEvent('warning', 'model call failed', { error: 'rate limited' }), null);
  assert.equal(logLineEvent('warning', 'convex sync failed; will retry', { error: 'TypeError: fetch failed' }), null);
  // A Convex sync failure that isn't the network still goes.
  assert.ok(logLineEvent('warning', 'convex sync failed; will retry', { error: 'ArgumentValidationError: bad field' }));
});

test('uncaught exceptions are left to reportException, which has the stack', () => {
  assert.equal(logLineEvent('error', 'uncaught exception', { error: 'boom' }), null);
});

test('the RPC method goes in the title, so different requests failing are separate issues', () => {
  const now = 3_000_000;
  const a = logLineEvent('error', 'request failed', { method: 'panels.convexKey', error: 'x' }, now);
  const b = logLineEvent('error', 'request failed', { method: 'runners.list', error: 'fetch failed' }, now);
  assert.equal(a?.title, 'request failed (panels.convexKey)');
  assert.notDeepEqual(a?.fingerprint, b?.fingerprint);
});

// Daybreak finding 155: errors quote what they were looking at (git's stderr
// names a remote with its token in the URL), and the `error` field and
// exceptions went to Sentry as they were. Every event is scrubbed as it
// leaves, by the real SDK's beforeSend, and dropped if the scrub fails.
const GIT_URL = 'https://x-access-token:ghs_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789@github.com/mikecann/private.git';
const BARE = 'https://ghp_SecretTokenValue0123456789abcdefABCDEF@example.com/repo.git';
const PRIVATE = 'zebra-private-marker-4471';
// Text no rule or known value knows: an error quoting a thread's words.
const THREAD_TEXT = 'my landlord owes me four hundred dollars';
// Built, so the SDK's source lines around a frame (this file, in a test) don't hold them.
const LEAKS = [['ghs', 'AbCd'].join('_'), ['ghp', 'Secret'].join('_'), ['x', 'access', 'token'].join('-'), PRIVATE, ['landlord', 'owes'].join(' ')];

async function capture(fn: (S: typeof import('@sentry/node')) => void | Promise<void>): Promise<string> {
  const S = await import('@sentry/node');
  const sent: string[] = [];
  useSentryMask((text) => text.split(PRIVATE).join('[REDACTED]'));
  S.init({
    ...sentryOptions(),
    dsn: 'https://public@o1.ingest.sentry.io/1',
    transport: () => ({
      send: async (envelope: unknown) => {
        sent.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  });
  try {
    await fn(S);
    await S.flush(2000);
  } finally {
    await S.close(2000);
    useSentryMask((t) => t);
  }
  return sent.join('\n');
}

test('a credential in a git URL or a known private value never leaves in a log line event', async () => {
  useSentryMask((text) => text.split(PRIVATE).join('[REDACTED]'));
  const ev = logLineEvent('warning', `upstream check failed ${PRIVATE} in /Users/someone/secret-project/x`, { error: `Error: git fetch ${GIT_URL} failed: fatal: could not read from ${BARE} (${PRIVATE}) ${THREAD_TEXT}`, prompt: PRIVATE }, 9_000_000);
  assert.ok(ev);
  const local = JSON.stringify(ev);
  for (const bad of LEAKS) assert.ok(!local.includes(bad), `${bad} in ${local}`);
  assert.ok(!local.includes('secret-project'), 'a path in the message');
  assert.equal(ev.extra.error, 'Error');
  useSentryMask((t) => t);
});

test('exceptions, their causes and extras are scrubbed by beforeSend in the real SDK', async () => {
  const out = await capture((S) => {
    const cause = new Error(`git fetch ${BARE} failed: ${PRIVATE} ${THREAD_TEXT}`);
    const e = new TypeError(`fetch from ${GIT_URL} failed: ${THREAD_TEXT}`, { cause });
    S.captureException(e, { tags: { what: 'upstream' }, extra: { error: `${PRIVATE} ${GIT_URL}` } });
    S.captureMessage(`could not reach ${GIT_URL}`, { level: 'warning', extra: { error: `stderr: ${BARE} ${PRIVATE}` } });
  });
  assert.ok(out.length > 0, 'events went out');
  for (const bad of LEAKS) assert.ok(!out.includes(bad), `${bad} left the runner: ${out.slice(Math.max(0, out.indexOf(bad) - 300), out.indexOf(bad) + 100)}`);
  assert.match(out, /"type":"TypeError","value":"TypeError"/, 'the kind goes');
  assert.match(out, /sentry\.test\.ts/, 'and the stack');
});

test("an event whose scrub fails isn't sent", () => {
  useSentryMask(() => {
    throw new Error('check broke');
  });
  try {
    assert.equal(scrubEvent({ message: 'anything at all' }), null);
  } finally {
    useSentryMask((t) => t);
  }
  assert.deepEqual(scrubEvent({ message: 'fine', breadcrumbs: [{ message: PRIVATE }], user: { id: 'x' } }), { message: 'fine' });
});

test("an error's kind is from fixed lists: a made-up class or code from its text never goes", () => {
  assert.equal(errorKind('LandlordOwesMeError: x'), 'Error');
  assert.equal(errorKind('Error: spawn git ENOENT'), 'Error (ENOENT)');
  assert.equal(errorKind('Error: ERR_LANDLORD_OWES_ME and EXAMPLESECRET'), 'Error');
  assert.equal(errorKind('RpcError: Thread not found'), 'RpcError');
  assert.equal(errorKind('anything', 'MadeUpError'), 'Error');
});

test('every error class in src/ is on the list errorKind knows', () => {
  const src = path.join(import.meta.dirname, '..', '..', 'src');
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name.endsWith('.ts')) for (const m of fs.readFileSync(path.join(dir, e.name), 'utf8').matchAll(/class ([A-Za-z0-9]+) extends [A-Za-z]*Error\b/g)) names.add(m[1]!);
    }
  };
  walk(src);
  const missing = [...names].filter((n) => !ERROR_CLASSES.has(n));
  assert.deepEqual(missing, [], 'add these to ERROR_CLASSES in sentry.ts');
});

test("a URL's whole userinfo goes, an @ or a quote in the password too", () => {
  for (const url of ["https://user:p@ssword123@github.com/org/repo.git", "https://carol@corp.com:pass1@host/repo", `https://bob:it's"secret@host/x`]) {
    const out = scrubForSentry(`fatal: ${url} failed`);
    for (const bad of ['ssword123', 'pass1', 'secret', 'carol', 'bob']) assert.ok(!out.includes(bad), `${bad} in ${out}`);
  }
});

test("lines in an error's message that look like stack frames never become frames", async () => {
  const out = await capture((S) => {
    const e = new Error(`boom\n    at fetch (https://${['al', 'ice'].join('')}:${['hunter2', 'pass'].join('')}@${['exam', 'ple.com'].join('')}/a.js:1:1)\n    at ${THREAD_TEXT} (x.js:2:2)`);
    S.captureException(cleanError(e));
  });
  assert.ok(out.length > 0);
  for (const bad of [['hunter2', 'pass'].join(''), ['al', 'ice'].join(''), ['exam', 'ple.com'].join(''), ...LEAKS]) assert.ok(!out.includes(bad), `${bad} left the runner: ${out.slice(Math.max(0, out.indexOf(bad) - 200), out.indexOf(bad) + 60)}`);
  assert.match(out, /sentry\.test\.ts/, 'the real frames stay');
});

test("a frame from outside the runner (a project's patch) goes as no more than that, and no source lines go", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-patch-'));
  const file = path.join(dir, 'secret-client-patch.mjs');
  fs.writeFileSync(file, `export function confidentialHelper() { throw new Error('x'); }\n`);
  try {
    const mod = await import(pathToFileURL(file).href);
    const out = await capture((S) => {
      try {
        mod.confidentialHelper();
      } catch (e) {
        S.captureException(cleanError(e));
      }
    });
    assert.ok(out.length > 0);
    for (const bad of ['secret-client-patch', 'confidentialHelper', 'tb-patch-']) assert.ok(!out.includes(bad), `${bad} left the runner`);
    assert.match(out, /<outside the runner>/);
    assert.ok(!/"(?:pre_context|context_line|post_context)"/.test(out), 'no source lines');
    assert.ok(!out.includes(os.homedir() + '/'), 'no home folder');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an exception type off the list goes as Error', () => {
  const e = scrubEvent({ exception: { values: [{ type: 'LandlordOwesMeError', value: 'x' }] } }) as { exception: { values: { type: string; value: string }[] } };
  assert.deepEqual([e.exception.values[0]!.type, e.exception.values[0]!.value], ['Error', 'Error']);
});

test("eval'd code's frames go as outside the runner, and a frame keeps only its known fields", () => {
  const e = scrubEvent({ exception: { values: [{ type: 'Error', value: 'x', stacktrace: { frames: [
    { filename: '<anonymous>', function: 'eval at secretFn (/Users/x/secret-project/p.ts:1:1)', lineno: 1 },
    { filename: 'node:internal/process/task_queues', function: 'process.processTicksAndRejections', lineno: 2 },
    { filename: path.join(import.meta.dirname, 'x.ts'), function: 'ok', raw_function: 'secretRaw', symbol: 'secretSym', lineno: 3 },
  ] } }] } }) as { exception: { values: { stacktrace: { frames: Record<string, unknown>[] } }[] } };
  const [anon, node, own] = e.exception.values[0]!.stacktrace.frames;
  assert.equal(anon!.function, '<outside the runner>');
  assert.equal(node!.function, 'process.processTicksAndRejections');
  assert.equal(own!.function, 'ok');
  assert.deepEqual(Object.keys(own!).sort(), ['filename', 'function', 'lineno']);
});

test("a relative frame name isn't the runner's own, and the home folder comes out only whole", () => {
  const home = os.homedir();
  const e = scrubEvent({ exception: { values: [{ type: 'Error', value: 'x', stacktrace: { frames: [
    { filename: 'evalmachine.<anonymous>', function: 'secretVm', lineno: 1 },
    { filename: 'src/secret-source-url.ts', function: 'secretUrl', lineno: 2 },
    { filename: path.join(import.meta.dirname, 'x.ts'), function: 'ok', lineno: 3 },
  ] } }] } }) as { exception: { values: { stacktrace: { frames: Record<string, unknown>[] } }[] } };
  const [vm, rel, own] = e.exception.values[0]!.stacktrace.frames;
  assert.equal(vm!.function, '<outside the runner>');
  assert.equal(rel!.function, '<outside the runner>');
  assert.equal(own!.function, 'ok');
  if (import.meta.dirname.startsWith(home + path.sep)) assert.ok(String(own!.filename).startsWith('~' + path.sep));
});
