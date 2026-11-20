// Runs in a Fly box for the cold-start test (cold-start.ts): the real
// Threadbear runner, from a fresh clone of threadbear, opens a thread in
// that repo (its own worktree, with the repo's worktree setup) and answers.
// Then, after the driver pauses and resumes the box, a second message on
// the same thread times a warm wake.
//
// The runner runs on its own, as in runner/test/e2e: a local port, no
// Convex. The Claude token arrives by the boot exchange and goes in
// claude-main's threadbear-token.json, as the runner reads year-long
// tokens (runner/src/year-token.ts).
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const url = process.env.CONVEX_URL;
const REPO = "/work/threadbear";
const HOME = "/data/tb";
const t0 = Date.now();
const steps = {};
const step = (n) => (steps[n] = Date.now() - t0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function convex(kind, path, args) {
  const res = await fetch(`${url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = await res.json();
  if (body.status !== "success") throw new Error(body.errorMessage ?? JSON.stringify(body));
  return body.value;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}
async function must(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} -> ${r.code}: ${r.out.slice(-800)}`);
  return r.out;
}

const { claudeToken, reportKey } = await convex("action", "login:exchange", { bootToken: process.env.BOOT_TOKEN });
step("exchanged");
const scrub = (s) => String(s).split(claudeToken).join("[token]");
const report = (r) => convex("mutation", "login:report", { reportKey, report: { steps, at: Date.now(), ...r } });

let runner;
let runnerOut = "";
try {
  // What a real box image would already have: Claude Code and the runner
  // with its node_modules (here the clone's own runner, installed below).
  await must("npm", ["install", "-g", "--no-fund", "--no-audit", "@anthropic-ai/claude-code@2.1.326"]);
  step("claudeInstalled");

  // Per thread: the repo.
  await must("git", ["clone", "--quiet", "--filter=blob:none", "https://github.com/mikecann/threadbear.git", REPO]);
  step("cloned");
  await must("npm", ["ci", "--no-fund", "--no-audit"], { cwd: `${REPO}/runner` });
  step("runnerInstalled");

  // The login: claude-main is ~/.claude; its year-long token file.
  await mkdir("/root/.claude", { recursive: true });
  await writeFile("/root/.claude/threadbear-token.json", JSON.stringify({ token: claudeToken, madeAt: new Date().toISOString() }), { mode: 0o600 });

  await mkdir(HOME, { recursive: true });
  runner = spawn(process.execPath, ["src/main.ts"], {
    cwd: `${REPO}/runner`,
    env: { ...process.env, BOOT_TOKEN: "", THREADBEAR_HOME: HOME, THREADBEAR_PORT: "0", THREADBEAR_CLI_UPDATES: "off", THREADBEAR_TOKEN_TALLY: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  runner.stdout.on("data", (d) => (runnerOut += d));
  runner.stderr.on("data", (d) => (runnerOut += d));
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("runner didn't start")), 60_000);
    const check = () => {
      const m = /listening on (\d+)/.exec(runnerOut);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    };
    runner.stdout.on("data", check);
    runner.once("exit", (code) => reject(new Error(`runner exited ${code}`)));
  });
  step("runnerListening");

  const { RunnerClient } = await import(`${REPO}/runner/src/client.ts`);
  const token = (await readFile(`${HOME}/secrets/runner-token`, "utf8")).trim();
  const client = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, token);
  const events = new Map();
  const summaries = new Map();
  client.onNotification((method, params) => {
    if (method === "thread.event") {
      const e = { ...params.event, seenAt: Date.now() };
      (events.get(params.threadId) ?? events.set(params.threadId, []).get(params.threadId)).push(e);
    } else if (method === "thread.updated") {
      summaries.set(params.thread.id, params.thread);
    }
  });
  const hello = await client.call("hello", { client: "box-spike", version: "1" });
  const account = hello.accounts.find((a) => a.provider === "claude")?.id ?? "claude-main";
  const waitFor = async (what, fn, ms = 300_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const subscribe = async (id) => {
    const sub = await client.call("threads.subscribe", { threadId: id, afterSeq: 0 });
    const live = events.get(id) ?? [];
    const seen = new Set(sub.events.map((e) => e.seq));
    events.set(id, [...sub.events.map((e) => ({ ...e, seenAt: Date.now() })), ...live.filter((e) => !seen.has(e.seq))]);
  };
  const MODEL = "claude-haiku-5-5";

  // Trust the repo's patches, as Mike would once: through a first thread in
  // the main checkout, which shows the hash to trust.
  // threads.create needs a message; a tiny one, in the main checkout.
  const first = await client.call("threads.create", { accountId: account, model: MODEL, cwd: REPO, text: "Reply with: ok" });
  await subscribe(first.thread.id);
  const untrusted = await waitFor("patches listed", () => {
    const p = summaries.get(first.thread.id)?.patches ?? first.thread.patches;
    return p?.length ? p.filter((x) => x.untrusted) : false;
  }, 30_000);
  if (untrusted.length) {
    await client.call("patches.trust", { threadId: first.thread.id, files: untrusted.map((x) => ({ file: x.file ?? x.path, hash: x.hash })) });
  }
  step("trusted");

  // The thread itself: a worktree, the repo's setup, then the turn.
  const tSend = Date.now();
  const made = await client.call("threads.create", {
    accountId: account,
    model: MODEL,
    cwd: REPO,
    text: "Reply with exactly these words and nothing else: box ok",
  });
  const id = made.thread.id;
  await subscribe(id);
  const turnDone = (turnId) =>
    waitFor(`turn ${turnId}`, () => (events.get(id) ?? []).find((e) => e.type === "turn.completed" && e.turnId === turnId));
  const done1 = await turnDone(made.turnId);
  step("firstReply");
  const evs = events.get(id) ?? [];
  const setupEv = evs.find((e) => e.type === "action.run" && e.trigger === "worktree.setup");
  const text1 = evs.filter((e) => e.type === "assistant.text" && e.turnId === made.turnId).map((e) => e.text).join("");
  const firstText = evs.find((e) => e.type === "assistant.text" && e.turnId === made.turnId);
  await report({
    phase: "cold",
    account,
    cwd: summaries.get(id)?.cwd ?? made.thread.cwd,
    trustedFiles: untrusted.length,
    setup: setupEv ? { ok: setupEv.ok, durationMs: setupEv.durationMs, tail: scrub(setupEv.text).slice(-600) } : null,
    sendToFirstTextMs: firstText ? firstText.seenAt - tSend : null,
    sendToDoneMs: Date.now() - tSend,
    outcome: done1.outcome,
    error: done1.error ? scrub(done1.error) : undefined,
    reply: text1,
  });

  // Warm wake: the driver pauses and resumes the box. A pause shows up as a
  // jump in the wall clock; then send at once and time the reply.
  let last = Date.now();
  for (;;) {
    await sleep(1000);
    const now = Date.now();
    if (now - last > 10_000) break;
    last = now;
  }
  const woke = Date.now();
  const second = await client.call("threads.send", { threadId: id, text: "Reply with exactly these words and nothing else: still here" });
  const done2 = await turnDone(second.turnId);
  const text2 = (events.get(id) ?? []).filter((e) => e.type === "assistant.text" && e.turnId === second.turnId).map((e) => e.text).join("");
  await report({ phase: "warm", wokeAt: woke, wakeToDoneMs: Date.now() - woke, outcome: done2.outcome, error: done2.error ? scrub(done2.error) : undefined, reply: text2 });
} catch (e) {
  await report({ phase: "error", error: scrub(e), runnerTail: scrub(runnerOut.slice(-2000)) }).catch(() => console.log("error", scrub(e)));
}
runner?.kill("SIGTERM");
console.log("done", JSON.stringify(steps));
