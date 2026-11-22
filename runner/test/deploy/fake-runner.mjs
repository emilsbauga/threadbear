// Stands in for src/main.ts in the deploy tests: the test commits it as
// runner/src/main.ts in a throwaway repo, so releases are tiny and need no
// packages (their npm ci installs nothing). It speaks just enough of the
// protocol over a hand-rolled WebSocket: auth, hello, runner.status,
// runner.restart and threads.list.
//
// mode.json next to it sets how this commit behaves:
//   crash: "always" | "launched"  exit 1 at startup; "launched" only under
//                                 launch.mjs (not in the smoke test)
//   oldRunner: true               no runner.restart, like runners before it
//   goodAfterMs: n                mark lastGood after n ms (default 200, -1 never)
//   crashAfterMs: n               under launch.mjs, exit 1 n ms after it
//                                 starts listening (passes the first hello)
//   handover: true                an idle restart with busy threads hands
//                                 over (launch.mjs starts current beside
//                                 it); it stops listening and exits 0 once
//                                 fake-busy.json is empty
// <home>/fake-busy.json lists the threads that count as running,
// <home>/fake-background.json the background work ({ threadId, tasks }[]),
// while <home>/fake-hang-restart exists runner.restart never answers (a
// runner too busy to reply), and while <home>/fake-no-resume exists it says
// it won't send the resume (as for a thread resumed 3 times this hour).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
// Copied beside this file (as src/main.ts) by deploy.test.ts, so releases
// have it too: the real runner's auth challenge (docs/protocol/connection.md, "Auth").
import { authProof, isNonce, newNonce } from './rpc-auth.ts';

const here = import.meta.dirname;
const mode = JSON.parse(fs.readFileSync(path.join(here, 'mode.json'), 'utf8'));
const home = process.env.THREADBEAR_HOME;
const release = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'release.json'), 'utf8')).id;
  } catch {
    return null;
  }
})();
const version = `9.9.9+${release ?? 'source'}`;
// The contract with launch.mjs: state.json lives in <THREADBEAR_HOME>/runner,
// which only exists for an installed runner, never in the smoke test.
const stateFile = path.join(home, 'runner', 'state.json');
const launched = fs.existsSync(stateFile);

console.log(`fake runner ${version} starting (pid ${process.pid})`);
if (mode.crash === 'always' || (mode.crash === 'launched' && launched)) {
  console.log('fake runner: crashing on purpose');
  process.exit(1);
}

fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
const tokenFile = path.join(home, 'secrets', 'runner-token');
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(16).toString('hex') + '\n', { mode: 0o600 });
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const startedAt = new Date().toISOString();

// Like main.ts: launch.mjs's watchdog applies, and a clean exit after
// listening isn't counted as a crash.
export const REPORTS_LISTENING = true;
let pending = null;

const readList = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, name), 'utf8'));
  } catch {
    return [];
  }
};
const busy = () => readList('fake-busy.json');
const background = () => readList('fake-background.json');
let timer = null;

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function handle(method, params) {
  switch (method) {
    case 'hello':
      return { runnerVersion: version, protocol: 1, accounts: [], defaults: { cwd: '/tmp' } };
    case 'runner.status':
      if (mode.oldRunner) break;
      return {
        version,
        release: release ?? undefined,
        pid: process.pid,
        startedAt,
        home,
        liveClis: 0,
        running: busy(),
        background: background(),
        ...(pending ? { pendingRestart: { ...pending, waitingFor: busy() } } : {}),
      };
    case 'threads.list':
      return { threads: busy().map((id) => ({ id, title: `Thread ${id}`, status: 'running' })) };
    case 'runner.restart': {
      if (mode.oldRunner) break;
      fs.appendFileSync(path.join(home, 'fake-restart-calls.ndjson'), JSON.stringify(params) + '\n');
      if (fs.existsSync(path.join(home, 'fake-hang-restart'))) return NO_REPLY;
      if (params.cancel) {
        // Unlike the real one, it doesn't put current back.
        clearInterval(timer);
        const had = pending !== null;
        pending = null;
        return { scheduled: false, waitingFor: [], ...(had ? { note: 'fake: current left alone' } : {}) };
      }
      const waitingFor = params.when === 'now' ? [] : [...new Set([...busy(), ...background().map((b) => b.threadId)])];
      pending = { when: params.when ?? 'idle', requestedAt: new Date().toISOString(), release: params.release, resumeThreadId: params.resume?.threadId };
      // As the real one does, it still shows the restart as pending until it
      // lets go of the port.
      if (mode.handover && waitingFor.length && process.env.THREADBEAR_SUPERVISED === '1' && process.send) {
        handOver();
        return { scheduled: true, waitingFor: [], handover: { keeps: waitingFor } };
      }
      // Like the real one: exit 0 once nothing is running, and launchd
      // (here the fake one) starts it again.
      clearInterval(timer);
      timer = setInterval(() => {
        if (params.when === 'now' || (busy().length === 0 && background().length === 0)) {
          clearInterval(timer);
          setTimeout(() => process.exit(0), 50);
        }
      }, 100);
      const bg = background().filter((b) => waitingFor.includes(b.threadId));
      const noResume = params.resume && fs.existsSync(path.join(home, 'fake-no-resume')) ? { noResume: 'fake: resumed too often' } : {};
      return { scheduled: true, waitingFor, ...(bg.length ? { background: bg } : {}), ...noResume };
    }
  }
  throw Object.assign(new Error(`Unknown method ${method}`), { code: -32601 });
}

const NO_REPLY = Symbol('no reply');

// As main.ts does: let go of the port, ask launch.mjs for the next runner,
// finish the busy threads, then exit 0.
function handOver() {
  setTimeout(() => {
    server.close();
    for (const s of sockets) s.destroy();
    process.on('message', (m) => {
      if (m?.type !== 'handover') return;
      writeJsonAtomic(path.join(home, `fake-handover-${process.pid}.json`), m);
      if (!m.ok) process.exit(0);
      const t = setInterval(() => {
        if (busy().length === 0) {
          clearInterval(t);
          process.exit(0);
        }
      }, 100);
    });
    process.send({ type: 'handover' });
  }, 50);
}
const sockets = new Set();

// The smallest WebSocket server that works with Node's WebSocket client:
// the upgrade handshake, masked client frames in, unmasked text frames out.
function frame(text) {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([head, body]);
}

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});
server.on('upgrade', (req, socket) => {
  const accept = crypto
    .createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  let authed = false;
  const challenge = newNonce();
  // Its own listening port, as the real runner binds its proofs to.
  const channel = { server: 'primary', port: socket.localPort };
  socket.write(frame(JSON.stringify({ jsonrpc: '2.0', method: 'auth.challenge', params: { version: 1, nonce: challenge, port: channel.port } })));
  socket.on('error', () => {});
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (buf[1] & 0x80) !== 0;
      if (buf.length < off + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      off += masked ? 4 : 0;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);
      if (opcode === 0x8) {
        socket.end(Buffer.from([0x88, 0]));
        return;
      }
      if (opcode !== 0x1) continue;
      const msg = JSON.parse(payload.toString('utf8'));
      if (!authed) {
        const p = msg.params ?? {};
        if (msg.method === 'auth.prove' && isNonce(p.nonce) && p.proof === authProof(token, 'client', challenge, p.nonce, channel)) {
          authed = true;
          socket.write(frame(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { proof: authProof(token, 'runner', challenge, p.nonce, channel) } })));
        } else if (msg.method === 'auth' && p.token === token) {
          authed = true;
          socket.write(frame(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })));
        } else socket.end(Buffer.from([0x88, 0]));
        continue;
      }
      let reply;
      try {
        const result = handle(msg.method, msg.params ?? {});
        if (result === NO_REPLY) continue;
        reply = { jsonrpc: '2.0', id: msg.id, result };
      } catch (e) {
        reply = { jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32000, message: e.message } };
      }
      socket.write(frame(JSON.stringify(reply)));
    }
  });
});

server.listen(Number(process.env.THREADBEAR_PORT ?? 0), '127.0.0.1', () => {
  const { port } = server.address();
  writeJsonAtomic(path.join(home, 'runner.json'), { port });
  console.log(`threadbear-runner listening on ${port}`);
  globalThis.threadbearLaunch?.listening?.();
  if (launched && typeof mode.crashAfterMs === 'number') {
    setTimeout(() => {
      console.log('fake runner: dying after it started, on purpose');
      process.exit(1);
    }, mode.crashAfterMs);
  }
  const goodAfter = mode.goodAfterMs ?? 200;
  // main.ts does this after 60 s; the tests can't wait that long.
  if (launched && release && goodAfter >= 0) {
    setTimeout(() => {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      writeJsonAtomic(stateFile, { ...state, lastGood: release });
    }, goodAfter);
  }
});

process.on('SIGTERM', () => process.exit(0));
