// A few pages, so no router: "/" is the list, "/t/<threadId>" a thread,
// "/s/<slug>" a thread someone shared (no sign-in; share.tsx), "/new" a new
// thread, and the rail's views with what's open in them. Static
// hosting sends every unknown path to index.html, so a link works when
// opened cold.
import { useSyncExternalStore } from 'react';
import { parsePath, type RailView, type Route } from './route-path';

export type { RailView, Route };

function parse(): Route {
  return parsePath(location.pathname);
}

let current = parse();
const listeners = new Set<() => void>();
window.addEventListener('popstate', () => {
  current = parse();
  listeners.forEach((l) => l());
});

export function go(path: string): void {
  if (path === location.pathname) return;
  history.pushState(null, '', path);
  current = parse();
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export function threadPath(threadId: string): string {
  return `/t/${encodeURIComponent(threadId)}`;
}

/** A project's page: its runner and its id, as a project is only its runner's. */
export function projectPath(runnerId: string, id: string): string {
  return `/projects/${encodeURIComponent(runnerId)}/${encodeURIComponent(id)}`;
}

export function viewPath(view: RailView, id?: string): string {
  return id ? `/${view}/${encodeURIComponent(id)}` : `/${view}`;
}
