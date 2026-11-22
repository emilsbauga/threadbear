#!/usr/bin/env node
// Writes the Phosphor icons the site uses (regular weight unless it says, MIT, LICENSE-Phosphor) into
// src/icons as plain SVGs, from any @phosphor-icons/react install on this Mac. Only needed when
// adding an icon: the SVGs are committed. `node scripts/icons.mjs <path to @phosphor-icons/react>`
// The agent-*.svg logos (the hero line) are not Phosphor's and not written here: they are LobeHub's
// icons (MIT), copied from the desktop app's desktop/gpui/src/icons.rs (agent-gemini.svg from
// @lobehub/icons-static-svg, as the desktop app has no Gemini logo yet).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkg = process.argv[2];
if (!pkg) throw new Error("Pass the path to an @phosphor-icons/react folder");
const ICONS = {
  "bandaids": "Bandaids", "device-mobile": "DeviceMobile", "link": "Link", "lightning": "Lightning",
  "key": "Key", "lock": "Lock", "shield-check": "ShieldCheck", "terminal-window": "TerminalWindow",
  "github-logo": "GithubLogo", "bell": "Bell", "database": "Database", "moon-stars": "MoonStars",
  "qr-code": "QrCode", "coins": "Coins", "code": "Code", "cursor-click": "CursorClick", "wrench": "Wrench",
  "user-circle": "UserCircle", "git-fork": "GitFork", "desktop": "Desktop", "copy": "Copy", "check": "Check",
  "columns": "Columns", "books": "Books",
  // The platforms under the hero's copy button, filled (Mike picked filled over outline, 17 Nov).
  // apple-logo.svg isn't made here: Phosphor's filled apple has a flat bottom that looks cut off,
  // so it's Simple Icons' Apple mark (CC0), padded to Phosphor's margins by hand.
  "windows-logo": ["WindowsLogo", "fill"], "linux-logo": ["LinuxLogo", "fill"],
  // The Android badge beside the App Store one in the install section.
  "android-logo": ["AndroidLogo", "fill"],
  // The docs pages' own icons (site/docs-icons.json).
  "chats-circle": "ChatsCircle", "paper-plane-tilt": "PaperPlaneTilt", "archive": "Archive", "push-pin": "PushPin",
  "stack": "Stack", "clock": "Clock", "users-three": "UsersThree", "keyboard": "Keyboard", "flask": "Flask",
  "plugs-connected": "PlugsConnected", "warning-circle": "WarningCircle", "hard-drives": "HardDrives",
  "lifebuoy": "Lifebuoy", "compass": "Compass", "book-open": "BookOpen",
  // The docs search box (src/docs-search.js).
  "magnifying-glass": "MagnifyingGlass",
};
for (const [file, entry] of Object.entries(ICONS)) {
  const [name, weight] = Array.isArray(entry) ? entry : [entry, "regular"];
  const src = readFileSync(join(pkg, "dist/defs", `${name}.es.js`), "utf8");
  // Each weight is a list of elements; every one of these icons is plain paths.
  const regular = src.split(`"${weight}"`)[1].split(/\n\s*\],?\n\s*\[/)[0];
  const paths = [...regular.matchAll(/d: "([^"]+)"/g)].map((m) => `<path d="${m[1]}"/>`).join("");
  if (!paths) throw new Error(`No paths for ${name}`);
  writeFileSync(join("src/icons", `${file}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor">${paths}</svg>\n`);
}
console.log(`Wrote ${Object.keys(ICONS).length} icons.`);
