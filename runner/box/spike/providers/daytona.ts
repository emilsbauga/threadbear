// Daytona adapter (https://www.daytona.io/docs/en/tools/api/, OpenAPI at
// https://www.daytona.io/docs/openapi.json and the toolbox's at
// https://www.daytona.io/docs/toolbox-openapi.json, read 16 Nov 2026).
//
// Main API, https://app.daytona.io/api, `Authorization: Bearer $DAYTONA_API_KEY`:
//   GET    /sandbox?labels=<json>&limit=&cursor=   list by label
//   POST   /sandbox                                create
//   GET    /sandbox/<id>                           state, toolboxProxyUrl
//   POST   /sandbox/<id>/pause                     Linux VM only: memory kept
//   POST   /sandbox/<id>/stop                      containers: memory lost
//   POST   /sandbox/<id>/start                     start or resume
//   DELETE /sandbox/<id>
// Toolbox, `{toolboxProxyUrl}/{sandboxId}` (default
// https://proxy.app.daytona.io/toolbox/<id>), same bearer:
//   POST   /files/upload-v2?path=<abs>             multipart field "file"
//   POST   /process/execute {command, timeout}     run and wait
//   POST   /process/session {sessionId}
//   POST   /process/session/<sid>/exec {command, runAsync: true}
//
// Two classes of sandbox (docs/en/sandboxes, docs/en/persistence):
// - "vm" (default): Linux VM sandboxes, made only from a VM snapshot
//   (`daytona-vm-small`: 1 vCPU, 1 GiB). Pause "freezes the VM with memory
//   intact, resuming continues all processes from the point they were
//   frozen". caps.pause is true. This is the one the spike is about.
// - "container": the default class. "Pause is not supported for container
//   sandboxes", so pause/resume here are stop/start: the filesystem stays,
//   memory doesn't, and resume launches the agent again (a new process).
//   caps.pause is false; the driver still runs the cycle to time it.
//
// Not sure about, to check on the first real run:
// - Whether a VM snapshot takes cpu/memory/disk at create. The SDK only
//   sets resources when creating from an image, so for "vm" they're left
//   out and the snapshot's size is used.
// - What the VM snapshot has installed. start.sh installs Node 24 from
//   nodejs.org into the box if there's no Node with a global WebSocket.
// - Whether toolbox commands see the sandbox's `env`. It's passed at
//   create (the interface's meaning) and also written to env.sh, which
//   start.sh sources.
// - Whether a duplicate sandbox name is refused; on a 409 we list again.
//   As with Fly, two racing creates can both miss the list.
// - The session exec body has both `runAsync` and `async`; we send both.
// - List is paginated ({items, nextCursor}) in the current spec; an older
//   bare array is accepted too.
import {
  call,
  HttpError,
  IDEMPOTENCY_TAG,
  sleep,
  type BoxProvider,
  type BoxState,
  type Fetch,
  type SpikeCreateSpec,
} from "./types.ts";

export type DaytonaOptions = {
  apiKey: string;
  kind?: "vm" | "container"; // DAYTONA_CLASS, default vm
  snapshot?: string; // DAYTONA_SNAPSHOT, default daytona-vm-small for vm
  target?: string; // DAYTONA_TARGET region
  orgId?: string; // only needed with a JWT, not an API key
  ttlMinutes?: number; // backstop so a forgotten box dies on its own
  baseUrl?: string;
  toolboxUrl?: string;
  pollMs?: number;
  fetch?: Fetch;
};

// Everything the adapter puts in a box lives here: /tmp is writable for
// whatever user the snapshot runs as.
export const BOX_DIR = "/tmp/tb-spike";

// install: make sure there's a Node with a global WebSocket (22+), fetching
//          the latest 24.x from nodejs.org if not.
// run:     start the given command detached, logging to agent.log.
export const START_SH = `#!/bin/sh
set -e
D=${BOX_DIR}
if [ -f "$D/env.sh" ]; then . "$D/env.sh"; fi
PATH="$D/node/bin:$PATH"; export PATH
case "$1" in
install)
  if node -e 'process.exit(typeof WebSocket === "function" ? 0 : 1)' 2>/dev/null; then
    echo "node $(node --version) at $(command -v node)"; exit 0
  fi
  case "$(uname -m)" in x86_64) A=x64;; aarch64|arm64) A=arm64;; *) echo "unknown arch $(uname -m)"; exit 1;; esac
  get() { if command -v curl >/dev/null; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }
  U=https://nodejs.org/dist/latest-v24.x
  F=$(get "$U/SHASUMS256.txt" | awk -v a="linux-$A.tar.gz" '$2 ~ a"$" {print $2}')
  mkdir -p "$D/node"
  get "$U/$F" | tar -xz -C "$D/node" --strip-components=1
  echo "installed node $(node --version)"
  ;;
run)
  shift
  nohup "$@" >> "$D/agent.log" 2>&1 &
  echo "started $!"
  ;;
esac
`;

type Sandbox = { id: string; state: string; labels?: Record<string, string>; toolboxProxyUrl?: string; errorReason?: string };

function boxState(state: string): BoxState {
  if (["started", "starting", "creating", "restoring", "resuming", "pulling_snapshot", "pending_build", "building_snapshot"].includes(state)) return "running";
  if (state === "paused" || state === "pausing") return "paused";
  return "stopped";
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function daytonaProvider(opts: DaytonaOptions): BoxProvider {
  const base = (opts.baseUrl ?? "https://app.daytona.io/api").replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? fetch;
  const kind = opts.kind ?? "vm";
  const pollMs = opts.pollMs ?? 2000;
  const headers: Record<string, string> = { authorization: `Bearer ${opts.apiKey}` };
  if (opts.orgId) headers["x-daytona-organization-id"] = opts.orgId;
  const api = <T>(method: string, path: string, body?: unknown) =>
    call<T>(fetchImpl, method, `${base}${path}`, headers, body);

  // What each box was started with, so a container can be relaunched after
  // a stop/start. Lost if the driver restarts, which only cleanup does.
  const launches = new Map<string, SpikeCreateSpec>();

  async function sandboxes(tags: Record<string, string>): Promise<Sandbox[]> {
    const out: Sandbox[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ labels: JSON.stringify(tags), limit: "100" });
      if (cursor) q.set("cursor", cursor);
      const res = await api<Sandbox[] | { items: Sandbox[]; nextCursor: string | null }>(
        "GET",
        `/sandbox?${q}`,
      );
      if (Array.isArray(res)) {
        out.push(...res);
        cursor = undefined;
      } else {
        out.push(...(res?.items ?? []));
        cursor = res?.nextCursor ?? undefined;
      }
    } while (cursor);
    return out.filter(
      (s) =>
        s.state !== "destroyed" &&
        s.state !== "destroying" &&
        Object.entries(tags).every(([k, v]) => s.labels?.[k] === v),
    );
  }

  async function waitFor(id: string, want: string, timeoutMs = 5 * 60_000): Promise<Sandbox> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const sb = await api<Sandbox>("GET", `/sandbox/${id}`);
      if (sb.state === want) return sb;
      if (["error", "build_failed", "destroyed"].includes(sb.state)) {
        throw new Error(`sandbox ${id} is ${sb.state}${sb.errorReason ? `: ${sb.errorReason}` : ""}`);
      }
      if (Date.now() > until) throw new Error(`sandbox ${id} still ${sb.state} after ${timeoutMs} ms, wanted ${want}`);
      await sleep(pollMs);
    }
  }

  // Drop the files in, make sure Node is there, start the command detached.
  async function launch(sb: Sandbox, spec: SpikeCreateSpec) {
    const tb = `${(sb.toolboxProxyUrl ?? opts.toolboxUrl ?? "https://proxy.app.daytona.io/toolbox").replace(/\/$/, "")}/${sb.id}`;
    const toolbox = <T>(method: string, path: string, body?: unknown) =>
      call<T>(fetchImpl, method, `${tb}${path}`, headers, body);
    const upload = async (path: string, contents: string) => {
      const form = new FormData();
      form.append("file", new Blob([contents]), path.split("/").pop());
      const res = await fetchImpl(`${tb}/files/upload-v2?path=${encodeURIComponent(path)}`, {
        method: "POST",
        headers,
        body: form,
      });
      if (!res.ok) throw new HttpError("POST", `${tb}/files/upload-v2`, res.status, await res.text());
    };

    const envSh = Object.entries(spec.env)
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("\n");
    await upload(`${BOX_DIR}/start.sh`, START_SH);
    await upload(`${BOX_DIR}/env.sh`, envSh + "\n");
    for (const f of spec.files ?? []) await upload(BOX_DIR + f.path, f.contents);

    const install = await toolbox<{ exitCode?: number; result?: string }>("POST", "/process/execute", {
      command: `sh ${BOX_DIR}/start.sh install`,
      timeout: 300,
    });
    if (install?.exitCode !== 0) {
      throw new Error(`installing node in ${sb.id} failed (${install?.exitCode}): ${install?.result ?? ""}`);
    }

    // Paths the spec gave as box-root paths (Fly's files) live under BOX_DIR here.
    const filePaths = new Set((spec.files ?? []).map((f) => f.path));
    const argv = (spec.command ?? []).map((a) => (filePaths.has(a) ? BOX_DIR + a : a));
    const sessionId = `tb-agent-${Date.now()}`;
    await toolbox("POST", "/process/session", { sessionId });
    await toolbox("POST", `/process/session/${sessionId}/exec`, {
      command: `sh ${BOX_DIR}/start.sh run ${argv.map(shellQuote).join(" ")}`,
      runAsync: true,
      async: true,
    });
  }

  return {
    name: "daytona",
    caps: { pause: kind === "vm" },

    async create(spec) {
      const idem = { [IDEMPOTENCY_TAG]: spec.idempotencyKey };
      const existing = await sandboxes(idem);
      // Found: the first create made it. The spike assumes that create also
      // launched the agent; a real adapter would check the box's runner is up.
      if (existing[0]) return { providerBoxId: existing[0].id };

      const common = {
        name: spec.name,
        labels: { ...spec.tags, ...idem },
        env: spec.env,
        // We pause and stop it ourselves; Daytona's own timers would get in
        // the way of a 10-minute pause test.
        autoStopInterval: 0,
        ...(kind === "vm" ? { autoPauseInterval: 0 } : {}),
        ttlMinutes: opts.ttlMinutes ?? 120,
        ...(opts.target ? { target: opts.target } : {}),
      };
      const body =
        kind === "vm"
          ? { ...common, snapshot: opts.snapshot ?? "daytona-vm-small" }
          : opts.snapshot
            ? { ...common, snapshot: opts.snapshot }
            : {
                ...common,
                // A container from a plain image goes through a build.
                buildInfo: { dockerfileContent: `FROM ${spec.image}\n` },
                cpu: spec.cpus,
                memory: Math.max(1, Math.ceil(spec.memoryMb / 1024)),
                disk: spec.diskGb,
              };

      let sb: Sandbox;
      try {
        sb = await api<Sandbox>("POST", "/sandbox", body);
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) {
          const again = await sandboxes(idem);
          if (again[0]) return { providerBoxId: again[0].id };
        }
        throw e;
      }
      launches.set(sb.id, spec);
      const started = sb.state === "started" ? sb : await waitFor(sb.id, "started");
      await launch(started, spec);
      return { providerBoxId: sb.id };
    },

    async list(tags) {
      return (await sandboxes(tags)).map((s) => ({ providerBoxId: s.id, state: boxState(s.state) }));
    },

    async pause(id) {
      if (kind === "vm") {
        await api("POST", `/sandbox/${id}/pause`);
        await waitFor(id, "paused");
      } else {
        await api("POST", `/sandbox/${id}/stop`);
        await waitFor(id, "stopped");
      }
    },

    async resume(id) {
      await api("POST", `/sandbox/${id}/start`);
      const sb = await waitFor(id, "started");
      if (kind === "container") {
        const spec = launches.get(id);
        if (!spec) throw new Error(`don't know how ${id} was started, can't relaunch its agent`);
        await launch(sb, spec);
      }
    },

    async destroy(id) {
      try {
        await api("DELETE", `/sandbox/${id}`);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
    },
  };
}
