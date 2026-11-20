// Fly Machines adapter (https://docs.fly.io/machines/api/).
//
// Endpoints used, all under https://api.machines.dev/v1 with
// `Authorization: Bearer $FLY_API_TOKEN`:
//   GET    /apps?org_slug=<org>                 list apps (to find ours)
//   GET    /apps/<app>                          does our app exist
//   POST   /apps {app_name, org_slug}           make it
//   DELETE /apps/<app>?force=true               teardown
//   GET    /apps/<app>/machines?metadata.k=v    list by tag
//   POST   /apps/<app>/machines                 create
//   POST   /apps/<app>/machines/<id>/suspend    pause (memory snapshot)
//   POST   /apps/<app>/machines/<id>/start      resume a suspended machine
//   GET    /apps/<app>/machines/<id>/wait?state=<s>&timeout=<s>
//   DELETE /apps/<app>/machines/<id>?force=true
//
// Not sure about, to check on the first real run:
// - Idempotency: Fly documents no idempotency header, so create lists by
//   the `tb_idem` metadata tag first. Machine `name` is documented as
//   "Unique name for this Machine" but not whether a duplicate is refused
//   (409?) or allowed; on a 409 we list again. Two creates racing each
//   other can both miss in the list; Convex retries are sequential, so the
//   spike only tests that case.
// - Whether several `metadata.<k>=<v>` filters AND together: only one is
//   shown in the docs, so list also filters what comes back.
// - Suspend needs <= 2 GB of memory, no swap and no schedule
//   (https://docs.fly.io/reference/suspend-resume/). "Snapshots aren't
//   guaranteed to persist": a start after a host move cold-boots (a new
//   process, same rootfs). The driver reports which happened.
// - diskGb is ignored: a Machine's rootfs comes from the image, and extra
//   disk is a Volume, which the spike doesn't need.
import {
  call,
  HttpError,
  IDEMPOTENCY_TAG,
  type BoxProvider,
  type BoxState,
  type Fetch,
  type SpikeCreateSpec,
} from "./types.ts";

export type FlyOptions = {
  token: string;
  org?: string; // FLY_ORG, default "personal"
  app?: string; // FLY_APP; otherwise found or made as tb-box-spike-<random>
  region?: string; // FLY_REGION; otherwise Fly picks one near the caller
  baseUrl?: string;
  fetch?: Fetch;
};

export const FLY_APP_PREFIX = "tb-box-spike-";

type FlyMachine = {
  id: string;
  name?: string;
  state: string;
  config?: { metadata?: Record<string, string> };
};

// Fly's states (https://docs.fly.io/machines/machine-states/) folded into
// the three the interface knows. Destroyed ones are dropped by list.
function boxState(state: string): BoxState {
  if (["started", "starting", "created", "replacing", "updating"].includes(state)) return "running";
  if (state === "suspended" || state === "suspending") return "paused";
  return "stopped";
}

export function flyProvider(opts: FlyOptions): BoxProvider & { appName(): Promise<string> } {
  const base = (opts.baseUrl ?? "https://api.machines.dev/v1").replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? fetch;
  const org = opts.org ?? "personal";
  const headers = { authorization: `Bearer ${opts.token}` };
  const api = <T>(method: string, path: string, body?: unknown) =>
    call<T>(fetchImpl, method, `${base}${path}`, headers, body);

  let app: string | undefined = opts.app;
  let appReady: Promise<string> | undefined;

  // Our app's name if it exists, without making one: listing or cleaning
  // up shouldn't create an app just to find it empty.
  async function findApp(): Promise<string | undefined> {
    if (app) {
      try {
        await api("GET", `/apps/${app}`);
        return app;
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return undefined;
        throw e;
      }
    }
    const res = await api<{ apps?: { name: string }[] }>(
      "GET",
      `/apps?org_slug=${encodeURIComponent(org)}`,
    );
    const found = (res.apps ?? []).find((a) => a.name.startsWith(FLY_APP_PREFIX));
    return found ? (app = found.name) : undefined;
  }

  async function ensureApp(): Promise<string> {
    const found = await findApp();
    if (found) return found;
    app ??= FLY_APP_PREFIX + Math.random().toString(36).slice(2, 8);
    await api("POST", "/apps", { app_name: app, org_slug: org });
    return app;
  }

  const appName = () => (appReady ??= ensureApp().catch((e) => {
    appReady = undefined;
    throw e;
  }));

  async function machines(tags: Record<string, string>, make = false): Promise<FlyMachine[]> {
    const a = make ? await appName() : appReady ? await appReady : await findApp();
    if (!a) return [];
    const q = Object.entries(tags)
      .map(([k, v]) => `metadata.${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const list = await api<FlyMachine[]>("GET", `/apps/${a}/machines${q ? `?${q}` : ""}`);
    return (list ?? []).filter(
      (m) =>
        m.state !== "destroyed" &&
        m.state !== "destroying" &&
        Object.entries(tags).every(([k, v]) => m.config?.metadata?.[k] === v),
    );
  }

  async function wait(id: string, state: string, timeoutS = 60) {
    const a = await appName();
    await api("GET", `/apps/${a}/machines/${id}/wait?state=${state}&timeout=${timeoutS}`);
  }

  return {
    name: "fly",
    caps: { pause: true },
    appName,

    async create(spec: SpikeCreateSpec) {
      const idem = { [IDEMPOTENCY_TAG]: spec.idempotencyKey };
      const existing = await machines(idem, true);
      if (existing[0]) return { providerBoxId: existing[0].id };

      const a = await appName();
      const body = {
        name: spec.name,
        ...(opts.region ? { region: opts.region } : {}),
        config: {
          image: spec.image,
          // shared-cpu, memory in multiples of 256; suspend wants <= 2048.
          guest: { cpu_kind: "shared", cpus: spec.cpus, memory_mb: spec.memoryMb },
          env: spec.env,
          metadata: { ...spec.tags, ...idem },
          files: (spec.files ?? []).map((f) => ({
            guest_path: f.path,
            raw_value: Buffer.from(f.contents).toString("base64"),
          })),
          // `cmd` keeps the image's entrypoint (node's docker-entrypoint.sh,
          // which execs "$@"); `exec` would replace both.
          ...(spec.command ? { init: { cmd: spec.command } } : {}),
          // A crashed agent should show as a stopped box, not quietly come
          // back as a new process the driver might take for a resumed one.
          restart: { policy: "no" },
          auto_destroy: false,
        },
      };
      try {
        const m = await api<FlyMachine>("POST", `/apps/${a}/machines`, body);
        return { providerBoxId: m.id };
      } catch (e) {
        // A duplicate name, if Fly refuses one: the first create got there.
        if (e instanceof HttpError && e.status === 409) {
          const again = await machines(idem);
          if (again[0]) return { providerBoxId: again[0].id };
        }
        throw e;
      }
    },

    async list(tags) {
      return (await machines(tags)).map((m) => ({ providerBoxId: m.id, state: boxState(m.state) }));
    },

    async pause(id) {
      const a = await appName();
      await api("POST", `/apps/${a}/machines/${id}/suspend`);
      await wait(id, "suspended");
    },

    async resume(id) {
      const a = await appName();
      await api("POST", `/apps/${a}/machines/${id}/start`);
      await wait(id, "started");
    },

    async destroy(id) {
      const a = await appName();
      try {
        await api("DELETE", `/apps/${a}/machines/${id}?force=true`);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
    },

    async teardown() {
      const a = await findApp();
      if (!a) return;
      await api("DELETE", `/apps/${a}?force=true`);
      app = opts.app;
      appReady = undefined;
    },
  };
}
