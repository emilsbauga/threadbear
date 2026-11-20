import fs from 'node:fs';

// One profile, two apps: TB_APP says which to drive (gpui by default, or
// swift), and a scenario tagged @<app>-pending hasn't been done on that app
// yet, or @<os>-pending on the GPUI app on that system. TB_INCLUDE_PENDING=1
// runs those too, to see what's left.
//
// Each run writes reports/<app>-<os>.json, which parity.mjs turns into the
// table in docs/gpui-port/PARITY.md.
const app = process.env.TB_APP ?? 'gpui';
const os = { darwin: 'mac', win32: 'windows', linux: 'linux' }[process.platform] ?? process.platform;
// @mac-pending, @windows-pending and @linux-pending: the GPUI app on that
// system doesn't pass it yet (the Swift app only runs on the Mac, and has
// @swift-pending for itself).
const pending = process.env.TB_INCLUDE_PENDING ? '' : ` and not @${app}-pending${app === 'gpui' ? ` and not @${os}-pending` : ''}`;
// Real pointer events are opt-in on a check host's desktop, never Mike's Mac.
const realScreen = process.env.TB_REAL_SCREEN === '1' ? '' : ' and not @real-screen';

// Feature files named on the command line (`cucumber-js window.feature:30`) are
// the run: with `paths` set as well, cucumber-js ran every file anyway, and a
// one-scenario check took a whole suite's twenty minutes (10 Nov).
const named = process.argv.slice(2).some((a) => /\.feature(:\d+)*$/.test(a));

// TB_SHARD=2/3: this run takes the second of three shares of the feature
// files, for a CI job running beside the others. Linux's whole run took 28 to
// 31 minutes and then passed its job's 45 (17 Nov): about 620 scenarios at
// three seconds each, a third of that starting the app. Shares are balanced
// by scenario count, biggest file first into the emptiest share.
const shard = /^(\d+)\/(\d+)$/.exec(process.env.TB_SHARD ?? '');
function shardOf(files, index, count) {
  const sized = files.map((f) => ({ f, n: (fs.readFileSync(f, 'utf8').match(/^\s*Scenario/gm) ?? []).length }));
  sized.sort((a, b) => b.n - a.n || a.f.localeCompare(b.f));
  const shares = Array.from({ length: count }, () => ({ n: 0, files: [] }));
  for (const { f, n } of sized) {
    const emptiest = shares.reduce((a, b) => (b.n < a.n ? b : a));
    emptiest.n += n;
    emptiest.files.push(f);
  }
  return shares[index - 1].files.sort();
}
const paths = named ? [] : shard
  ? shardOf(fs.readdirSync('.').filter((f) => f.endsWith('.feature')).sort(), Number(shard[1]), Number(shard[2])).map((f) => `./${f}`)
  : ['./*.feature'];
// Each shard writes a report of its own; parity.mjs reads them together.
const report = `./reports/${app}-${os}${shard ? `.shard-${shard[1]}-of-${shard[2]}` : ''}.json`;

export default {
  paths,
  import: ['./support/*.ts', './steps/*.ts'],
  tags: `not @manual${pending}${realScreen}${process.env.TB_TAGS ? ` and (${process.env.TB_TAGS})` : ''}`,
  format: ['progress', `json:${report}`],
  retry: Number(process.env.TB_RETRY ?? 0),
  // Each scenario's app and mock are stopped, but a run once sat for half an
  // hour after its last scenario with nothing left to do (9 Nov).
  forceExit: true,
};
