#!/usr/bin/env node
// How long switching threads keeps Mike waiting in the installed GPUI app, from
// the `switch` lines it writes to its log (ThreadPane::log_read in
// desktop/gpui/src/thread.rs, and app.rs `open` for a thread shown from the
// kept ones). Mike, 16 Nov: "I've started to get a lot more loading symbols".
//
//   node desktop/scripts/switch-stats.mjs [desktop.log ...]
//
// With no files it reads ~/Library/Logs/Threadbear/desktop.log and the
// desktop.log.1 it rolls over to. It says how many switches were instant (the
// thread still loaded) and how many showed the spinner, why those had to read
// (`new`: not opened since the app last started, which a restart onto an
// update causes; `evicted`: pushed out of the 24 kept), and how long they took.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const logs = path.join(os.homedir(), 'Library/Logs/Threadbear');
const files = process.argv.length > 2 ? process.argv.slice(2) : [path.join(logs, 'desktop.log.1'), path.join(logs, 'desktop.log')];

const switches = [];
let starts = 0;
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    // "12:34:56.789 switch id=… from=read why=new kept=3 waited_ms=412 …"
    const m = line.match(/^\S+ (\w+) (.*)$/);
    if (!m) continue;
    if (m[1] === 'app' && m[2].startsWith('started')) starts++;
    if (m[1] !== 'switch') continue;
    const fields = {};
    for (const part of m[2].split(' ')) {
      const [k, v] = part.split('=');
      fields[k] = v === undefined ? true : /^\d+$/.test(v) ? Number(v) : v;
    }
    switches.push(fields);
  }
}

if (switches.length === 0) {
  console.log('No thread switches logged yet (the app logs them from the build after 16 Nov).');
  process.exit(0);
}

const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '-');
const quantile = (xs, q) => {
  if (!xs.length) return '-';
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const describe = (rows) => {
  const waits = rows.map((r) => r.waited_ms).filter((n) => typeof n === 'number');
  return `${rows.length} (median ${quantile(waits, 0.5)} ms, p90 ${quantile(waits, 0.9)} ms, worst ${waits.length ? Math.max(...waits) : '-'} ms)`;
};

const kept = switches.filter((s) => s.from === 'kept');
const reads = switches.filter((s) => s.from === 'read' && !s.failed);
const failed = switches.filter((s) => s.failed);
const opens = kept.length + reads.length + failed.length;

console.log(`Thread switches: ${opens}, app starts in these logs: ${starts}`);
console.log(`  instant (still loaded): ${kept.length} ${pct(kept.length, opens)}`);
console.log(`  spinner (had to read):  ${describe(reads)} ${pct(reads.length, opens)}`);
for (const why of ['new', 'evicted']) {
  const these = reads.filter((r) => r.why === why);
  if (these.length) console.log(`    ${why === 'new' ? 'not opened since the app started' : 'pushed out of the kept 24'}: ${describe(these)}`);
}
const soon = reads.filter((r) => r.up_s < 600);
if (soon.length) console.log(`    within 10 min of the app starting: ${soon.length} ${pct(soon.length, reads.length)} of the spinners`);
const panels = reads.filter((r) => !r.why);
if (panels.length) console.log(`    in a panel of its own: ${describe(panels)}`);
if (failed.length) console.log(`  read failed: ${failed.length}`);

const slow = [...reads].sort((a, b) => b.waited_ms - a.waited_ms).slice(0, 5);
console.log('Slowest reads:');
for (const r of slow) {
  console.log(`  ${r.id}  ${r.waited_ms} ms  (runner ${r.request_ms} ms, ${r.kb} KB, decode ${r.decode_ms} ms, fold ${r.fold_ms} ms, ${r.rows} rows${r.remote ? ', another runner' : ''})`);
}
