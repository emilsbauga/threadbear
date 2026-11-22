// The parity run's page (scripts/parity/run.sh): each scenario in a row,
// with the Mac app (the GPUI one; another runner's thread, through Convex),
// the iPhone app, the Android app and the website side by side, the words
// each didn't show in red, and where one looks different from the Mac's
// (looks.json, from looks.ts, once nightly.sh has run it). Also writes
// results.json, prints one line per failure and difference, and exits 1 if
// any surface missed a word or a picture or looks different.
//
//   node scripts/parity/gallery.mjs <out dir>
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const read = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
  } catch {
    return d;
  }
};
const seed = read('seed.json', { threads: [] });
const web = read('web.json', []);
const mac = read('mac.json', []);
const ios = read('ios.json', []);
const android = read('android.json', []);
const looks = read('looks.json', null);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const surfaces = [
  // short: the name looks.ts gives it.
  ['Mac (GPUI), another runner', 'Mac', (i) => ({ file: `mac-${i + 1}.png`, missing: mac[i]?.missing })],
  ['iPhone', 'iPhone', (i) => ({ file: `iphone-${i + 1}.png`, missing: ios[i]?.missing })],
  ['Android', 'Android', (i) => ({ file: `android-${i + 1}.png`, missing: android[i]?.missing })],
  ['Website', 'Website', (i) => ({ file: `web-${i + 1}.png`, missing: web[i]?.missing })],
];
const results = [];
const failures = [];
const differences = [];
for (const [i, t] of seed.threads.entries()) {
  const row = { name: t.name, surfaces: {} };
  const look = looks?.[i];
  for (const [label, short, of] of surfaces) {
    const { file, missing } = of(i);
    const has = fs.existsSync(path.join(out, file));
    const differs = (look?.differences ?? []).filter((d) => d.surface === short).map((d) => d.what);
    row.surfaces[label] = { file: has ? file : null, missing: missing ?? null, ...(looks ? { differs } : {}) };
    if (!has) failures.push(`${t.name}: no picture from ${label}`);
    else if (!missing) failures.push(`${t.name}: ${label}'s words weren't checked (its step failed)`);
    else if (missing.length) failures.push(`${t.name}: ${label} didn't show ${missing.map((m) => JSON.stringify(m)).join(', ')}`);
    for (const what of differs) differences.push(`${t.name}: ${label} looks different: ${what}`);
  }
  // A look that couldn't be had isn't a difference, but is said, so a
  // check that never runs doesn't pass for one that found nothing.
  if (look?.error) row.lookError = look.error;
  results.push(row);
}
const lookErrors = [...new Set(results.map((r) => r.lookError).filter(Boolean))];
if (!seed.threads.length) failures.push('no scenarios were seeded');
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), failures, differences, ...(lookErrors.length ? { lookErrors } : {}), looked: !!looks, results }, null, 2));
const cell = (s) =>
  s.file
    ? `<figure><img src="${esc(s.file)}" loading="lazy"><figcaption>${s.missing?.length ? `<b>Missing:</b> ${s.missing.map(esc).join(', ')}` : s.missing ? 'Shows every word' : '<b>Words not checked</b>'}${(s.differs ?? []).map((d) => `<br><b>Looks different:</b> ${esc(d)}`).join('')}</figcaption></figure>`
    : '<figure class="none">No picture</figure>';
const problems = [...failures, ...differences];
const html = `<!doctype html><meta charset="utf-8"><title>Threadbear parity run</title>
<style>
body{background:#111;color:#ddd;font:14px -apple-system,system-ui,sans-serif;margin:24px}
h1{font-size:20px} h2{font-size:15px;margin:28px 0 8px} .bad{color:#ff6b6b}
.row{display:grid;grid-template-columns:2fr 1fr 1fr 2fr;gap:12px;align-items:start}
figure{margin:0} img{width:100%;border-radius:8px;border:1px solid #333}
figcaption{font-size:12px;color:#999;margin-top:4px} figcaption b{color:#ff6b6b} .none{color:#ff6b6b}
.head{display:grid;grid-template-columns:2fr 1fr 1fr 2fr;gap:12px;color:#888;font-size:12px}
</style>
<h1>Threadbear parity run, ${esc(new Date().toLocaleString())}</h1>
<p class="${problems.length ? 'bad' : ''}">${problems.length ? `${problems.length} problem${problems.length === 1 ? '' : 's'}:<br>${problems.map(esc).join('<br>')}` : 'Every surface showed every scenario.'}</p>
<p>${looks ? (lookErrors.length ? `The looks check couldn't compare some: ${lookErrors.map(esc).join('; ')}` : 'Compared with the Mac app by Opus.') : 'Not compared with the Mac app yet (nightly.sh does that after the run).'}</p>
<div class="head">${surfaces.map(([l]) => `<div>${esc(l)}</div>`).join('')}</div>
${results.map((r) => `<h2>${esc(r.name)}</h2><div class="row">${surfaces.map(([l]) => cell(r.surfaces[l])).join('')}</div>`).join('\n')}
`;
fs.writeFileSync(path.join(out, 'index.html'), html);
for (const f of problems) console.log(f);
process.exit(problems.length ? 1 : 0);
