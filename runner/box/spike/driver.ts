// Runs the "a paused box comes back as the same runner" check on one
// provider and prints a JSON summary. See README.md.
//
//   node driver.ts <fly|daytona> run [--pause-min N]   (default 2; the real run uses 10)
//   node driver.ts <fly|daytona> cleanup               destroy every spike box (and Fly's app)
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readFile } from "node:fs/promises";
import { buildAgent } from "./build.ts";
import { daytonaProvider } from "./providers/daytona.ts";
import { flyProvider } from "./providers/fly.ts";
import { sleep, type BoxProvider } from "./providers/types.ts";

const SPIKE_TAG = { tb_spike: "1" };
const api = anyApi.spike;

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`set ${name}`);
  return value;
}

function provider(name: string): BoxProvider {
  if (name === "fly") {
    return flyProvider({
      token: env("FLY_API_TOKEN"),
      org: env("FLY_ORG", "personal"),
      app: process.env.FLY_APP,
      region: process.env.FLY_REGION,
    });
  }
  if (name === "daytona") {
    const kind = env("DAYTONA_CLASS", "vm");
    if (kind !== "vm" && kind !== "container") throw new Error("DAYTONA_CLASS is vm or container");
    return daytonaProvider({
      apiKey: env("DAYTONA_API_KEY"),
      kind,
      snapshot: process.env.DAYTONA_SNAPSHOT,
      target: process.env.DAYTONA_TARGET,
      baseUrl: process.env.DAYTONA_API_URL,
    });
  }
  throw new Error(`unknown provider ${name}: fly or daytona`);
}

const log = (...parts: unknown[]) => console.error(new Date().toISOString(), ...parts);

type Beat = { pid: number; startedAt: number; connectionCount: number; at: number };
type Command = { state: string; attempts: number; takes: number; finishes: number; takenBy?: string };

async function waitUntil<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined | null | false>): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const got = await probe();
    if (got) return got;
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(1000);
  }
}

async function run(providerName: string, pauseMin: number) {
  const p = provider(providerName);
  const key = env("SPIKE_KEY");
  const convexUrl = env("CONVEX_URL");
  const convex = new ConvexHttpClient(convexUrl);
  const q = <T>(fn: any, args: Record<string, unknown>) => convex.query(fn, { key, ...args }) as Promise<T>;
  const m = <T>(fn: any, args: Record<string, unknown>) => convex.mutation(fn, { key, ...args }) as Promise<T>;

  const agent = await readFile(await buildAgent(), "utf8");
  const name = `spike-${providerName}-${Date.now().toString(36)}`;
  const tags = { ...SPIKE_TAG, tb_box: name };
  const idempotencyKey = `idem-${name}`;
  const spec = {
    image: "node:24-slim",
    cpus: 1,
    memoryMb: 1024, // Fly suspend needs <= 2 GB
    diskGb: 4,
    env: { CONVEX_URL: convexUrl, SPIKE_KEY: key, BOX_NAME: name },
    name,
    tags,
    idempotencyKey,
    files: [{ path: "/agent.mjs", contents: agent }],
    command: ["node", "/agent.mjs"],
  };

  const summary: Record<string, unknown> = {
    provider: providerName,
    caps: p.caps,
    box: name,
    pauseMinutes: pauseMin,
    checks: {} as Record<string, boolean>,
  };
  const checks = summary.checks as Record<string, boolean>;
  let id: string | undefined;

  try {
    await m(api.registerBox, { name, provider: providerName, idempotencyKey });
    const tCreate = Date.now();
    log("create", name);
    id = (await p.create(spec)).providerBoxId;
    summary.createCallMs = Date.now() - tCreate;
    await m(api.setBox, { name, providerBoxId: id, state: "starting" });

    // A Convex action retry: same key, must find the same box.
    const again = (await p.create({ ...spec, name: `${name}-retry` })).providerBoxId;
    const listed = await p.list(tags);
    checks.idempotentCreate = again === id && listed.length === 1;
    summary.idempotency = { first: id, retry: again, listed: listed.length };
    log("idempotent create", summary.idempotency);

    const first = await waitUntil<Beat[]>("first heartbeat", 5 * 60_000, async () => {
      const b = await q<Beat[]>(api.beats, { box: name });
      return b.length > 0 && b;
    });
    summary.createToFirstHeartbeatMs = first[0].at - tCreate;
    await m(api.setBox, { name, state: "running" });
    log("first heartbeat", summary.createToFirstHeartbeatMs, "ms");

    // A command while awake, as a baseline.
    const awakeCmd = await m<string>(api.queue, { box: name, text: "while awake" });
    const tQueued = Date.now();
    await waitUntil("awake command done", 60_000, async () => (await q<Command>(api.command, { id: awakeCmd }))?.state === "done");
    summary.awakeCommandMs = Date.now() - tQueued;

    const beforePause = (await q<Beat[]>(api.beats, { box: name })).at(-1)!;
    await m(api.setBox, { name, state: "pausing" });
    const tPause = Date.now();
    await p.pause!(id);
    summary.pauseMs = Date.now() - tPause;
    const pausedAt = Date.now();
    await m(api.setBox, { name, state: "paused" });
    log("paused in", summary.pauseMs, "ms; listed as", (await p.list(tags))[0]?.state);
    summary.listedWhilePaused = (await p.list(tags))[0]?.state;

    const pausedCmd = await m<string>(api.queue, { box: name, text: "queued while paused" });
    let stayedPending = true;
    const pausedUntil = Date.now() + pauseMin * 60_000;
    while (Date.now() < pausedUntil) {
      const c = await q<Command>(api.command, { id: pausedCmd });
      if (c?.state !== "pending") stayedPending = false;
      await sleep(Math.min(15_000, Math.max(0, pausedUntil - Date.now())));
    }
    checks.commandStayedPendingWhilePaused = stayedPending;
    const beatsWhilePaused = await q<Beat[]>(api.beats, { box: name, since: pausedAt });
    // A heartbeat while "paused" means the pause didn't freeze anything.
    checks.noHeartbeatsWhilePaused = beatsWhilePaused.length === 0;

    await m(api.setBox, { name, state: "resuming" });
    const tResume = Date.now();
    await p.resume!(id);
    summary.resumeCallMs = Date.now() - tResume;
    const afterResume = await waitUntil<Beat[]>("heartbeat after resume", 5 * 60_000, async () => {
      const b = await q<Beat[]>(api.beats, { box: name, since: tResume });
      return b.length > 0 && b;
    });
    summary.resumeToFirstHeartbeatMs = afterResume[0].at - tResume;
    await m(api.setBox, { name, state: "running" });
    const back = afterResume[0];
    summary.sameProcess = back.pid === beforePause.pid && back.startedAt === beforePause.startedAt;
    summary.process = {
      beforePause: { pid: beforePause.pid, startedAt: beforePause.startedAt, connectionCount: beforePause.connectionCount },
      afterResume: { pid: back.pid, startedAt: back.startedAt, connectionCount: back.connectionCount },
    };
    log("back after", summary.resumeToFirstHeartbeatMs, "ms; same process:", summary.sameProcess);

    const done = await waitUntil<Command>("paused command done", 3 * 60_000, async () => {
      const c = await q<Command>(api.command, { id: pausedCmd });
      return c?.state === "done" && c;
    });
    summary.pausedCommand = { attempts: done.attempts, takes: done.takes, finishes: done.finishes, takenBy: done.takenBy };
    checks.pausedCommandTakenOnce = done.takes === 1 && done.finishes === 1;

    // Keeps heartbeating, not just one beat that was in flight at the pause.
    await waitUntil("two more heartbeats", 60_000, async () => {
      const b = await q<Beat[]>(api.beats, { box: name, since: tResume });
      return b.length >= 3;
    });
    checks.heartbeatsAfterResume = true;
    // Did the websocket reconnect, or did the old one survive the pause?
    const latest = (await q<Beat[]>(api.beats, { box: name, since: tResume })).at(-1)!;
    summary.reconnectedAfterResume = latest.connectionCount > beforePause.connectionCount;

    const awakeFinal = await q<Command>(api.command, { id: awakeCmd });
    checks.awakeCommandTakenOnce = awakeFinal.takes === 1 && awakeFinal.finishes === 1;
  } catch (e) {
    summary.error = String(e);
    log("failed:", e);
  } finally {
    if (id) {
      const tDestroy = Date.now();
      try {
        await p.destroy(id);
        await m(api.setBox, { name, state: "destroyed" }).catch(() => {});
        await waitUntil("box gone from list", 2 * 60_000, async () => (await p.list(tags)).length === 0);
        summary.destroyToGoneMs = Date.now() - tDestroy;
        checks.goneAfterDestroy = true;
      } catch (e) {
        checks.goneAfterDestroy = false;
        summary.destroyError = String(e);
      }
    }
  }
  summary.ok = !summary.error && Object.values(checks).every(Boolean);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

async function cleanup(providerName: string) {
  const p = provider(providerName);
  const boxes = await p.list(SPIKE_TAG);
  for (const b of boxes) {
    log("destroy", b.providerBoxId, b.state);
    await p.destroy(b.providerBoxId);
  }
  if (p.teardown) await p.teardown();
  console.log(JSON.stringify({ provider: providerName, destroyed: boxes.length }));
}

const [providerName, cmd, ...rest] = process.argv.slice(2);
const flag = rest.indexOf("--pause-min");
const pauseMin = flag >= 0 ? Number(rest[flag + 1]) : 2;
if (cmd === "run") await run(providerName, pauseMin);
else if (cmd === "cleanup") await cleanup(providerName);
else {
  console.error("usage: node driver.ts <fly|daytona> <run [--pause-min N] | cleanup>");
  process.exitCode = 2;
}
