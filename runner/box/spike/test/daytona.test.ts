import { test } from "node:test";
import assert from "node:assert/strict";
import { daytonaProvider, BOX_DIR } from "../providers/daytona.ts";
import { fakeServer, type Seen } from "./fake-server.ts";

const spec = {
  image: "node:24-slim",
  cpus: 1,
  memoryMb: 1024,
  diskGb: 4,
  env: { CONVEX_URL: "https://x.convex.cloud", SPIKE_KEY: "it's secret", BOX_NAME: "b1" },
  name: "b1",
  tags: { tb_spike: "1", tb_box: "b1" },
  idempotencyKey: "idem-1",
  files: [{ path: "/agent.mjs", contents: "console.log('agent')" }],
  command: ["node", "/agent.mjs"],
};

// A fake Daytona: sandboxes go creating -> started on the first GET, and
// pausing/stopping settle on the next GET, so the adapter has to poll.
function fakeDaytona(url: () => string, opts: { pageSize?: number } = {}) {
  const boxes: { id: string; name: string; state: string; labels: Record<string, string>; body: any }[] = [];
  let n = 0;
  const settle: Record<string, string> = { creating: "started", pausing: "paused", stopping: "stopped", starting: "started" };
  return {
    boxes,
    handler(r: Seen) {
      if (r.headers.authorization !== "Bearer key") return { status: 401, text: "no" };
      const view = (b: (typeof boxes)[number]) => ({
        id: b.id,
        name: b.name,
        state: b.state,
        labels: b.labels,
        toolboxProxyUrl: `${url()}/toolbox`,
      });
      let m: RegExpMatchArray | null;
      if (r.path === "/api/sandbox" && r.method === "GET") {
        const want = JSON.parse(r.query.get("labels") ?? "{}");
        const hits = boxes.filter(
          (b) => b.state !== "destroyed" && Object.entries(want).every(([k, v]) => b.labels[k] === v),
        );
        const size = opts.pageSize ?? 100;
        const start = Number(r.query.get("cursor") ?? 0);
        const page = hits.slice(start, start + size);
        const next = start + size < hits.length ? String(start + size) : null;
        return { json: { items: page.map(view), nextCursor: next } };
      }
      if (r.path === "/api/sandbox" && r.method === "POST") {
        const b = { id: `sb${++n}`, name: r.json.name, state: "creating", labels: r.json.labels, body: r.json };
        boxes.push(b);
        return { json: view(b) };
      }
      if ((m = r.path.match(/^\/api\/sandbox\/([^/]+)(\/\w+)?$/))) {
        const b = boxes.find((x) => x.id === m![1]);
        if (!b) return { status: 404, text: "" };
        const action = m[2];
        if (r.method === "GET" && !action) {
          const out = view(b);
          b.state = settle[b.state] ?? b.state;
          return { json: out };
        }
        if (r.method === "POST" && action === "/pause") b.state = "pausing";
        else if (r.method === "POST" && action === "/stop") b.state = "stopping";
        else if (r.method === "POST" && action === "/start") b.state = "starting";
        else if (r.method === "DELETE" && !action) b.state = "destroyed";
        else return undefined;
        return { json: view(b) };
      }
      if ((m = r.path.match(/^\/toolbox\/([^/]+)\/(.*)$/))) {
        const rest = m[2];
        if (rest === "files/upload-v2" && r.method === "POST") return { json: {} };
        if (rest === "process/execute") return { json: { exitCode: 0, result: "node v24.0.0" } };
        if (rest === "process/session") return { json: {} };
        if (/^process\/session\/[^/]+\/exec$/.test(rest)) return { json: { cmdId: "c1" } };
      }
      return undefined;
    },
  };
}

async function withFake(
  opts: { pageSize?: number },
  fn: (srv: Awaited<ReturnType<typeof fakeServer>>, fake: ReturnType<typeof fakeDaytona>) => Promise<void>,
) {
  let base = "";
  const fake = fakeDaytona(() => base, opts);
  const srv = await fakeServer((r) => fake.handler(r));
  base = srv.url;
  try {
    await fn(srv, fake);
  } finally {
    await srv.close();
  }
}

const toolboxCalls = (seen: Seen[], id: string) => seen.filter((r) => r.path.startsWith(`/toolbox/${id}/`));

test("vm create: lists by key, makes a VM sandbox, uploads the agent and starts it", () =>
  withFake({}, async (srv, fake) => {
    const p = daytonaProvider({ apiKey: "key", baseUrl: `${srv.url}/api`, pollMs: 1 });
    assert.equal(p.caps.pause, true);
    const { providerBoxId: id } = await p.create(spec);
    assert.equal(id, "sb1");

    const firstList = srv.seen[0];
    assert.equal(firstList.method, "GET");
    assert.deepEqual(JSON.parse(firstList.query.get("labels")!), { tb_idem: "idem-1" });

    const body = fake.boxes[0].body;
    assert.equal(body.snapshot, "daytona-vm-small");
    assert.equal(body.name, "b1");
    assert.deepEqual(body.labels, { tb_spike: "1", tb_box: "b1", tb_idem: "idem-1" });
    assert.deepEqual(body.env, spec.env);
    assert.equal(body.autoStopInterval, 0);
    assert.equal(body.autoPauseInterval, 0);
    assert.equal(body.ttlMinutes, 120);
    assert.equal(body.cpu, undefined, "a VM snapshot brings its own size");
    assert.equal(body.buildInfo, undefined);

    const tb = toolboxCalls(srv.seen, id);
    const uploads = tb.filter((r) => r.path.endsWith("/files/upload-v2"));
    assert.deepEqual(
      uploads.map((r) => r.query.get("path")),
      [`${BOX_DIR}/start.sh`, `${BOX_DIR}/env.sh`, `${BOX_DIR}/agent.mjs`],
    );
    assert.ok(uploads.every((r) => String(r.headers["content-type"]).startsWith("multipart/form-data")));
    assert.ok(uploads[2].body.includes("console.log('agent')"));
    // The env file quotes values for the shell.
    assert.ok(uploads[1].body.includes(`export SPIKE_KEY='it'\\''s secret'`));

    const exec = tb.find((r) => r.path.endsWith("/process/execute"))!;
    assert.equal(exec.json.command, `sh ${BOX_DIR}/start.sh install`);
    const session = tb.find((r) => r.path.endsWith("/process/session"))!;
    assert.match(session.json.sessionId, /^tb-agent-/);
    const run = tb.find((r) => r.path.endsWith("/exec"))!;
    assert.equal(run.path, `/toolbox/${id}/process/session/${session.json.sessionId}/exec`);
    assert.equal(run.json.runAsync, true);
    assert.equal(run.json.command, `sh ${BOX_DIR}/start.sh run 'node' '${BOX_DIR}/agent.mjs'`);
    // Uploads happen only once the sandbox is started.
    const startedAt = srv.seen.findIndex((r) => r.method === "GET" && r.path === `/api/sandbox/${id}`);
    assert.ok(startedAt >= 0 && startedAt < srv.seen.indexOf(uploads[0]));
  }));

test("a repeated create with the same idempotency key finds the first sandbox", () =>
  withFake({}, async (srv, fake) => {
    const p = daytonaProvider({ apiKey: "key", baseUrl: `${srv.url}/api`, pollMs: 1 });
    const a = await p.create(spec);
    const b = await p.create({ ...spec, name: "b1-retry" });
    assert.equal(a.providerBoxId, b.providerBoxId);
    assert.equal(fake.boxes.length, 1);
    assert.equal(srv.seen.filter((r) => r.method === "POST" && r.path === "/api/sandbox").length, 1);
  }));

test("vm pause and resume use pause/start and wait for the state", () =>
  withFake({}, async (srv, fake) => {
    const p = daytonaProvider({ apiKey: "key", baseUrl: `${srv.url}/api`, pollMs: 1 });
    const { providerBoxId: id } = await p.create(spec);
    const before = toolboxCalls(srv.seen, id).length;
    await p.pause!(id);
    assert.equal(fake.boxes[0].state, "paused");
    assert.deepEqual(await p.list({ tb_box: "b1" }), [{ providerBoxId: id, state: "paused" }]);
    await p.resume!(id);
    assert.equal(fake.boxes[0].state, "started");
    assert.ok(srv.seen.some((r) => r.method === "POST" && r.path === `/api/sandbox/${id}/pause`));
    assert.ok(srv.seen.some((r) => r.method === "POST" && r.path === `/api/sandbox/${id}/start`));
    assert.equal(toolboxCalls(srv.seen, id).length, before, "a VM resume doesn't relaunch the agent");
  }));

test("container class: built from the image, pause is stop, resume relaunches", () =>
  withFake({}, async (srv, fake) => {
    const p = daytonaProvider({ apiKey: "key", kind: "container", baseUrl: `${srv.url}/api`, pollMs: 1 });
    assert.equal(p.caps.pause, false);
    const { providerBoxId: id } = await p.create(spec);
    const body = fake.boxes[0].body;
    assert.deepEqual(body.buildInfo, { dockerfileContent: "FROM node:24-slim\n" });
    assert.equal(body.cpu, 1);
    assert.equal(body.memory, 1);
    assert.equal(body.disk, 4);
    assert.equal(body.autoPauseInterval, undefined);

    const launches = () => toolboxCalls(srv.seen, id).filter((r) => r.path.endsWith("/exec")).length;
    assert.equal(launches(), 1);
    await p.pause!(id);
    assert.ok(srv.seen.some((r) => r.method === "POST" && r.path === `/api/sandbox/${id}/stop`));
    assert.equal(fake.boxes[0].state, "stopped");
    assert.deepEqual(await p.list({ tb_box: "b1" }), [{ providerBoxId: id, state: "stopped" }]);
    await p.resume!(id);
    assert.equal(launches(), 2);
  }));

test("list follows the cursor and drops other labels; destroy deletes", () =>
  withFake({ pageSize: 1 }, async (srv) => {
    const p = daytonaProvider({ apiKey: "key", baseUrl: `${srv.url}/api`, pollMs: 1 });
    const a = await p.create(spec);
    const b = await p.create({ ...spec, idempotencyKey: "idem-2", name: "b2", tags: { tb_spike: "1", tb_box: "b2" } });
    const all = await p.list({ tb_spike: "1" });
    assert.deepEqual(all.map((x) => x.providerBoxId).sort(), [a.providerBoxId, b.providerBoxId]);
    assert.ok(srv.seen.some((r) => r.query.get("cursor") === "1"));
    await p.destroy(a.providerBoxId);
    assert.ok(srv.seen.some((r) => r.method === "DELETE" && r.path === `/api/sandbox/${a.providerBoxId}`));
    assert.deepEqual((await p.list({ tb_spike: "1" })).map((x) => x.providerBoxId), [b.providerBoxId]);
  }));
