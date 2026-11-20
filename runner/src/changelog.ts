// The cards from Mike's What's new page (threadbear.mikecann.app/changelog) for
// the releases a fork hasn't brought in yet, for its Updates panel's From Mike
// section. Mike picked the cards over the plain notes on 17 Nov 2026: a
// picture or a clip of each big change says what a release brings at a glance.
//
// The site's build writes /changelog.json (site/scripts/changelog.mjs,
// changelogFeed); upstream.ts reads it once per release check, after the
// release itself has been verified. It's only something to look at: nothing
// is merged, run or trusted from it, and the release's signed notes stay the
// fallback whenever the page has no entry for a release yet (the daily
// changelog thread writes one a few hours after the tag) or can't be reached.
// So everything in it is checked here, and a card that doesn't fit is left
// out rather than passed on.

// Each upstream repo whose releases have a What's new page, by repoKey. A fork
// of a fork follows someone else's releases, which have no page, so it gets
// none and keeps the notes.
export const CHANGELOG_SITES: Record<string, string> = {
  'github.com/mikecann/threadbear': 'https://threadbear.mikecann.app',
};

export type ChangelogCard = {
  kind: 'added' | 'changed' | 'fixed';
  title: string;
  text: string;
  // The card's picture: the image, or a clip's still. On the site, always.
  picture: string;
  clip?: true;
};

export type ChangelogRelease = {
  tag: string; // release/2026-11-16
  link: string; // that release on the page
  highlights: ChangelogCard[];
  // How many plain Added / Changed / Fixed lines it has besides the cards.
  added: number;
  changed: number;
  fixed: number;
};

export type ReleaseChangelog = {
  page: string; // the whole What's new page
  releases: ChangelogRelease[]; // the ones the page has, newest first
};

export const CHANGELOG_TIMEOUT_MS = 15_000;
// The feed is about 20 KB for 20 releases; anything near this isn't it.
const MAX_FEED_BYTES = 512 * 1024;
const RELEASE = /^\d{4}-\d{2}-\d{2}$/;
// As the site's build allows (changelog.mjs MEDIA_NAME), pictures only: a
// name can't climb out of its release's folder or point anywhere else.
const PICTURE = /^[a-z0-9][a-z0-9-]*\.(webp|png|jpg)$/;
const KINDS = new Set(['added', 'changed', 'fixed']);

const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t && t.length <= max ? t : undefined;
};
const count = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1000 ? (v as number) : 0);

// The entries of `feed` (/changelog.json as parsed) for `tags`, in their
// order, each card checked. Releases the feed has no entry for are left out.
export function readFeed(site: string, feed: unknown, tags: string[]): ReleaseChangelog | undefined {
  const list = (feed as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(list)) return undefined;
  const page = `${site}/changelog`;
  const byName = new Map<string, Record<string, unknown>>();
  for (const r of list) if (r && typeof r === 'object' && typeof r.release === 'string' && RELEASE.test(r.release)) byName.set(r.release, r);
  const releases: ChangelogRelease[] = [];
  for (const tag of tags) {
    const name = tag.replace(/^release\//, '');
    const r = byName.get(name);
    if (!r) continue;
    const highlights: ChangelogCard[] = [];
    for (const h of Array.isArray(r.highlights) ? r.highlights : []) {
      const kind = h?.kind;
      const title = text(h?.title, 120);
      const body = text(h?.text, 600);
      const media = h?.media;
      const file = media?.type === 'clip' ? media.poster : media?.type === 'image' ? media.src : undefined;
      if (!KINDS.has(kind) || !title || !body || typeof file !== 'string' || !PICTURE.test(file)) continue;
      highlights.push({ kind, title, text: body, picture: `${site}/media/changelog/${r.release}/${file}`, ...(media.type === 'clip' ? { clip: true as const } : {}) });
    }
    releases.push({ tag, link: `${page}#${r.release}`, highlights, added: count(r.added), changed: count(r.changed), fixed: count(r.fixed) });
  }
  return releases.length ? { page, releases } : undefined;
}

// GETs the feed, bounded in time and size. Throws on anything but a JSON 200.
export async function fetchFeed(site: string, timeoutMs = CHANGELOG_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(`${site}/changelog.json`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { 'User-Agent': 'threadbear-runner' } });
  if (!res.ok) throw new Error(`the changelog answered ${res.status}`);
  const body = await res.text();
  if (body.length > MAX_FEED_BYTES) throw new Error('the changelog is too big');
  return JSON.parse(body);
}

// The page's cards for `tags`, when `upstreamKey` (repoKey of the upstream
// remote) is a repo with a page.
// Undefined when it has none or can't be read: the panel shows the notes.
export async function changelogFor(upstreamKey: string, tags: string[], get: (site: string) => Promise<unknown> = fetchFeed): Promise<ReleaseChangelog | undefined> {
  const site = CHANGELOG_SITES[upstreamKey];
  if (!site || !tags.length) return undefined;
  return readFeed(site, await get(site), tags);
}
