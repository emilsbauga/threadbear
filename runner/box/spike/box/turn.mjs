// Runs in a Fly box for the login test (claude-turn.ts). Plain JS with no
// dependencies, dropped in at create time onto a stock node:24-slim.
//
// It gets only BOOT_TOKEN in its environment. It trades that for the
// Claude setup token, installs Claude Code, runs one turn on the cheapest
// model with the token passed only to that child process, and reports.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const url = process.env.CONVEX_URL;
const boot = process.env.BOOT_TOKEN;
const t0 = Date.now();
const report = { steps: {} };
const step = (name) => (report.steps[name] = Date.now() - t0);

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

let claudeToken;
let reportKey;
try {
  const got = await convex("action", "login:exchange", { bootToken: boot });
  claudeToken = got.claudeToken;
  reportKey = got.reportKey;
  step("exchanged");
  report.tokenLooksRight = claudeToken.startsWith("sk-ant-oat");

  // The boot token must be dead now.
  try {
    await convex("action", "login:exchange", { bootToken: boot });
    report.secondExchangeRefused = false;
  } catch {
    report.secondExchangeRefused = true;
  }

  // Nothing reusable in this process's own environment or init's.
  const initEnv = (() => {
    try {
      return readFileSync("/proc/1/environ", "latin1");
    } catch {
      return "";
    }
  })();
  report.tokenInBoxEnv = JSON.stringify(process.env).includes(claudeToken) || initEnv.includes(claudeToken);

  execFileSync("npm", ["install", "-g", "--no-fund", "--no-audit", "@anthropic-ai/claude-code@2.1.326"], {
    stdio: "ignore",
  });
  step("installed");
  report.claudeVersion = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();

  const out = await new Promise((resolve) => {
    const child = spawn(
      "claude",
      ["-p", "Reply with exactly these words and nothing else: box ok", "--model", "haiku", "--output-format", "json"],
      { cwd: "/tmp", env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: claudeToken }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  step("turnDone");
  report.exitCode = out.code;
  const scrub = (s) => s.split(claudeToken).join("[token]").slice(-1500);
  try {
    const j = JSON.parse(out.stdout);
    report.result = j.result;
    report.isError = j.is_error;
    report.costUsd = j.total_cost_usd;
    report.modelUsage = Object.keys(j.modelUsage ?? {});
    report.durationMs = j.duration_ms;
  } catch {
    report.stdout = scrub(out.stdout);
  }
  if (out.stderr) report.stderr = scrub(out.stderr);
} catch (e) {
  report.error = String(e).split(claudeToken ?? "\u0000").join("[token]");
}

if (reportKey) {
  await convex("mutation", "login:report", { reportKey, report });
} else {
  console.log("no report key:", JSON.stringify(report));
}
console.log("done", JSON.stringify(report.steps));
