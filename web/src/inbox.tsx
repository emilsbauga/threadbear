// The inbox for every component that shows it, read whole once and then only
// what changed. One provider, as each component subscribing for itself would
// be several subscriptions moving at different times. What's on screen stays
// while the page is away; coming back reads the list once again.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import { usePageAway } from './live';
import { CHANGES_MARGIN_MS, firstSince, mergeChanges } from './inbox-merge';

const RELOAD_AFTER_MORE_MS = CHANGES_MARGIN_MS + 1000;

type Row = FunctionReturnType<typeof api.phone.threads>[number];

const Inbox = createContext<Row[] | undefined>(undefined);

export function useInbox(): Row[] | undefined {
  return useContext(Inbox);
}

export function InboxProvider({ token, children }: { token: string; children: ReactNode }) {
  const away = usePageAway();
  const [rows, setRows] = useState<Row[]>();
  // Undefined: the whole list is due.
  const [since, setSince] = useState<number>();
  const first = useQuery(api.phone.threadsAt, !away && since === undefined ? { token, view: 'inbox' } : 'skip');
  const changes = useQuery(api.phone.threadsSince, !away && since !== undefined ? { token, since } : 'skip');

  useEffect(() => {
    if (away) setSince(undefined);
  }, [away]);

  useEffect(() => {
    if (!first || since !== undefined) return;
    setRows(first.rows);
    setSince(firstSince(first.at));
  }, [first, since]);

  useEffect(() => {
    if (!changes || since === undefined) return;
    if (changes.more) {
      // After the margin: loading now would ask from before the same burst
      // (a runner's full write) and hear `more` again, over and over.
      const wait = setTimeout(() => setSince(undefined), RELOAD_AFTER_MORE_MS);
      return () => clearTimeout(wait);
    }
    const next = mergeChanges(rows ?? [], since, changes);
    setRows(next.rows);
    if (next.since !== since) setSince(next.since);
    return undefined;
    // Only an answer starts this: rows and since follow from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changes]);

  return <Inbox.Provider value={rows}>{children}</Inbox.Provider>;
}
