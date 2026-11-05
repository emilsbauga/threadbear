import crypto from 'node:crypto';
import type { SessionSink } from '../types.ts';
import type { RecordValue } from './rpc.ts';

// Pi sends delta-only updates and an authoritative completed message. A
// message/block pair keeps the same item ID from first delta through final.
export class PiNormalizer {
  private messageId?: string;
  error?: string;
  aborted = false;

  private sink: SessionSink;
  constructor(sink: SessionSink) { this.sink = sink; }

  handle(record: RecordValue): void {
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
}
