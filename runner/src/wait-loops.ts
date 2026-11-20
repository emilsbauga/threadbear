// Background wait loops, caught as the agent starts one (docs/protocol.md,
// "Background wait loops"). An agent waiting on something outside its turn
// (a merge to land, CI, another thread, a time) tends to start a background
// shell that sleeps until it's there, then end its turn. The CLI wakes it
// when the shell exits, so it works, but the thread can't be hibernated
// meanwhile: hibernating stops the CLI's background jobs, so Threadbear asks
// first and Mike is stuck with it awake (17 Nov: "Wait until this Mac's main
// has Ian's commit" sat 40 minutes, and Hibernate asked to kill it). The
// stuck-job check (stuck-jobs.ts) only sees one after 30 quiet minutes.
//
// A scheduled message with a check is the way to wait: Threadbear runs the
// check every few minutes with no agent, wakes the thread when it prints
// something, and the thread can hibernate in between. So the Claude
// adapter's PreToolUse hook refuses a Bash call that looks like a wait that
// would outlast the turn in the background, with a reason saying how. A short wait the agent will use within
// its turn (a dev server coming up, a build it needs next) is fine: it says
// so with SHORT_WAIT_MARK on the command and the call goes through.
//
// Codex's shell has no hook to refuse a call with, so Codex threads aren't
// checked.

// What an agent adds to a command it means as a short wait inside its turn.
// A shell comment, so it changes nothing when the command runs.
export const SHORT_WAIT_MARK = '# short wait';

// A sleep this long or longer by itself (not in a loop) is a timer to wake
// the agent later, which a scheduled message does better.
export const TIMER_SECONDS = 60;

// A loop in the foreground that sleeps this long between looks is a long
// wait too: the CLI moves a command that hits its timeout to the background
// (the SDK's timedOutAfterMs), where it's the same job (Codex's review,
// 18 Nov). A shorter one is a server coming up.
export const FOREGROUND_POLL_SECONDS = 30;

export const WAIT_LOOP_REASON = [
  "This looks like a wait that would outlast the turn as a background job. While one runs, this thread can't be hibernated: hibernating stops background jobs, so the user is asked to choose between killing it and leaving the thread awake.",
  // A one-off (`when`) whose check prints nothing is skipped and done for
  // good, so the wait would be dropped (Codex's review, 18 Nov): cron only.
  `If it waits on something outside this turn (a merge or landing, CI, a deploy, another thread, a person, a time), don't run it. Call schedule_message with cron "*/5 * * * *" and \`check\` set to a command that prints only once it's ready, saying in the message what to do then and to delete the schedule; then end_turn with snooze. The thread hibernates and the check wakes it.`,
  `If it's a short wait you'll use within this turn (a server starting, a build you need next), add \`${SHORT_WAIT_MARK}\` at the end of the command and run it again.`,
].join(' ');

// sleep's argument in seconds: 30, 1.5, 10m, 2h, 1d. Undefined when it isn't
// a plain number (sleep "$DELAY").
export function sleepSeconds(arg: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(arg);
  if (!m) return undefined;
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

// The words of the command being written at the end of `out`, from the last
// separator, looking back at most 300 characters so many quotes or heredocs
// on one long line stay linear (Codex's review, round 3).
function lastCommandWords(out: string): string[] {
  const tail = out.slice(Math.max(0, out.length - 300));
  const cmd = tail.split(/[\n;&|(]/).pop() ?? '';
  return cmd.trim().split(/\s+/).filter(Boolean);
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const base = (w: string) => w.split('/').pop() ?? w;

// Whether a quoted string coming next is a script that runs: after a shell's
// -c (any letters with it, as in bash -lc), or as ssh's remote command.
function scriptNext(out: string): boolean {
  const words = lastCommandWords(out);
  if (words.length && base(words[0]) === 'ssh') return true;
  let w = words.length - 1;
  if (!/^-[a-zA-Z]*c[a-zA-Z]*$/.test(words[w] ?? '')) return false;
  while (w > 0 && words[w].startsWith('-')) w--;
  return SHELLS.has(base(words[w]));
}

// The command with the text that isn't run blanked, in one pass: a quoted
// string becomes `_`, and a heredoc's body goes. Kept, and read the same
// way: a shell's -c script or ssh's remote command (bash -lc 'until …'), a
// double-quoted string with a command substitution in it ("$(until …)"),
// and a heredoc a shell or ssh reads (`cat <<EOF` prints a script, `bash
// <<EOF` runs one). A quoted number is kept as it is, so `sleep "60"` is
// still a minute. Codex's review, 18 Nov: `printf "wait; sleep 60"` and a
// printed loop were refused, and round 3 found the rest.
export function shellCode(command: string): string {
  const n = command.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = command[i];
    if (c === '\\') {
      out += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && command[j] !== c) j += c === '"' && command[j] === '\\' ? 2 : 1;
      const body = command.slice(i + 1, j);
      let keep = '_';
      if (scriptNext(out) || (c === '"' && (body.includes('$(') || body.includes('`')))) keep = shellCode(body);
      else if (/^\d+(?:\.\d+)?[smhd]?$/.test(body)) keep = body;
      out += ` ${keep} `;
      i = j + 1;
      continue;
    }
    // A here-string (<<<word) is one line of input, not a heredoc.
    if (command.startsWith('<<<', i)) {
      out += '<<<';
      i += 3;
      continue;
    }
    if (c === '<' && command[i + 1] === '<') {
      const m = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(command.slice(i, i + 200));
      if (m) {
        const runs = lastCommandWords(out).some((w) => SHELLS.has(base(w)) || base(w) === 'ssh');
        out += command.slice(i, i + m[0].length);
        i += m[0].length;
        if (runs) continue;
        // The rest of the line is still code (`<<EOF | sh` aside); the body
        // runs to a line holding only the word, or to the end.
        const nl = command.indexOf('\n', i);
        if (nl < 0) continue;
        out += command.slice(i, nl + 1);
        let at = nl + 1;
        i = n;
        while (at < n) {
          const end = command.indexOf('\n', at);
          const line = command.slice(at, end < 0 ? n : end);
          if (line.trim() === m[2]) {
            i = end < 0 ? n : end;
            break;
          }
          if (end < 0) break;
          at = end + 1;
        }
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// What a command does that looks like waiting, read loosely from its code
// (shellCode) with linear scans only: a nested lazy regex took 300 ms on 10
// KB of unclosed `while x; do`, on the runner's event loop (Codex's review).
// loopSleep: the longest sleep at or after the first while/until/for, so
// `while sleep 5; do …` and a sleep after a nested loop's `done` count (0
// for one whose length can't be read, -1 with no loop or no sleep in it).
// longestSleep: the longest sleep anywhere. watch: a CLI watching CI.
export type WaitShape = { loopSleep: number; longestSleep: number; watch: boolean };

// Where a shell command can start.
const START = String.raw`(?:^|[\s;&|(\x60{])`;
const LOOP_RE = new RegExp(`${START}(?:while|until|for)\\s`);
const SLEEP_RE = new RegExp(`${START}sleep\\s+([^\\s;&|)\\x60]+)`, 'g');

export function waitShape(command: string): WaitShape {
  const code = shellCode(command);
  const loopAt = code.search(LOOP_RE);
  let loopSleep = -1;
  let longestSleep = -1;
  for (const m of code.matchAll(SLEEP_RE)) {
    const secs = sleepSeconds(m[1]) ?? 0;
    longestSleep = Math.max(longestSleep, secs);
    if (loopAt >= 0 && m.index >= loopAt) loopSleep = Math.max(loopSleep, secs);
  }
  // A command at a time, so no scan runs on past the end of one (a regex
  // looking for --watch after each `gh pr checks` was quadratic).
  const watch = code.split(/[;&|\n]/).some((c) => /\bgh\s+run\s+watch\b/.test(c) || (/\bgh\s+pr\s+checks\b/.test(c) && /\s--watch\b/.test(c)));
  return { loopSleep, longestSleep, watch };
}

// Whether a command would wait past the turn. In the background: any loop
// that sleeps, a sleep of a minute or more (a timer), or a CI watch. In the
// foreground, where the CLI moves a command that hits its timeout to the
// background: a loop that sleeps FOREGROUND_POLL_SECONDS or more between
// looks, or a timer. A quick poll there is a server coming up, and a CI
// watch is how a turn that ships something waits for its checks, which the
// agent is still there for.
export function isWaitCommand(command: string, background = true): boolean {
  const w = waitShape(command);
  if (!background) return w.loopSleep >= FOREGROUND_POLL_SECONDS || w.longestSleep >= TIMER_SECONDS;
  return w.loopSleep >= 0 || w.longestSleep >= TIMER_SECONDS || w.watch;
}

// The reason to refuse a call, or undefined when it's fine: only a Bash call
// that waits (isWaitCommand), without the short-wait mark.
export function denyWaitLoop(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool !== 'Bash') return undefined;
  const command = typeof input.command === 'string' ? input.command : '';
  if (command.toLowerCase().includes(SHORT_WAIT_MARK)) return undefined;
  return isWaitCommand(command, input.run_in_background === true) ? WAIT_LOOP_REASON : undefined;
}
