import { test } from "node:test";
import assert from "node:assert/strict";
import { flyProvider, FLY_APP_PREFIX } from "../providers/fly.ts";
import { fakeServer, type Seen } from "./fake-server.ts";

const spec = {
  image: "node:24-slim",
  cpus: 1,
  memoryMb: 1024,
  diskGb: 4,
  env: { CONVEX_URL: "https://x.convex.cloud", BOX_NAME: "b1" },
  name: "b1",
  tags: { tb_spike: "1", tb_box: "b1" },
  idempotencyKey: "idem-1",
  files: [{ path: "/agent.mjs", contents: "console.log('hi')" }],
  command: ["node", "/agent.mjs"],
};

// A fake Fly with apps and machines held in memory.
function fakeFly(opts: { apps?: string[]; conflictOnCreate?: boolean } = {}) {
  const apps = new Set(opts.apps ?? []);
  const machines: { id: string; name: string; state: string; config: any }[] = [];
  let n = 0;
  return {
    machines,
    handler(r: Seen) {
      if (r.headers.authorization !== "Bearer tok") return { status: 401, text: "no" };
      let m: RegExpMatchArray | null;
      if (r.method === "GET" && r.path === "/v1/apps") {
        return { json: { total_apps: apps.size, apps: [...apps].map((name) => ({ name })) } };
      }
      if (r.method === "POST" && r.path === "/v1/apps") {
        apps.add(r.json.app_name);
        return { status: 201, json: { id: "app1" } };
      }
      if ((m = r.path.match(/^\/v1\/apps\/([^/]+)$/))) {
        if (r.method === "GET") return apps.has(m[1]) ? { json: { name: m[1] } } : { status: 404, text: "" };
        if (r.method === "DELETE") return apps.delete(m[1]) ? { status: 202 } : { status: 404, text: "" };
      }
      if ((m = r.path.match(/^\/v1\/apps\/([^/]+)\/machines$/))) {
        if (r.method === "GET") {
          // Fake only honours the first metadata filter, like a server that
          // doesn't AND them, so the adapter's own filter is exercised.
          const first = [...r.query.entries()].find(([k]) => k.startsWith("metadata."));
          return {
            json: machines.filter(
              (x) => !first || x.config.metadata?.[first[0].slice(9)] === first[1],
            ),
          };
        }
        if (r.method === "POST") {
          const made = { id: `m${++n}`, name: r.json.name, state: "created", config: r.json.config };
          machines.push(made);
          if (opts.conflictOnCreate) return { status: 409, text: "name taken" };
          return { json: made };
        }
      }
      if ((m = r.path.match(/^\/v1\/apps\/[^/]+\/machines\/([^/]+)(\/\w+)?$/))) {
        const mc = machines.find((x) => x.id === m![1]);
        if (!mc) return { status: 404, text: "" };
        const action = m[2];
        if (r.method === "POST" && action === "/suspend") mc.state = "suspended";
        else if (r.method === "POST" && action === "/start") mc.state = "started";
        else if (r.method === "GET" && action === "/wait") {
          return mc.state === r.query.get("state") ? { json: { ok: true } } : { status: 408, text: "timeout" };
        } else if (r.method === "DELETE" && !action) mc.state = "destroyed";
        else return undefined;
        return { json: { ok: true } };
      }
      return undefined;
    },
  };
}

test("create makes the app once, then one machine with the agent file and tags", async () => {
  const fly = fakeFly();
  const srv = await fakeServer((r) => fly.handler(r));
  try {
    const p = flyProvider({ token: "tok", org: "my-org", baseUrl: `${srv.url}/v1` });
    const { providerBoxId } = await p.create(spec);
    assert.equal(providerBoxId, "m1");

    const appList = srv.seen.find((r) => r.method === "GET" && r.path === "/v1/apps")!;
    assert.equal(appList.query.get("org_slug"), "my-org");
    const appMake = srv.seen.find((r) => r.method === "POST" && r.path === "/v1/apps")!;
    assert.equal(appMake.json.org_slug, "my-org");
    assert.ok(appMake.json.app_name.startsWith(FLY_APP_PREFIX));

    const posts = srv.seen.filter((r) => r.method === "POST" && r.path.endsWith("/machines"));
    assert.equal(posts.length, 1);
    const body = posts[0].json;
    assert.equal(body.name, "b1");
    assert.equal(body.config.image, "node:24-slim");
    assert.deepEqual(body.config.guest, { cpu_kind: "shared", cpus: 1, memory_mb: 1024 });
    assert.deepEqual(body.config.env, spec.env);
    assert.deepEqual(body.config.metadata, { tb_spike: "1", tb_box: "b1", tb_idem: "idem-1" });
    assert.equal(body.config.files[0].guest_path, "/agent.mjs");
    assert.equal(Buffer.from(body.config.files[0].raw_value, "base64").toString(), "console.log('hi')");
    assert.deepEqual(body.config.init, { cmd: ["node", "/agent.mjs"] });
    assert.equal(body.config.restart.policy, "no");

    // The list before the create asked by the idempotency tag.
    const firstList = srv.seen.find((r) => r.method === "GET" && r.path.endsWith("/machines"))!;
    assert.equal(firstList.query.get("metadata.tb_idem"), "idem-1");
  } finally {
    await srv.close();
  }
});

test("a repeated create with the same idempotency key finds the first machine", async () => {
  const fly = fakeFly({ apps: [`${FLY_APP_PREFIX}abc`] });
  const srv = await fakeServer((r) => fly.handler(r));
  try {
    const p = flyProvider({ token: "tok", baseUrl: `${srv.url}/v1` });
    const a = await p.create(spec);
    const b = await p.create({ ...spec, name: "b1-retry" });
    assert.equal(a.providerBoxId, b.providerBoxId);
    assert.equal(fly.machines.length, 1);
    // Found the existing spike app, didn't make another.
    assert.equal(srv.seen.filter((r) => r.method === "POST" && r.path === "/v1/apps").length, 0);
    assert.ok(srv.seen.some((r) => r.path === `/v1/apps/${FLY_APP_PREFIX}abc/machines`));
    // A different key does make a second one.
    await p.create({ ...spec, idempotencyKey: "idem-2" });
    assert.equal(fly.machines.length, 2);
  } finally {
    await srv.close();
  }
});

test("a 409 on create lists again and returns what's there", async () => {
  const fly = fakeFly({ apps: ["given-app"], conflictOnCreate: true });
  const srv = await fakeServer((r) => fly.handler(r));
  try {
    const p = flyProvider({ token: "tok", app: "given-app", baseUrl: `${srv.url}/v1` });
    assert.equal((await p.create(spec)).providerBoxId, "m1");
    assert.ok(srv.seen.some((r) => r.method === "GET" && r.path === "/v1/apps/given-app"));
  } finally {
    await srv.close();
  }
});

test("list filters by every tag and maps states; pause, resume, destroy", async () => {
  const fly = fakeFly({ apps: ["given-app"] });
  const srv = await fakeServer((r) => fly.handler(r));
  try {
    const p = flyProvider({ token: "tok", app: "given-app", baseUrl: `${srv.url}/v1` });
    const { providerBoxId: id } = await p.create(spec);
    await p.create({ ...spec, idempotencyKey: "other", tags: { tb_spike: "1", tb_box: "b2" } });

    const listed = await p.list({ tb_spike: "1", tb_box: "b1" });
    assert.deepEqual(listed, [{ providerBoxId: id, state: "running" }]);
    const listReq = srv.seen.filter((r) => r.method === "GET" && r.path.endsWith("/machines")).at(-1)!;
    assert.equal(listReq.query.get("metadata.tb_spike"), "1");
    assert.equal(listReq.query.get("metadata.tb_box"), "b1");

    await p.pause!(id);
    assert.ok(srv.seen.some((r) => r.method === "POST" && r.path === `/v1/apps/given-app/machines/${id}/suspend`));
    const waitSus = srv.seen.find((r) => r.path.endsWith(`/${id}/wait`))!;
    assert.equal(waitSus.query.get("state"), "suspended");
    assert.deepEqual(await p.list({ tb_box: "b1" }), [{ providerBoxId: id, state: "paused" }]);

    await p.resume!(id);
    assert.ok(srv.seen.some((r) => r.method === "POST" && r.path.endsWith(`/${id}/start`)));
    assert.equal(srv.seen.filter((r) => r.path.endsWith(`/${id}/wait`)).at(-1)!.query.get("state"), "started");

    await p.destroy(id);
    const del = srv.seen.find((r) => r.method === "DELETE" && r.path.endsWith(`/machines/${id}`))!;
    assert.equal(del.query.get("force"), "true");
    assert.deepEqual(await p.list({ tb_box: "b1" }), []);
    await p.destroy(id); // already gone is fine
  } finally {
    await srv.close();
  }
});

test("list and teardown with no spike app don't make one", async () => {
  const fly = fakeFly({ apps: ["someone-elses"] });
  const srv = await fakeServer((r) => fly.handler(r));
  try {
    const p = flyProvider({ token: "tok", baseUrl: `${srv.url}/v1` });
    assert.deepEqual(await p.list({ tb_spike: "1" }), []);
    await p.teardown!();
    assert.equal(srv.seen.filter((r) => r.method !== "GET").length, 0);
  } finally {
    await srv.close();
  }
});
