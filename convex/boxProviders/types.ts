// What a virtual runner's provider must do (docs/virtual-runners.md,
// decisions 8 and 9), called from the service's Convex actions
// (convex/boxService.ts) over plain fetch. Adding a provider is one file
// beside this one and a test against a fake HTTP API
// (runner/test/unit/box-fly.test.ts has Fly's).
//
// Plain TypeScript with no Convex imports and no Node APIs (no Buffer):
// it runs in Convex's default runtime and in the runner's tests alike.

export type BoxCaps = {
  // Pause that keeps memory, so the same process carries on (a fast wake).
  pause: boolean;
  egressAllowlist?: boolean;
  snapshots?: boolean;
};

export type ProviderBoxState = 'running' | 'paused' | 'stopped';

export type CreateSpec = {
  image: string;
  cpus: number;
  memoryMb: number;
  // Extra disk, where a provider has it. Fly's root disk comes from the image.
  diskGb?: number;
  region?: string;
  // The boot token and the deployment's address: nothing reusable (decision 5).
  env: Record<string, string>;
  name: string;
  // tb_box (the boxes row), tb_attempt (which boot token), tb_service.
  tags: Record<string, string>;
  // One per attempt at a box: a create that's run again (a retry, or the
  // action run twice) finds the first box rather than making a second.
  idempotencyKey: string;
};

export type ListedBox = { providerBoxId: string; state: ProviderBoxState; tags: Record<string, string> };

export interface BoxProvider {
  name: string;
  caps: BoxCaps;
  // The environment variable inside a box that holds the provider's id for
  // its own machine, which the box sends with its boot exchange
  // (`machineId`), so the key holder's machine is known among duplicates.
  machineIdEnv?: string;
  create(spec: CreateSpec): Promise<{ providerBoxId: string }>;
  // Every box with all of these tags, with its own tags, for the reaper.
  list(tags: Record<string, string>): Promise<ListedBox[]>;
  // One box by its id, asked directly, to confirm what a listing showed
  // (boxService.ts identify): null once the provider has it no more.
  get?(id: string): Promise<ListedBox | null>;
  pause?(id: string): Promise<void>;
  resume?(id: string): Promise<void>;
  // A box already gone is fine.
  destroy(id: string): Promise<void>;
}

// The tag every box records its idempotency key under. Underscores, not
// dashes: Fly reserves `fly_*` metadata keys and documents no others, so
// keep to plain identifiers.
export const IDEMPOTENCY_TAG = 'tb_idem';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// A provider's API said no. `status` 0: it couldn't be reached. Never
// carries the API token: only the method, the path and the start of the body.
export class ProviderError extends Error {
  status: number;
  body: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(status ? `${method} ${path} -> ${status}: ${body.slice(0, 300)}` : `${method} ${path} failed: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

/** Worth trying again: unreachable, timed out, rate limited or the provider's own fault. */
export function transient(e: unknown): boolean {
  if (!(e instanceof ProviderError)) return true;
  return e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
}

/** Gone: the provider has no such box (or app). */
export function notFound(e: unknown): boolean {
  return e instanceof ProviderError && e.status === 404;
}

// One JSON-over-HTTPS call, given up (aborted) after `timeoutMs`: a caller
// holding a lease must never have a call outlive it. Undefined for an empty body.
export async function call<T>(fetchImpl: Fetch, method: string, base: string, path: string, headers: Record<string, string>, body?: unknown, timeoutMs?: number): Promise<T> {
  const abort = new AbortController();
  const init: RequestInit = { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, signal: abort.signal };
  if (body !== undefined) init.body = JSON.stringify(body);
  const timer = timeoutMs ? setTimeout(() => abort.abort(), timeoutMs) : undefined;
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(`${base}${path}`, init);
    text = await res.text();
  } catch (e) {
    throw new ProviderError(method, path.split('?')[0]!, 0, abort.signal.aborted ? `no answer in ${timeoutMs} ms` : String((e as Error)?.message ?? e));
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) throw new ProviderError(method, path.split('?')[0]!, res.status, text);
  return (text ? JSON.parse(text) : undefined) as T;
}

// The providers there's an adapter for (boxService.ts providerFor): a
// runnerServices row's `provider` is one of these.
export const PROVIDERS: readonly string[] = ['fly'];
