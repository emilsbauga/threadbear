// The home page hero's live inbox (Mike picked "Live decision" from three directions on 19 Nov,
// ~/dev/me/misc/threadbear-site-juice). No inline styles in its markup: the CSP has no
// 'unsafe-inline' for styles, so the bear's pivots and the empty inbox's start are in styles.css.
//
// "Live decision": the hero acts out "Get to your next decision fast". A small live copy of the
// app's inbox: threads arrive, the top one rises with its decision, a pointer answers it, the row
// slides off (its thread goes back to work, so Running ticks up), the rest glide up, and after
// the last one the bear waves at an empty inbox. Then the threads come back and it plays again.
// It holds while it's off screen or the tab's hidden, and with reduced motion it's a still of the
// first decision. It's drawn in the page's light colours, not the app's dark ones ("Paper
// window", Mike's pick of 19 Nov from three fixes to the hero), and on a phone the decision
// sits above the list (styles.css). Everything moves by transform and opacity (Web Animations), with spring curves
// drawn as CSS linear() where the browser has it.
(() => {
  const host = document.querySelector(".live");
  if (!host) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ───── Springs as linear() easings ─────
  const hasLinear = CSS.supports("animation-timing-function", "linear(0, 1)");
  function spring(stiffness, damping) {
    if (!hasLinear) return { easing: "cubic-bezier(.3, 1.4, .5, 1)", duration: 420 };
    let x = 0, v = 0, t = 0;
    const dt = 1 / 120, pts = [0];
    while (t < 2) {
      v += (-stiffness * (x - 1) - damping * v) * dt;
      x += v * dt;
      t += dt;
      pts.push(x);
      if (t > 0.1 && Math.abs(x - 1) < 0.002 && Math.abs(v) < 0.02) break;
    }
    const step = Math.max(1, Math.ceil(pts.length / 40));
    const out = [];
    for (let i = 0; i < pts.length; i += step) out.push(+pts[i].toFixed(3));
    out.push(1);
    return { easing: `linear(${out.join(", ")})`, duration: Math.round(t * 1000) };
  }
  const SNAP = spring(520, 30); // rows, counts: quick with a hint of bounce
  const RISE = spring(340, 22); // the decision card coming up
  const POP = spring(300, 16); // the bear
  const OUT = "cubic-bezier(.22, 1, .36, 1)";
  const AWAY = "cubic-bezier(.55, 0, .75, .3)";

  // Sets the end state inline and animates to it from `from`, so nothing piles up as fills.
  const go = (el, from, to, opts) => {
    Object.assign(el.style, to);
    return el.animate([from, to], { fill: "backwards", ...opts }).finished.catch(() => {});
  };

  // ───── Holding while off screen or hidden ─────
  let inView = true;
  const held = () => !inView || document.hidden;
  const wait = (ms) => new Promise((done) => {
    let last = performance.now();
    const tick = (now) => {
      if (!held()) ms -= now - last;
      last = now;
      if (ms <= 0) done(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const syncAnims = () => {
    for (const a of host.getAnimations({ subtree: true })) held() ? a.pause() : a.play();
  };

  // ───── Pieces ─────
  const I = {
    inbox: '<path d="M2 9l2-5.5h8l2 5.5v3.5H2z"/><path d="M2 9h3.5l.8 1.5h3.4l.8-1.5H14"/>',
    bolt: '<path d="M9 1.8L3.8 9h4l-1 5.2L12.2 7h-4z"/>',
    moon: '<path d="M12.5 9.5A5.5 5.5 0 1 1 6.5 3.5a4.5 4.5 0 0 0 6 6z"/>',
    folder: '<path d="M2 4.5h4l1.2 1.3H14V13H2z"/>',
    wrench: '<path d="M10.5 2.5a3 3 0 0 0-2.8 4l-5 5 1.8 1.8 5-5a3 3 0 0 0 4-2.8l-1.7 1.2-1.6-.4-.4-1.6z"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  };
  const icon = (n) => `<svg class="ic" viewBox="0 0 16 16">${I[n]}</svg>`;

  // The line bear, waving (Bear.swift on its 24 grid, as in the juice kit's TB.bear).
  function bear(size) {
    const c = [10.5, 12.5], r = 7, er = 2.6, lw = 1.6;
    const ears = [-1, 1].map((s) => `<circle cx="${c[0] + s * r * 0.72}" cy="${c[1] - r * 0.72}" r="${er}"/>`).join("");
    const eyeY = c[1] - r * 0.12;
    const eyes = [-1, 1].map((s) => `<circle cx="${c[0] + s * r * 0.4}" cy="${eyeY}" r="${r * 0.14}" fill="currentColor" stroke="none"/>`).join("");
    const toes = [220, 270, 320].map((a) => { const q = a * Math.PI / 180; return `<circle cx="${20.6 + Math.cos(q) * 3.9}" cy="${6.6 + Math.sin(q) * 3.9}" r=".75" fill="currentColor" stroke="none"/>`; }).join("");
    return `<svg class="bear" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${lw}" stroke-linecap="round" stroke-linejoin="round" overflow="visible">
      <defs><mask id="ld-out" maskUnits="userSpaceOnUse" x="-10" y="-10" width="44" height="44"><rect x="-10" y="-10" width="44" height="44" fill="#fff"/><circle cx="${c[0]}" cy="${c[1]}" r="${r}" fill="#000"/></mask></defs>
      <g class="b-fig">
        <g mask="url(#ld-out)">${ears}</g>
        <circle cx="${c[0]}" cy="${c[1]}" r="${r}"/>
        <g class="b-eyes">${eyes}</g>
        <ellipse cx="${c[0]}" cy="${c[1] + r * 0.3}" rx="${r * 0.17}" ry="${r * 0.12}" fill="currentColor" stroke="none"/>
        <g class="b-paw"><path d="M16.4 16.6C19.6 15.6 21.4 12.4 20.4 9.4"/><circle cx="20.6" cy="6.6" r="2.4"/>${toes}</g>
      </g></svg>`;
  }

  const THREADS = [
    { title: "Ship the beta to TestFlight", project: "misc", time: "1m", av: icon("folder"),
      asked: "Get build 42 out to the beta testers.", worked: "18s",
      said: "Build 42 is signed, with release notes written from this week's commits.",
      q: "Send the release notes as they are?", answers: ["Send them", "Let me read", "Something else…"], pick: 0 },
    { title: "Pick a colour for the Share button", project: "Walkies", time: "4m", av: "W",
      asked: "Try the new Share button in a few colours.", worked: "41s",
      said: "Three versions are side by side in the panel. They all look fine, honestly.",
      q: "Which one should ship?", answers: ["Honey", "Grey", "Show me again"], pick: 1 },
    { title: "Clear out the old build folders", project: "misc", time: "9m", av: icon("folder"),
      asked: "Clear out the old build folders, they're taking up space.", worked: "6s",
      said: "Found 14 of them, 38 GB in all. None are used by a current branch.",
      q: "Delete all 14?", answers: ["Delete them", "Keep the newest", "Deny"], pick: 0 },
    { title: "Draft the release notes for 0.4", project: "Threadbear", time: "12m", av: "🧸",
      asked: "Draft the notes for 0.4.", worked: "33s",
      said: "Two drafts are ready. One leads with the iPhone app, one with the speed-ups.",
      q: "Which one goes first?", answers: ["iPhone app", "Speed-ups", "You pick"], pick: 2 },
  ];

  host.innerHTML = `
    <div class="ld" role="img" aria-label="A Threadbear inbox where each thread asks one question with its answers as buttons. Each is answered with a click and slides away until the inbox is empty and the bear waves.">
      <div class="ld-win">
        <div class="ld-lights"><i></i><i></i><i></i></div>
        <div class="ld-side">
          <div class="ld-sec">${icon("inbox")}<span>Inbox</span><span class="rule"></span><span class="ld-count" data-k="inbox"><span>0</span></span></div>
          <div class="ld-rows"></div>
          <div class="ld-after">
          <div class="ld-sec run">${icon("bolt")}<span>Running</span><span class="rule"></span><span class="ld-count" data-k="run"><span>2</span></span></div>
          <div class="ld-sec">${icon("moon")}<span>Hibernating</span><span class="rule"></span><span class="ld-count"><span>3</span></span></div>
          </div>
        </div>
        <div class="ld-main">
          <div class="ld-head"></div>
          <div class="ld-body"></div>
          <div class="ld-compose">
            <div class="ld-cardarea"></div>
            <div class="ld-input">Or say something else…</div>
            <div class="ld-bar">${icon("plus")}<span>Claude · Fable 5.1</span><span>Full access</span><span class="grow"></span><span class="ld-send">${icon("up")}</span></div>
          </div>
        </div>
        <div class="ld-zero">${bear(76)}<p>Nothing in the inbox.</p></div>
        <div class="ld-ptr"><svg viewBox="0 0 18 22"><path d="M2 1.5v16.2l4.1-3.9 2.7 6.2 2.8-1.2-2.6-6.1h5.8z" fill="#111" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg><div class="ld-touch"></div></div>
      </div>
    </div>`;

  const $ = (s) => host.querySelector(s);
  const win = $(".ld-win"), rowsEl = $(".ld-rows"), head = $(".ld-head"), body = $(".ld-body");
  const after = $(".ld-after"), cardArea = $(".ld-cardarea"), compose = $(".ld-compose"), zero = $(".ld-zero"), ptr = $(".ld-ptr");
  const counts = { inbox: $('[data-k="inbox"]'), run: $('[data-k="run"]') };
  // The row height, measured: the window's sizes scale with its width (--u in styles.css).
  const rh = () => rowsEl.offsetHeight / THREADS.length;
  const narrow = () => win.offsetWidth < 520;

  const rowHTML = (t) => `<span class="ld-dot"></span><div class="ld-av">${t.av}</div><div class="ld-tx"><div class="ld-t">${t.title}</div><div class="ld-s"><span>${t.project}</span><span>${t.time}</span></div></div>`;
  const cardHTML = (t) => `<div class="ld-ch"><span>✋</span><span>Decisions needed</span>${t.of ? `<b>${t.of}</b>` : ""}</div>
    <div class="ld-q"><i>1.</i><span>${t.q}</span></div>
    <div class="ld-btns">${t.answers.map((a) => `<span class="ld-btn">${a}</span>`).join("")}</div>`;
  const make = (cls, html) => { const el = document.createElement("div"); el.className = cls; el.innerHTML = html; return el; };

  // A count that rolls to its new number.
  function setCount(k, n, quiet) {
    const box = counts[k], old = box.lastElementChild;
    if (old && old.textContent === String(n)) return;
    const next = document.createElement("span");
    next.textContent = n;
    box.append(next);
    if (quiet || !old) { old?.remove(); return; }
    const dir = +old.textContent < n ? 1 : -1;
    go(old, { transform: "none", opacity: 1 }, { transform: `translateY(${-dir * 100}%)`, opacity: 0 }, { duration: 180, easing: OUT }).then(() => old.remove());
    go(next, { transform: `translateY(${dir * 100}%)`, opacity: 0 }, { transform: "none", opacity: 1 }, SNAP);
  }

  // Where an element sits inside the window, ignoring any transform that's mid-flight.
  function spot(el) {
    let x = 0, y = 0;
    for (let n = el; n && n !== win; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }

  let ptrAt = null, ptrShown = false;
  async function pointTo(el) {
    const s = spot(el), touch = narrow();
    const to = { x: s.x + s.w * (touch ? 0.5 : 0.42), y: s.y + s.h * (touch ? 0.5 : 0.55) };
    if (touch) {
      // A fingertip doesn't glide over the glass: it lands where it means to tap.
      ptrAt = to;
      ptr.style.transform = `translate(${to.x}px, ${to.y}px)`;
      ptrShown = true;
      go(ptr, { opacity: 0 }, { opacity: 1 }, { duration: 160, easing: OUT });
      await ptr.querySelector(".ld-touch").animate([{ transform: "scale(1.5)" }, { transform: "scale(1)" }], { duration: 260, easing: OUT }).finished.catch(() => {});
      return;
    }
    if (!ptrAt) ptrAt = { x: win.offsetWidth - 30, y: win.offsetHeight - 20 };
    const from = `translate(${ptrAt.x}px, ${ptrAt.y}px)`;
    const mid = `translate(${(ptrAt.x + to.x) / 2 + 10}px, ${(ptrAt.y + to.y) / 2 + 14}px)`;
    const end = `translate(${to.x}px, ${to.y}px)`;
    ptrAt = to;
    if (!ptrShown) { ptrShown = true; go(ptr, { opacity: 0 }, { opacity: 1 }, { duration: 200, easing: OUT }); }
    ptr.style.transform = end;
    await ptr.animate([{ transform: from }, { transform: mid, offset: 0.45 }, { transform: end }], { duration: touch ? 460 : 520, easing: OUT }).finished.catch(() => {});
  }
  async function hidePointer() {
    if (!ptrShown) return;
    ptrShown = false;
    await go(ptr, { opacity: 1 }, { opacity: 0 }, { duration: 260, easing: OUT });
  }
  async function tap(btn) {
    const inner = narrow() ? ptr.querySelector(".ld-touch") : ptr.querySelector("svg");
    inner.animate([{ transform: "scale(1)" }, { transform: "scale(.82)", offset: 0.35 }, { transform: "scale(1)" }], { duration: 240, easing: OUT });
    await wait(70);
    btn.classList.add("chosen");
    btn.animate([{ transform: "scale(1)" }, { transform: "scale(.93)", offset: 0.3 }, { transform: "scale(1)" }], { duration: 260, easing: OUT });
  }

  // ───── Scenes ─────
  let rows = [];
  const placeRows = (stagger = 0) => Promise.all(rows.map((r, i) => {
    const y = i * rh();
    if (r.y === y) return null;
    const from = `translateY(${r.y}px)`;
    r.y = y;
    return go(r.el, { transform: from }, { transform: `translateY(${y}px)` }, { ...SNAP, delay: i * stagger });
  }));
  // Running and Hibernating sit just under the last row, so they come up as the inbox empties.
  let afterY = 0;
  const placeAfter = (delay = 0) => {
    const y = -(THREADS.length - rows.length) * rh();
    if (y === afterY) return;
    const from = `translateY(${afterY}px)`;
    afterY = y;
    go(after, { transform: from }, { transform: `translateY(${y}px)` }, { ...SNAP, delay });
  };

  async function arrive() {
    rowsEl.textContent = "";
    rows = [];
    afterY = -THREADS.length * rh();
    after.style.transform = `translateY(${afterY}px)`;
    const all = THREADS.map((t, i) => {
      const el = make("ld-row", rowHTML(t));
      el.style.opacity = 0;
      rowsEl.append(el);
      return { t, el, y: i * rh() };
    });
    await Promise.all(all.map((r, i) => (async () => {
      await wait(i * 110);
      rows.push(r);
      placeAfter();
      setCount("inbox", i + 1);
      setCount("run", Math.max(2, 5 - i));
      await go(r.el, { transform: `translateY(${r.y - 14}px) scale(.97)`, opacity: 0 }, { transform: `translateY(${r.y}px)`, opacity: 1 }, SNAP);
    })()));
  }

  let shown = null, composeUp = false;
  async function open(t) {
    rows[0].el.classList.add("sel");
    const old = shown;
    const title = make("ld-ht", `${icon("folder")}<span>${t.title}</span>`);
    const tr = make("ld-tr", `<div class="ld-bubble">${t.asked}</div><div class="ld-worked">${icon("wrench")}Worked for ${t.worked}</div><div class="ld-said">${t.said}</div>`);
    head.append(title);
    body.append(tr);
    if (old) {
      go(old.title, { opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-6px)" }, { duration: 160, easing: OUT }).then(() => old.title.remove());
      go(old.tr, { opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-10px)" }, { duration: 180, easing: OUT }).then(() => old.tr.remove());
    }
    go(title, { opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }, { duration: 260, easing: OUT, delay: 40 });
    go(tr, { opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }, { duration: 320, easing: OUT, delay: 60 });
    shown = { title, tr };

    if (!composeUp) {
      composeUp = true;
      go(compose, { opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }, { duration: 280, easing: OUT });
      await wait(120);
    }
    const card = make("ld-card", cardHTML(t));
    // Out of sight until it rises: for those 40 ms it sat in place, over the card still leaving.
    card.style.transform = "translateY(100%)";
    cardArea.append(card);
    await wait(40);
    await go(card, { transform: "translateY(100%)", opacity: 0.4 }, { transform: "none", opacity: 1 }, RISE);
    return card;
  }

  async function answer(t, card) {
    const btn = card.querySelectorAll(".ld-btn")[t.pick];
    await pointTo(btn);
    await wait(110);
    await tap(btn);
    if (narrow()) wait(200).then(hidePointer);
    await wait(240);
    // The card drops back into the composer and the row slides off to Running.
    go(card, { transform: "none", opacity: 1 }, { transform: "translateY(40%)", opacity: 0 }, { duration: 200, easing: AWAY }).then(() => card.remove());
    const gone = rows.shift();
    gone.el.classList.remove("sel");
    go(gone.el, { transform: `translateY(${gone.y}px)`, opacity: 1 }, { transform: `translate(-70%, ${gone.y}px)`, opacity: 0 }, { duration: 240, easing: AWAY }).then(() => gone.el.remove());
    setCount("inbox", rows.length);
    setCount("run", +counts.run.lastElementChild.textContent + 1);
    await wait(110);
    placeRows(25);
    placeAfter(rows.length * 25);
    await wait(60);
  }

  async function inboxZero() {
    hidePointer();
    if (shown) {
      const { title, tr } = shown;
      shown = null;
      go(title, { opacity: 1 }, { opacity: 0 }, { duration: 200, easing: OUT }).then(() => title.remove());
      go(tr, { opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-10px)" }, { duration: 220, easing: OUT }).then(() => tr.remove());
    }
    composeUp = false;
    go(compose, { opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(16px)" }, { duration: 240, easing: OUT });
    await wait(160);
    const fig = zero.querySelector(".b-fig"), paw = zero.querySelector(".b-paw"), text = zero.querySelector("p");
    zero.style.opacity = 1;
    go(fig, { transform: "translateY(10px) scale(.6)", opacity: 0 }, { transform: "none", opacity: 1 }, POP);
    go(text, { opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }, { duration: 360, easing: OUT, delay: 160 });
    await wait(260);
    await paw.animate(
      [{ transform: "rotate(0)" }, { transform: "rotate(-24deg)" }, { transform: "rotate(10deg)" }, { transform: "rotate(-24deg)" }, { transform: "rotate(10deg)" }, { transform: "rotate(-14deg)" }, { transform: "rotate(0)" }],
      { duration: 1100, easing: "cubic-bezier(.45, 0, .55, 1)" },
    ).finished.catch(() => {});
    // A blink, since he's pleased.
    zero.querySelector(".b-eyes").animate([{ transform: "scaleY(1)" }, { transform: "scaleY(.1)", offset: 0.5 }, { transform: "scaleY(1)" }], { duration: 180, easing: OUT });
    await wait(1500);
    await go(zero, { opacity: 1 }, { opacity: 0 }, { duration: 260, easing: OUT });
  }

  async function loop() {
    for (;;) {
      await arrive();
      await wait(350);
      for (const t of THREADS) {
        const card = await open(t);
        await answer(t, card);
      }
      await inboxZero();
      await wait(300);
    }
  }

  // A resized window changes the row height, so everything goes back to where it belongs.
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => {
      rows.forEach((r, i) => { r.y = i * rh(); r.el.style.transform = `translateY(${r.y}px)`; });
      afterY = -(THREADS.length - rows.length) * rh();
      after.style.transform = `translateY(${afterY}px)`;
    }).observe(win);
  }

  // With reduced motion: the first decision, still.
  if (still) {
    rows = THREADS.map((t, i) => {
      const el = make("ld-row", rowHTML(t));
      el.style.transform = `translateY(${i * rh()}px)`;
      rowsEl.append(el);
      return { t, el, y: i * rh() };
    });
    rows[0].el.classList.add("sel");
    counts.inbox.firstElementChild.textContent = THREADS.length;
    const t = THREADS[0];
    head.append(make("ld-ht", `${icon("folder")}<span>${t.title}</span>`));
    body.append(make("ld-tr", `<div class="ld-bubble">${t.asked}</div><div class="ld-worked">${icon("wrench")}Worked for ${t.worked}</div><div class="ld-said">${t.said}</div>`));
    cardArea.append(make("ld-card", cardHTML(t)));
    return;
  }

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => { inView = e.isIntersecting; syncAnims(); }, { threshold: 0.05 }).observe(host);
  }
  document.addEventListener("visibilitychange", syncAnims);
  compose.style.opacity = 0;
  loop();
})();
