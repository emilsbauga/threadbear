// Year-long token… for a login on this runner, asked from another Mac's app
// (docs/protocol.md, `accounts.yearToken` and Accounts, "Year-long tokens on
// another runner"). The Mac app's own helper (desktop/core/src/claude_token.py)
// runs `claude setup-token` in Terminal, which only works for the Mac the app
// is on. Here the runner runs it, under a Python helper in a pseudo-terminal,
// and hands back only the claude.ai page to approve it on. Mike approves it
// in his browser on any Mac, the app sends the code that page shows, and the
// helper types it in and writes threadbear-token.json in the login's folder
// itself, as the Terminal helper does. The token stays in that process and
// the file: the helper tells this file only `url`, `done` or `failed`, and
// never passes on anything else setup-token printed.
//
// Before this, giving bruce, Tinker Desk and the XPS a token meant scp'ing
// the helper over, driving it through `ssh -tt` and a FIFO, and scraping the
// URL out of the pty by hand: hours, mostly waiting (thread 75026195, 18 Nov).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Account } from './protocol.ts';
import { ErrorCode, RpcError } from './protocol.ts';
import { TOKEN_FILE } from './year-token.ts';

export type YearTokenState = 'idle' | 'starting' | 'waiting' | 'checking' | 'done' | 'failed';
export type YearTokenAnswer = { state: YearTokenState; url?: string; message?: string; madeAt?: string };
export type YearTokenParams = { code?: string; check?: boolean; cancel?: boolean };

// One not finished in this long is stopped: setup-token's own page doesn't
// last much longer, and a pty left waiting is a process nobody's watching.
export const SESSION_MS = 10 * 60_000;
// How long a start or a code waits for the next state before answering with
// where it's got to; the app asks again (`check`) every couple of seconds.
// Short, as through Convex each answer is a command's.
const ANSWER_WAIT_MS = 8_000;
// What a code may be: `<code>#<state>`, as platform.claude.com's page shows
// it. Nothing else reaches the pty, so no control character can type keys
// into setup-token.
const CODE = /^([A-Za-z0-9_-]{8,512})#([A-Za-z0-9_-]{8,512})$/;

// The helper. It runs `claude setup-token` in a pty 1000 columns wide, so the
// page's address comes out on one line; picks out the address whose
// redirect_uri is platform.claude.com's code page (the one that shows a code
// to copy, as a localhost callback can't reach this machine), and says it.
// Each line on stdin is a code: it types it, then Enter half a second later
// (sent together, setup-token shows the code and never takes it: thread
// 75026195). A token in what setup-token prints goes to the file (0600,
// through a temp file), and the helper says `done`. It never prints the
// token or setup-token's own words: `failed` carries a fixed message.
export const HELPER = String.raw`
import datetime, fcntl, json, os, pty, re, select, signal, struct, sys, termios, time
cli, target = sys.argv[1], sys.argv[2]
code_wait = float(sys.argv[3]) if len(sys.argv) > 3 else 30
def say(o):
    try:
        sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
    except Exception:
        pass
size = struct.pack("HHHH", 50, 1000, 0, 0)
pid, fd = pty.fork()
if pid == 0:
    try:
        fcntl.ioctl(0, termios.TIOCSWINSZ, size)
    except Exception:
        pass
    try:
        os.execvp(cli, [cli, "setup-token"])
    finally:
        os._exit(127)
try:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
except Exception:
    pass
URL = re.compile(rb"https://(?:claude\.ai|claude\.com|platform\.claude\.com)/[A-Za-z0-9/_.-]*oauth/authorize\?[A-Za-z0-9%&=_.~+-]+(?=[^A-Za-z0-9%&=_.~+-])")
# Only a token with something after it: one at the end of what's been read
# so far may be cut off mid-read (Codex's review, 19 Nov).
TOKEN = re.compile(rb"sk-ant-oat01-[A-Za-z0-9_-]{40,}(?=[^A-Za-z0-9_-])")
STATE = re.compile(rb"[?&]state=[A-Za-z0-9_-]{16,}(?:&|$)")
captured = bytearray()
said_url = False
typed = 0
done = False
inbuf = b""
def finish_token(tok):
    made = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    tmp = "%s.%d" % (target, os.getpid())
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump({"token": tok.decode(), "madeAt": made}, f)
        f.write("\n")
    os.replace(tmp, target)
    say({"done": True, "madeAt": made})
open_fds = [fd, 0]
while not done:
    try:
        ready, _, _ = select.select(open_fds, [], [], 1.0)
    except InterruptedError:
        continue
    # A code it didn't take leaves setup-token asking again: stop rather
    # than wait out the whole session.
    if typed and time.time() - typed > code_wait:
        break
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        captured.extend(data)
        if len(captured) > 4 << 20:
            del captured[: len(captured) - (1 << 20)]
        if not said_url:
            for m in URL.finditer(bytes(captured)):
                u = m.group(0)
                if b"redirect_uri=https%3A%2F%2Fplatform.claude.com" in u and STATE.search(u):
                    say({"url": u.decode()})
                    said_url = True
                    break
        found = TOKEN.findall(bytes(captured))
        if found:
            finish_token(found[-1])
            done = True
            break
    if 0 in ready:
        chunk = os.read(0, 4096)
        if not chunk:
            open_fds = [fd]
            continue
        inbuf += chunk
        while b"\n" in inbuf:
            line, inbuf = inbuf.split(b"\n", 1)
            line = line.strip()
            if not re.fullmatch(rb"[A-Za-z0-9_-]{8,512}#[A-Za-z0-9_-]{8,512}", line):
                continue
            os.write(fd, line)
            time.sleep(0.5)
            os.write(fd, b"\r")
            typed = time.time()
try:
    os.kill(pid, signal.SIGTERM)
except Exception:
    pass
try:
    os.waitpid(pid, 0)
except Exception:
    pass
captured = None
if not done:
    say({"failed": "Claude didn't take that code. Try again with a new page." if typed else "claude setup-token stopped before it gave a token."})
`;

type Session = {
  account: string;
  state: YearTokenState;
  child?: ChildProcess;
  url?: string;
  urlState?: string;
  message?: string;
  madeAt?: string;
  startedAt: number;
  endedAt?: number;
  timer?: NodeJS.Timeout;
  waiters: Set<() => void>;
};

export type MakerOptions = {
  claudePath: string;
  // The login's CLI environment (cliEnv), which this file strips of any token.
  env: (account: Account) => Record<string, string | undefined>;
  log?: { info: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void };
  python?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  answerWaitMs?: number;
  sessionMs?: number;
  // How long setup-token gets to take a code before it's given up on.
  codeWaitSecs?: number;
};

/** The url's own state, which a pasted code must end with. */
export function urlState(url: string): string | undefined {
  try {
    const s = new URL(url).searchParams.get('state');
    return s && /^[A-Za-z0-9_-]{16,}$/.test(s) ? s : undefined;
  } catch {
    return undefined;
  }
}

export class YearTokenMaker {
  private sessions = new Map<string, Session>();
  private o: MakerOptions;
  constructor(o: MakerOptions) {
    this.o = o;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** accounts.yearToken for one of this runner's logins. */
  async step(account: Account, p: YearTokenParams): Promise<YearTokenAnswer> {
    if (account.provider !== 'claude') throw new RpcError(ErrorCode.badParams, 'A year-long token is only for Claude logins.');
    if (!account.configDir) throw new RpcError(ErrorCode.badParams, `Threadbear doesn't know where ${account.id} keeps its files on this runner.`);
    let s = this.sessions.get(account.id);
    // A finished one is only told for a while; then it's as if none ran.
    if (s?.endedAt !== undefined && this.now() - s.endedAt > (this.o.sessionMs ?? SESSION_MS)) {
      this.sessions.delete(account.id);
      s = undefined;
    }
    if (p.cancel) {
      if (s && !s.endedAt) this.end(s, 'failed', 'Stopped.');
      this.sessions.delete(account.id);
      return { state: 'idle' };
    }
    if (p.check) return s ? this.answer(s) : { state: 'idle' };
    if (p.code !== undefined) {
      if (!s || s.endedAt !== undefined) throw new RpcError(ErrorCode.badParams, 'That sign-in page has finished. Start again for a new one.');
      if (s.state === 'checking') throw new RpcError(ErrorCode.busy, 'A code for this login is already being checked.');
      if (s.state !== 'waiting') throw new RpcError(ErrorCode.badParams, "The sign-in page isn't ready yet.");
      const m = CODE.exec(p.code.trim());
      if (!m) throw new RpcError(ErrorCode.badParams, "That isn't a code from Claude's page: it looks like letters and digits, a #, then more.");
      if (m[2] !== s.urlState) throw new RpcError(ErrorCode.badParams, "That code is from another sign-in page, not this login's.");
      s.state = 'checking';
      s.child?.stdin?.write(`${m[0]}\n`);
      return this.answerSoon(s);
    }
    // A start: join one still going, else begin again.
    if (s && s.endedAt === undefined) return this.answerSoon(s);
    return this.answerSoon(this.start(account));
  }

  stopAll(): void {
    for (const s of this.sessions.values()) if (s.endedAt === undefined) this.end(s, 'failed', 'The runner stopped.');
  }

  private start(account: Account): Session {
    const platform = this.o.platform ?? process.platform;
    const s: Session = { account: account.id, state: 'starting', startedAt: this.now(), waiters: new Set() };
    this.sessions.set(account.id, s);
    if (platform === 'win32') {
      this.end(s, 'failed', 'Making a token from another Mac needs a Mac or Linux runner. Run claude setup-token on that machine instead.');
      return s;
    }
    const env = { ...this.o.env(account) };
    // setup-token makes a new token from a browser sign-in: an old one in its
    // environment has no part in it, and mustn't be in the helper's.
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const python = this.o.python ?? (fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');
    const target = path.join(account.configDir, TOKEN_FILE);
    let child: ChildProcess;
    try {
      child = spawn(python, ['-I', '-c', HELPER, this.o.claudePath, target, String(this.o.codeWaitSecs ?? 30)], { env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      this.end(s, 'failed', `Couldn't start python3 for setup-token: ${(e as Error).message}`);
      return s;
    }
    s.child = child;
    this.o.log?.info('making a year-long token', { accountId: account.id });
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 1 << 16) buf = buf.slice(-(1 << 16));
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.heard(s, line);
      }
    });
    child.on('error', (e) => this.end(s, 'failed', (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'This runner has no python3, which making a token from here needs.' : `setup-token's helper failed: ${e.message}`));
    child.on('exit', () => {
      if (s.endedAt === undefined) this.end(s, 'failed', 'claude setup-token stopped before it gave a token.');
    });
    child.stdin?.on('error', () => {});
    s.timer = setTimeout(() => {
      if (s.endedAt === undefined) this.end(s, 'failed', "It wasn't approved within 10 minutes. Start again for a new page.");
    }, this.o.sessionMs ?? SESSION_MS);
    s.timer.unref?.();
    return s;
  }

  // One line from the helper: only these three shapes mean anything.
  private heard(s: Session, line: string): void {
    let o: { url?: unknown; done?: unknown; madeAt?: unknown; failed?: unknown };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      return;
    }
    if (s.endedAt !== undefined) return;
    if (typeof o.url === 'string' && s.state === 'starting') {
      const st = urlState(o.url);
      if (!st || !/^https:\/\/(claude\.ai|claude\.com|platform\.claude\.com)\//.test(o.url)) return;
      s.url = o.url;
      s.urlState = st;
      s.state = 'waiting';
      this.wake(s);
    } else if (o.done === true) {
      if (typeof o.madeAt === 'string') s.madeAt = o.madeAt;
      this.o.log?.info('made a year-long token', { accountId: s.account });
      this.end(s, 'done');
    } else if (typeof o.failed === 'string') {
      this.end(s, 'failed', o.failed.slice(0, 200));
    }
  }

  private end(s: Session, state: 'done' | 'failed', message?: string): void {
    if (s.endedAt !== undefined) return;
    s.state = state;
    if (message) s.message = message;
    s.endedAt = this.now();
    if (s.timer) clearTimeout(s.timer);
    if (state === 'failed') this.o.log?.warn('year-long token not made', { accountId: s.account, why: message });
    const c = s.child;
    s.child = undefined;
    if (c && c.exitCode === null && c.signalCode === null) {
      c.stdin?.end();
      c.kill('SIGTERM');
    }
    this.wake(s);
  }

  private wake(s: Session): void {
    for (const w of [...s.waiters]) w();
  }

  // Waits a few seconds for the state to move on, then says where it is.
  private answerSoon(s: Session): Promise<YearTokenAnswer> {
    const from = s.state;
    if (from === 'done' || from === 'failed') return Promise.resolve(this.answer(s));
    return new Promise((resolve) => {
      const moved = () => {
        if (s.state !== from) go();
      };
      const go = () => {
        clearTimeout(t);
        s.waiters.delete(moved);
        resolve(this.answer(s));
      };
      const t = setTimeout(go, this.o.answerWaitMs ?? ANSWER_WAIT_MS);
      s.waiters.add(moved);
    });
  }

  private answer(s: Session): YearTokenAnswer {
    return {
      state: s.state,
      ...(s.url && (s.state === 'waiting' || s.state === 'checking') ? { url: s.url } : {}),
      ...(s.message && s.state === 'failed' ? { message: s.message } : {}),
      ...(s.madeAt && s.state === 'done' ? { madeAt: s.madeAt } : {}),
    };
  }
}
