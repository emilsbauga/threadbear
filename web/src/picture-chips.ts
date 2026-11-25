// [Picture N] in Mike's own message stands for a picture he pasted
// (docs/protocol/threads.md, "Pictures in a message"). The picture goes in its place when
// the runner sent it up (`src` picture:N), and a chip when it didn't: pasted
// before that, too big, or kept on the Mac (`sync.pastedPictures`). Done on the
// parsed Markdown, so a marker in code stays as typed. Turned into a link the
// `a` renderer knows by its address.
type Node = { type: string; value?: string; url?: string; children?: Node[] };

const SCHEME = 'picture:';

// One message's pasted pictures: which ones it has, by number, out of everything
// the page loaded, and those its words don't place, which go under it.
export function pastedOf<T extends { seq: number; src?: string; url: string }>(pictures: T[], seq: number, text: string): { byNumber: Map<number, string>; unplaced: T[] } {
  const mine = pictures.filter((p) => p.seq === seq && p.src && pictureNumber(p.src) !== undefined);
  const placed = new Set([...text.matchAll(/\[Picture ([1-9]\d{0,2})\]/g)].map((m) => Number(m[1])));
  return {
    byNumber: new Map(mine.map((p) => [pictureNumber(p.src!)!, p.url])),
    unplaced: mine.filter((p) => !placed.has(pictureNumber(p.src!)!)),
  };
}

export function pictureNumber(url: string): number | undefined {
  const m = url.startsWith(SCHEME) ? url.slice(SCHEME.length) : '';
  return /^\d{1,3}$/.test(m) ? Number(m) : undefined;
}

// A text node's pieces, the markers as links. Picture 0 isn't one: they
// count from 1.
export function splitMarkers(text: string): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const m of text.matchAll(/\[Picture ([1-9]\d{0,2})\]/g)) {
    if (m.index > at) out.push({ type: 'text', value: text.slice(at, m.index) });
    out.push({ type: 'link', url: `${SCHEME}${m[1]}`, children: [{ type: 'text', value: m[0] }] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ type: 'text', value: text.slice(at) });
  return out;
}

function walk(node: Node): void {
  // Not into a link: a chip inside a link's words would be a link in a link.
  if (!node.children || node.type === 'link') return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value) return splitMarkers(child.value);
    walk(child);
    return [child];
  });
}

export function remarkPictureChips() {
  return (tree: unknown) => walk(tree as Node);
}

// A Notion card Mike mentioned in his message ([title](https://…notion.so/…)),
// drawn as a chip as the Mac and the phones draw it (CardMentions.swift,
// CardMentions.kt): an https address on Notion's own domains, whose host
// ends where its path starts, so notion.so.example.com is no card.
export function isNotionCard(href: string): boolean {
  const m = /^https:\/\/([A-Za-z0-9.-]+)\//.exec(href);
  return !!m && /^(?:[A-Za-z0-9-]+\.)*notion\.(?:so|site|com)$/.test(m[1]!) && !/[\s)]/.test(href);
}
