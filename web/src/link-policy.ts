// What a link from a thread may become on this site (SECURITY.md, "Your Mac
// and phone from links and files"): the one rule every link drawn from a
// remote string goes through (a reply's Markdown, an ask's links, a draft's
// addresses, a picture's link). A web page (http or https, with a host)
// opens as a link. Any other kind (mailto:, slack:, intent:,
// x-apple.systempreferences:) hands its words to another app, so it opens
// only after Threadbear's own question names the whole address and you say
// yes (link-confirm.tsx). What can't be an address at all (javascript:,
// data:, file:, blob:, vbscript:, about:, or one too long to show whole) is
// its text and never a link. A runner, another Mac or an agent's words are
// what write these, so the page decides, not the backend (Daybreak finding
// 139, 16 Nov 2026), as the Mac app, the iPhone and Android apps do with
// their own link gates.

export type LinkTarget = { kind: 'web'; url: string } | { kind: 'ask'; url: string; scheme: string } | { kind: 'never' };

// Longer than this and the question couldn't show the whole address.
export const MAX_LINK_CHARS = 2048;
// Another app's link, whose question has to show all of it, as the apps
// keep it (the desktop's alert doesn't scroll).
export const MAX_ASK_CHARS = 1024;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Schemes that never leave the page as a link, asked or not: they run or
// load something in the page's own context or the machine's files.
const NEVER = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'filesystem:', 'view-source:']);

/**
 * How a link's address may be used here. `base` is the page's address, so
 * a relative link (`/t/abc`, `//example.com`) is read as the browser would.
 */
export function classifyLink(href: string, base: string): LinkTarget {
  // No controls or spaces: the browser strips some of those before reading
  // the scheme, so "java\tscript:" must not get past as something else. And
  // no format character (a bidi override, a zero-width one: Unicode's Cf) or
  // line or paragraph separator, which change how the rest of the address
  // shows in the question about it (Daybreak 167, 22 Nov 2026).
  // eslint-disable-next-line no-control-regex
  // Half a surrogate pair, which URL would quietly turn into U+FFFD, too.
  if (!href || href.length > MAX_LINK_CHARS || /[\u0000-\u0020\u007f-\u009f\u2028\u2029\p{Cf}\p{Zs}]/u.test(href) || LONE_SURROGATE.test(href)) return { kind: 'never' };
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return { kind: 'never' };
  }
  if (url.href.length > MAX_LINK_CHARS) return { kind: 'never' };
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname ? { kind: 'web', url: url.href } : { kind: 'never' };
  if (NEVER.has(url.protocol)) return { kind: 'never' };
  // Printable ASCII only, as the apps hold it: a blank filler or a run of
  // wide letters could push the rest of the address out of sight.
  if (url.href.length > MAX_ASK_CHARS || !/^[\x21-\x7e]*$/.test(url.href)) return { kind: 'never' };
  return { kind: 'ask', url: url.href, scheme: url.protocol.slice(0, -1) };
}
