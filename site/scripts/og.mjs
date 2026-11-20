#!/usr/bin/env node
// Makes public/img/og.jpg (1200 x 630), the picture link previews show: the icon, the name and
// the headline beside the Mac app. Drawn with Playwright from the site's own font and images, so
// run `node scripts/images.mjs` first. Committed, so this only runs when it should change.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
// Playwright isn't a dependency of the site: it comes from PLAYWRIGHT_DIR (a folder whose
// node_modules has it) or, failing that, wherever Node finds it from here.
function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_DIR;
  try {
    return createRequire(dir ? (dir.endsWith("/") ? dir : `${dir}/`) : import.meta.url)("playwright");
  } catch {
    console.error("Playwright not found. Set PLAYWRIGHT_DIR to a folder that has it installed (npm i playwright there).");
    process.exit(1);
  }
}
const { chromium } = loadPlaywright();
const data = (file, type) => `data:${type};base64,${readFileSync(join(site, file)).toString("base64")}`;

const html = `<!doctype html><html><head><style>
@font-face { font-family: Geist; src: url(${data("public/fonts/Geist-Variable.woff2", "font/woff2")}); font-weight: 100 900; }
* { margin: 0; box-sizing: border-box; }
body { width: 1200px; height: 630px; overflow: hidden; background: #faf8f3; font-family: Geist; position: relative; }
.copy { position: absolute; left: 64px; top: 64px; width: 470px; }
.brand { display: flex; align-items: center; gap: 16px; font-size: 30px; font-weight: 600; color: #1f1c18; }
.brand img { width: 64px; height: 64px; border-radius: 16px; }
h1 { margin-top: 48px; font-size: 60px; line-height: 60px; font-weight: 600; letter-spacing: -.035em;
  background: linear-gradient(90deg, #000, #666); -webkit-background-clip: text; color: transparent; }
p { margin-top: 24px; font-size: 24px; line-height: 32px; color: #46413a; }
.mac { position: absolute; left: 580px; top: 72px; width: 900px; filter: drop-shadow(0 24px 40px rgba(40,30,15,.18)); }
</style></head><body>
<div class="copy">
  <div class="brand"><img src="${data("public/img/icon-192.png", "image/png")}">Threadbear</div>
  <h1>Get to your next decision fast</h1>
  <p>A desktop app for your Claude Code and Codex threads, and all of its source.</p>
</div>
<img class="mac" src="${data("public/screens/mac-thread.webp", "image/webp")}">
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(site, "public/img/og.jpg"), type: "jpeg", quality: 85 });
await browser.close();
console.log("public/img/og.jpg");
