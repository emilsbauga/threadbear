// The docs search (issue #32, Wayne Sutton's idea): one box that searches every docs page as you
// type, opened from the button above the docs list, with / or ⌘K (Ctrl K off a Mac). The index is
// docs-search.<hash>.json, made by the build from docs/guide.md (searchEntries in scripts/docs.mjs):
// the guide cut at every heading, as plain words. It's fetched once the page is idle, so the first
// key already has it, and every search runs here, in the page, on each key. No server, no service.
//
// Picking a result opens its page at that heading, then scrolls on to the word that matched and
// marks it (reveal, below), as a long section can run for screens past its heading. A result
// opened in a new tab (⌘-click) does the same through a text fragment (#anchor:~:text=...), which
// browsers only follow from a real click, not the Enter key's.
//
// The search itself (search, parts, href, nth) is plain functions with no DOM, so
// runner/test/unit/docs-search.test.ts can run it in node; the box is wired up only in a browser.

/** The query as lower-case words. */
export const terms = (query) => query.toLowerCase().split(/\s+/).filter(Boolean);

const wordStart = (text, at) => at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]);

/** Where `term` first starts a word in `text` (lower-case), or failing that where it first appears. */
function firstHit(text, term) {
  let at = text.indexOf(term);
  const first = at;
  while (at !== -1 && !wordStart(text, at)) at = text.indexOf(term, at + 1);
  return at === -1 ? first : at;
}

/**
 * The entries every word of `query` is in (heading, page name or text), best first: a word in a
 * heading counts most, then in the page's name, then in the text, more for starting a word, and
 * the whole query as written counts again. Inside a word ("pin" in "keeping") counts for little. Each result is { entry, at }, `at` being where in its
 * text the snippet should be (-1 when the words are only in its heading or page name).
 */
export function search(entries, query, limit = 20) {
  const words = terms(query);
  if (!words.length) return [];
  const phrase = words.join(" ");
  const results = [];
  entries.forEach((entry, order) => {
    const lower = entry.lower ??= {
      heading: entry.heading.toLowerCase(), page: entry.page.toLowerCase(), text: entry.text.toLowerCase(),
    };
    let score = 0;
    for (const word of words) {
      const inHeading = firstHit(lower.heading, word);
      const inPage = firstHit(lower.page, word);
      const inText = firstHit(lower.text, word);
      if (inHeading === -1 && inPage === -1 && inText === -1) return;
      if (inHeading !== -1) score += wordStart(lower.heading, inHeading) ? 40 : 6;
      // The page's name matters most for its own top part, which is where a result opens.
      if (inPage !== -1) score += wordStart(lower.page, inPage) ? 15 + (entry.heading ? 0 : 10) : 3;
      if (inText !== -1) {
        score += wordStart(lower.text, inText) ? 6 : 2;
        let count = 0;
        for (let at = lower.text.indexOf(word); at !== -1 && count < 5; at = lower.text.indexOf(word, at + 1)) count++;
        score += count;
      }
    }
    if (words.length > 1) {
      if (lower.heading.includes(phrase)) score += 40;
      if (lower.text.includes(phrase)) score += 20;
    }
    const phraseAt = words.length > 1 ? lower.text.indexOf(phrase) : -1;
    const at = phraseAt !== -1 ? phraseAt : words.map((w) => firstHit(lower.text, w)).filter((n) => n !== -1).sort((a, b) => a - b)[0] ?? -1;
    results.push({ entry, at, score, order });
  });
  return results.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map(({ entry, at }) => ({ entry, at }));
}

/** `text` cut to about `length` characters around `at`, at word gaps, with … where it was cut. */
export function snippet(text, at, length = 150) {
  if (text.length <= length) return text;
  let start = Math.max(0, (at < 0 ? 0 : at) - 40);
  if (start > 0) start = text.indexOf(" ", start) + 1 || start;
  let end = Math.min(text.length, start + length);
  if (end < text.length) end = text.lastIndexOf(" ", end) > start ? text.lastIndexOf(" ", end) : end;
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** `text` as [part, matched] pairs, the query's words marked wherever they appear. */
export function parts(text, query) {
  const words = terms(query);
  const lower = text.toLowerCase();
  const marked = new Array(text.length).fill(false);
  for (const word of words) {
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + 1)) marked.fill(true, at, at + word.length);
  }
  const out = [];
  for (let i = 0; i < text.length;) {
    let j = i;
    while (j < text.length && marked[j] === marked[i]) j++;
    out.push([text.slice(i, j), marked[i]]);
    i = j;
  }
  return out;
}

/**
 * The link for a result: its page, at its heading, plus a text fragment for the words at `at`
 * (the word there and up to three after it, within its sentence) so the browser scrolls to them and marks them. A
 * fragment that doesn't match the page (words split across two list items, say) is ignored, and
 * the heading's anchor still works.
 */
export function href(entry, at) {
  const base = `${entry.path}${entry.anchor ? `#${entry.anchor}` : ""}`;
  if (at < 0) return base;
  let start = at;
  while (start > 0 && /\S/.test(entry.text[start - 1])) start--;
  // Up to four words, stopping at the end of a sentence: the next one may be another list item
  // or paragraph on the page, and a fragment can't run across those.
  const found = entry.text.slice(start).match(/^\S+(?:\s+\S+){0,3}/)?.[0] ?? "";
  const words = found.replace(/^(.*?[.!?:;])\s.*$/, "$1").replace(/[.,;:!?)"]+$/, "");
  if (!words) return base;
  // The directive's own marks (- , &) have to be escaped inside it.
  const text = encodeURIComponent(words).replace(/-/g, "%2D");
  return `${entry.anchor ? base : `${base}#`}:~:text=${text}`;
}

/** Which time (0 for the first) the word at `at` comes up in `text`, so the page can find that one. */
export function nth(text, at) {
  const lower = text.toLowerCase();
  const word = lower.slice(at).match(/^[\p{L}\p{N}_'-]+/u)?.[0];
  if (!word) return { word: "", count: 0 };
  let count = 0;
  for (let i = lower.indexOf(word); i !== -1 && i < at; i = lower.indexOf(word, i + 1)) count++;
  return { word, count };
}

const JUMP = "threadbear-docs-search-jump";

if (typeof document !== "undefined") {
  const opener = document.querySelector(".docs-search-open");
  if (opener) setUp(opener);
  arrive();
}

/**
 * On a page opened from a result: scroll to the word that matched and mark it (with the CSS
 * highlight API, so the page's own markup isn't touched; browsers without it just scroll). The
 * result left { path, anchor, word, count } in sessionStorage on its way here.
 */
function arrive() {
  let jump;
  try {
    jump = JSON.parse(sessionStorage.getItem(JUMP) ?? "null");
    sessionStorage.removeItem(JUMP);
  } catch {}
  if (!jump || jump.path !== location.pathname) return;
  if (document.readyState === "complete") reveal(jump);
  else addEventListener("load", () => reveal(jump), { once: true });
}

function reveal({ anchor, word, count }) {
  const article = document.querySelector(".doc");
  const heading = anchor ? document.getElementById(anchor) : null;
  if (!article || !word) return;
  // The word's count-th time after the heading (the index's text is the page's, in its order).
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let range = null;
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (heading && !(heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (heading?.contains(node)) continue;
    const lower = node.data.toLowerCase();
    for (let i = lower.indexOf(word); i !== -1; i = lower.indexOf(word, i + 1)) {
      last = new Range();
      last.setStart(node, i);
      last.setEnd(node, i + word.length);
      if (seen++ === count) { range = last; break; }
    }
    if (range) break;
  }
  range ??= last;
  if (!range) return;
  const place = () => {
    const top = range.getBoundingClientRect().top + scrollY - innerHeight / 3;
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  };
  place();
  // Pictures above it loading late move it down, so it's put back once they have.
  setTimeout(place, 400);
  if (window.CSS?.highlights && window.Highlight) {
    CSS.highlights.set("docs-search", new Highlight(range));
    addEventListener("pointerdown", () => CSS.highlights.delete("docs-search"), { once: true });
  }
}

function setUp(opener) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  opener.querySelector("kbd").textContent = mac ? "⌘K" : "Ctrl K";
  opener.hidden = false;

  // The box: a dialog over the page (Escape and a click outside close it).
  const dialog = document.createElement("dialog");
  dialog.className = "docs-search";
  dialog.setAttribute("aria-label", "Search the docs");
  dialog.innerHTML = `<div class="ds-field">${opener.querySelector("svg").outerHTML}<input type="text" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="ds-results" aria-autocomplete="list"><kbd>esc</kbd></div><ul class="ds-results" id="ds-results" role="listbox" aria-label="Results"></ul><p class="ds-empty" hidden></p>`;
  document.body.append(dialog);
  const input = dialog.querySelector("input");
  const list = dialog.querySelector(".ds-results");
  const empty = dialog.querySelector(".ds-empty");

  let entries = null;
  let loading = null;
  const load = () => loading ??= fetch(opener.dataset.index)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((data) => { entries = data; render(); })
    .catch(() => { loading = null; if (dialog.open) say("The search couldn't load. Try again in a moment."); });

  let active = -1;
  let shown = [];
  const say = (text) => {
    list.replaceChildren();
    empty.textContent = text;
    empty.hidden = !text;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const marked = (text, query) => parts(text, query).map(([part, hit]) => {
    if (!hit) return document.createTextNode(part);
    const mark = document.createElement("mark");
    mark.textContent = part;
    return mark;
  });
  const setActive = (index) => {
    const items = list.children;
    if (!items.length) return;
    active = (index + items.length) % items.length;
    [...items].forEach((item, i) => item.setAttribute("aria-selected", String(i === active)));
    input.setAttribute("aria-activedescendant", items[active].id);
    items[active].scrollIntoView({ block: "nearest" });
  };

  // Every key shows its results straight away: the search runs here, on the index already loaded.
  function render() {
    const query = input.value.trim();
    if (!query) return say("");
    if (!entries) { load(); return say("Loading the docs…"); }
    const results = search(entries, query);
    shown = results;
    if (!results.length) return say("Nothing in the docs matches that.");
    say("");
    list.replaceChildren(...results.map(({ entry, at }, i) => {
      const item = document.createElement("li");
      item.id = `ds-result-${i}`;
      item.setAttribute("role", "option");
      const link = document.createElement("a");
      link.href = href(entry, at);
      const title = document.createElement("span");
      title.className = "ds-title";
      // In a span of its own, as the title's a flex row and each marked word would be an item.
      const name = document.createElement("span");
      name.append(...marked(entry.heading || entry.page, query));
      title.append(name);
      if (entry.heading) {
        const page = document.createElement("span");
        page.className = "ds-page";
        page.textContent = entry.page;
        title.append(page);
      }
      link.append(title);
      if (entry.text) {
        const text = document.createElement("span");
        text.className = "ds-text";
        text.append(...marked(snippet(entry.text, at), query));
        link.append(text);
      }
      link.addEventListener("click", (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        go(entry, at);
      });
      link.addEventListener("pointermove", () => active !== i && setActive(i));
      item.append(link);
      return item;
    }));
    input.setAttribute("aria-expanded", "true");
    setActive(0);
  }

  // A result opens its page at its heading, then reveal() goes on to the word: here straight
  // away when it's this page, or once another page has loaded.
  function go(entry, at) {
    const jump = { path: entry.path, anchor: entry.anchor, ...(at < 0 ? { word: "", count: 0 } : nth(entry.text, at)) };
    const url = `${entry.path}${entry.anchor ? `#${entry.anchor}` : ""}`;
    dialog.close();
    if (entry.path === location.pathname) {
      if (entry.anchor) history.replaceState(null, "", url);
      if (jump.word) reveal(jump);
      else if (entry.anchor) document.getElementById(entry.anchor)?.scrollIntoView();
      else window.scrollTo({ top: 0 });
      // The heading flashes (styles.css, :target) the same as on a page that's just loaded.
      if (entry.anchor) flash(document.getElementById(entry.anchor));
      return;
    }
    try { sessionStorage.setItem(JUMP, JSON.stringify(jump)); } catch {}
    location.assign(url);
  }
  const flash = (el) => {
    if (!el) return;
    el.classList.remove("ds-flash");
    void el.offsetWidth;
    el.classList.add("ds-flash");
  };

  const open = () => {
    if (dialog.open) return input.select();
    dialog.showModal();
    input.select();
    render();
    load();
  };
  opener.addEventListener("click", open);
  opener.addEventListener("pointerenter", load, { once: true });
  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Escape") {
      // Closed here rather than left to the dialog, so it's one press however the browser treats the field.
      event.preventDefault();
      dialog.close();
    } else if (event.key === "Enter" && list.children[active]) {
      event.preventDefault();
      const link = list.children[active].querySelector("a");
      if (event.metaKey || event.ctrlKey) window.open(link.href, "_blank");
      else { const { entry, at } = shown[active]; go(entry, at); }
    }
  });
  // A click on the dim around the box (the dialog itself, not anything in it) closes it.
  dialog.addEventListener("click", (event) => event.target === dialog && dialog.close());
  document.addEventListener("keydown", (event) => {
    const typing = event.target.closest?.("input, textarea, select, [contenteditable='true']");
    if ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey) && !event.altKey) {
      event.preventDefault();
      open();
    } else if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      open();
    }
  });
  // Loaded once the page has settled, so the first key already has it (about 45 KB compressed).
  (window.requestIdleCallback ?? ((f) => setTimeout(f, 1500)))(load);
}
