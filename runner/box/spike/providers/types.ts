// The adapter interface from docs/virtual-runners.md, decision 9, as the
// spike uses it. The real one will live in convex/boxProviders/ and be
// called from Convex actions; this copy runs from the driver on a Mac.

export type BoxCaps = {
  // Pause that keeps memory, so the same process carries on (a fast wake).
  pause: boolean;
  egressAllowlist?: boolean;
  snapshots?: boolean;
};

export type BoxState = "running" | "paused" | "stopped";

export type CreateSpec = {
  image: string;
  cpus: number;
  memoryMb: number;
  diskGb: number;
  env: Record<string, string>;
  name: string;
  tags: Record<string, string>;
  // The boxes row's: Convex may retry an action, and a retry must find the
  // first box, not make a second.
  idempotencyKey: string;
};

// Spike only. The real boxes start a runner baked into the image; the spike
// uses a stock node image and drops its one-file agent in at create time.
export type SpikeCreateSpec = CreateSpec & {
  files?: { path: string; contents: string }[];
  command?: string[];
};

export interface BoxProvider {
  name: string;
  caps: BoxCaps;
  create(spec: SpikeCreateSpec): Promise<{ providerBoxId: string }>;
  list(tags: Record<string, string>): Promise<{ providerBoxId: string; state: BoxState }[]>;
  // Without caps.pause these may still exist (Daytona containers: stop and
  // start, memory lost). The driver reports which kind it got.
  pause?(id: string): Promise<void>;
  resume?(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  // Spike only: remove anything the adapter made besides boxes (Fly's app).
  teardown?(): Promise<void>;
}

// The tag every box records its idempotency key under. Underscores, not
// dashes: Fly reserves `fly_*` metadata keys and documents no others, so
// keep to plain identifiers.
export const IDEMPOTENCY_TAG = "tb_idem";

export type Fetch = typeof fetch;

export class HttpError extends Error {
  status: number;
  body: string;
  constructor(method: string, url: string, status: number, body: string) {
    super(`${method} ${url} -> ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

// One JSON-over-HTTPS call. Returns undefined for an empty body.
export async function call<T>(
  fetchImpl: Fetch,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (typeof body === "string") {
    init.body = body;
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) throw new HttpError(method, url, res.status, text);
  return (text ? JSON.parse(text) : undefined) as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
