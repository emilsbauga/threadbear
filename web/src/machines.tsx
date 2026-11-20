// The Machines page (/machines): the backend's state machines (a command, and
// the lifecycles that follow it onto @convex-dev/state-machines,
// docs/lifecycles.md), drawn from the same rules the backend runs, with live
// counts in each state and any row's state and history. Read-only.
// convex/viewer.ts answers only this browser's token, which the viewer's
// queries don't know to send: the client below adds it to each one.
import { useMemo } from 'react';
import { useConvex } from 'convex/react';
import type { ConvexReactClient } from 'convex/react';
import { MachinesViewer } from '@convex-dev/state-machines/viewer';
import '@convex-dev/state-machines/viewer.css';
import { api } from '../../convex/_generated/api';
import { readTheme } from './theme';
import { go } from './route';

// The app's own client, with the token added to every query the viewer
// watches. Everything else goes straight through.
function withToken(client: ConvexReactClient, token: string): ConvexReactClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'watchQuery') return (query: never, args: Record<string, unknown> | undefined, options?: never) => target.watchQuery(query, { ...(args ?? {}), token } as never, options);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export default function MachinesPage({ token }: { token: string }) {
  const convex = useConvex();
  const client = useMemo(() => withToken(convex, token), [convex, token]);
  return (
    <div className="machines-page">
      <header className="machines-bar">
        <a href="/" onClick={(e) => { e.preventDefault(); go('/'); }}>Threads</a>
        <span>Machines</span>
      </header>
      <MachinesViewer client={client} functions={api.viewer} config={{ settings: { theme: readTheme() } }} />
    </div>
  );
}
