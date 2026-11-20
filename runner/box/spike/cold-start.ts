// The numbers from docs/virtual-runners.md step 1: a cold start of the real
// runner on threadbear itself (clone, worktree setup, first reply) and a
// warm wake (pause, resume, reply), on Fly.
//
//   CLAUDE_TOKEN_FILE=... node cold-start.ts
//
// Same environment as claude-turn.ts. The box runs box/cold.mjs.
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readFile } from "node:fs/promises";
import { flyProvider } from "./providers/fly.ts";
import { sleep } from "./providers/types.ts";

const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`set ${n}`);
  return v;
};
const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a);

const convexUrl = need("CONVEX_URL");
const key = need("SPIKE_KEY");
const claudeToken = (await readFile(need("CLAUDE_TOKEN_FILE"), "utf8")).trim();
const convex = new ConvexHttpClient(convexUrl);
const fly = flyProvider({ token: need("FLY_API_TOKEN"), org: process.env.FLY_ORG ?? "personal", region: process.env.FLY_REGION });
const PAUSE_S = Number(process.env.PAUSE_S ?? 60);

const box = `spike-cold-${Date.now().toString(36)}`;
const summary: Record<string, any> = { box };
const checks: Record<string, boolean> = {};
let id: string | undefined;

async function waitReport(phase: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows: any[] = await convex.query(anyApi.lose.reports, { key, box });
    const err = rows.find((r) => r.report.phase === "error");
    if (err) throw new Error(`box: ${err.report.error}\n${err.report.runnerTail ?? ""}`);
    const hit = rows.find((r) => r.report.phase === phase);
    if (hit) return hit;
    if (Date.now() > until) throw new Error(`no ${phase} report after ${timeoutMs / 1000} s`);
    await sleep(3000);
  }
}

try {
  await convex.action(anyApi.login.setLogin, { key, name: "claude-box", token: claudeToken });
  const bootToken = await convex.action(anyApi.login.mintBoot, { key, box, login: "claude-box" });
  const t0 = Date.now();
  id = (
    await fly.create({
      // The full Node image: it has git, as a real box image would.
      image: "node:24",
      cpus: 2,
      memoryMb: 2048, // Fly suspend needs <= 2 GB
      diskGb: 8,
      env: { CONVEX_URL: convexUrl, BOOT_TOKEN: bootToken, IS_SANDBOX: "1" },
      name: box,
      tags: { tb_spike: "1", tb_box: box },
      idempotencyKey: `idem-${box}`,
      files: [{ path: "/cold.mjs", contents: await readFile(new URL("./box/cold.mjs", import.meta.url), "utf8") }],
      command: ["node", "/cold.mjs"],
    })
  ).providerBoxId;
  log("created", id);

  const cold = (await waitReport("cold", 20 * 60_000)).report;
  summary.cold = { createToReplyMs: cold.at - t0, ...cold };
  checks.coldAnswered = cold.outcome === "completed" && /box ok/i.test(cold.reply ?? "");
  checks.inItsOwnWorktree = typeof cold.cwd === "string" && cold.cwd.includes("threadbear-threads");
  checks.setupRan = cold.setup?.ok === true;
  log("cold reply after", summary.cold.createToReplyMs, "ms");

  // Let the runner release the idle CLI first, as a thread that's gone
  // quiet would have before it sleeps.
  await sleep(20_000);
  const tPause = Date.now();
  await fly.pause!(id);
  summary.pauseMs = Date.now() - tPause;
  await sleep(PAUSE_S * 1000);
  const tResume = Date.now();
  await fly.resume!(id);
  summary.resumeCallMs = Date.now() - tResume;
  const warm = (await waitReport("warm", 5 * 60_000)).report;
  summary.warm = { resumeToReplyMs: warm.at - tResume, ...warm };
  checks.warmAnswered = warm.outcome === "completed" && /still here/i.test(warm.reply ?? "");
} catch (e) {
  summary.error = String(e).split(claudeToken).join("[token]");
} finally {
  if (id) await fly.destroy(id).catch((e) => (summary.destroyError = String(e)));
  log("destroyed", id);
}
summary.checks = checks;
summary.ok = !summary.error && Object.keys(checks).length === 4 && Object.values(checks).every(Boolean);
console.log(JSON.stringify(summary, null, 2).split(claudeToken).join("[token]"));
if (!summary.ok) process.exitCode = 1;
