// Which page an address is (route.ts). Apart from the browser, so a test
// can run it.

export type RailView = 'scheduled' | 'projects' | 'runners' | 'usage';
// A project's page names its runner too (/projects/<runnerId>/<id>): a
// project id is only its runner's own, and another runner can use the same
// one (Daybreak finding 141). An address with the id alone, from before,
// has no runnerId, and its page says the project's gone.
// machines: the backend's state machines (machines.tsx), for the deployment's owner.
export type Route = { page: 'list' } | { page: 'new' } | { page: 'machines' } | { page: 'thread'; threadId: string } | { page: 'share'; slug: string } | { page: RailView; id?: string; runnerId?: string };

// A path part as text, or undefined for a bad % escape (/s/%zz): that's the
// list, as decodeURIComponent throwing there stopped the app loading at all.
function decode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

export function parsePath(pathname: string): Route {
  const s = pathname.match(/^\/s\/([^/]+)\/?$/);
  if (s) {
    const slug = decode(s[1]);
    return slug === undefined ? { page: 'list' } : { page: 'share', slug };
  }
  const m = pathname.match(/^\/t\/([^/]+)\/?$/);
  if (m) {
    const threadId = decode(m[1]);
    return threadId === undefined ? { page: 'list' } : { page: 'thread', threadId };
  }
  if (/^\/new\/?$/.test(pathname)) return { page: 'new' };
  if (/^\/machines\/?$/.test(pathname)) return { page: 'machines' };
  const p = pathname.match(/^\/projects\/([^/]+)\/([^/]+)\/?$/);
  if (p) {
    const runnerId = decode(p[1]);
    const id = decode(p[2]);
    return runnerId === undefined || id === undefined ? { page: 'list' } : { page: 'projects', runnerId, id };
  }
  const v = pathname.match(/^\/(scheduled|projects|runners|usage)(?:\/([^/]+))?\/?$/);
  if (v) {
    if (!v[2]) return { page: v[1] as RailView };
    const id = decode(v[2]);
    return id === undefined ? { page: 'list' } : { page: v[1] as RailView, id };
  }
  return { page: 'list' };
}
