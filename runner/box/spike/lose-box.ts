// "Losing a box loses nothing" from docs/virtual-runners.md step 1:
//
// 1. box A does a Claude turn that leaves uncommitted work and a secret
//    only the session knows;
// 2. the backend asks for a save, then pauses box A and destroys it (the
//    provider losing a paused box);
// 3. box B starts for the same thread, restores the save and resumes the
//    same Claude session, which must still know the secret, with the work
//    still uncommitted;
// 4. box A's key must be refused once box B has started.
//
//   CLAUDE_TOKEN_FILE=... node lose-box.ts
//
// Same environment as claude-turn.ts.
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
const api = anyApi.lose;
const fly = flyProvider({ token: need("FLY_API_TOKEN"), org: process.env.FLY_ORG ?? "personal", region: process.env.FLY_REGION });
const script = await readFile(new URL("./box/lose.mjs", import.meta.url), "utf8");

const run = Date.now().toString(36);
const thread = `thread-${run}`;
const summary: Record<string, any> = { thread };
const checks: Record<string, boolean> = {};
const made: string[] = [];

async function startBox(box: string, mode: "first" | "second") {
  const bootToken = await convex.action(api.mintBoot, { key, thread, box, login: "claude-box" });
  const id = (
    await fly.create({
      image: "node:24-slim",
      cpus: 1,
      memoryMb: 2048, // Fly suspend needs <= 2 GB
      diskGb: 4,
      env: { CONVEX_URL: convexUrl, BOOT_TOKEN: bootToken, MODE: mode },
      name: box,
      tags: { tb_spike: "1", tb_box: box },
      idempotencyKey: `idem-${box}`,
      files: [{ path: "/lose.mjs", contents: script }],
      command: ["node", "/lose.mjs"],
    })
  ).providerBoxId;
  made.push(id);
  log("started", box, id, mode);
  return id;
}

async function waitReport(box: string, phase: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows: any[] = await convex.query(api.reports, { key, box });
    const err = rows.find((r) => r.report.phase === "error");
    if (err) throw new Error(`${box}: ${err.report.error}`);
    const hit = rows.find((r) => r.report.phase === phase);
    if (hit) return hit;
    if (Date.now() > until) throw new Error(`${box}: no ${phase} report after ${timeoutMs / 1000} s`);
    await sleep(3000);
  }
}

try {
  await convex.action(anyApi.login.setLogin, { key, name: "claude-box", token: claudeToken });
  await convex.action(api.createThread, { key, name: thread });
  const sessionId = (await convex.query(api.thread, { key, thread })).sessionId;

  // 1. Box A's turn.
  const boxA = `spike-lose-a-${run}`;
  const tA = Date.now();
  const idA = await startBox(boxA, "first");
  const t1 = (await waitReport(boxA, "turn1", 8 * 60_000)).report;
  summary.boxA = { createToTurnMs: Date.now() - tA, steps: t1.steps, turn: t1.turn, work: t1.work };
  checks.turn1Answered = t1.turn.exitCode === 0 && t1.turn.isError === false;
  checks.turn1UsedThreadSession = t1.turn.sessionId === sessionId;
  checks.workUncommitted = /notes\.txt/.test(t1.work.gitStatus) && /pelican-42/.test(t1.work.notes ?? "");
  const boxKeyA: string = t1.boxKeyForTest;

  // 2. Save, then sleep it, then lose it.
  const tSave = Date.now();
  await convex.mutation(api.requestSave, { key, thread });
  const saved = (await waitReport(boxA, "saved", 3 * 60_000)).report;
  summary.save = { requestToSavedMs: Date.now() - tSave, bytes: saved.bytes, tarBytes: saved.tarBytes };
  await fly.pause!(idA);
  summary.listedAfterPause = (await fly.list({ tb_box: boxA }))[0]?.state;
  await fly.destroy(idA);
  for (let i = 0; i < 40 && (await fly.list({ tb_box: boxA })).length > 0; i++) await sleep(3000);
  checks.boxAGone = (await fly.list({ tb_box: boxA })).length === 0;
  log("box A paused and destroyed");

  // 3. Box B carries on.
  const boxB = `spike-lose-b-${run}`;
  const tB = Date.now();
  await startBox(boxB, "second");
  const r = (await waitReport(boxB, "restored", 8 * 60_000)).report;
  summary.boxB = { createToAnswerMs: Date.now() - tB, steps: r.steps, turn: r.turn, work: r.work };
  checks.turn2Answered = r.turn.exitCode === 0 && r.turn.isError === false;
  checks.sameSession = r.turn.sessionId === sessionId;
  checks.sessionRemembered = /pelican-42/.test(r.turn.result ?? "") && /7319/.test(r.turn.result ?? "");
  checks.workStillUncommitted = /notes\.txt/.test(r.work.gitStatus) && /pelican-42/.test(r.work.notes ?? "") && r.work.commits === 1;
  checks.boxBKeyWorks = r.ping === boxB;

  // 4. Box A's key is dead.
  try {
    await convex.query(api.ping, { boxKey: boxKeyA });
    checks.boxAKeyRefused = false;
  } catch {
    checks.boxAKeyRefused = true;
  }
} catch (e) {
  summary.error = String(e).split(claudeToken).join("[token]");
} finally {
  for (const id of made) await fly.destroy(id).catch(() => {});
  log("cleaned up", made.length, "boxes");
}
summary.checks = checks;
summary.ok = !summary.error && Object.keys(checks).length === 10 && Object.values(checks).every(Boolean);
console.log(JSON.stringify(summary, null, 2).split(claudeToken).join("[token]"));
if (!summary.ok) process.exitCode = 1;
