import crypto from 'node:crypto';
import type { SessionSink } from '../types.ts';
import type { RecordValue } from './rpc.ts';
import { truncateResultText, type NormalizerContext } from '../context.ts';
import { computeEditDiff, toolKind, toolTitle, truncateInput } from '../../tools.ts';
import { displayToolName } from './tools.ts';

// Pi sends delta-only updates and an authoritative completed message. A
// message/block pair keeps the same item ID from first delta through final.
export class PiNormalizer {
  private messageId?: string;
  private openTools = new Set<string>();
  error?: string;
  aborted = false;

  private sink: SessionSink;
  private context?: NormalizerContext;
  constructor(sink: SessionSink, context?: NormalizerContext) { this.sink = sink; this.context = context; }

  handle(record: RecordValue): void {
    if (record.type === 'tool_execution_start' && typeof record.toolCallId === 'string') {
      this.openTools.add(record.toolCallId);
      const args = record.args ?? {}, name = String(record.toolName ?? 'tool');
      const display = displayToolName(name);
      this.sink.output({ kind: 'event', event: { type: 'tool.call', itemId: record.toolCallId, name, kind: toolKind(display), title: toolTitle(display, args, this.context?.cwd ?? ''), input: truncateInput(args) } });
      if (this.context && ['edit', 'write'].includes(name) && typeof args.path === 'string') {
        const input = name === 'edit' ? { file_path: args.path, old_string: args.oldText, new_string: args.newText } : { file_path: args.path, content: args.content };
        const diff = computeEditDiff(name === 'edit' ? 'Edit' : 'Write', input, this.context.readFile(args.path));
        if (diff) this.sink.output({ kind: 'event', event: { type: 'edit.diff', itemId: record.toolCallId, path: diff.path, hunks: diff.hunks } });
      }
    }
    if (record.type === 'tool_execution_end' && typeof record.toolCallId === 'string') {
      this.openTools.delete(record.toolCallId);
      const blocks: RecordValue[] = Array.isArray(record.result?.content) ? record.result.content : [];
      const text = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
      const images = [];
      if (this.context) for (const block of blocks) if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        try { images.push(this.context.saveImage(block.data, block.mimeType, record.toolCallId)); } catch { /* Ignore invalid image data. */ }
      }
      const result = this.context ? truncateResultText(text, record.toolCallId, this.context) : { text, truncated: false };
      this.sink.output({ kind: 'event', event: { type: 'tool.result', itemId: record.toolCallId, ok: record.isError !== true, images, ...result } });
    }
    if (record.type === 'message_start' && record.message?.role === 'assistant') {
      this.messageId = crypto.randomUUID();
      this.error = undefined;
    }
    if (record.type === 'message_update') {
      const event = record.assistantMessageEvent;
      if (!event || !['text_delta', 'thinking_delta'].includes(event.type) || typeof event.delta !== 'string' || !Number.isInteger(event.contentIndex) || event.contentIndex < 0) return;
      this.messageId ??= crypto.randomUUID();
      this.sink.output({ kind: 'delta', delta: { type: event.type === 'text_delta' ? 'assistant.text.delta' : 'reasoning.delta', itemId: `${this.messageId}:${event.contentIndex}`, text: event.delta } });
    }
    if (record.type === 'message_end' && record.message?.role === 'assistant') {
      const message = record.message;
      this.messageId ??= crypto.randomUUID();
      if (Array.isArray(message.content)) message.content.forEach((block: RecordValue, index: number) => {
        const itemId = `${this.messageId}:${index}`;
        if (block?.type === 'text' && typeof block.text === 'string') this.sink.output({ kind: 'event', event: { type: 'assistant.text', itemId, text: block.text } });
        if (block?.type === 'thinking' && typeof block.thinking === 'string') this.sink.output({ kind: 'event', event: { type: 'reasoning', itemId, text: block.thinking } });
      });
      this.error = message.stopReason === 'error' ? (message.errorMessage ?? 'Pi model request failed.') : message.stopReason === 'length' ? 'Pi reached the model output limit.' : undefined;
      this.aborted = message.stopReason === 'aborted';
      this.messageId = undefined;
    }
  }

  closeOpen(): void {
    for (const itemId of this.openTools) this.sink.output({ kind: 'event', event: { type: 'tool.result', itemId, ok: false, text: 'Pi stopped before this tool finished.', truncated: false, images: [] } });
    this.openTools.clear();
  }
}
