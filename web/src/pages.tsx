// The rail's views: each is a list for the sidebar and a page for the main
// column, like a thread and the threads list. They only subscribe while they're
// showing. Most of what they say comes from the queries the phone reads, and
// most of it is for reading: a schedule can be paused or run from here, and any
// other change to one, or to a project, happens on the Mac or through an agent.
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { useLiveQuery, usePageAway } from './live';
import { useInbox } from './inbox';
import { MessageText } from './messages';
import { CommandState } from './command-state';
import { go, threadPath, type RailView, viewPath } from './route';
import { ago, day, folderName } from './format';
import { readTheme, setTheme, type Theme } from './theme';
import { bytesWords, statsFresh, isOnline, matchesSchedule, runnersShown, runnerState, scheduleSections, sinceWords, tightest, untilWords } from './view-logic';
import { busy, type Row } from './sidebar';
import * as Icon from './icons';

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState(readTheme);
  return [
    theme,
    (t) => {
      setTheme(t);
      set(t);
    },
  ];
}

type Schedule = {
  id: string;
  runnerId: string;
  title: string;
  text: string;
  whenText: string;
  paused: boolean;
  runs: number;
  nextRunAt?: string;
  finishedAt?: string;
  threadId?: string;
  cwd?: string;
  accountId?: string;
  poolId?: string;
  model?: string;
  lastRun?: { at: string; outcome: string; threadId?: string; note?: string };
};
type UsageWindow = { kind: string; title: string; remainingPercent: number; resetsAt?: string; detail?: string };
type Account = { runnerId: string; id: string; provider: string; title: string; note?: string; email?: string; plan?: string; usage?: { windows: UsageWindow[] } };

// A row in a view's list. As a thread's row, without the status marks.
function ListRow({ href, on, title, sub, right, icon }: { href: string; on: boolean; title: string; sub?: ReactNode; right?: ReactNode; icon?: ReactNode }) {
  return (
    <li>
      <a
        href={href}
        className={`row ${on ? 'on' : ''}`}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          go(href);
        }}
      >
        <span className="row-top">
          {icon}
          <span className="title">{title}</span>
          {right !== undefined ? <span className="when">{right}</span> : null}
        </span>
        {sub !== undefined ? <span className="sub">{sub}</span> : null}
      </a>
    </li>
  );
}

function Heading({ icon, title, count, folded, toggle }: { icon: ReactNode; title: string; count: number; folded?: boolean; toggle?: () => void }) {
  const label = (
    <>
      {icon}
      <span className="section-title">{title}</span>
      <span className="rule" />
      {count > 0 ? <span className="count">{count}</span> : null}
      {toggle ? <Icon.ChevronDown /> : null}
    </>
  );
  return (
    <div className={`section-head ${folded ? 'folded' : ''}`}>
      {toggle ? (
        <button className="fold" onClick={toggle} aria-expanded={!folded} title={folded ? `Show ${title}` : `Hide ${title}`}>
          {label}
        </button>
      ) : (
        <div className="fold">{label}</div>
      )}
    </div>
  );
}

// A page's header: back to the view's list on a phone, its title, what goes at
// the end.
function PageHead({ view, title, children }: { view: RailView; title: string; children?: ReactNode }) {
  return (
    <header className="thread-head">
      <button className="icon-btn back" onClick={() => go(viewPath(view))} aria-label="Back to the list" title="Back to the list">
        <Icon.Back />
      </button>
      <div className="crumbs">
        <h1>{title}</h1>
      </div>
      {children}
    </header>
  );
}

function Nothing({ children }: { children: string }) {
  return <div className="list note">{children}</div>;
}

// A bar and its words. Single values, so one quiet colour, and orange with
// its words when it's low: `low` is never said by the colour alone.
function Meter({ label, value, sub, percent, low }: { label: string; value: string; sub?: string; percent: number; low?: boolean }) {
  return (
    <div className="meter">
      <div className="top">
        <span>{label}</span>
        {sub ? <span className="sub">{sub}</span> : null}
        <span className="v">{value}</span>
      </div>
      <div className={`track ${low ? 'low' : ''}`} role="img" aria-label={`${label}: ${value}`}>
        <i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
    </div>
  );
}

// Re-renders every half minute, for "in 3h" and "heard from 12s ago".
function useClock(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const ThreadRows = ({ rows }: { rows: Row[] }) => (
  <ul className="list">
    {rows.map((t) => (
      <ListRow key={t.threadId} href={threadPath(t.threadId)} on={false} title={t.title || 'Untitled'} sub={t.projects?.length ? t.projects.map((p) => p.title).join(', ') : folderName(t.cwd)} right={busy(t) ? <span className="spinner" /> : ago(t.lastActivityMs)} />
    ))}
  </ul>
);

// ------------------------------------------------------------ scheduled

const FOLDED_DONE = 'threadbear.scheduledDoneOpen';

export function ScheduledList({ token, selected }: { token: string; selected?: string }) {
  const rows = useLiveQuery(api.phone.schedules, { token }) as Schedule[] | undefined;
  const [query, setQuery] = useState('');
  const [doneOpen, setDoneOpen] = useState(() => localStorage.getItem(FOLDED_DONE) === '1');
  const now = useClock();
  if (!rows) return <div className="lists muted pad">Loading…</div>;
  const q = query.trim();
  const { active, paused, done } = scheduleSections(rows.filter((s) => matchesSchedule(s, q)));
  const open = doneOpen || !!q;
  const list = (items: Schedule[], right: (s: Schedule) => string) => (
    <ul className="list">
      {items.map((s) => (
        <ListRow key={s.id} href={viewPath('scheduled', s.id)} on={s.id === selected} title={s.title} sub={s.whenText} right={right(s)} />
      ))}
    </ul>
  );
  return (
    <div className="lists-wrap">
      <div className="search-row">
        <div className="search">
          <Icon.Search />
          <input type="text" value={query} placeholder="Search schedules" aria-label="Search schedules" spellCheck={false} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
          {query ? (
            <button className="clear" title="Clear the search" aria-label="Clear the search" onClick={() => setQuery('')}>
              <Icon.Close />
            </button>
          ) : null}
        </div>
      </div>
      <nav className="lists">
        {active.length + paused.length + done.length === 0 ? <Nothing>{q ? 'No schedules match.' : 'Nothing scheduled.'}</Nothing> : null}
        {active.length ? (
          <>
            <Heading icon={<Icon.Clock />} title="Active" count={active.length} />
            {list(active, (s) => untilWords(s.nextRunAt, now))}
          </>
        ) : null}
        {paused.length ? (
          <>
            <Heading icon={<Icon.Moon />} title="Paused" count={paused.length} />
            {list(paused, () => 'Paused')}
          </>
        ) : null}
        {done.length ? (
          <>
            <Heading
              icon={<Icon.Archive />}
              title="Done"
              count={done.length}
              folded={!open}
              toggle={
                q
                  ? undefined
                  : () => {
                      localStorage.setItem(FOLDED_DONE, doneOpen ? '0' : '1');
                      setDoneOpen(!doneOpen);
                    }
              }
            />
            {open ? list(done, (s) => day(s.finishedAt!)) : null}
          </>
        ) : null}
      </nav>
    </div>
  );
}

export function SchedulePage({ token, id }: { token: string; id: string }) {
  const rows = useLiveQuery(api.phone.schedules, { token }) as Schedule[] | undefined;
  const runners = useLiveQuery(api.phone.runners, { token });
  const command = useMutation(api.phone.schedule);
  const [pending, setPending] = useState<Id<'commands'> | null>(null);
  const now = useClock();
  if (!rows) return <div className="pad muted">Loading…</div>;
  const s = rows.find((x) => x.id === id);
  if (!s) return <PageGone view="scheduled" what="That schedule has gone." />;
  const runner = runners?.find((r) => r.runnerId === s.runnerId);
  const act = async (action: 'pause' | 'resume' | 'run') => setPending(await command({ token, scheduleId: s.id, action }));
  const state = s.finishedAt ? `Finished ${day(s.finishedAt)}` : s.paused ? 'Paused' : s.nextRunAt ? `${new Date(s.nextRunAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}, ${untilWords(s.nextRunAt, now)}` : '';
  return (
    <div className="page">
      <PageHead view="scheduled" title={s.title}>
        {s.finishedAt ? null : (
          <>
            <button className="btn" title={s.paused ? 'Let it run again' : 'Stop it running until you resume it'} onClick={() => void act(s.paused ? 'resume' : 'pause')}>
              {s.paused ? <Icon.Play /> : <Icon.Pause />}
              {s.paused ? 'Resume' : 'Pause'}
            </button>
            <button className="btn" title="Run it once now, whatever its next time is" onClick={() => void act('run')}>
              <Icon.Play />
              Run now
            </button>
          </>
        )}
      </PageHead>
      <div className="page-body">
        <div className="page-col">
          {pending ? <CommandState token={token} commandId={pending} onDone={() => setPending(null)} /> : null}
          <dl className="facts">
            <dt>When</dt>
            <dd>{s.whenText}</dd>
            <dt>{s.finishedAt || s.paused ? 'State' : 'Next'}</dt>
            <dd>{state}</dd>
            {s.lastRun ? (
              <>
                <dt>Last</dt>
                <dd>
                  {s.lastRun.threadId ? (
                    <a
                      href={threadPath(s.lastRun.threadId)}
                      onClick={(e) => {
                        e.preventDefault();
                        go(threadPath(s.lastRun!.threadId!));
                      }}
                    >
                      {sinceWords(Date.parse(s.lastRun.at), now)} ago
                    </a>
                  ) : (
                    `${sinceWords(Date.parse(s.lastRun.at), now)} ago`
                  )}
                  {s.lastRun.note ? `, ${s.lastRun.note}` : ''}
                </dd>
              </>
            ) : null}
            <dt>Runs</dt>
            <dd>{s.runs}</dd>
            <dt>Runner</dt>
            <dd>{runner?.name ?? s.runnerId}</dd>
            {s.threadId ? (
              <>
                <dt>Sends to</dt>
                <dd>
                  <a
                    href={threadPath(s.threadId)}
                    onClick={(e) => {
                      e.preventDefault();
                      go(threadPath(s.threadId!));
                    }}
                  >
                    Its thread
                  </a>
                </dd>
              </>
            ) : s.cwd ? (
              <>
                <dt>Folder</dt>
                <dd>{folderName(s.cwd)}</dd>
              </>
            ) : null}
            {s.accountId || s.poolId ? (
              <>
                <dt>Login</dt>
                <dd>{s.accountId ?? s.poolId}</dd>
              </>
            ) : null}
          </dl>
          <div className="prompt">
            <MessageText text={s.text} />
          </div>
        </div>
      </div>
    </div>
  );
}

function PageGone({ view, what }: { view: RailView; what: string }) {
  return (
    <div className="page">
      <PageHead view={view} title="" />
      <div className="page-body">
        <div className="page-col page-note">{what}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ projects

// A project's picture, when it has one (its symbol is an SF Symbol, which a
// browser can't draw).
const iconOf = (p: object) => (p as { icon?: { url?: string } }).icon?.url;

export function ProjectsList({ token, selected }: { token: string; selected?: string }) {
  const rows = useLiveQuery(api.phone.projects, { token });
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // Goals and state aren't in the list (phone:projects), so those are asked about
  // only once typing has paused, as it reads every project's whole row.
  const [asked, setAsked] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setAsked(q), 400);
    return () => clearTimeout(t);
  }, [q]);
  const deep = useLiveQuery(api.phone.projectSearch, asked ? { token, text: asked } : 'skip');
  if (!rows) return <div className="lists muted pad">Loading…</div>;
  const inDepth = new Set((deep ?? []).map((m) => `${m.runnerId}/${m.id}`));
  const shown = rows.filter((p) => !q || p.title.toLowerCase().includes(q) || inDepth.has(`${p.runnerId}/${p.id}`));
  return (
    <div className="lists-wrap">
      <div className="search-row">
        <div className="search">
          <Icon.Search />
          <input type="text" value={query} placeholder="Search projects" aria-label="Search projects" spellCheck={false} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
          {query ? (
            <button className="clear" title="Clear the search" aria-label="Clear the search" onClick={() => setQuery('')}>
              <Icon.Close />
            </button>
          ) : null}
        </div>
      </div>
      <nav className="lists">
        <div className="section-head" />
        {shown.length ? (
          <ul className="list">
            {shown.map((p) => (
              <ListRow
                key={`${p.runnerId}/${p.id}`}
                href={viewPath('projects', p.id)}
                on={p.id === selected}
                title={p.title}
                sub={`${p.threadCount} ${p.threadCount === 1 ? 'thread' : 'threads'}`}
                right={p.lastActivityAt ? ago(Date.parse(p.lastActivityAt)) : undefined}
                icon={iconOf(p) ? <img className="row-icon" src={iconOf(p)} alt="" /> : undefined}
              />
            ))}
          </ul>
        ) : (
          <Nothing>{q ? 'No projects match.' : 'No projects yet.'}</Nothing>
        )}
      </nav>
    </div>
  );
}

// How many of a project's threads its page asks for first, and how many more
// each "Show more" adds (phone:projectThreads, newest first).
const PROJECT_THREADS_FIRST = 50;
const PROJECT_THREADS_MORE = 100;

export function ProjectPage({ token, id }: { token: string; id: string }) {
  const rows = useLiveQuery(api.phone.projects, { token });
  // The list says which runner has it; its goals, state and notes are read for
  // this project alone.
  const head = rows?.find((x) => x.id === id);
  const p = useLiveQuery(api.phone.project, head ? { token, runnerId: head.runnerId, id } : 'skip');
  const [limit, setLimit] = useState(PROJECT_THREADS_FIRST);
  // Archived threads too, so the list matches the "22 threads" in the
  // sidebar rather than only the ones still in the inbox.
  const threads = useLiveQuery(api.phone.projectThreads, { token, projectId: id, limit });
  // A new project starts from the first page again.
  useEffect(() => setLimit(PROJECT_THREADS_FIRST), [id]);
  if (!rows) return <div className="pad muted">Loading…</div>;
  if (!head || p === null) return <PageGone view="projects" what="That project has gone." />;
  if (!p) return <div className="pad muted">Loading…</div>;
  const live = (threads ?? []).filter((t) => t.view !== 'den');
  const archived = (threads ?? []).filter((t) => t.view === 'den');
  const more = (threads?.length ?? 0) >= limit;
  const block = (title: string, text: string) =>
    text.trim() ? (
      <section className="block">
        <h2>{title}</h2>
        <MessageText text={text} />
      </section>
    ) : null;
  return (
    <div className="page">
      <PageHead view="projects" title={p.title} />
      <div className="page-body">
        <div className="page-col">
          {block('Goals', p.goals)}
          {block('Where it stands', p.state)}
          {live.length ? (
            <section className="block">
              <h2>Live threads</h2>
              <ThreadRows rows={live} />
            </section>
          ) : null}
          {archived.length ? (
            <section className="block">
              <h2>Archived</h2>
              <ThreadRows rows={archived} />
            </section>
          ) : null}
          {more ? (
            <button className="btn" title="Show older threads in this project" onClick={() => setLimit((n) => n + PROJECT_THREADS_MORE)}>
              Show more
            </button>
          ) : null}
          {p.notes.trim() ? (
            <details className="worked">
              <summary>
                Notes<span className="chev">›</span>
              </summary>
              <div className="worked-body">
                <MessageText text={p.notes} />
              </div>
            </details>
          ) : null}
          {p.folders.length ? (
            <section className="block">
              <h2>Folders</h2>
              <div className="page-note">{p.folders.map(folderName).join(', ')}</div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ runners

// Tells the runners someone's looking, so they report their figures. Only while
// the tab can be seen, as nobody needs them otherwise and each report is a write.
function useWatchRunners(token: string) {
  const watch = useMutation(api.phone.watchRunners);
  const away = usePageAway();
  useEffect(() => {
    if (away) return;
    const ping = () => {
      if (!document.hidden) void watch({ token });
    };
    ping();
    const t = setInterval(ping, 30_000);
    return () => clearInterval(t);
  }, [away, token, watch]);
}

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function Mini({ label, value, low }: { label: string; value: number; low?: boolean }) {
  return (
    <span title={`${label} ${value}%`}>
      {label}
      <span className={`mini ${low ? 'low' : ''}`}>
        <i style={{ width: `${value}%` }} />
      </span>
    </span>
  );
}

export function RunnersList({ token, selected }: { token: string; selected?: string }) {
  const rows = useLiveQuery(api.phone.runners, { token });
  const inbox = useInbox();
  const stats = useLiveQuery(api.phone.runnerStats, { token });
  useWatchRunners(token);
  const now = useClock();
  if (!rows) return <div className="lists muted pad">Loading…</div>;
  const shown = runnersShown(rows, now);
  const online = shown.filter((r) => isOnline(r, now));
  const offline = shown.filter((r) => !isOnline(r, now));
  const list = (items: typeof shown) => (
    <ul className="list">
      {items.map((r) => {
        const running = (inbox ?? []).filter((t) => t.runnerId === r.runnerId && busy(t)).length;
        const s = stats?.find((x) => x.runnerId === r.runnerId);
        const sub =
          s && isOnline(r, now) && statsFresh(s, now) ? (
            <span className="minis">
              <Mini label="CPU" value={s.cpuPercent} />
              <Mini label="Mem" value={percent(s.memUsed, s.memTotal)} low={r.pressure === 'memory'} />
            </span>
          ) : (
            runnerState(r, now)
          );
        return <ListRow key={r.runnerId} href={viewPath('runners', r.runnerId)} on={r.runnerId === selected} title={r.name} sub={sub} right={running ? `${running} running` : undefined} />;
      })}
    </ul>
  );
  return (
    <div className="lists-wrap">
      <nav className="lists">
        {online.length ? (
          <>
            <Heading icon={<Icon.Bolt />} title="Online" count={online.length} />
            {list(online)}
          </>
        ) : null}
        {offline.length ? (
          <>
            <Heading icon={<Icon.Moon />} title="Offline" count={offline.length} />
            {list(offline)}
          </>
        ) : null}
        {!shown.length ? <Nothing>No runners have reported in.</Nothing> : null}
      </nav>
    </div>
  );
}

export function RunnerPage({ token, id }: { token: string; id: string }) {
  const rows = useLiveQuery(api.phone.runners, { token });
  const inbox = useInbox();
  const accounts = useLiveQuery(api.phone.accounts, { token }) as Account[] | undefined;
  const stats = useLiveQuery(api.phone.runnerStats, { token });
  const now = useClock();
  if (!rows) return <div className="pad muted">Loading…</div>;
  const r = rows.find((x) => x.runnerId === id);
  if (!r) return <PageGone view="runners" what="That runner has gone." />;
  const mine = (inbox ?? []).filter((t) => t.runnerId === id);
  const running = mine.filter(busy);
  const logins = (accounts ?? []).filter((a) => a.runnerId === id).map((a) => a.title);
  const s = stats?.find((x) => x.runnerId === id);
  const fresh = !!s && isOnline(r, now) && statsFresh(s, now);
  return (
    <div className="page">
      <PageHead view="runners" title={r.name}>
        <span className="state-line">
          <span className={`dot ${isOnline(r, now) ? 'ok' : ''}`} />
          {runnerState(r, now)}
        </span>
      </PageHead>
      <div className="page-body">
        <div className="page-col">
          {s ? (
            <div className="meters">
              <Meter label="CPU" sub={`${s.cores} cores${s.load1 !== undefined ? `, load ${s.load1}` : ''}`} value={`${s.cpuPercent}%`} percent={s.cpuPercent} />
              <Meter label="Memory" sub={r.pressure === 'memory' ? 'Running low' : undefined} value={`${bytesWords(s.memUsed)} of ${bytesWords(s.memTotal)}`} percent={percent(s.memUsed, s.memTotal)} low={r.pressure === 'memory'} />
              <Meter label="Disk" sub={r.pressure === 'disk' ? 'Running low' : undefined} value={`${bytesWords(s.diskFree)} free of ${bytesWords(s.diskTotal)}`} percent={percent(s.diskTotal - s.diskFree, s.diskTotal)} low={r.pressure === 'disk'} />
              {fresh ? null : <div className="page-note">From {sinceWords(Date.parse(s.at), now)} ago, when it last reported.</div>}
            </div>
          ) : isOnline(r, now) ? (
            <div className="page-note">Asking it for its figures…</div>
          ) : null}
          <dl className="facts">
            {s?.machine || s?.os ? (
              <>
                <dt>Machine</dt>
                <dd>{[s.machine, s.os].filter(Boolean).join(', ')}</dd>
              </>
            ) : null}
            <dt>Version</dt>
            <dd>{r.version}</dd>
            {r.startedAt && isOnline(r, now) ? (
              <>
                <dt>Up for</dt>
                <dd>
                  {sinceWords(Date.parse(r.startedAt), now)}
                  {s ? `, the machine ${sinceWords(now - s.uptimeSec * 1000, now)}` : ''}
                </dd>
              </>
            ) : null}
            <dt>Threads</dt>
            <dd>
              {running.length} running, {mine.length} not put away
            </dd>
            {logins.length ? (
              <>
                <dt>Logins</dt>
                <dd>{logins.join(', ')}</dd>
              </>
            ) : null}
          </dl>
          {running.length ? (
            <section className="block">
              <h2>Running here</h2>
              <ThreadRows rows={running} />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ usage

export function UsageList({ token, selected }: { token: string; selected?: string }) {
  const rows = useLiveQuery(api.phone.accounts, { token }) as Account[] | undefined;
  const runners = useLiveQuery(api.phone.runners, { token });
  if (!rows) return <div className="lists muted pad">Loading…</div>;
  const name = (id: string) => runners?.find((r) => r.runnerId === id)?.name ?? '';
  const severalRunners = new Set(rows.map((a) => a.runnerId)).size > 1;
  return (
    <div className="lists-wrap">
      <nav className="lists">
        <div className="section-head" />
        {rows.length ? (
          <ul className="list">
            {[...rows]
              .sort((a, b) => a.title.localeCompare(b.title) || a.runnerId.localeCompare(b.runnerId))
              .map((a) => {
                const room = tightest(a.usage?.windows);
                const key = `${a.runnerId}~${a.id}`;
                return <ListRow key={key} href={viewPath('usage', key)} on={key === selected} title={a.title} sub={severalRunners ? name(a.runnerId) : (a.note ?? a.provider)} right={room ? `${Math.round(room.remainingPercent)}% left` : undefined} />;
              })}
          </ul>
        ) : (
          <Nothing>No logins have reported in.</Nothing>
        )}
      </nav>
    </div>
  );
}

export function UsagePage({ token, id }: { token: string; id: string }) {
  const rows = useLiveQuery(api.phone.accounts, { token }) as Account[] | undefined;
  const runners = useLiveQuery(api.phone.runners, { token });
  const now = useClock();
  if (!rows) return <div className="pad muted">Loading…</div>;
  const a = rows.find((x) => `${x.runnerId}~${x.id}` === id);
  if (!a) return <PageGone view="usage" what="That login has gone." />;
  const windows = a.usage?.windows ?? [];
  return (
    <div className="page">
      <PageHead view="usage" title={a.title} />
      <div className="page-body">
        <div className="page-col">
          <dl className="facts">
            {a.email ? (
              <>
                <dt>Email</dt>
                <dd>{a.email}</dd>
              </>
            ) : null}
            {a.plan ? (
              <>
                <dt>Plan</dt>
                <dd>{a.plan}</dd>
              </>
            ) : null}
            <dt>Runner</dt>
            <dd>{runners?.find((r) => r.runnerId === a.runnerId)?.name ?? a.runnerId}</dd>
          </dl>
          {windows.length ? (
            <div className="meters">
              {windows.map((w) => (
                <Meter key={w.kind + w.title} label={w.title} sub={w.resetsAt ? `resets ${untilWords(w.resetsAt, now)}` : w.detail} value={`${Math.round(w.remainingPercent)}% left`} percent={w.remainingPercent} low={w.remainingPercent < 15} />
              ))}
            </div>
          ) : (
            <div className="page-note">This login hasn't said how much room it has yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ a new thread

export function NewThread({ token }: { token: string }) {
  const create = useMutation(api.phone.create);
  const runners = useLiveQuery(api.phone.runners, { token });
  const [text, setText] = useState('');
  const [runnerId, setRunnerId] = useState('');
  const [pending, setPending] = useState<Id<'commands'> | null>(null);
  const command = useLiveQuery(api.phone.command, pending ? { token, commandId: pending } : 'skip');
  // The runner makes the thread, so it has an id once it's taken the command.
  useEffect(() => {
    if (command?.threadId) go(threadPath(command.threadId));
  }, [command?.threadId]);
  const now = Date.now();
  const online = runnersShown(runners ?? [], now).filter((r) => isOnline(r, now));
  const submit = async () => {
    const body = text.trim();
    if (!body || pending) return;
    setPending(await create({ token, text: body, ...(runnerId ? { runnerId } : {}) }));
  };
  return (
    <div className="page">
      <header className="thread-head">
        <button className="icon-btn back" onClick={() => go('/')} aria-label="Back to the threads" title="Back to the threads">
          <Icon.Back />
        </button>
        <div className="crumbs">
          <h1>New thread</h1>
        </div>
      </header>
      <div className="new-thread">
        {pending ? <CommandState token={token} commandId={pending} onDone={() => setPending(null)} /> : null}
        <div className="box">
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <textarea
              autoFocus
              value={text}
              rows={Math.min(10, Math.max(2, text.split('\n').length))}
              placeholder="What should it do?"
              aria-label="What should it do?"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia('(pointer: coarse)').matches) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="tools-row">
              {online.length > 1 ? (
                <select value={runnerId} onChange={(e) => setRunnerId(e.target.value)} aria-label="Runner" title="Which runner it starts on">
                  <option value="">Main runner</option>
                  {online.map((r) => (
                    <option key={r.runnerId} value={r.runnerId}>
                      {r.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <span className="grow" />
              <button className="send" disabled={!text.trim() || !!pending} aria-label="Start the thread" title="Start the thread">
                <Icon.Up />
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
