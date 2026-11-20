import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denyWaitLoop, isWaitCommand, shellCode, sleepSeconds, SHORT_WAIT_MARK, WAIT_LOOP_REASON } from '../../src/wait-loops.ts';

test('sleep arguments read as seconds', () => {
  assert.equal(sleepSeconds('30'), 30);
  assert.equal(sleepSeconds('1.5'), 1.5);
  assert.equal(sleepSeconds('10m'), 600);
  assert.equal(sleepSeconds('2h'), 7200);
  assert.equal(sleepSeconds('1d'), 86_400);
  assert.equal(sleepSeconds('"$DELAY"'), undefined);
});

test('wait loops, long sleeps and CI watches count as waits', () => {
  // The one that kept a thread awake on 17 Nov, shaped like it.
  assert.ok(isWaitCommand('cd ~/dev/me/threadbear && until git merge-base --is-ancestor abc123 main; do sleep 60; done; echo landed'));
  assert.ok(isWaitCommand('while ! curl -sf https://example.com/health; do\n  sleep 5\ndone'));
  assert.ok(isWaitCommand('for i in $(seq 1 120); do gh pr view 72 --json state | grep -q MERGED && break; sleep 30; done'));
  assert.ok(isWaitCommand("bash -c 'until test -f /tmp/done; do sleep 2; done'"));
  assert.ok(isWaitCommand('sleep 1800 && echo "check the deploy"'));
  assert.ok(isWaitCommand('sleep 10m; tb status'));
  assert.ok(isWaitCommand('gh run watch 123456 --exit-status'));
  assert.ok(isWaitCommand('gh pr checks 72 --watch'));
  // Shapes from Codex's review, 18 Nov: the sleep in the condition, a quoted
  // word before it, a nested loop's done first.
  assert.ok(isWaitCommand('while sleep 5; do test -f ready && break; done'));
  assert.ok(isWaitCommand('until test -f ready; do echo "not done"; sleep 5; done'));
  assert.ok(isWaitCommand('until test -f ready; do for x in a b; do echo checking; done; sleep 5; done'));
  assert.ok(isWaitCommand('nohup sh -c "while true; do sleep 30; done" &'));
});

test('ordinary background commands are not waits', () => {
  assert.ok(!isWaitCommand('npm run dev'));
  assert.ok(!isWaitCommand('./check.sh --quick'));
  assert.ok(!isWaitCommand('runner/bin/tb land'));
  assert.ok(!isWaitCommand('sleep 2 && open http://localhost:3000'), 'a short sleep by itself');
  assert.ok(!isWaitCommand('for f in *.mov; do ffmpeg -i "$f" -c:v libx264 "${f%.mov}.mp4"; done'), 'a loop that never sleeps');
  assert.ok(!isWaitCommand('gh pr checks 72'));
  assert.ok(!isWaitCommand('sleepwalk --fast'), 'only sleep the command');
  assert.ok(!isWaitCommand('for f in *.mov; do ffmpeg -i "$f" -metadata title="sleep forever" out.mp4; done'), 'a quoted word is not a command');
});

test('Bash calls that would wait past the turn are refused, and the short-wait mark lets one through', () => {
  const loop = 'until curl -sf localhost:3000; do sleep 1; done';
  assert.equal(denyWaitLoop('Bash', { command: loop, run_in_background: true }), WAIT_LOOP_REASON);
  assert.equal(denyWaitLoop('Bash', { command: loop }), undefined, 'a quick poll in the foreground is a server coming up');
  // A slow poll in the foreground is moved to the background when it times out.
  assert.equal(denyWaitLoop('Bash', { command: 'until test -f ready; do sleep 60; done', timeout: 1000 }), WAIT_LOOP_REASON);
  assert.equal(denyWaitLoop('Bash', { command: 'sleep 2 && curl localhost:3000' }), undefined);
  assert.equal(denyWaitLoop('Bash', { command: `${loop} ${SHORT_WAIT_MARK}`, run_in_background: true }), undefined);
  assert.equal(denyWaitLoop('Bash', { command: `${loop} # Short Wait`, run_in_background: true }), undefined, 'in any letters');
  assert.equal(denyWaitLoop('Bash', { command: 'npm run dev', run_in_background: true }), undefined);
  assert.equal(denyWaitLoop('Read', { file_path: '/tmp/x', run_in_background: true }), undefined);
  assert.equal(denyWaitLoop('Bash', { run_in_background: true }), undefined);
});

test('the reason names the way to wait instead', () => {
  assert.match(WAIT_LOOP_REASON, /schedule_message/);
  assert.match(WAIT_LOOP_REASON, /check/);
  assert.match(WAIT_LOOP_REASON, /snooze/);
  assert.ok(WAIT_LOOP_REASON.includes(SHORT_WAIT_MARK));
});

test('a long command is read in linear time', () => {
  // 10 KB of unclosed loops took 300 ms with the first regex (Codex's review).
  // CPU time, the best of up to five, under 500 ms: a busy Linux
  // follower's update build took 78 ms of the clock (18 Nov), and the old
  // regex's quadratic time on this 60 KB would be seconds.
  const big = 'while x; do '.repeat(5000);
  let ms = Infinity;
  for (let i = 0; i < 5 && ms >= 500; i++) {
    const t = process.cpuUsage();
    isWaitCommand(big);
    isWaitCommand(big + ' sleep 5');
    const d = process.cpuUsage(t);
    ms = Math.min(ms, (d.user + d.system) / 1000);
  }
  assert.ok(ms < 500, `took ${ms} ms of CPU`);
});

test('the reason says to poll on a cron, never a one-off that would drop the wait', () => {
  assert.match(WAIT_LOOP_REASON, /cron/);
  assert.doesNotMatch(WAIT_LOOP_REASON, /`when`/);
});

test('quoted text and printed heredocs are not code, but -c scripts and heredocs a shell reads are (Codex review round 2)', () => {
  assert.ok(!isWaitCommand('printf "wait for CI; sleep 60"', false));
  assert.ok(!isWaitCommand("cat <<'EOF' > poll.sh\nuntil test -f ready; do sleep 60; done\nEOF\nchmod +x poll.sh"));
  assert.ok(isWaitCommand("bash <<'EOF'\nuntil test -f ready; do sleep 60; done\nEOF"));
  assert.ok(isWaitCommand("ssh tinker-desk bash -s <<'EOF'\nwhile true; do sleep 30; done\nEOF"));
  // A sleep whose length is quoted still sleeps.
  assert.ok(isWaitCommand('until test -f ready; do sleep "60"; done'));
  assert.ok(isWaitCommand('until test -f ready; do sleep "$DELAY"; done'));
  assert.equal(shellCode(`echo "a \\" b" 'c' && bash -c 'sleep 9'`), 'echo  _   _  && bash -c  sleep 9 ');
});

test('foreground timers are refused; quick polls and CI watches in the turn are not', () => {
  assert.ok(isWaitCommand('sleep 600', false));
  assert.ok(!isWaitCommand('until test -f ready; do sleep 5; done', false));
  assert.ok(!isWaitCommand('gh pr checks 72 --watch', false));
});

test('many gh pr checks without --watch are read in linear time', () => {
  const big = 'gh pr checks '.repeat(4000);
  const t = performance.now();
  isWaitCommand(big);
  assert.ok(performance.now() - t < 50, `took ${performance.now() - t} ms`);
});

test('round 3: here-strings, bash -lc, ssh commands, substitutions, quoted lengths, printed text in a script', () => {
  assert.ok(isWaitCommand('grep -q ready <<<ready\nuntil test -f ready; do sleep 60; done'));
  assert.ok(isWaitCommand("bash -lc 'until test -f ready; do sleep 60; done'", false));
  assert.ok(isWaitCommand("ssh tinker-desk 'until test -f ready; do sleep 60; done'", false));
  assert.ok(isWaitCommand('result="$(until test -f ready; do sleep 60; done)"', false));
  assert.ok(isWaitCommand('sleep "600"', false));
  assert.ok(isWaitCommand('until test -f ready; do sleep "60"; done', false));
  assert.ok(!isWaitCommand(`python3 -c 'print("example: sleep 60 before retrying")'`, false));
  assert.ok(!isWaitCommand(`bash -c 'printf "%s\\n" "example: sleep 60 before retrying"'`, false));
  assert.ok(!isWaitCommand(`git commit -m "Fix the loop that would sleep 60 s; done"`, false));
  assert.ok(!isWaitCommand("gh pr create --title x --body \"$(cat <<'EOF'\nWe used to sleep 60 in a while loop; do not.\nEOF\n)\"", false));
});

test('a long line before a heredoc is read in linear time', () => {
  const big = 'true;'.repeat(8000) + 'cat <<EOF\nx\nEOF';
  const t = performance.now();
  isWaitCommand(big);
  assert.ok(performance.now() - t < 50, `took ${performance.now() - t} ms`);
});
