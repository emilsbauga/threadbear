// Fly Machines (https://docs.fly.io/machines/api/), the first provider for
// virtual runners (docs/virtual-runners.md). Ported from the spike's
// adapter (runner/box/spike/providers/fly.ts), which ran against the real
// API on 16 to 18 Nov 2026, to run in a Convex action.
//
// Endpoints, all under https://api.machines.dev/v1 with
// `Authorization: Bearer $FLY_API_TOKEN`:
//   POST   /apps {app_name, org_slug}           make the app, the first time
//   GET    /apps/<app>/machines?metadata.k=v    list by tag
//   POST   /apps/<app>/machines                 create
//   GET    /apps/<app>/machines/<id>            one machine's state
//   POST   /apps/<app>/machines/<id>/suspend    pause (a memory snapshot)
//   POST   /apps/<app>/machines/<id>/start      resume a suspended machine
//   GET    /apps/<app>/machines/<id>/wait?state=<s>&timeout=<s>
//   DELETE /apps/<app>/machines/<id>?force=true
//
// What the spike found:
// - Fly has no idempotency header, so create lists by the `tb_idem`
//   metadata tag first, and a 409 lists again.
// - Several `metadata.<k>=<v>` filters aren't documented to AND together,
//   so list filters what comes back as well.
// - Suspend needs <= 2 GB of memory, no swap and no schedule
//   (https://docs.fly.io/reference/suspend-resume/), so a bigger box
//   can't pause (caps.pause false) and is deleted on sleep instead. A
//   snapshot isn't guaranteed to persist: a start after a host move
//   cold-boots, which the service sees as the box lost (decision 7).
// - The image's own entrypoint runs (the runner in box mode); nothing is
//   injected (no files, no init.cmd), and `restart: no`, so a crashed
//   runner shows as a stopped machine, not a new process passing for the old.
import { call, IDEMPOTENCY_TAG, isPinnedImage, notFound, ProviderError } from './types';
import type { BoxProvider, CreateSpec, Fetch, ListedBox, ProviderBoxState } from './types';

export const FLY_API = 'https://api.machines.dev/v1';
// The most memory a Fly Machine can have and still suspend.
export const FLY_SUSPEND_MAX_MB = 2048;

export type FlyOptions = {
  token: string;
  // The app boxes live in (FLY_APP). Made in `org` the first time it's needed.
  app: string;
  org?: string; // FLY_ORG, default "personal"
  // The service's box size: whether it can suspend.
  memoryMb: number;
  baseUrl?: string;
  fetch?: Fetch;
  // Each call's deadline: it's aborted after this (types.ts call).
  timeoutMs?: number;
};

type FlyMachine = { id: string; name?: string; state: string; config?: { metadata?: Record<string, string> } };

// Fly's states (https://docs.fly.io/machines/machine-states/) folded into
// the three the interface knows. Destroyed ones are dropped by list.
export function flyState(state: string): ProviderBoxState {
  if (['started', 'starting', 'created', 'replacing', 'updating'].includes(state)) return 'running';
  if (state === 'suspended' || state === 'suspending') return 'paused';
  return 'stopped';
}

const enc = encodeURIComponent;

/** The Fly adapter from a deployment's environment: FLY_API_TOKEN, FLY_APP, FLY_ORG. */
export function flyFromEnv(env: Record<string, string | undefined>, memoryMb: number, fetchImpl?: Fetch, timeoutMs?: number): BoxProvider {
  const token = env.FLY_API_TOKEN?.trim();
  const app = env.FLY_APP?.trim();
  if (!token || !app) throw new Error('FLY_API_TOKEN and FLY_APP must be set on this deployment for a Fly virtual runner');
  return flyProvider({ token, app, org: env.FLY_ORG?.trim() || 'personal', memoryMb, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
}

export function flyProvider(opts: FlyOptions): BoxProvider {
  const base = (opts.baseUrl ?? FLY_API).replace(/\/$/, '');
  // Looked up at each call, so a test's fetch is the one used.
  const fetchImpl: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const org = opts.org ?? 'personal';
  const app = enc(opts.app);
  const headers = { authorization: `Bearer ${opts.token}` };
  const api = <T>(method: string, path: string, body?: unknown) => call<T>(fetchImpl, method, base, path, headers, body, opts.timeoutMs);

  async function machines(tags: Record<string, string>, makeApp = false): Promise<FlyMachine[]> {
    const q = Object.entries(tags)
      .map(([k, v]) => `metadata.${enc(k)}=${enc(v)}`)
      .join('&');
    let list: FlyMachine[] | undefined;
    try {
      list = await api<FlyMachine[]>('GET', `/apps/${app}/machines${q ? `?${q}` : ''}`);
    } catch (e) {
      // No app yet: nothing in it. Only a create makes it.
      if (!notFound(e)) throw e;
      if (makeApp) await api('POST', '/apps', { app_name: opts.app, org_slug: org });
      return [];
    }
    return (list ?? []).filter((m) => m.state !== 'destroyed' && m.state !== 'destroying' && Object.entries(tags).every(([k, v]) => m.config?.metadata?.[k] === v));
  }

  async function stateOf(id: string): Promise<string> {
    return (await api<FlyMachine>('GET', `/apps/${app}/machines/${enc(id)}`)).state;
  }

  // Fly's own wait, shorter than a call's deadline (CALL_MS in boxService.ts).
  const wait = (id: string, state: string) => api('GET', `/apps/${app}/machines/${enc(id)}/wait?state=${state}&timeout=30`);

  return {
    name: 'fly',
    caps: { pause: opts.memoryMb <= FLY_SUSPEND_MAX_MB },
    // Fly sets it in every Machine (https://fly.io/docs/machines/runtime-environment/).
    machineIdEnv: 'FLY_MACHINE_ID',

    async create(spec: CreateSpec) {
      // Only an image pinned by digest gets a box and its boot token (boxImage.ts).
      if (!isPinnedImage(spec.image)) throw new ProviderError('POST', `/apps/${app}/machines`, 400, `not made: the image ${spec.image.slice(0, 120)} isn't pinned by digest (name@sha256:...)`);
      const idem = { [IDEMPOTENCY_TAG]: spec.idempotencyKey };
      const existing = await machines(idem, true);
      if (existing[0]) return { providerBoxId: existing[0].id };
      const body = {
        name: spec.name,
        ...(spec.region ? { region: spec.region } : {}),
        config: {
          image: spec.image,
          // shared-cpu, memory in multiples of 256.
          guest: { cpu_kind: 'shared', cpus: spec.cpus, memory_mb: spec.memoryMb },
          env: spec.env,
          metadata: { ...spec.tags, ...idem },
          restart: { policy: 'no' },
          auto_destroy: false,
        },
      };
      try {
        return { providerBoxId: (await api<FlyMachine>('POST', `/apps/${app}/machines`, body)).id };
      } catch (e) {
        // A duplicate name: the first create got there.
        if (e instanceof ProviderError && e.status === 409) {
          const again = await machines(idem);
          if (again[0]) return { providerBoxId: again[0].id };
        }
        throw e;
      }
    },

    async list(tags): Promise<ListedBox[]> {
      return (await machines(tags)).map((m) => ({ providerBoxId: m.id, state: flyState(m.state), tags: { ...(m.config?.metadata ?? {}) } }));
    },

    async get(id): Promise<ListedBox | null> {
      let m: FlyMachine;
      try {
        m = await api<FlyMachine>('GET', `/apps/${app}/machines/${enc(id)}`);
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
      // Fly answers for a destroyed machine for a while: it's gone.
      return m.state === 'destroyed' || m.state === 'destroying' ? null : { providerBoxId: m.id, state: flyState(m.state), tags: { ...(m.config?.metadata ?? {}) } };
    },

    async pause(id) {
      try {
        await api('POST', `/apps/${app}/machines/${enc(id)}/suspend`);
      } catch (e) {
        // Already suspended (a second sleep): fine. Gone: the caller hears 404.
        if (notFound(e) || flyState(await stateOf(id)) !== 'paused') throw e;
      }
      await wait(id, 'suspended');
    },

    async resume(id) {
      try {
        await api('POST', `/apps/${app}/machines/${enc(id)}/start`);
      } catch (e) {
        // Already started (a second wake): fine.
        if (notFound(e) || (await stateOf(id)) !== 'started') throw e;
      }
      await wait(id, 'started');
    },

    async destroy(id) {
      try {
        await api('DELETE', `/apps/${app}/machines/${enc(id)}?force=true`);
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
  };
}
