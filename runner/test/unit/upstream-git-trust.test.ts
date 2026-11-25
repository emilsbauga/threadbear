// Daybreak 179 and 180, 24 Nov 2026: the release check runs by itself, two
// minutes after the runner starts, in a checkout whose .git Threadbear didn't
// make (an archive, a shared drive, or the .git a thread's worktree shares).
// 179: its git ran the checkout's own transport programs (core.sshCommand,
// credential helpers, a remote's uploadpack or remote helper), its hooks and
// anything an include named, before a signature was looked at. 180: it read a
// signed release's commit through the checkout's replacement objects, so a
// release's key files, notes and tree could come from a commit nobody signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { FakeClock } from '../../src/clock.ts';
import { keyStatePath } from '../../src/release-keys.ts';
import { fetchableUrl, gitAsync, gitBytes, signersPath } from '../../src/upstream.ts';
import { LATER, commit, git, key, keyLine, pinnedKeys, pubOf, release, upstreamFor, world } from '../helpers/upstream-harness.ts';
import { tmpDir } from '../helpers/fakes.ts';
import { skipOnWindows } from '../helpers/platform.ts';

const NO_SH = skipOnWindows('the sentinels and the stand-in ssh are shell scripts');

// A program that only says it ran, by name, in `ran`. `then`: what it goes on
// to do, so a fetch it stands in for can still work.
function sentinel(dir: string, name: string, ran: string, then = 'exit 1'): string {
  const file = path.join(dir, `sentinel-${name}`);
  fs.writeFileSync(file, `#!/bin/sh\necho ${name} >> '${ran}'\n${then}\n`, { mode: 0o755 });
  return file;
}

const ranIn = (ran: string) => (fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').trim().split('\n').filter(Boolean) : []);

async function withPath<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const was = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${was ?? ''}`;
  try {
    return await run();
  } finally {
    process.env.PATH = was;
  }
}

test("179: the automatic check runs nothing the checkout's own git config names", NO_SH, async () => {
  const w = world();
  const ran = path.join(w.root, 'ran');
  const bin = path.join(w.root, 'bin');
  fs.mkdirSync(bin);
  const real = commit(w.mike, 'b.txt', 'Real');
  git(w.mike, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${w.mikeKey.priv}`, 'tag', '-s', '-m', 'Threadbear 2026-11-06', 'release/2026-11-06');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  // A remote's own programs: its upload-pack (which then does the real
  // work, so an old runner would go on and reach the rest) and a remote helper.
  git(w.theirs, 'config', 'remote.upstream.uploadpack', sentinel(w.root, 'uploadpack', ran, 'exec git-upload-pack "$@"'));
  fs.writeFileSync(path.join(bin, 'git-remote-tbsentinel'), `#!/bin/sh\necho remote-helper >> '${ran}'\nexit 1\n`, { mode: 0o755 });
  // Transport programs and helpers, some of them only through an include.
  git(w.theirs, 'config', 'core.sshCommand', sentinel(w.root, 'sshcommand', ran));
  git(w.theirs, 'config', 'credential.helper', `!${sentinel(w.root, 'credential', ran)}`);
  git(w.theirs, 'config', 'core.alternateRefsCommand', sentinel(w.root, 'alternate-refs', ran));
  const hooks = path.join(w.root, 'hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'reference-transaction'), `#!/bin/sh\necho reference-transaction-hook >> '${ran}'\n`, { mode: 0o755 });
  const included = path.join(w.root, 'included.gitconfig');
  fs.writeFileSync(included, `[core]\n\thooksPath = ${hooks}\n[log]\n\tshowSignature = true\n[gpg "ssh"]\n\tprogram = ${sentinel(w.root, 'gpg-ssh', ran)}\n`);
  git(w.theirs, 'config', 'include.path', included);
  // The same hook where git looks by default, and one named in config (git 2.54).
  fs.copyFileSync(path.join(hooks, 'reference-transaction'), path.join(w.theirs, '.git', 'hooks', 'reference-transaction'));
  fs.chmodSync(path.join(w.theirs, '.git', 'hooks', 'reference-transaction'), 0o755);
  git(w.theirs, 'config', 'hook.planted.event', 'reference-transaction');
  git(w.theirs, 'config', 'hook.planted.command', sentinel(w.root, 'config-hook', ran));
  const s = await withPath(bin, () => upstreamFor(w.theirs, w.home).check());
  assert.deepEqual(ranIn(ran), [], 'nothing the checkout named ran');
  assert.equal(s.release?.commit, real, s.reason ?? '');
  assert.equal(s.release?.tag, 'release/2026-11-06');

  // A remote helper or an ext:: address the checkout rewrites upstream to is
  // never reached either: the check fails rather than run it.
  git(w.theirs, 'config', 'remote.upstream.vcs', 'tbsentinel');
  const viaHelper = await withPath(bin, () => upstreamFor(w.theirs, w.home).check());
  assert.deepEqual(ranIn(ran), [], 'no remote helper ran');
  assert.equal(viaHelper.release?.commit, real, viaHelper.reason ?? '');
  git(w.theirs, 'config', '--unset', 'remote.upstream.vcs');
  git(w.theirs, 'config', 'protocol.ext.allow', 'always');
  git(w.theirs, 'config', `url.ext::sh -c ${sentinel(w.root, 'ext', ran)} #.insteadOf`, path.join(w.root, 'mike.git'));
  const viaExt = await upstreamFor(w.theirs, w.home).check();
  assert.deepEqual(ranIn(ran), [], 'no ext:: command ran');
  assert.equal(viaExt.state, 'failed');
});

test('179: an ssh upstream is reached with ssh as the owner has it, never the checkout\'s core.sshCommand', NO_SH, async () => {
  const w = world();
  const ran = path.join(w.root, 'ran');
  const bin = path.join(w.root, 'bin');
  fs.mkdirSync(bin);
  // ssh as found on PATH: here a stand-in that runs the remote command on
  // this Mac, as sshd would on the other end.
  // None of git's variables go across, as with real ssh.
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\necho "$@" >> '${path.join(w.root, 'ssh-args')}'\nfor last; do :; done\nexec env -i PATH="$PATH" HOME="$HOME" sh -c "$last"\n`, { mode: 0o755 });
  git(w.theirs, 'remote', 'set-url', 'upstream', `ssh://tb-test-host${path.join(w.root, 'mike.git')}`);
  git(w.theirs, 'config', 'core.sshCommand', sentinel(w.root, 'sshcommand', ran));
  const included = path.join(w.root, 'included.gitconfig');
  fs.writeFileSync(included, `[core]\n\tsshCommand = ${sentinel(w.root, 'included-sshcommand', ran)}\n[credential]\n\thelper = !${sentinel(w.root, 'credential', ran)}\n`);
  git(w.theirs, 'config', 'include.path', included);
  const s = await withPath(bin, () => upstreamFor(w.theirs, w.home, new FakeClock(LATER), { localRemotes: false }).check());
  assert.deepEqual(ranIn(ran), []);
  assert.equal(s.release?.tag, 'release/2026-10-01', s.reason ?? '');
  assert.match(fs.readFileSync(path.join(w.root, 'ssh-args'), 'utf8'), /tb-test-host/, 'it went over ssh');
});

test("179: an https remote asks none of the checkout's credential helpers", NO_SH, async (t) => {
  const dir = tmpDir('tb-https-');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { encoding: 'utf8' });
  if (made.status !== 0) return t.skip('no openssl to make a certificate with');
  // A server that wants a password for everything, as a private repo does.
  let asked = 0;
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (_req, res) => {
    asked++;
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const repo = path.join(dir, 'r');
    git(dir, 'init', '-q', repo);
    const ran = path.join(dir, 'ran');
    // The owner's own config takes the stand-in's certificate (the
    // checkout's http.* settings stop network git: below).
    const owner = path.join(dir, 'owner.gitconfig');
    fs.writeFileSync(owner, '[http]\n\tsslVerify = false\n');
    git(repo, 'config', 'credential.helper', `!${sentinel(dir, 'credential', ran)}`);
    git(repo, 'config', `credential.https://127.0.0.1:${port}.helper`, `!${sentinel(dir, 'credential-for-url', ran)}`);
    git(repo, 'config', 'core.askPass', sentinel(dir, 'askpass', ran));
    const url = fetchableUrl(`https://127.0.0.1:${port}/mikecann/threadbear.git`)!;
    const global = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = owner;
    try {
      await assert.rejects(gitAsync(repo, ['ls-remote', url], { network: 'remote', owner: true }));
    } finally {
      process.env.GIT_CONFIG_GLOBAL = global;
    }
    assert.ok(asked > 0, 'it reached the server');
    assert.deepEqual(ranIn(ran), []);
    // A proxy or certificate setting of the checkout's own isn't used at all.
    git(repo, 'config', 'http.proxy', 'http://127.0.0.1:9');
    git(repo, 'config', 'http.sslVerify', 'false');
    await assert.rejects(gitAsync(repo, ['ls-remote', url], { network: 'remote' }), /changes where or how git reaches a remote/);
  } finally {
    server.close();
  }
});

test('179: only an https or ssh address of a plain host and path is fetched from', () => {
  assert.equal(fetchableUrl('https://github.com/mikecann/threadbear.git'), 'https://github.com/mikecann/threadbear.git');
  assert.equal(fetchableUrl('https://someone:token@github.com/mikecann/threadbear'), 'https://github.com/mikecann/threadbear', 'no user or password');
  assert.equal(fetchableUrl('git@github.com:mikecann/threadbear.git'), 'git@github.com:mikecann/threadbear.git');
  assert.equal(fetchableUrl('ssh://git@github.com:22/mikecann/threadbear.git'), 'ssh://git@github.com:22/mikecann/threadbear.git');
  for (const bad of ['/srv/threadbear.git', 'file:///srv/threadbear.git', 'ext::sh -c touch% /tmp/x', 'git://github.com/mikecann/threadbear', 'http://github.com/mikecann/threadbear', 'fake::https://github.com/x', 'ssh://-oProxyCommand=x/y', '-oProxyCommand=x@host:y', 'git@host:-u', 'https://github.com/x y', 'https://github.com/x\nhttps://evil']) {
    assert.equal(fetchableUrl(bad), undefined, bad);
  }
  assert.equal(fetchableUrl('/srv/threadbear.git', { files: true }), '/srv/threadbear.git', 'a folder only in tests');
});

test('179: a checkout whose upstream is a folder or a program is not checked', async () => {
  const w = world();
  const s = await upstreamFor(w.theirs, w.home, new FakeClock(LATER), { localRemotes: false }).check();
  assert.equal(s.state, 'off');
  assert.match(s.reason ?? '', /isn't an https or ssh one/);
});

// 180. Mike's release L is signed; M is a commit of the attacker's, never
// signed, that announces their key in scripts/release-signers.
function replaced() {
  const w = world();
  const evil = key(w.root, 'evil-key');
  const signed = release(w, 'release/2026-11-06', w.mikeKey.priv);
  git(w.theirs, 'fetch', '-q', 'upstream', 'main');
  // Beside the release, not after it: a replacement that has the commit it
  // replaces as its parent would loop.
  git(w.theirs, 'checkout', '-q', '-b', 'evil', `${signed}~1`);
  git(w.theirs, 'checkout', '-q', signed, '--', '.');
  fs.writeFileSync(path.join(w.theirs, 'scripts', 'release-signers'), `${keyLine(w.mikeKey)}\n${keyLine(evil)}\n`);
  fs.writeFileSync(path.join(w.theirs, 'evil.txt'), 'unsigned code');
  git(w.theirs, 'add', '.');
  git(w.theirs, 'commit', '-q', '-m', 'Unsigned work');
  const forged = git(w.theirs, 'rev-parse', 'HEAD');
  git(w.theirs, 'checkout', '-q', 'main');
  return { w, evil, signed, forged };
}

const waiting = (home: string) => (fs.existsSync(keyStatePath(home)) ? fs.readFileSync(keyStatePath(home), 'utf8') : '');

test("180: a replacement for a signed release's commit stops the check, and nothing of the replacement is read", async () => {
  const { w, evil, signed, forged } = replaced();
  git(w.theirs, 'replace', signed, forged);
  const up = upstreamFor(w.theirs, w.home);
  const s = await up.check();
  assert.equal(s.state, 'failed');
  assert.match(s.reason ?? '', /replacement refs/);
  assert.ok(!waiting(w.home).includes(pubOf(evil)), "the replacement's key isn't waiting to count");
  assert.deepEqual(pinnedKeys(w.home), [pubOf(w.mikeKey)]);
  // Release git reads the signed commit as itself whatever's in refs/replace/.
  assert.ok(!(await gitAsync(w.theirs, ['log', '--format=%s', '-1', signed])).includes('Unsigned work'));
  assert.equal(await gitAsync(w.theirs, ['rev-parse', `${signed}^{tree}`]), git(w.mike, 'rev-parse', `${signed}^{tree}`));
  assert.ok(!(await gitAsync(w.theirs, ['ls-tree', '--name-only', signed])).includes('evil.txt'));

  git(w.theirs, 'replace', '-d', signed);
  const after = await upstreamFor(w.theirs, w.home).check();
  assert.equal(after.release?.commit, signed, after.reason ?? '');
  assert.ok(!after.release?.subjects.includes('Unsigned work'));
  assert.ok(!waiting(w.home).includes(pubOf(evil)));
});

test('180: grafts stop the check too, and release git never reads them', async () => {
  const { w, signed, forged } = replaced();
  const grafts = path.join(w.theirs, '.git', 'info', 'grafts');
  fs.mkdirSync(path.dirname(grafts), { recursive: true });
  // The release's commit given the attacker's commit as its parent.
  fs.writeFileSync(grafts, `${signed} ${forged}\n`);
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.equal(s.state, 'failed');
  assert.match(s.reason ?? '', /grafts/);
  assert.ok(!(await gitAsync(w.theirs, ['rev-list', signed])).split('\n').includes(forged));
  fs.rmSync(grafts);
  assert.equal((await upstreamFor(w.theirs, w.home).check()).release?.commit, signed);
});

test("180: a release's key files are read only as the objects its commit names", async () => {
  const { w, evil, signed } = replaced();
  // Whatever's on disk for the release-signers blob (a forged pack or loose
  // object) is checked against its id before it counts.
  const blob = git(w.mike, 'rev-parse', `${signed}:scripts/release-signers`);
  const up = upstreamFor(w.theirs, w.home, new FakeClock(LATER), {
    gitBytes: (cwd: string, args: string[]) => (args[1] === 'blob' && args[2] === blob ? Promise.resolve(Buffer.from(`${keyLine(w.mikeKey)}\n${keyLine(evil)}\n`)) : gitBytes(cwd, args)),
  });
  const s = await up.check();
  assert.equal(s.state, 'failed');
  assert.match(s.reason ?? '', /isn't the one its id names/);
  assert.ok(!waiting(w.home).includes(pubOf(evil)));
  assert.equal(fs.readFileSync(signersPath(w.home), 'utf8').includes(pubOf(evil)), false);
});

test('180: Mike\'s runner holds its release while his checkout has replacement refs', async () => {
  const w = world();
  commit(w.mike, 'b.txt', 'Newer work');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const tip = git(w.mike, 'rev-parse', 'HEAD');
  git(w.mike, 'replace', tip, git(w.mike, 'rev-parse', 'HEAD~1'));
  const committed = Number(git(w.mike, '--no-replace-objects', 'log', '-1', '--format=%ct')) * 1000;
  const up = upstreamFor(w.mike, w.home, new FakeClock(committed + 2 * 60 * 60_000), { publish: { publish: true, signingKey: w.mikeKey.priv }, runningMainSettled: () => true });
  assert.equal(await up.publishOnce(), undefined);
  assert.match(up.status().held?.why ?? '', /replacement refs/);
  assert.equal(git(w.mike, 'tag', '--list', 'release/2026-*'), 'release/2026-10-01');
});

// Codex's review of this fix: Mike's own publishing, with the checkout's
// config set to run things at each of its steps.
test("179: Mike's runner tags, checks and pushes its release running nothing his checkout's own config names", NO_SH, async () => {
  const w = world();
  const ran = path.join(w.root, 'ran');
  commit(w.mike, 'b.txt', 'Newer work');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  git(w.mike, 'config', 'gpg.ssh.program', sentinel(w.root, 'gpg-ssh', ran));
  git(w.mike, 'config', 'gpg.program', sentinel(w.root, 'gpg', ran));
  git(w.mike, 'config', 'core.sshCommand', sentinel(w.root, 'sshcommand', ran));
  git(w.mike, 'config', 'credential.helper', `!${sentinel(w.root, 'credential', ran)}`);
  git(w.mike, 'config', 'remote.origin.receivepack', sentinel(w.root, 'receivepack', ran, 'exec git-receive-pack "$@"'));
  git(w.mike, 'config', 'remote.origin.uploadpack', sentinel(w.root, 'uploadpack', ran, 'exec git-upload-pack "$@"'));
  git(w.mike, 'config', 'push.gpgSign', 'true');
  git(w.mike, 'config', 'log.showSignature', 'true');
  for (const hook of ['pre-push', 'reference-transaction', 'post-update']) {
    fs.writeFileSync(path.join(w.mike, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook}-hook >> '${ran}'\n`, { mode: 0o755 });
  }
  const up = upstreamFor(w.mike, w.home, new FakeClock(committed + 2 * 60 * 60_000), { publish: { publish: true, signingKey: w.mikeKey.priv }, runningMainSettled: () => true });
  const tag = await up.publishOnce();
  assert.deepEqual(ranIn(ran), []);
  assert.ok(tag, up.status().held?.why ?? 'not tagged');
  assert.ok(git(w.mike, 'ls-remote', 'origin', `refs/tags/${tag}`), 'and pushed');
});

test('180: a revocation whose object is missing fails the check rather than not happening', async () => {
  const w = world();
  const next = key(w.root, 'next-key');
  fs.writeFileSync(signersPath(w.home), `${keyLine(w.mikeKey)}\n${keyLine(next)}\n`);
  // The newer key revokes the older one (only it or a newer key can).
  const signed = release(w, 'release/2026-11-06', next.priv, { 'scripts/release-keys-revoked': `${pubOf(w.mikeKey)}\n` });
  const blob = git(w.mike, 'rev-parse', `${signed}:scripts/release-keys-revoked`);
  const up = upstreamFor(w.theirs, w.home, new FakeClock(LATER), {
    gitBytes: (cwd: string, args: string[]) => (args[1] === 'blob' && args[2] === blob ? Promise.reject(new Error('fatal: not a valid object')) : gitBytes(cwd, args)),
  });
  const s = await up.check();
  assert.equal(s.state, 'failed');
  assert.match(s.reason ?? '', /can't be read/);
  assert.deepEqual(pinnedKeys(w.home), [pubOf(w.mikeKey), pubOf(next)], 'nothing changed');
  // And read as it is, the revocation happens.
  const after = await upstreamFor(w.theirs, w.home).check();
  assert.equal(after.release?.commit, signed, after.reason ?? '');
  assert.deepEqual(pinnedKeys(w.home), [pubOf(next)], 'revoked');
});

test("179: a config setting whose name isn't UTF-8 stops release git rather than slip past being switched off", NO_SH, async () => {
  const w = world();
  const ran = path.join(w.root, 'ran');
  // A config hook (git 2.54) named with byte 0xff, which -c can't name.
  fs.appendFileSync(path.join(w.theirs, '.git', 'config'), Buffer.concat([Buffer.from('[hook "'), Buffer.from([0xff]), Buffer.from(`"]\n\tevent = reference-transaction\n\tcommand = ${sentinel(w.root, 'hook', ran)}\n`)]));
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.deepEqual(ranIn(ran), []);
  assert.equal(s.state, 'failed');
  assert.match(s.reason ?? '', /isn't UTF-8/);
});

// Gemini's review of this fix: a URL given to git is still looked up as a
// remote's name, and the checkout's config can rewrite it.
test("179: a checkout whose config redirects a remote isn't used for network git", async () => {
  const github = 'https://github.com/mikecann/threadbear.git';
  for (const [key, value] of [
    [`url.ssh://attacker@evil.example/r.git.insteadOf`, github],
    [`url.https://evil.example/r.git.pushInsteadOf`, github],
    [`remote.${github}.pushurl`, 'https://evil.example/steal.git'],
    [`remote.${github}.vcs`, 'https'],
    ['http.proxy', 'http://attacker.example:8080'],
    ['http.https://github.com/.sslVerify', 'false'],
  ]) {
    const w = world();
    git(w.theirs, 'remote', 'set-url', 'upstream', github);
    git(w.theirs, 'config', key, value);
    const s = await upstreamFor(w.theirs, w.home, new FakeClock(LATER), { localRemotes: false }).check();
    assert.equal(s.state, 'failed', key);
    assert.match(s.reason ?? '', /changes where or how git reaches a remote/, key);
  }
});

test('179: a remote with two addresses is not fetched from, as git and the check could read different ones', async () => {
  const w = world();
  git(w.theirs, 'config', '--add', 'remote.upstream.url', 'https://github.com/mikecann/threadbear.git');
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.equal(s.state, 'off');
});
