// How much of a free Convex plan this runner is using, as near as a runner can
// tell, and the once-only question that turns full sync on for an install from
// before it was the default (docs/full-convex.md step 6).
//
// A runner only holds a deploy key and a runner key, and neither can read the
// team's usage: that takes a Convex login (the dashboard, or the API with a
// team token). So this counts what it can: the bytes of every mutation this
// runner sends, by day, kept for 30 days. Measured on Mike's deployment
// (13 Nov 2026, 15 minutes of prod logs), all reads and writes came to 1.7
// times what runners wrote, so the I/O estimate doubles what was sent to leave
// room for phones and the website. Storage is the tool output sent in the last
// 30 days, as that's how long full sync keeps it, plus a third for indexes.
// Both are estimates, and only of this runner: the plan's limits are the team's,
// shared with its other projects and runners.
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60_000;
export const WINDOW_DAYS = 30;
// Convex's Free plan (docs.convex.dev/production/state/limits).
export const FREE_IO_BYTES = 1_000_000_000;
export const FREE_STORAGE_BYTES = 500_000_000;
// Warn early: the limits are the team's, and this sees one runner.
export const WARN_AT = 0.7;
// All I/O for each byte a runner writes (1.7 measured), rounded up.
export const IO_PER_SENT_BYTE = 2;
export const STORAGE_PER_BODY_BYTE = 1.3;
// How often the counts are written to disk at most.
const SAVE_MS = 60_000;

type Day = { sent: number; bodies: number };
type File = { days: Record<string, Day> };

export type ConvexUse = {
  // What this runner sent in the last 30 days, and the part that was tool output.
  sent: number;
  bodies: number;
  // Estimates, against Free's monthly I/O and its storage.
  io: number;
  storage: number;
  // When it was first counted, so a count that's only days old says so.
  since: string;
  // Set once either estimate passes WARN_AT of Free's limit.
  warning?: string;
};

export class ConvexUseTally {
  private file: string;
  private now: () => number;
  private days: Record<string, Day> = {};
  private since: number;
  private dirty = false;
  private savedAt = 0;

  constructor(opts: { home: string; now?: () => number }) {
    this.file = path.join(opts.home, 'convex-use.json');
    this.now = opts.now ?? Date.now;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as File;
      // Only well-formed days: it's a cache of counts, and a broken one starts again.
      if (saved?.days && typeof saved.days === 'object' && !Array.isArray(saved.days)) {
        for (const [k, d] of Object.entries(saved.days)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(Date.parse(k)) && d && Number.isFinite(d.sent) && Number.isFinite(d.bodies)) this.days[k] = { sent: d.sent, bodies: d.bodies };
        }
      }
    } catch {
      // None yet.
    }
    const first = Object.keys(this.days).sort()[0];
    this.since = first ? Date.parse(first) : this.now();
    this.prune();
  }

  /** One mutation sent: its arguments' size in bytes, and whether it was tool output. */
  record(bytes: number, isBodies: boolean): void {
    if (!(bytes > 0)) return;
    const key = dayKey(this.now());
    const d = (this.days[key] ??= { sent: 0, bodies: 0 });
    d.sent += bytes;
    if (isBodies) d.bodies += bytes;
    this.dirty = true;
    if (this.now() - this.savedAt >= SAVE_MS) this.save();
  }

  save(): void {
    // Days dropping out of the window are a change too.
    if (this.prune()) this.dirty = true;
    if (!this.dirty) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ days: this.days }) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      this.savedAt = this.now();
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }

  use(): ConvexUse {
    const from = dayKey(this.now() - (WINDOW_DAYS - 1) * DAY_MS);
    let sent = 0;
    let bodies = 0;
    for (const [k, d] of Object.entries(this.days)) {
      if (k < from) continue;
      sent += d.sent;
      bodies += d.bodies;
    }
    return estimate({ sent, bodies, since: new Date(this.since).toISOString(), days: Math.max(1, (this.now() - this.since) / DAY_MS) });
  }

  private prune(): boolean {
    const from = dayKey(this.now() - WINDOW_DAYS * DAY_MS);
    let gone = false;
    for (const k of Object.keys(this.days)) {
      if (k < from) {
        delete this.days[k];
        gone = true;
      }
    }
    return gone;
  }
}

// The estimate from 30 days' counts, scaled up to a month while there are
// fewer days than that, so a busy first week warns before the month is out.
export function estimate(c: { sent: number; bodies: number; since: string; days: number }): ConvexUse {
  const scale = WINDOW_DAYS / Math.min(WINDOW_DAYS, Math.max(1, c.days));
  const io = Math.round(c.sent * IO_PER_SENT_BYTE * scale);
  // Bodies are kept 30 days, so what's stored is a month's worth however long it's been.
  const storage = Math.round(c.bodies * STORAGE_PER_BODY_BYTE * scale);
  const out: ConvexUse = { sent: c.sent, bodies: c.bodies, io, storage, since: c.since };
  const ioOver = io >= FREE_IO_BYTES * WARN_AT;
  const storageOver = storage >= FREE_STORAGE_BYTES * WARN_AT;
  if (ioOver || storageOver) out.warning = warningText(io, storage, ioOver, storageOver);
  return out;
}

export function warningText(io: number, storage: number, ioOver: boolean, storageOver: boolean): string {
  const what = [ioOver ? `about ${mb(io)} of database I/O a month` : '', storageOver ? `about ${mb(storage)} of stored tool output` : ''].filter(Boolean).join(' and ');
  return (
    `Convex: this runner looks to be heading for ${what}, near the Free plan's limits (1 GB of I/O a month, 0.5 GB stored). ` +
    `It's an estimate, and the limits are your team's. On Free, writes can start failing once you're over. ` +
    `To use less, turn full sync off ("sync": { "full": false } in runner.json); or move to a paid plan in the Convex dashboard. ` +
    `On a paid plan already? Hide this with "sync": { "usageWarning": false }.`
  );
}

function mb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
