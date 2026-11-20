// Box mode's gate on starting processes (src/spawn-gate.ts): while a
// stopping save holds the box, no process starts, however it's asked for,
// but the save's own. Installed in this test's process only (each test file
// is a process of its own).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import cp, { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from 'node:child_process';
import { SPAWNERS, SpawnRefused, asSave, closeSpawns, installSpawnGate, openSpawns } from '../../src/spawn-gate.ts';
import { untrustedGit } from '../../src/safe-git.ts';
import { runCommand } from '../../src/patches.ts';

const SRC = path.join(import.meta.dirname, '..', '..', 'src');

test('closed, every way to start a process is refused, through imports made before the gate went in too; asSave lets the save by', async () => {
  installSpawnGate();
  closeSpawns('a save holds the box');
  const req = createRequire(import.meta.url)('node:child_process') as typeof cp;
  const tries: [string, () => unknown][] = [
    ['spawn', () => spawn('true')],
    ['spawnSync', () => spawnSync('true')],
    ['exec', () => exec('true')],
    ['execSync', () => execSync('true')],
    ['execFile', () => execFile('true')],
    ['execFileSync', () => execFileSync('true')],
    ['fork', () => fork(path.join(SRC, 'clock.ts'))],
    ['default import', () => cp.spawn('true')],
    ['require', () => req.execFileSync('true')],
    ['the class', () => (new cp.ChildProcess() as unknown as { spawn: (o: unknown) => unknown }).spawn({ file: 'true', args: ['true'], stdio: 'ignore' })],
  ];
  for (const [what, start] of tries) assert.throws(start, SpawnRefused, what);
  // The helpers the runner uses, end to end: refused, or failing, never run.
  const stopped = async (f: () => Promise<{ ok: boolean }>) => {
    try {
      return (await f()).ok === false;
    } catch (e) {
      return e instanceof SpawnRefused;
    }
  };
  assert.equal(await stopped(() => untrustedGit(SRC, ['rev-parse', '--show-toplevel'])), true);
  const marker = path.join(SRC, '..', `spawn-gate-${process.pid}`);
  assert.equal(await stopped(() => runCommand(`touch ${marker}`, { cwd: SRC, env: process.env, timeoutMs: 5000 })), true);
  assert.equal(fs.existsSync(marker), false);
  // The save's own git goes.
  assert.equal((await asSave(() => untrustedGit(SRC, ['rev-parse', '--show-toplevel']))).ok, true);
  // But not something started outside it meanwhile.
  let outside: unknown;
  await asSave(async () => {
    await new Promise<void>((r) => setImmediate(() => r()));
  });
  setImmediate(() => {
    try {
      spawnSync('true');
    } catch (e) {
      outside = e;
    }
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(outside instanceof SpawnRefused);
  openSpawns();
  assert.equal(spawnSync('true').status, 0);
});

test("the gate covers every function node:child_process has that starts a process", () => {
  const fns = Object.keys(cp).filter((k) => typeof (cp as unknown as Record<string, unknown>)[k] === 'function');
  // ChildProcess (its spawn is gated) and _forkChild (sets up a child's own IPC) start nothing themselves.
  assert.deepEqual(fns.filter((k) => k !== 'ChildProcess' && k !== '_forkChild').sort(), [...SPAWNERS].sort());
});

// Workers that refuse to start once the gate is installed (the test below
// checks each does).
const WORKERS_REFUSED_IN_BOX = ['trust-off-thread.ts'];

test("the trust worker won't start once the gate is installed", async () => {
  const { TrustOffThread } = await import('../../src/trust-off-thread.ts');
  installSpawnGate();
  assert.throws(() => new TrustOffThread(), /No trust worker in box mode/);
});

test('nothing in runner/src starts a process past the gate', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs|js)$/.test(e.name)) files.push(p);
    }
  };
  walk(SRC);
  const problems: string[] = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(SRC, f);
    // Process bindings below child_process, or another module that starts processes.
    if (/\bprocess\.binding\(|\binternalBinding\(|spawn_wrap|process_wrap|\bposix_spawn/.test(text)) problems.push(`${rel}: a process binding`);
    if (/from ['"](node:)?(cluster|worker_threads)['"]/.test(text) && /\bexecArgv|\bfork\(/.test(text) && !WORKERS_REFUSED_IN_BOX.includes(rel)) problems.push(`${rel}: cluster or worker processes`);
    // What it takes from child_process: only the gated functions, and types.
    for (const m of text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"](?:node:)?child_process['"]/g)) {
      if (m[1]) continue;
      for (const raw of m[2]!.split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
        if (!name || raw.trim().startsWith('type ')) continue;
        if (!(SPAWNERS as readonly string[]).includes(name) && !['ChildProcess', 'ChildProcessWithoutNullStreams', 'SpawnOptions', 'ExecFileOptions'].includes(name)) problems.push(`${rel}: imports ${name} from child_process`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("promisify(exec) and promisify(execFile) keep their contract through the gate ({ stdout, stderr }, .child, the error's output), and are refused while it's closed", async () => {
  installSpawnGate();
  openSpawns();
  const { promisify } = await import('node:util');
  const pFile = promisify(execFile);
  const pExec = promisify(exec);
  const got = pFile(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']);
  assert.ok((got as unknown as { child?: unknown }).child, '.child is there');
  assert.deepEqual(await got, { stdout: 'out', stderr: 'err' });
  // cmd.exe's echo ends its line with \r\n (Windows CI, 18 Nov).
  const echoed = await pExec('echo hi');
  assert.deepEqual({ ...echoed, stdout: echoed.stdout.replace(/\r\n/g, '\n') }, { stdout: 'hi\n', stderr: '' });
  await assert.rejects(pFile(process.execPath, ['-e', 'process.stdout.write("so far"); process.exit(3)']), (e: { code?: number; stdout?: string }) => e.code === 3 && e.stdout === 'so far');
  closeSpawns('a save holds the box');
  await assert.rejects(pFile('true'), SpawnRefused);
  await assert.rejects(pExec('true'), SpawnRefused);
  openSpawns();
});
