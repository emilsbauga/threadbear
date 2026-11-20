// The spike's stand-in for a box runner: one long-lived process holding a
// Convex websocket, heartbeating and taking commands. Bundled by build.ts
// into dist/agent.mjs, a single file that runs on a bare `node:24-slim`
// (no node_modules in the box).
//
// Every heartbeat carries this process's pid and start time, so the driver
// can tell "the same process came back from a pause" from "the box was
// cold-booted and this is a new one".
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";

const HEARTBEAT_MS = 10_000;

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`agent: ${name} isn't set`);
    process.exit(2);
  }
  return value;
}

const url = need("CONVEX_URL");
const key = need("SPIKE_KEY");
const box = need("BOX_NAME");
const pid = process.pid;
const startedAt = Date.now();
const me = `${box}:${pid}:${startedAt}`;
const api = anyApi.spike;

function log(...parts: unknown[]) {
  console.log(new Date().toISOString(), `[${pid} started ${startedAt}]`, ...parts);
}

// Node 22+ has a global WebSocket. Passing it explicitly means the bundle
// doesn't need the `ws` copy convex's node entry carries.
let client = connect();

function connect(): ConvexClient {
  const c = new ConvexClient(url, { webSocketConstructor: globalThis.WebSocket });
  c.subscribeToConnectionState((s) => {
    log("connection", {
      connected: s.isWebSocketConnected,
      connectionCount: s.connectionCount,
      retries: s.connectionRetries,
    });
  });
  c.onUpdate(
    api.pending,
    { key, box },
    (cmds: { _id: string; text: string }[]) => {
      log("pending", cmds.length);
      for (const cmd of cmds) void run(cmd);
    },
    (e) => log("pending subscription error", String(e)),
  );
  return c;
}

// After a pause the process carries on with a websocket whose other end is
// long gone, and the client only notices when the socket times out: on Fly
// that took 60 s (16 Nov). A pause shows up here as a jump in the wall clock
// between two ticks, so then the old client is dropped and a new one made at
// once. The same would help the laptop's runner after the Mac sleeps.
const TICK_MS = 2_000;
const JUMP_MS = 15_000;
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastTick > JUMP_MS) {
    log("clock jumped", now - lastTick, "ms: reconnecting");
    const old = client;
    client = connect();
    void old.close().catch(() => {});
    void beat();
  }
  lastTick = now;
}, TICK_MS);

async function beat() {
  const s = client.connectionState();
  try {
    await client.mutation(api.heartbeat, {
      key,
      box,
      pid,
      startedAt,
      connectionCount: s.connectionCount,
    });
    log("heartbeat", { connectionCount: s.connectionCount });
  } catch (e) {
    log("heartbeat failed", String(e));
  }
}

// Commands this process is already working on, so a second onUpdate before
// the take lands doesn't try twice. The backend's take is the real guard.
const working = new Set<string>();

async function run(cmd: { _id: string; text: string }) {
  if (working.has(cmd._id)) return;
  working.add(cmd._id);
  try {
    const won = await client.mutation(api.take, { key, id: cmd._id, by: me });
    log("take", cmd._id, won ? "won" : "lost");
    if (!won) return;
    // The "work": just echo it. Real commands come in later steps.
    log("run", JSON.stringify(cmd.text));
    const ok = await client.mutation(api.finish, { key, id: cmd._id, by: me });
    log("finish", cmd._id, ok);
  } catch (e) {
    log("command failed", cmd._id, String(e));
    working.delete(cmd._id); // let a later update retry it
  }
}

log("agent up", { box, node: process.version });
void beat();
setInterval(beat, HEARTBEAT_MS);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log("signal", sig);
    void client.close().finally(() => process.exit(0));
  });
}
