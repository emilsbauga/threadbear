// Runs in a Fly box for the lose-a-box test (lose-box.ts). Plain JS, no
// dependencies, on a stock node:24-slim.
//
// MODE=first: does a Claude turn that leaves uncommitted work, then waits
// for a save request, saves (folder + session transcript, sealed with the
// thread's key) to Convex file storage, and idles until it's destroyed.
// MODE=second: a new box for the same thread restores the last save and
// resumes the same Claude session.
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const url = process.env.CONVEX_URL;
const mode = process.env.MODE;
const WORK = "/work/proj";
const SAVE_PATHS = ["work/proj", "root/.claude/projects"]; // relative to /
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
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function must(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} -> ${r.code}: ${r.stderr.slice(-500)}`);
  return r.stdout;
}

const got = await convex("action", "lose:exchange", { bootToken: process.env.BOOT_TOKEN });
const { boxKey, claudeToken, sessionId } = got;
const threadKey = Buffer.from(got.threadKey, "base64");
step("exchanged");
const scrub = (s) => String(s).split(claudeToken).join("[token]");
const report = (r) => convex("mutation", "lose:report", { boxKey, report: { mode, steps, ...r } });

async function setup() {
  await must("sh", ["-c", "apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null"]);
  step("git");
  await must("npm", ["install", "-g", "--no-fund", "--no-audit", "@anthropic-ai/claude-code@2.1.326"]);
  step("claude");
}

function claude(args) {
  return run("claude", [...args, "--model", "haiku", "--output-format", "json"], {
    cwd: WORK,
    env: { ...process.env, BOOT_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: claudeToken },
  }).then((r) => {
    try {
      const j = JSON.parse(r.stdout);
      return { exitCode: r.code, result: j.result, isError: j.is_error, sessionId: j.session_id, costUsd: j.total_cost_usd };
    } catch {
      return { exitCode: r.code, stdout: scrub(r.stdout.slice(-800)), stderr: scrub(r.stderr.slice(-800)) };
    }
  });
}

async function workState() {
  const status = await run("git", ["status", "--porcelain"], { cwd: WORK });
  const notes = await readFile(`${WORK}/notes.txt`, "utf8").catch(() => null);
  const log = await run("git", ["log", "--oneline"], { cwd: WORK });
  return { gitStatus: status.stdout.trim(), notes: notes?.trim() ?? null, commits: log.stdout.trim().split("\n").length };
}

try {
  if (mode === "first") {
    await setup();
    await mkdir(WORK, { recursive: true });
    await must("sh", ["-c", `cd ${WORK} && git init -q && git config user.email box@example.com && git config user.name box && echo '# demo' > README.md && git add . && git commit -qm init`]);
    const turn = await claude([
      "-p",
      "Create a file notes.txt in this folder containing exactly one line: codeword pelican-42. " +
        "Also remember this secret number for later, but do not write it anywhere: 7319. Then reply with just: done",
      "--session-id",
      sessionId,
      "--permission-mode",
      "acceptEdits",
    ]);
    step("turn1");
    // Spike only: the box key goes into the report so the driver can check
    // it's refused once the next box has started. A real box never sends it.
    await report({ phase: "turn1", turn, work: await workState(), boxKeyForTest: boxKey });

    for (;;) {
      const s = await convex("query", "lose:state", { boxKey });
      if (s.saveWanted) break;
      await sleep(2000);
    }
    const tSave = Date.now();
    const tgz = Buffer.from(
      await new Promise((resolve, reject) => {
        const child = spawn("tar", ["-czf", "-", "-C", "/", ...SAVE_PATHS]);
        const chunks = [];
        child.stdout.on("data", (d) => chunks.push(d));
        child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar ${code}`))));
      }),
    );
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", threadKey, iv);
    const sealed = Buffer.concat([iv, c.update(tgz), c.final(), c.getAuthTag()]);
    const upload = await convex("mutation", "lose:uploadUrl", { boxKey });
    const res = await fetch(upload, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: sealed });
    const { storageId } = await res.json();
    await convex("mutation", "lose:recordSave", { boxKey, storageId, bytes: sealed.length });
    step("saved");
    await report({ phase: "saved", saveMs: Date.now() - tSave, bytes: sealed.length, tarBytes: tgz.length });
    // Idle until the driver pauses and then destroys this box.
    for (;;) await sleep(60_000);
  }

  if (mode === "second") {
    const s = await convex("query", "lose:state", { boxKey });
    if (!s.lastSave) throw new Error("no save to restore");
    const sealed = Buffer.from(await (await fetch(s.lastSave.url)).arrayBuffer());
    const d = createDecipheriv("aes-256-gcm", threadKey, sealed.subarray(0, 12));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    const tgz = Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]);
    await writeFile("/tmp/save.tgz", tgz);
    await must("tar", ["-xzf", "/tmp/save.tgz", "-C", "/"]);
    step("restored");
    await setup();
    const work = await workState();
    const turn = await claude([
      "-p",
      "From our conversation so far: what codeword did you put in notes.txt, and what secret number did I ask you to remember? " +
        "Answer from memory without reading any files, as: <codeword> <number>",
      "--resume",
      sessionId,
    ]);
    step("turn2");
    await report({ phase: "restored", turn, work, ping: await convex("query", "lose:ping", { boxKey }) });
  }
} catch (e) {
  await report({ phase: "error", error: scrub(e) }).catch(() => console.log("error", scrub(e)));
}
console.log("done", JSON.stringify(steps));
