// A small JSON-RPC client for the runner over a hand-rolled WebSocket, for
// deploy.mjs and its tests. Not Node's built-in WebSocket: on Node 24.22 it
// can throw an uncatchable `setTypeOfService EINVAL` when the server drops
// the connection during the handshake, which is just what a restarting
// runner does. Not the ws package either: deploy.mjs runs without the
// checkout's node_modules.
import crypto from 'node:crypto';
import net from 'node:net';
// Only node:crypto, so this still needs no node_modules.
import { answerChallenge } from '../src/rpc-auth.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Connects to ws://127.0.0.1:<port>/rpc and answers the runner's auth
// challenge (docs/protocol/connection.md, "Auth"): the token never goes out, and the
// runner has to prove it has it too. A refused connection rejects with
// `down: true`: nothing is listening, as while the runner restarts. One
// that sends no challenge (a runner from before 5 Nov 2026, or not the
// runner) rejects with `notProved: true`.
export async function connectRpc(port, token, timeoutMs = 3000) {
  const conn = new Connection(port, timeoutMs);
  try {
    await conn.opened;
    const challenge = await conn.first;
    // Always the runner's main server, on 127.0.0.1 at `port`.
    const { request, runnerProved } = answerChallenge(token, challenge, { port });
    const result = await conn.call('auth.prove', request.params);
    if (!runnerProved(result)) throw Object.assign(new Error("the runner's proof was wrong, so it isn't the runner"), { notProved: true });
  } catch (e) {
    conn.close();
    throw e;
  }
  return conn;
}

class Connection {
  constructor(port, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.upgraded = false;
    this.closed = false;
    const key = crypto.randomBytes(16).toString('base64');
    this.accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    this.opened = new Promise((resolve, reject) => {
      this.openOk = resolve;
      this.openFail = reject;
    });
    // The first message the runner sends: its auth challenge.
    this.first = new Promise((resolve, reject) => {
      this.firstOk = resolve;
      this.firstFail = reject;
    });
    this.first.catch(() => {});
    const firstTimer = setTimeout(() => this.firstFail(Object.assign(new Error("the runner didn't send an auth challenge"), { notProved: true })), timeoutMs);
    this.first.then(
      () => clearTimeout(firstTimer),
      () => clearTimeout(firstTimer),
    );
    const timer = setTimeout(() => this.destroy(new Error('timed out connecting')), timeoutMs);
    this.opened.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
    this.socket = net.connect({ host: '127.0.0.1', port });
    this.socket.on('connect', () =>
      this.socket.write(
        `GET /rpc HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    this.socket.on('data', (d) => this.onData(d));
    this.socket.on('error', (e) => this.destroy(Object.assign(e, { down: e.code === 'ECONNREFUSED' })));
    this.socket.on('close', () => this.destroy(new Error('connection closed')));
  }

  destroy(err) {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.openFail(err);
    this.firstFail(err);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.upgraded) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.buf.subarray(0, end).toString('latin1');
      this.buf = this.buf.subarray(end + 4);
      if (!/^HTTP\/1\.1 101/.test(head) || !head.includes(this.accept)) {
        return this.destroy(new Error(`no WebSocket upgrade (${head.split('\r\n')[0]})`));
      }
      this.upgraded = true;
      this.openOk();
    }
    // Server frames: FIN and opcode, then a 7, 16 or 64 bit length, unmasked.
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x8) return this.destroy(new Error('the runner closed the connection'));
      if (opcode === 0x9) this.send(0xa, payload);
      else if (opcode === 0x1 || opcode === 0x0) {
        this.parts.push(payload);
        if (fin) {
          const text = Buffer.concat(this.parts).toString('utf8');
          this.parts = [];
          this.onMessage(text);
        }
      }
    }
  }

  onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      msg = undefined;
    }
    if (!this.gotFirst) {
      this.gotFirst = true;
      return this.firstOk(msg);
    }
    if (msg === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return; // notifications
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
    else p.resolve(msg.result);
  }

  // Client frames must be masked.
  send(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) {
      head = Buffer.from([0x80 | opcode, 0x80 | 126, 0, 0]);
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([head, mask, body]));
  }

  call(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send(0x1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    });
  }

  // Destroys the socket rather than waiting for the runner's half of the
  // close: a runner shutting down waits for every client to go, so a caller
  // that blocks next (on a synchronous launchctl kickstart -k, which waits
  // for the runner to exit) would hold it up until launchd kills it.
  close() {
    if (this.closed) return;
    try {
      this.send(0x8, Buffer.alloc(0));
    } catch {
      // already gone
    }
    this.destroy(new Error('connection closed'));
  }
}
