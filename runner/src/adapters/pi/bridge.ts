import http from 'node:http';
import path from 'node:path';
import { runsAsCodeByName, codeWriteNote, type CodeWrite } from '../../code-writes.ts';
import crypto from 'node:crypto';
import { AgentTools, jsonSchema, type ToolDefinition } from '../../agent-tools.ts';
import { toolTitle, truncateInput } from '../../tools.ts';
import type { PermissionMode, PiProfile } from '../../protocol.ts';
import type { SessionSink } from '../types.ts';
import { displayToolName } from './tools.ts';

export type PiBridgeOptions = {
  toolContext?: PiProfile['toolContext'];
  tools: ToolDefinition[];
  sink: SessionSink;
  cwd(): string;
  mode(): PermissionMode;
  runsAsCode?(file: string): CodeWrite;
  rules(): Iterable<string>;
  addRules(rules: string[]): void;
};

export class PiBridge {
  private options: PiBridgeOptions;
  private token = crypto.randomBytes(32).toString('hex');
  private server: http.Server;
  private pending = new Set<AbortController>();
  private host: AgentTools;
  private closing?: Promise<void>;
  constructor(options: PiBridgeOptions) {
    this.options = options;
    this.host = new AgentTools(options.tools, { ...options, requestApproval: req => options.sink.requestApproval(req) });
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
  }
  async start(): Promise<{ url: string; token: string }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Pi tool bridge did not bind.');
    return { url: `http://127.0.0.1:${address.port}`, token: this.token };
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (data: unknown, status = 200) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); } };
    if (req.headers.authorization !== `Bearer ${this.token}`) { reply({ error: 'Unauthorized' }, 403); return; }
    if (req.method === 'GET' && req.url === '/tools') {
      reply({ toolContext: this.options.toolContext ?? 'auto', tools: this.options.tools.map(tool => ({ name: `mcp__threadbear__${tool.name}`, label: tool.name, description: tool.description, parameters: jsonSchema(tool) })) }); return;
    }
    if (req.method !== 'POST' || !['/tool', '/approve'].includes(req.url ?? '')) { reply({ error: 'Not found' }, 404); return; }
    const controller = new AbortController(); this.pending.add(controller);
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { reply({ error: 'Pi tool request is too large' }, 413); return; }
        chunks.push(Buffer.from(chunk));
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (controller.signal.aborted) return;
      if (!data || typeof data.name !== 'string' || !data.input || typeof data.input !== 'object' || Array.isArray(data.input)) { reply({ error: 'Invalid tool request' }, 400); return; }
      if (req.url === '/tool') {
        reply(await this.host.call({ namespace: 'threadbear', tool: data.name, arguments: data.input, callId: String(data.id ?? '') }, { fromChild: false, signal: controller.signal }));
      } else reply(await this.approve(data.name, data.input, String(data.id ?? ''), controller.signal));
    } catch { reply({ error: 'Pi tool request failed or was cancelled' }, 400); }
    finally { this.pending.delete(controller); }
  }
  private async approve(name: string, input: Record<string, unknown>, id: string, signal: AbortSignal): Promise<{ allow: boolean; reason?: string }> {
    if (this.options.mode() === 'full' || ['read', 'ls', 'find', 'grep', 'tool_search'].includes(name)) return { allow: true };
    const rule = `pi-native:${name}:${crypto.createHash('sha256').update(JSON.stringify([this.options.cwd(), input])).digest('hex')}`;
    const file = typeof input.path === 'string' ? path.resolve(this.options.cwd(), input.path) : undefined;
    const codeWrite = file && ['edit', 'write'].includes(name) ? runsAsCodeByName(file) || (this.options.runsAsCode?.(file) ?? false) : false;
    if (!codeWrite && [...this.options.rules()].includes(rule)) return { allow: true };
    const answer = await this.options.sink.requestApproval({ toolUseId: id, name: `pi__${name}`, title: toolTitle(displayToolName(name), input, this.options.cwd()) + (codeWrite ? ` · ${codeWriteNote(codeWrite)}` : ''), input: truncateInput(input), canAlwaysAllow: !codeWrite, signal });
    const allow = !signal.aborted && (answer.decision === 'allow' || answer.decision === 'allowAlways');
    if (allow && !codeWrite && answer.decision === 'allowAlways') this.options.addRules([rule]);
    return { allow, ...(allow ? {} : { reason: answer.message ?? 'The user did not approve this action.' }) };
  }
  close(): Promise<void> {
    this.closing ??= new Promise<void>(resolve => {
      for (const controller of this.pending) controller.abort();
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    return this.closing;
  }
}
