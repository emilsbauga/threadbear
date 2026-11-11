// Pi's JSONL protocol, independent of either provider SDK.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killGroup, type ProcessRegistry } from '../../proc.ts';
import type { Logger } from '../../log.ts';

export type RecordValue = Record<string, any>;
export type PiRpcOptions = {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  diagnosticsDir: string;
  threadId?: string;
  registry: Pick<ProcessRegistry, 'add' | 'remove'>;
  log: Logger;
  requestTimeoutMs: number; shutdownTimeoutMs: number; maxLineBytes?: number;
  event(record: RecordValue): void;
  exited(error?: Error): void;
};

export class PiRpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<string, { command: string; timer: NodeJS.Timeout; resolve(data: RecordValue): void; reject(error: Error): void }>();
  private writes: Promise<void> = Promise.resolve();
  private buffer = '';
  private diagnostics = '';
  private closing = false;
  private failure?: Error;
  private done = false;
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;

  private options: PiRpcOptions;
  constructor(options: PiRpcOptions) {
    this.options = options;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: 'pipe', detached: true });
    if (this.child.pid) options.registry.add(this.child.pid, options.command, options.threadId);
    options.log.debug('Pi RPC process started', { pid: this.child.pid });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.read(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      // Never parse diagnostics or put their potentially private contents in
      // runner errors/telemetry. Retain only a bounded, private local tail.
      this.diagnostics = (this.diagnostics + chunk).slice(-32 * 1024);
      try {
        fs.mkdirSync(options.diagnosticsDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(options.diagnosticsDir, 'pi-stderr.log'), this.diagnostics, { mode: 0o600 });
      } catch { /* Diagnostics must not interrupt a turn. */ }
    });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.on('error', error => this.fail(error));
    // A descendant can keep stdio open after its leader exits. Stop the
    // owned group on exit so close (and pending request cleanup) can follow.
    this.child.once('exit', () => {
      if (this.child.pid) killGroup(this.child.pid, 'SIGKILL');
    });
    this.child.on('close', (code, signal) => {
      if (this.done) return;
      this.done = true;
      if (!this.closing && !this.failure) this.failure = new Error(`Pi exited unexpectedly (${code ?? signal ?? 'unknown'}).`);
      // Classify only; do not echo native diagnostics into the error.
      if (/session.*(?:not found|does not exist)|no session.*found/i.test(this.diagnostics)) {
        this.failure = new PiMissingSessionError();
      }
      if (this.child.pid) {
        options.registry.remove(this.child.pid);
      }
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(this.failure ?? new Error('Pi session closed.')); }
      this.pending.clear();
      this.resolveClosed();
      options.log.debug('Pi RPC process closed', { pid: this.child.pid, code, signal });
      options.exited(this.failure);
    });
  }

  get alive(): boolean { return !this.closing && !this.failure && !this.done; }

  request(command: string, data: RecordValue = {}): Promise<RecordValue> {
    if (!this.alive) return Promise.reject(this.failure ?? new Error('Pi session is closed.'));
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Pi ${command} request timed out.`);
        reject(error); this.fail(error);
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { command, timer, resolve, reject });
      const payload = JSON.stringify({ ...data, type: command, id }) + '\n';
      // write's callback observes stream backpressure; one complete JSONL
      // record is submitted at a time, including when callers overlap.
      this.writes = this.writes.then(() => new Promise<void>((done, failed) => {
        if (!this.alive) return failed(new Error('Pi session closed before writing a request.'));
        this.child.stdin.write(payload, error => error ? failed(error) : done());
      }));
      void this.writes.catch(error => this.fail(error));
    });
  }

  respondUI(id: string, answer: RecordValue): Promise<void> {
    const payload = JSON.stringify({ ...answer, type: 'extension_ui_response', id }) + '\n';
    this.writes = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (!this.alive) return reject(new Error('Pi session is closed.'));
      this.child.stdin.write(payload, error => error ? reject(error) : resolve());
    }));
    return this.writes;
  }

  private read(chunk: string): void {
    if (this.done || this.failure) return;
    this.buffer += chunk;
    const max = this.options.maxLineBytes ?? 16 * 1024 * 1024;
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/, '');
      this.buffer = this.buffer.slice(at + 1);
      if (Buffer.byteLength(line) > max) return this.fail(new Error('Pi RPC record exceeded the size limit.'));
      if (!line) continue;
      let record: RecordValue;
      try {
        record = JSON.parse(line);
        if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.type !== 'string') throw new Error();
      } catch { return this.fail(new Error('Pi emitted an invalid RPC record.')); }
      if (record.type === 'response') {
        const pending = this.pending.get(record.id);
        if (!pending) continue;
        this.pending.delete(record.id); clearTimeout(pending.timer);
        if (record.command !== pending.command) {
          const error = new Error('Pi RPC response command did not match the request.');
          pending.reject(error);
          return this.fail(error);
        }
        if (record.success === true) pending.resolve(record.data ?? {});
        else pending.reject(new Error(typeof record.error === 'string' ? record.error : 'Pi rejected the request.'));
      } else {
        try { this.options.event(record); } catch { return this.fail(new Error('Pi RPC event could not be processed.')); }
      }
    }
    if (Buffer.byteLength(this.buffer) > max) this.fail(new Error('Pi RPC record exceeded the size limit.'));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.kill();
  }

  terminate(error: Error): void { this.fail(error); }

  kill(): void {
    this.closing = true;
    if (this.child.pid && !this.done) killGroup(this.child.pid, 'SIGKILL');
    else if (!this.done) this.child.kill('SIGKILL');
  }

  async end(hard = false): Promise<void> {
    if (this.done) return;
    this.closing = true;
    if (hard) this.kill();
    else this.child.stdin.end();
    const timer = setTimeout(() => this.kill(), this.options.shutdownTimeoutMs);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}

export class PiMissingSessionError extends Error {
  constructor() { super('The Pi session to resume was not found.'); }
}
