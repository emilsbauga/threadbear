// The login test from docs/virtual-runners.md step 1: one real Claude turn
// in a Fly box on a setup token kept in Convex, reaching the box only
// through a one-time boot token.
//
//   CLAUDE_TOKEN_FILE=... node claude-turn.ts
//
// Needs CONVEX_URL, SPIKE_KEY and FLY_API_TOKEN as for driver.ts, and
// SEAL_KEY set on the deployment. The token file is read here and never
// printed.
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
const flyToken = need("FLY_API_TOKEN");
const claudeToken = (await readFile(need("CLAUDE_TOKEN_FILE"), "utf8")).trim();
const convex = new ConvexHttpClient(convexUrl);
const api = anyApi.login;
const fly = flyProvider({ token: flyToken, org: process.env.FLY_ORG ?? "personal", region: process.env.FLY_REGION });

const name = `spike-login-${Date.now().toString(36)}`;
const tags = { tb_spike: "1", tb_box: name };
const summary: Record<string, unknown> = { box: name };
const checks: Record<string, boolean> = {};
let id: string | undefined;

try {
  await convex.action(api.setLogin, { key, name: "claude-box", token: claudeToken });
  const bootToken = await convex.action(api.mintBoot, { key, box: name, login: "claude-box" });
  const t0 = Date.now();
  id = (
    await fly.create({
      image: "node:24-slim",
      cpus: 1,
      memoryMb: 2048,
      diskGb: 4,
      env: { CONVEX_URL: convexUrl, BOOT_TOKEN: bootToken },
      name,
      tags,
      idempotencyKey: `idem-${name}`,
      files: [{ path: "/turn.mjs", contents: await readFile(new URL("./box/turn.mjs", import.meta.url), "utf8") }],
      command: ["node", "/turn.mjs"],
    })
  ).providerBoxId;
  log("created", id);

  // What anyone with the Fly token can read about the box.
  const app = await fly.appName();
  const res = await fetch(`https://api.machines.dev/v1/apps/${app}/machines/${id}`, {
    headers: { authorization: `Bearer ${flyToken}` },
  });
  const config = await res.text();
  checks.tokenNotInMachineConfig = res.ok && !config.includes(claudeToken);

  let turn: any;
  while (!(turn = await convex.query(api.turn, { key, box: name }))) {
    if (Date.now() - t0 > 8 * 60_000) throw new Error("no report after 8 min");
    await sleep(3000);
  }
  const r = turn.report;
  summary.createToReportMs = turn.at - t0;
  summary.report = r;
  checks.exchanged = r.tokenLooksRight === true;
  checks.bootTokenSingleUse = r.secondExchangeRefused === true;
  checks.tokenNotInBoxEnv = r.tokenInBoxEnv === false;
  checks.turnAnswered = r.exitCode === 0 && r.isError === false && /box ok/i.test(r.result ?? "");

  // And from outside, after the box has used it.
  try {
    await convex.action(api.exchange, { bootToken });
    checks.bootTokenDeadAfterwards = false;
  } catch {
    checks.bootTokenDeadAfterwards = true;
  }
} catch (e) {
  summary.error = String(e).split(claudeToken).join("[token]");
} finally {
  if (id) {
    await fly.destroy(id).catch((e) => (summary.destroyError = String(e)));
    log("destroyed", id);
  }
}
summary.checks = checks;
summary.ok = !summary.error && Object.keys(checks).length === 6 && Object.values(checks).every(Boolean);
console.log(JSON.stringify(summary, null, 2).split(claudeToken).join("[token]"));
if (!summary.ok) process.exitCode = 1;
