// The agents Threadbear runs over ACP, one row each: everything that differs
// between them. A new agent is a row here, a row in providers.ts and its
// line in docs/on-your-mac.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account, PermissionMode, Provider } from '../../protocol.ts';
import type { AcpToolCall } from './normalize.ts';
import type { InitializeResult } from './connection.ts';
import { exeName } from '../../platform.ts';
import { grokGuardDir, grokTrusts, guardPluginName } from './grok-guard.ts';

export type AcpProvider = Extract<Provider, 'cursor' | 'opencode' | 'grok'>;

// What a process is started for: the runner's data dir (where Grok's hook
// lives), and whether it's a small job that may use no tools at all.
// trusted: the folder was one the agent trusts when this process started.
// binary: the program about to be started, for an agent whose flags depend
// on its version (OpenCode).
export type AgentRun = { dataDir?: string; noTools?: boolean; trusted?: boolean; binary?: string };

export type AcpAgent = {
  provider: AcpProvider;
  accountId: string;
  title: string;
  // Where the agent keeps its login and settings. Never opened by Threadbear.
  configDir(home: string): string;
  // Whether it looks signed in, without reading what the login holds.
  loggedIn(home: string): boolean;
  // explicit: runner.json's path for it. Undefined when not installed.
  findBinary(o: { explicit?: string; home: string; pathEnv: string }): string | undefined;
  // Read for every process it starts.
  args(run?: AgentRun): string[];
  // Runs the agent's own updater, when Update is pressed.
  updateArgs: string[];
  // Set on every process it starts. What stops a thread running tools
  // unguarded is here, so it applies whatever mode the thread starts in and
  // whatever it changes to later: the runner answers each request (AcpSession).
  // noTools: for a small job, where the agent may not use anything at all.
  env(o?: { noTools?: boolean }): Record<string, string>;
  // Whether the process that answered initialize really is this agent, as
  // the same command name can be another program's.
  identifies(init: InitializeResult): boolean;
  // The agent's own session mode for a thread's permission mode, or
  // undefined to leave it as it is.
  modeFor(mode: PermissionMode): string | undefined;
  // The MCP tool a permission request is for, as `<server>__<tool>`, where
  // the agent says. A threadbear tool's request is allowed as it comes: the
  // runner's own MCP server gates those (tool-gate.ts).
  mcpToolName?(call: AcpToolCall): string | undefined;
  // The plugin a process started with these args must report running before
  // the model does anything each turn, or the turn is stopped (AcpSession).
  guardName?(args: string[]): string | undefined;
  // Whether the agent trusts this folder, read once as a process starts.
  trusts?(cwd: string): boolean;
  // Why a thread in this folder and mode can't run, if it can't. trusted: what
  // trusts said when its process started, which outlasts the trust file.
  // binary: the program the thread runs, for a refusal that depends on its version.
  refuses?(o: { cwd: string; mode: PermissionMode; trusted?: boolean; binary?: string }): string | undefined;
};

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Also config.ts's, for a claude from npm or Homebrew. Relative PATH folders
// never count: a thread's folder must not supply the runner's CLI.
// On Windows the PATH is split on ; and a program is name.exe (a .cmd shim
// can't be started without a shell, so it never counts).
export function onPath(name: string, pathEnv: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  for (const entry of pathEnv.split(win ? ';' : ':')) {
    const dir = win ? entry.trim().replace(/^"(.*)"$/, '$1') : entry;
    if (!P.isAbsolute(dir)) continue;
    const file = P.join(dir, exeName(name, platform));
    if (isExecutableFile(file)) return file;
  }
  return undefined;
}

// Cursor's CLI installs as ~/.local/bin/agent, a link into
// ~/.local/share/cursor-agent/versions/<v>/cursor-agent. `agent` is a generic
// name: on Mike's Mac both ~/.local/bin/agent and the PATH's are Grok's. So a
// file counts only when where it really lives says Cursor.
export function isCursorBinary(file: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return false;
  }
  return /(^|\/)cursor-agent(\/|$)/.test(real);
}

// Grok's installer links ~/.local/bin/grok to ~/.grok/bin/grok and that to
// ~/.grok/downloads/grok-<version>-<platform>. A file counts only when where
// it really lives is named grok: `agent` on Mike's Mac is a link to the same
// binary, and initialize checks the rest (identifies).
export function isGrokBinary(file: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return false;
  }
  return /^grok(-[\w.-]+)?$/.test(path.basename(real));
}

// Every tool asks unless it only reads, so a tool an agent adds later asks
// too. Read of something outside the folder asks as external_directory, and
// the threadbear tools have their own gate (tool-gate.ts).
// question: OpenCode 2's ask-the-user tool. Asking needs no card of its
// own: the question comes as a form (elicitation/create), shown as question
// cards (AcpSession.form). Small jobs, which have no one to ask, deny it.
const ASK_FOR_EVERYTHING: Record<string, string> = { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', external_directory: 'ask', 'threadbear_*': 'allow', question: 'allow' };
const DENY_EVERYTHING: Record<string, string> = { '*': 'deny' };

// OpenCode runs anything without asking unless its config says otherwise,
// and a folder's own opencode.json outranks this inline config: tried on
// 1.18.23 (9 Nov 2026), a repo with `permission: allow` wrote files with no
// request. A repo's .opencode/plugins also run the moment a session opens.
// So the folder's OpenCode config isn't read at all, as a folder's Claude
// settings aren't until trusted. The rules go on the agents too: agent-level
// rules outrank top-level ones.
//
// OpenCode 2 (checked on 2.3.0, 17 Nov 2026) needs more, as its --pure is
// gone and the user's own config folder is a way in too:
// - OPENCODE_CONFIG_DIR replaces ~/.config/opencode there, so OpenCode gets
//   a folder of the runner's own (configDir). A plugin in the user's is
//   imported (its top-level code runs) before any `plugins` rule can turn it
//   off, and one can claim an `opencode.*` id to be turned back on; the
//   user's MCP servers there start with the session, before any rule is
//   asked. On 1 the variable adds a folder, and an empty one adds nothing.
// - It reads OPENCODE_CONFIG_PROJECT_DISABLE before the older name, so an
//   inherited "0" there would win: both are set. OPENCODE_CONFIG (one more
//   file, read even with the project off) is blanked, which reads as unset.
// - The plugins rule turns everything else off and OpenCode's built-ins back
//   on, as they include what applies these rules (opencode.config.agent).
//   1 ignores it.
// Not covered, as they're the user's or an admin's own choices, not a
// folder's: an "Always allow" saved in OpenCode's own app (kept per project
// in its data folder, and outranking "ask" on 2; Threadbear only ever
// answers once), an organisation OpenCode is signed in to (its config comes
// from the data folder too), and system or managed config
// (/Library/Application Support/opencode, /etc/opencode), which outranks
// everything here by design.
export function opencodeEnv(o: { noTools?: boolean } = {}): Record<string, string> {
  const permission = o.noTools ? DENY_EVERYTHING : ASK_FOR_EVERYTHING;
  return {
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_CONFIG_PROJECT_DISABLE: '1',
    OPENCODE_CONFIG_DIR: configDir(),
    OPENCODE_CONFIG: '',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission, agent: { build: { permission }, plan: { permission }, general: { permission }, explore: { permission } }, plugins: ['-*', 'opencode.*'] }),
  };
}

const CONFIG_DIR_PREFIX = 'threadbear-opencode-config-';
let ownConfigDir: string | undefined;

// The runner's own OpenCode config folder: made empty, and only OpenCode
// writes there (its node_modules for plugins). One for the runner's life,
// named with its pid, so a folder is only swept once the runner that made it
// is gone, never from under a session still using it.
function configDir(): string {
  if (ownConfigDir && fs.existsSync(ownConfigDir)) return ownConfigDir;
  const tmp = os.tmpdir();
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith(CONFIG_DIR_PREFIX)) continue;
      const pid = Number(/^(\d+)-/.exec(name.slice(CONFIG_DIR_PREFIX.length))?.[1]);
      if (pid && pidAlive(pid)) continue;
      const dir = path.join(tmp, name);
      try {
        // Without a pid (none are made so now): only once it's old.
        if (!pid && Date.now() - fs.lstatSync(dir).mtimeMs < 24 * 60 * 60_000) continue;
        if (fs.lstatSync(dir).isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  } catch {
    // An unreadable temp folder only means nothing is swept.
  }
  ownConfigDir = fs.mkdtempSync(path.join(tmp, `${CONFIG_DIR_PREFIX}${process.pid}-`));
  return ownConfigDir;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: alive, but someone else's.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// The first .opencode/plugin(s) folder with anything in it, from `cwd` up:
// to the home folder (not its own, which is the user's, as ~/.config's is)
// when `cwd` is under it, else to the root.
export function folderPlugins(cwd: string, home = os.homedir()): string | undefined {
  const top = path.resolve(home);
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (dir === top) return undefined;
    for (const name of ['plugin', 'plugins']) {
      const p = path.join(dir, '.opencode', name);
      try {
        if (fs.readdirSync(p).length) return p;
      } catch {
        // None here.
      }
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

// OpenCode's major version, from `--version` ("1.19.5", "opencode v2.3.0"),
// remembered per binary until it changes on disk. A failed probe isn't
// remembered, so the next process tries again.
const majors = new Map<string, { key: string; major: number }>();
export function opencodeMajor(binary: string | undefined): number | undefined {
  if (!binary) return undefined;
  let key: string;
  try {
    const st = fs.statSync(binary);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return undefined;
  }
  const known = majors.get(binary);
  if (known?.key === key) return known.major;
  try {
    const out = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /(?:^|\s)v?(\d+)\./.exec(out.trim());
    if (!m) return undefined;
    const major = Number(m[1]);
    majors.set(binary, { key, major });
    return major;
  } catch {
    return undefined;
  }
}

export const ACP_AGENTS: Record<AcpProvider, AcpAgent> = {
  opencode: {
    provider: 'opencode',
    accountId: 'opencode-main',
    title: 'OpenCode',
    configDir: (home) => path.join(home, '.config', 'opencode'),
    // Free models work with no login, so being installed is enough.
    loggedIn: () => true,
    findBinary({ explicit, home, pathEnv }) {
      // Whole paths only: a relative one would resolve against the thread's
      // folder when it's run, and that can be anyone's repo.
      if (explicit) return path.isAbsolute(explicit) && isExecutableFile(explicit) ? explicit : undefined;
      const own = path.join(home, '.opencode', 'bin', 'opencode');
      return isExecutableFile(own) ? own : onPath('opencode', pathEnv);
    },
    // --pure: no plugins, the user's own included, for the same reason.
    // OpenCode 2 has no --pure (it prints its help and exits instead of
    // serving), so there the `plugins` rule in opencodeEnv does it.
    args: (run) => ((opencodeMajor(run?.binary) ?? 1) >= 2 ? ['acp'] : ['acp', '--pure']),
    // OpenCode 1 imports a folder's .opencode/plugins/*.js, running its
    // top-level code, even with --pure and the folder's config off (tried on
    // 1.19.5, 17 Nov 2026). 2 doesn't. So unless the thread may run anything
    // anyway, 1 doesn't start where a folder up the tree has plugins.
    refuses: ({ cwd, mode, binary }) =>
      mode !== 'full' && (opencodeMajor(binary) ?? 1) < 2 && folderPlugins(cwd)
        ? `This folder has OpenCode plugins (${folderPlugins(cwd)}), and OpenCode 1 runs their code as a session opens, before anything can ask you. Update OpenCode to 2 (\`opencode upgrade --major\`) or use Full access, then send this again.`
        : undefined,
    updateArgs: ['upgrade'],
    env: opencodeEnv,
    identifies: (init) => /opencode/i.test(init.agentInfo?.name ?? '') || Boolean(init.authMethods?.some((m) => m.id === 'opencode-login')),
    modeFor: (mode) => (mode === 'plan' ? 'plan' : 'build'),
  },
  cursor: {
    provider: 'cursor',
    accountId: 'cursor-main',
    title: 'Cursor',
    configDir: (home) => path.join(home, '.cursor'),
    // Written once the CLI has been used; only whether it exists is read.
    loggedIn: (home) => fs.existsSync(path.join(home, '.cursor', 'cli-config.json')),
    findBinary({ explicit, home, pathEnv }) {
      if (explicit) return path.isAbsolute(explicit) && isExecutableFile(explicit) ? explicit : undefined;
      const candidates = [path.join(home, '.local', 'bin', 'cursor-agent'), onPath('cursor-agent', pathEnv), path.join(home, '.local', 'bin', 'agent'), onPath('agent', pathEnv)];
      return candidates.find((f): f is string => Boolean(f) && isExecutableFile(f!) && isCursorBinary(f!));
    },
    args: () => ['acp'],
    updateArgs: ['update'],
    // Nothing to set: the mode does the job. See modeFor.
    env: () => ({}),
    identifies: (init) => Boolean(init.authMethods?.some((m) => m.id === 'cursor_login')) || /cursor/i.test(init.agentInfo?.name ?? ''),
    // Cursor's own allow-list and a folder's .cursor/cli.json can approve
    // things without a request, and the docs give no way to turn that off.
    // Its ask and plan modes are read-only, so a thread that has to ask
    // runs in one of those: it can't change anything, card or no card.
    modeFor: (mode) => (mode === 'full' ? 'agent' : mode === 'plan' ? 'plan' : 'ask'),
  },
  grok: {
    provider: 'grok',
    accountId: 'grok-main',
    title: 'Grok',
    configDir: (home) => path.join(home, '.grok'),
    // Its login; only whether it exists is read, never what it holds.
    loggedIn: (home) => fs.existsSync(path.join(home, '.grok', 'auth.json')),
    findBinary({ explicit, home, pathEnv }) {
      if (explicit) return path.isAbsolute(explicit) && isExecutableFile(explicit) ? explicit : undefined;
      const candidates = [path.join(home, '.local', 'bin', 'grok'), path.join(home, '.grok', 'bin', 'grok'), onPath('grok', pathEnv)];
      return candidates.find((f): f is string => Boolean(f) && isExecutableFile(f!) && isGrokBinary(f!));
    },
    // Threadbear's hook as a plugin (grok-guard.ts), which is what makes
    // every tool ask: a new one, named at random, for every start. Grok
    // ignores --plugin-dir in its leader mode, so never that, whatever its
    // config says.
    args: (run = {}) => ['agent', '--no-leader', '--plugin-dir', grokGuardDir(run), 'stdio'],
    guardName: guardPluginName,
    // A folder Grok trusts runs its own hooks before anything can ask, and
    // can rewrite what a call does after the guard has looked.
    trusts: (cwd) => grokTrusts(cwd),
    refuses: ({ cwd, mode, trusted }) =>
      mode !== 'full' && (trusted || grokTrusts(cwd))
        ? "Grok trusts this folder, so its own hooks would run before anything could ask you. Use Full access, or take the folder out of Grok's trusted folders (`/hooks-untrust` in Grok there), then send this again."
        : undefined,
    updateArgs: ['update'],
    // A thread's own variables come before these (AcpAdapter.env), so it
    // can't turn Grok's folder trust off (which would load a folder's hooks
    // and rules unasked) or let a sandbox approve shell commands by itself.
    // Neither can get round the hook; they're belt and braces.
    env: () => ({ GROK_FOLDER_TRUST: '1', GROK_SANDBOX_AUTO_ALLOW_BASH: 'false' }),
    identifies: (init) => Boolean(init.authMethods?.some((m) => m.id === 'grok.com')) || init._meta?.grokShell === true,
    // Grok offers no session modes over ACP: the hook makes every mode ask,
    // and each request is answered from the thread's mode (AcpSession).
    modeFor: () => undefined,
    // An MCP tool is called through Grok's use_tool, naming it.
    mcpToolName(call) {
      const input = call.rawInput;
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const r = input as Record<string, unknown>;
        if (r.variant === 'UseTool' && typeof r.tool_name === 'string') return r.tool_name;
      }
      return undefined;
    },
  },
};

export const ACP_PROVIDERS = Object.keys(ACP_AGENTS) as AcpProvider[];

// The logins an ACP agent gives: at most one each, as these CLIs have one
// per machine.
export function acpAccounts(o: { paths?: Partial<Record<AcpProvider, string>>; home?: string; pathEnv?: string } = {}): Account[] {
  const home = o.home ?? os.homedir();
  const pathEnv = o.pathEnv ?? process.env.PATH ?? '';
  const out: Account[] = [];
  for (const p of ACP_PROVIDERS) {
    const agent = ACP_AGENTS[p];
    if (!agent.findBinary({ explicit: o.paths?.[p], home, pathEnv }) || !agent.loggedIn(home)) continue;
    out.push({ id: agent.accountId, provider: p, title: agent.title, configDir: agent.configDir(home) });
  }
  return out;
}
