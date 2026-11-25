// CEF's sandbox is off (Mike's choice, docs/gpui-port.md). Notice a stale
// pin even when nobody remembers to check. This never installs a runtime.
import path from 'node:path';
import fs from 'node:fs';
import type { Clock, TimerHandle } from '../clock.ts';
import { atomicWriteFileSync, readJsonSync } from '../fsutil.ts';

export const PIN = '156.0.31+ge603d97+chromium-156.0.8078.100';
export const DAY_MS = 24 * 60 * 60_000;
const INDEX = 'https://cef-builds.spotifycdn.com/index.json';
// crates.io's sparse index entry for the `cef` crate (tauri-apps/cef-rs): a
// line of JSON per release. Its build metadata is the CEF it binds, and a CEF
// with no bindings yet is one Threadbear can't move to (desktop/web/Cargo.toml).
const BINDINGS = 'https://index.crates.io/3/c/cef';
type Checked = { latest: string; behindSince?: number };
// `bindings`: the newest CEF version cef-rs has published bindings for.
type Saved = Partial<Checked> & { pin: string; bindings?: string; checkedAt?: number; attemptedAt?: number; failingSince?: number };
type Deps = { home: string; clock: Clock; platform: string; changed(): void; fetchIndex?: () => Promise<unknown>; fetchBindings?: () => Promise<string>; installed?: () => boolean };

export function runtimeInstalled(root: string): boolean {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).some((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'installed.json')));
  } catch { return false; }
}

function parts(version: string): number[] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)\+g[a-f0-9]+\+chromium-\d+\.\d+\.\d+\.\d+$/.exec(version);
  return m ? m.slice(1).map(Number) : undefined;
}
/** The newest CEF a published, unyanked `cef` crate binds, as "156.0.31". */
export function newestBindings(text: string): string | undefined {
  let best: number[] | undefined;
  for (const line of text.split('\n')) {
    let v: { vers?: unknown; yanked?: unknown };
    try { v = JSON.parse(line) as typeof v; } catch { continue; }
    if (v.yanked !== false || typeof v.vers !== 'string') continue;
    // "156.7.0+156.0.31"; a prerelease ("-beta") isn't one to move to.
    const m = /^\d+\.\d+\.\d+\+(\d+)\.(\d+)\.(\d+)$/.exec(v.vers);
    const numbers = m?.slice(1).map(Number);
    if (numbers && (!best || newer(numbers, best))) best = numbers;
  }
  return best?.join('.');
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function inspectIndex(raw: unknown, platform: string, now: number): Checked {
  const versions = (raw as Record<string, { versions?: unknown[] }> | null)?.[platform]?.versions;
  if (!Array.isArray(versions)) throw Error('no builds for this platform');
  const stable: { version: string; numbers: number[]; at: number }[] = [];
  for (const value of versions) {
    const v = value as { channel?: string; cef_version?: string; files?: { type?: string; last_modified?: string }[] } | null;
    if (v?.channel !== 'stable') continue;
    // Intel history reaches CEF's pre-Chromium-version naming scheme.
    if (typeof v.cef_version === 'string' && /^3\.\d+\.\d+\.g[a-f0-9]+$/.test(v.cef_version)) continue;
    const numbers = typeof v.cef_version === 'string' ? parts(v.cef_version) : undefined;
    const file = Array.isArray(v.files) ? v.files.find((f) => f?.type === 'minimal') : undefined;
    // Historical entries sometimes have only symbols or a client archive.
    if (!file) continue;
    const at = Date.parse(file.last_modified ?? '');
    if (!numbers || !Number.isFinite(at) || at > now) throw Error('invalid stable build');
    stable.push({ version: v.cef_version!, numbers, at });
  }
  if (!stable.length) throw Error('no stable builds');
  const latest = stable.reduce((a, b) => newer(b.numbers, a.numbers) ? b : a);
  const behind = stable.filter((v) => newer(v.numbers, parts(PIN)!));
  return { latest: latest.version, ...(behind.length ? { behindSince: Math.min(...behind.map((v) => v.at)) } : {}) };
}

async function fetchIndex(): Promise<unknown> {
  return JSON.parse(await fetchText(INDEX));
}

async function fetchBindings(): Promise<string> {
  return fetchText(BINDINGS);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!response.ok || !response.body) throw Error('CEF index unavailable');
  // The index is metadata, not an archive. Bound it even without Content-Length.
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) throw Error('CEF index too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class WebRuntimeUpdates {
  private saved: Saved;
  private timer?: TimerHandle;
  private work?: Promise<void>;
  private stopped = true;
  private file: string;

  private d: Deps;

  constructor(d: Deps) {
    this.d = d;
    this.file = path.join(d.home, 'runner', 'web-runtime-check.json');
    const saved = readJsonSync<Saved>(this.file);
    this.saved = saved?.pin === PIN ? saved : { pin: PIN };
  }

  // Something to do: flagged on the Updates icon and in tb status.
  problem(): string | undefined {
    if (this.d.installed && !this.d.installed()) return undefined;
    const s = this.saved, now = this.d.clock.now();
    const lines: string[] = [];
    const behind = this.behind();
    if (behind && !behind.waiting) lines.push(behind.line);
    if (s.failingSince !== undefined && now - s.failingSince >= 3 * DAY_MS) {
      lines.push("Couldn't check CEF security updates for three days. The web runtime may be out of date.");
    }
    return lines.length ? lines.join(' ') : undefined;
  }

  // Behind, but nobody can move it until cef-rs publishes bindings: a quiet
  // line in the Updates panel, never a flag (Mike, 24 Nov: every flagged
  // line is one he can act on).
  note(): string | undefined {
    if (this.d.installed && !this.d.installed()) return undefined;
    const behind = this.behind();
    return behind?.waiting ? behind.line : undefined;
  }

  private behind(): { line: string; waiting: boolean } | undefined {
    const s = this.saved;
    if (s.behindSince === undefined || this.d.clock.now() - s.behindSince < 14 * DAY_MS) return undefined;
    const pin = PIN.split('+')[0], latest = s.latest?.split('+')[0];
    const bindings = s.bindings?.split('.').map(Number);
    // Only a CEF cef-rs has bindings for is one an agent can move to.
    const waiting = bindings !== undefined && !newer(bindings, parts(PIN)!);
    const next = !bindings ? "Ask your agent to update Threadbear's web runtime."
      : waiting ? `Waiting on cef-rs to support ${latest}.`
      : `Ask your agent to update it to ${s.bindings}, the newest cef-rs supports.`;
    return { line: `Web runtime: CEF ${pin} is over two weeks behind stable ${latest}. ${next} Chromium's sandbox is off.`, waiting };
  }

  start(): void {
    this.stopped = false;
    this.schedule(60_000);
  }
  stop(): void { this.stopped = true; this.timer?.cancel(); }
  private schedule(ms: number): void {
    this.timer = this.d.clock.setTimeout(() => {
      if (this.stopped) return;
      const elapsed = this.d.clock.now() - (this.saved.attemptedAt ?? 0);
      // A clock corrected backwards must neither delay checks for weeks nor
      // overflow Node's 32-bit timer delay into a tight 1 ms loop.
      const wait = elapsed < 0 ? 0 : Math.min(DAY_MS, DAY_MS - elapsed);
      if (wait > 0) { this.schedule(wait); return; }
      void this.check().finally(() => { if (!this.stopped) this.schedule(DAY_MS); });
    }, ms);
  }
  check(): Promise<void> {
    if (this.work) return this.work;
    this.work = this.run().finally(() => { this.work = undefined; });
    return this.work;
  }
  private async run(): Promise<void> {
    if (this.d.installed && !this.d.installed()) { this.d.changed(); return; }
    const now = this.d.clock.now();
    try {
      const checked = inspectIndex(await (this.d.fetchIndex ?? fetchIndex)(), this.d.platform, now);
      // Preserve the age if the CDN prunes the oldest newer build later.
      const behindSince = checked.behindSince === undefined ? undefined : Math.min(checked.behindSince, this.saved.behindSince ?? Infinity);
      // Which advice the warning gives, not whether there is one: a failure
      // here keeps the last answer.
      const bindings = await (this.d.fetchBindings ?? fetchBindings)().then(newestBindings, () => undefined) ?? this.saved.bindings;
      this.saved = { pin: PIN, checkedAt: now, attemptedAt: now, ...checked, behindSince, ...(bindings ? { bindings } : {}) };
    } catch {
      this.saved = { ...this.saved, attemptedAt: now, failingSince: Math.min(this.saved.failingSince ?? now, now) };
    }
    try { atomicWriteFileSync(this.file, JSON.stringify(this.saved)); } catch { /* Keep the in-memory warning on a full disk. */ }
    this.d.changed();
  }
}
