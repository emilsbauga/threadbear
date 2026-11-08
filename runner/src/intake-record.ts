import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFileSync } from './fsutil.ts';

export type IntakeRecord = {
  clientId: string; receiptId: string; receivedAt: number;
  attachments?: { id: string; name: string; mediaType: string; size: number; sha256: string }[];
  message: { messageId: string; source: 'email' | 'telegram'; sourceMessageId: string; text: string; sentAt: string; sender?: string };
};
export function intakeThreadId(clientId: string, receiptId: string): string {
  const h = crypto.createHash('sha256').update('threadbear-intake-v1:' + JSON.stringify([clientId, receiptId])).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
const marker = (home: string, item: IntakeRecord) => path.join(home, 'intake-imports', intakeThreadId(item.clientId, item.receiptId) + '.json');
export function savedIntake(home: string, item: IntakeRecord): string | undefined {
  const file = marker(home, item);
  if (!fs.existsSync(file)) return undefined;
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (row.clientId !== item.clientId || row.receiptId !== item.receiptId || row.threadId !== intakeThreadId(item.clientId, item.receiptId)) throw new Error('Invalid intake completion marker');
  return row.threadId;
}
export function rememberIntake(home: string, item: IntakeRecord, threadId: string): void {
  if (threadId !== intakeThreadId(item.clientId, item.receiptId)) throw new Error('Intake thread identity mismatch');
  // Publish completion only after the thread directory entry is durable.
  for (const dir of [path.join(home, 'threads', threadId), path.join(home, 'threads')]) {
    if (!fs.existsSync(dir)) continue;
    const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  atomicWriteFileSync(marker(home, item), JSON.stringify({ clientId: item.clientId, receiptId: item.receiptId, threadId }), 0o600);
  for (const dir of [path.join(home, 'intake-imports'), home]) {
    const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
