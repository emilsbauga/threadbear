// What CLI updates leave on disk: <home>/updates.json (the state the app's
// Usage popover shows, kept across restarts) and <home>/updates.ndjson (one
// line per check, install, hold or failure, with the command's output).
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, readJsonSync } from '../fsutil.ts';
import type { CliPolicy, CliStatus, Provider } from '../protocol.ts';

export const HISTORY_MAX_LINES = 500;
export const OUTPUT_MAX_BYTES = 10 * 1024;

// Per provider: the last check, the last update's outcome, the policy the
// app chose (over runner.json's), and how many sessions in a row failed to
// start on a new version.
export type ProviderState = {
  policy?: CliPolicy;
  latestVersion?: string;
  checkedAt?: string;
  update?: CliStatus['update'];
  startFailures?: { version: string; count: number; warned?: boolean };
};
export type UpdatesFile = Partial<Record<Provider, ProviderState>>;

export type HistoryEntry = {
  at: string;
  provider: Provider;
  action: 'check' | 'update' | 'install' | 'activate' | 'hold' | 'cleanup' | 'notice';
  ok: boolean;
  version?: string;
  message?: string;
  output?: string;
  [k: string]: unknown;
};

export class UpdateHistory {
  readonly stateFile: string;
  readonly logFile: string;

  constructor(home: string) {
    this.stateFile = path.join(home, 'updates.json');
    this.logFile = path.join(home, 'updates.ndjson');
  }

  read(): UpdatesFile {
    return readJsonSync<UpdatesFile>(this.stateFile) ?? {};
  }

  write(state: UpdatesFile): void {
    atomicWriteFileSync(this.stateFile, JSON.stringify(state, null, 2) + '\n');
  }

  append(entry: HistoryEntry): void {
    const e = { ...entry };
    if (typeof e.output === 'string') e.output = tail(e.output, OUTPUT_MAX_BYTES);
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, JSON.stringify(e) + '\n');
      this.trim();
    } catch {
      // The history is for reading afterwards; an update never fails on it.
    }
  }

  entries(): HistoryEntry[] {
    try {
      return fs
        .readFileSync(this.logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as HistoryEntry);
    } catch {
      return [];
    }
  }

  // Keeps the last HISTORY_MAX_LINES lines. Updates are rare, so reading
  // the file back on each append costs nothing.
  private trim(): void {
    const lines = fs.readFileSync(this.logFile, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= HISTORY_MAX_LINES) return;
    atomicWriteFileSync(this.logFile, lines.slice(-HISTORY_MAX_LINES).join('\n') + '\n');
  }
}

// The end of a command's output, where its error usually is.
export function tail(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return '…' + buf.subarray(start).toString('utf8');
}
