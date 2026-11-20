// A fake Fly Machines API as a fetch function (convex/boxProviders/fly.ts),
// with its apps and machines in memory, so the adapter and the service's
// actions (convex/boxService.ts) are checked without a Fly account or any
// network. Every request is recorded in `seen`.

export type Seen = { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; json?: any };
type Machine = { id: string; name: string; state: string; config: any };

export function fakeFly(opts: { token?: string; apps?: string[] } = {}) {
  const token = opts.token ?? 'fly-token';
  const apps = new Set(opts.apps ?? []);
  const machines: Machine[] = [];
  const seen: Seen[] = [];
  let n = 0;
  // Fail the next calls matching a method and path ending: a status each.
  const failures: { method: string; ends: string; status: number }[] = [];
  const standing: { match: (r: Seen) => boolean; status: number }[] = [];
  // Do the next matching call, then answer with a failure: an answer lost on the way back.
  const lostAnswers: { method: string; ends: string; status: number }[] = [];
  // Requests held before they're answered, so a test can run something else in between.
  const holds: { match: (r: Seen) => boolean; reached: () => void; gate: Promise<void> }[] = [];
  const state = {
    apps,
    machines,
    seen,
    // Only the first metadata filter is honoured, like a server that
    // doesn't AND them, so the adapter's own filter is exercised.
    conflictOnCreate: false,
    failNext(method: string, ends: string, status: number, times = 1) {
      for (let i = 0; i < times; i++) failures.push({ method, ends, status });
    },
    // Fail every request `match` takes with `status`, until stop() is called.
    failWhile(match: (r: Seen) => boolean, status: number) {
      const rule = { match, status };
      standing.push(rule);
      return { stop: () => standing.splice(standing.indexOf(rule), 1) };
    },
    // The next request `match` takes waits until release(); `reached` resolves when it arrives.
    hold(match: (r: Seen) => boolean) {
      let reached!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((r) => (reached = r));
      const gate = new Promise<void>((r) => (release = r));
      holds.push({ match, reached, gate });
      return { arrived, release };
    },
    loseAnswerNext(method: string, ends: string, status: number) {
      lostAnswers.push({ method, ends, status });
    },
    live: () => machines.filter((m) => m.state !== 'destroyed'),
    byId: (id: string) => machines.find((m) => m.id === id),
    // The provider loses a machine (a host gone): it's simply not there.
    lose(id: string) {
      const i = machines.findIndex((m) => m.id === id);
      if (i >= 0) machines.splice(i, 1);
    },
    calls: (method: string, ends: string) => seen.filter((r) => r.method === method && r.path.endsWith(ends)).length,
  };

  const reply = (status: number, body?: unknown) => new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {} });

  async function handle(r: Seen): Promise<Response> {
    if (r.headers.authorization !== `Bearer ${token}`) return reply(401, 'no');
    const always = standing.find((x) => x.match(r));
    if (always) return reply(always.status, 'injected failure');
    const f = failures.findIndex((x) => x.method === r.method && r.path.endsWith(x.ends));
    if (f >= 0) return reply(failures.splice(f, 1)[0]!.status, 'injected failure');
    let m: RegExpMatchArray | null;
    if (r.method === 'POST' && r.path === '/v1/apps') {
      apps.add(r.json.app_name);
      return reply(201, { id: 'app1' });
    }
    if ((m = r.path.match(/^\/v1\/apps\/([^/]+)\/machines$/))) {
      if (!apps.has(m[1]!)) return reply(404, 'app not found');
      if (r.method === 'GET') {
        const first = [...r.query.entries()].find(([k]) => k.startsWith('metadata.'));
        return reply(200, machines.filter((x) => !first || x.config.metadata?.[first[0].slice(9)] === first[1]));
      }
      if (r.method === 'POST') {
        const made = { id: `m${++n}`, name: r.json.name, state: 'created', config: r.json.config };
        machines.push(made);
        if (state.conflictOnCreate) return reply(409, 'name taken');
        return reply(200, made);
      }
    }
    if ((m = r.path.match(/^\/v1\/apps\/[^/]+\/machines\/([^/]+)(\/\w+)?$/))) {
      const mc = machines.find((x) => x.id === m![1]);
      if (!mc || mc.state === 'destroyed') return reply(404, '');
      const action = m[2];
      if (r.method === 'GET' && !action) return reply(200, mc);
      if (r.method === 'POST' && action === '/suspend') {
        if (mc.state === 'suspended') return reply(412, 'not started');
        // As Fly: a machine with more than 2 GB can't suspend.
        if ((mc.config.guest?.memory_mb ?? 0) > 2048) return reply(400, 'machine memory too large to suspend');
        mc.state = 'suspended';
      } else if (r.method === 'POST' && action === '/start') {
        if (mc.state === 'started') return reply(412, 'already started');
        mc.state = 'started';
      } else if (r.method === 'GET' && action === '/wait') {
        return mc.state === r.query.get('state') ? reply(200, { ok: true }) : reply(408, 'timeout');
      } else if (r.method === 'DELETE' && !action) mc.state = 'destroyed';
      else return reply(404, `no fake for ${r.method} ${r.path}`);
      return reply(200, { ok: true });
    }
    return reply(404, `no fake for ${r.method} ${r.path}`);
  }

  const fetchFn = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === 'string' ? init.body : '';
    const r: Seen = { method: init.method ?? 'GET', path: u.pathname, query: u.searchParams, headers, ...(body ? { json: JSON.parse(body) } : {}) };
    seen.push(r);
    const h = holds.findIndex((x) => x.match(r));
    if (h >= 0) {
      const [held] = holds.splice(h, 1);
      held!.reached();
      // A caller that gives up (its deadline) gets an abort, and the request is never handled.
      const signal = init.signal;
      await new Promise<void>((resolve, reject) => {
        held!.gate.then(resolve);
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    const answer = await handle(r);
    const lost = lostAnswers.findIndex((x) => x.method === r.method && r.path.endsWith(x.ends));
    return lost >= 0 ? reply(lostAnswers.splice(lost, 1)[0]!.status, 'answer lost') : answer;
  };
  return Object.assign(state, { fetch: fetchFn, url: 'https://fly.fake/v1' });
}
