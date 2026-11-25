// What every extra Codex login shares with the main one (~/.codex). Each
// login is its own CODEX_HOME (accounts.ts), and Codex reads its instructions
// (AGENTS.md), hooks (hooks.json), skills (skills/) and settings, MCP servers
// included (config.toml), from that folder alone. A login made with `codex
// login` starts with none of them, so a thread on codex-1 ran without Mike's
// instructions, hooks, most of his skills or his connectors (23 Nov 2026).
//
// So before each Codex session on a login other than the main one, this
// links those back to the main folder, as Token Stats' share-config does for
// Claude logins. Links, not copies, so an edit in ~/.codex is everywhere at
// once; Codex writes config.toml through a link (resolve_symlink_write_paths).
// It never replaces a file of the login's own, with one exception: a
// config.toml holding nothing but Codex's own project trust bookkeeping is
// moved aside (kept beside it) for the link. auth.json, sessions and the
// rest are left alone.
//
// Hooks need one more step. Codex runs a hook only once it's trusted, and
// keeps that trust in config.toml under the hooks.json's own path
// ("<CODEX_HOME>/hooks.json:pre_tool_use:0:0"), so the main login's trust
// doesn't cover the same file reached through another login. hookTrust gives
// the session the hooks Codex says ~/.codex trusts, under the login's path,
// as config overrides: their own hashes, so only hooks trusted in ~/.codex
// run, and one changed since stays untrusted until it's trusted there.
// Where the sign-in lives and what's trusted come from Codex itself
// (config/read and hooks/list on ~/.codex, the Codex adapter's mainHome), as
// reading config.toml by hand was fooled by text inside a multi-line string.
import fs from 'node:fs';
import path from 'node:path';

export type ShareReport = { changes: string[]; skipped: string[] };

const FILES = ['AGENTS.md', 'hooks.json'] as const;
const CONFIG = 'config.toml';

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// The same folder (or one a link leads to): ~/.codex itself needs nothing.
export function sameHome(a: string, b: string): boolean {
  return realOr(a) === realOr(b);
}

// Points `link` at `target`, never over a real file someone made. A link
// that leads nowhere (its target moved) is repointed.
function linkTo(target: string, link: string, report: ShareReport): void {
  if (!exists(target)) {
    // Gone from the main home: so is the login's link to it, rather than
    // left leading nowhere (memory-sync.ts would keep it for good).
    if (isLink(link) && fs.readlinkSync(link) === target) {
      fs.unlinkSync(link);
      report.changes.push(`removed ${link} (${target} is gone)`);
    }
    return;
  }
  if (isLink(link)) {
    if (fs.readlinkSync(link) === target) return;
    if (exists(link)) {
      report.skipped.push(`${link} points somewhere else`);
      return;
    }
    fs.unlinkSync(link);
  } else if (exists(link)) {
    report.skipped.push(`${link} is the login's own, not a link to ${target}`);
    return;
  }
  try {
    fs.symlinkSync(target, link);
    report.changes.push(`linked ${link} -> ${target}`);
  } catch (e) {
    // Windows without the right to make links, say.
    report.skipped.push(`${link}: ${(e as Error).message}`);
  }
}

// A config.toml Codex wrote by itself on a fresh login: only
// `[projects."<folder>"]` tables, each with its trust_level.
export function onlyProjectTrust(text: string): boolean {
  return text.split(/\r?\n/).every((line) => {
    const l = line.trim();
    return l === '' || l.startsWith('#') || /^\[projects\.(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\]$/.test(l) || /^trust_level\s*=\s*"[a-z_]+"$/.test(l);
  });
}

function shareConfig(mainDir: string, loginDir: string, report: ShareReport, stamp: string, store: string | undefined): void {
  const target = path.join(mainDir, CONFIG);
  const link = path.join(loginDir, CONFIG);
  if (!exists(target)) return linkTo(target, link, report);
  // Not known (Codex couldn't be asked): left as it is.
  if (store === undefined) return;
  // The main home keeping its tokens in the Keychain would send the login
  // there too, away from its own auth.json.
  if (store !== 'file') {
    if (isLink(link) && fs.readlinkSync(link) === target) {
      fs.unlinkSync(link);
      report.changes.push(`removed ${link}: ${target} now keeps its sign-in in the ${store} store`);
      return;
    }
    report.skipped.push(`${target} keeps its sign-in in the ${store} store, so ${link} isn't shared`);
    return;
  }
  if (!isLink(link) && exists(link)) {
    let text: string;
    try {
      text = fs.readFileSync(link, 'utf8');
    } catch (e) {
      report.skipped.push(`${link}: ${(e as Error).message}`);
      return;
    }
    if (!onlyProjectTrust(text)) {
      report.skipped.push(`${link} has settings of its own, so it isn't shared`);
      return;
    }
    // Kept by a second name (a hard link, which never replaces a file: an
    // earlier one kept the same day, or another runner's at the same
    // moment), then the first name goes.
    let aside = '';
    for (let n = 1; !aside; n++) {
      const name = `${link}.before-share-${stamp}${n > 1 ? `-${n}` : ''}`;
      try {
        fs.linkSync(link, name);
        aside = name;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 100) throw e;
      }
    }
    // Take whatever holds the name now, and drop it only if it's still the
    // file just kept: one Codex saved there meanwhile goes back.
    const moving = `${aside}.moving-${process.pid}`;
    fs.renameSync(link, moving);
    if (fs.statSync(moving).ino !== fs.statSync(aside).ino) {
      fs.renameSync(moving, link);
      report.skipped.push(`${link} changed while it was being shared; left as it is`);
      return;
    }
    fs.unlinkSync(moving);
    try {
      fs.symlinkSync(target, link);
    } catch (e) {
      // No link (Windows without the right to make one): the login keeps
      // its own file rather than having none, unless something else has
      // taken the name since.
      if (!exists(link) && !isLink(link)) fs.renameSync(aside, link);
      report.skipped.push(`${link}: ${(e as Error).message}`);
      return;
    }
    report.changes.push(`moved ${link} aside to ${aside}`, `linked ${link} -> ${target}`);
    return;
  }
  linkTo(target, link, report);
}

// Each of the main login's skills, as a link in the login's skills/. Hidden
// folders stay the login's own (.system is Codex's, written per home), as
// does any skill the login has itself. A link to a skill since deleted from
// the main folder goes.
function shareSkills(mainDir: string, loginDir: string, report: ShareReport): void {
  const from = path.join(mainDir, 'skills');
  const to = path.join(loginDir, 'skills');
  let names: string[];
  try {
    names = fs.readdirSync(from);
  } catch {
    return;
  }
  if (isLink(to)) return;
  if (exists(to) && !fs.statSync(to).isDirectory()) {
    report.skipped.push(`${to} isn't a folder`);
    return;
  }
  if (!exists(to)) {
    fs.mkdirSync(to, { recursive: true });
    report.changes.push(`made ${to}`);
  }
  for (const name of names.sort()) if (!name.startsWith('.')) linkTo(path.join(from, name), path.join(to, name), report);
  for (const name of fs.readdirSync(to)) {
    const p = path.join(to, name);
    if (isLink(p) && !exists(p) && fs.readlinkSync(p).startsWith(from + path.sep)) {
      fs.unlinkSync(p);
      report.changes.push(`removed ${p} (its skill was deleted)`);
    }
  }
}

// Links what the login is missing. Safe to run before every session: once
// shared, it only looks. `store` is where the main home keeps its sign-in
// (cli_auth_credentials_store as Codex's config/read has it, "file" when
// unset); config.toml is linked only when that's "file", and left alone when
// it isn't known. `stamp` names a moved-aside config.toml.
export function shareCodexHome(mainDir: string, loginDir: string, store: string | undefined, stamp = new Date().toISOString().slice(0, 10)): ShareReport {
  const report: ShareReport = { changes: [], skipped: [] };
  if (!fs.existsSync(mainDir) || !fs.existsSync(loginDir) || sameHome(mainDir, loginDir)) return report;
  // Each step on its own: two threads starting on one login at once race
  // here (one's link or rename finds the other's done), and a step that
  // fails leaves the rest to do theirs.
  const steps = [
    ...FILES.map((name) => () => linkTo(path.join(mainDir, name), path.join(loginDir, name), report)),
    () => shareConfig(mainDir, loginDir, report, stamp, store),
    () => shareSkills(mainDir, loginDir, report),
  ];
  for (const step of steps) {
    try {
      step();
    } catch (e) {
      report.skipped.push((e as Error).message);
    }
  }
  return report;
}

type HookState = { trusted_hash: string; enabled?: false };

// A hook as Codex's hooks/list reports it, for the main home.
export type MainHook = { key: string; trustStatus: string; currentHash: string; enabled?: boolean };

// Config overrides that trust the login's hooks.json as far as Codex itself
// says the main home trusts its own (hooks/list on ~/.codex, so nothing here
// reads config.toml's trust by hand), when the two are the same file. Codex
// keys a hook by its file's path under CODEX_HOME made real, so that's the
// path used for both.
export function hookTrust(hooks: MainHook[], mainDir: string, loginDir: string): Record<string, unknown> {
  if (sameHome(mainDir, loginDir)) return {};
  const mainHooks = path.join(mainDir, 'hooks.json');
  const loginHooks = path.join(loginDir, 'hooks.json');
  if (!exists(mainHooks) || !exists(loginHooks) || realOr(mainHooks) !== realOr(loginHooks)) return {};
  const prefix = `${path.join(realOr(mainDir), 'hooks.json')}:`;
  const loginKey = path.join(realOr(loginDir), 'hooks.json');
  const state: Record<string, HookState> = {};
  for (const h of hooks) {
    if (h.trustStatus !== 'trusted' || !h.key.startsWith(prefix) || !h.currentHash) continue;
    state[`${loginKey}:${h.key.slice(prefix.length)}`] = h.enabled === false ? { trusted_hash: h.currentHash, enabled: false } : { trusted_hash: h.currentHash };
  }
  return Object.keys(state).length ? { 'hooks.state': state } : {};
}
