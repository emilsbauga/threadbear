// How setup self-hosts the backend (scripts/self-hosted-plan.mjs): on the
// tailnet, on this Mac only, or at an address of your own, which a later run
// keeps, and the container settings for each, never published beyond loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Flags = { selfHosted?: boolean; local?: boolean; tailnet?: boolean; url?: string; siteUrl?: string };
type Plan = { selfHosted?: boolean; mode?: 'local' | 'tailnet' | 'url'; from?: string; was?: { url: string; site?: string }; fail?: string; url?: string; site?: string; readdressed?: boolean };
type Answer = { status?: number; body?: string; error?: string };
type Container = { env: Record<string, string>; runArgs: string[]; cmd: string[] };
// Plain JS with no types, as setup runs before any packages are installed.
const planModule: string = '../../../scripts/self-hosted-plan.mjs';
const m = (await import(planModule)) as {
  selfHostedPlan: (p: { flags?: Flags; joining?: boolean; adminKeyFile?: boolean; syncUrl?: string; syncSite?: string }) => Plan;
  backendContainer: (mode: string, at?: { name: string; ip: string } | { url: string; site: string }) => Container;
  origins: (mode: string, at?: string | { url: string; site: string }) => { url: string; site: string; dashboard: string; dashboardBackend: string };
  reachOf: (syncUrl: string) => string;
  ownAddress: (raw: string, flag: string) => { origin?: string; fail?: string };
  isLoopbackUrl: (u: string) => boolean;
  servedOn: (status: unknown, tailnetPort: number) => { Proxy?: string }[] | undefined;
  mustSeeTailnetOff: (a: { from?: string; pending?: boolean }) => boolean;
  tailnetPendingFiles: (defaultHome: string, home: string, path: unknown) => string[];
  ownAddresses: (text: string | undefined, add?: { api?: string[]; site?: string[] }) => { api: string[]; site: string[] };
  OWN_ADDRESSES_FILE: string;
  oldAddressStep: (a: { checks: { addr: string; want: Answer; got: Answer }[]; mode: string; again: string }) => { do: string; message: string };
  offTailnetStep: (a: { cli: boolean; handlers?: { Proxy?: string }[]; tailnetPort: number; localPort: number; moving: boolean }) => { do: string; message?: string };
  BACKEND_IMAGE: string;
  DASHBOARD_IMAGE: string;
  pinnedImage: (docker: (args: string[]) => { status: number; stdout?: string }, ref: string) => void;
};

const LOCAL_URL = 'http://127.0.0.1:13210';
const TAILNET_URL = 'https://mac.tail1.ts.net:3210';
const OWN_URL = 'https://threadbear.example.com';
const OWN_SITE = 'https://threadbear-site.example.com';
const OWN = { url: OWN_URL, siteUrl: OWN_SITE };

test('a first setup self-hosts only when asked, on the tailnet unless --local', () => {
  assert.deepEqual(m.selfHostedPlan({}), { selfHosted: false });
  assert.deepEqual(m.selfHostedPlan({ flags: { selfHosted: true } }), { selfHosted: true, mode: 'tailnet' });
  assert.deepEqual(m.selfHostedPlan({ flags: { selfHosted: true, local: true } }), { selfHosted: true, mode: 'local' });
  // --local on its own means self-hosted too.
  assert.deepEqual(m.selfHostedPlan({ flags: { local: true } }), { selfHosted: true, mode: 'local' });
  assert.ok(m.selfHostedPlan({ flags: { local: true, tailnet: true } }).fail);
});

test('setup run again keeps the way it was set up, and only a flag moves it', () => {
  // No flags: the admin key file says self-hosted, the loopback sync.url says local.
  assert.deepEqual(m.selfHostedPlan({ adminKeyFile: true, syncUrl: LOCAL_URL }), { selfHosted: true, mode: 'local' });
  assert.deepEqual(m.selfHostedPlan({ adminKeyFile: true, syncUrl: TAILNET_URL }), { selfHosted: true, mode: 'tailnet' });
  // Plain --self-hosted on a local Mac stays local: an agent rerunning the
  // docs' command doesn't put it on a (work) tailnet.
  assert.deepEqual(m.selfHostedPlan({ flags: { selfHosted: true }, adminKeyFile: true, syncUrl: LOCAL_URL }), { selfHosted: true, mode: 'local' });
  assert.deepEqual(m.selfHostedPlan({ flags: { tailnet: true }, adminKeyFile: true, syncUrl: LOCAL_URL }), { selfHosted: true, mode: 'tailnet', from: 'local' });
  assert.deepEqual(m.selfHostedPlan({ flags: { selfHosted: true, local: true }, adminKeyFile: true, syncUrl: TAILNET_URL }), { selfHosted: true, mode: 'local', from: 'tailnet' });
  // An admin key with no sync.url: a first setup stopped partway. Without a
  // flag it asks rather than guess the tailnet; with one it carries on.
  assert.ok(m.selfHostedPlan({ adminKeyFile: true }).fail);
  assert.ok(m.selfHostedPlan({ flags: { selfHosted: true }, adminKeyFile: true }).fail);
  assert.deepEqual(m.selfHostedPlan({ flags: { local: true }, adminKeyFile: true }), { selfHosted: true, mode: 'local' });
  // A loopback sync.url without the admin key file isn't a self-hosted Mac
  // (a dev deployment, say): setup doesn't take it for one.
  assert.deepEqual(m.selfHostedPlan({ syncUrl: LOCAL_URL }), { selfHosted: false });
});

test('a Mac joining another has no backend, and the self-hosted flags are refused there', () => {
  assert.deepEqual(m.selfHostedPlan({ joining: true, adminKeyFile: false }), { selfHosted: false });
  for (const flags of [{ selfHosted: true }, { local: true }, { tailnet: true }]) assert.ok(m.selfHostedPlan({ joining: true, flags }).fail);
});

test('every port either backend publishes is on 127.0.0.1, never the LAN', () => {
  for (const c of [m.backendContainer('local'), m.backendContainer('tailnet', { name: 'mac.tail1.ts.net', ip: '100.64.0.1' }), m.backendContainer('url', { url: OWN_URL, site: OWN_SITE })]) {
    const published = c.runArgs.flatMap((a, i) => (c.runArgs[i - 1] === '-p' ? [a] : []));
    assert.equal(published.length, 2);
    for (const p of published) assert.match(p, /^127\.0\.0\.1:\d+:\d+$/);
    assert.ok(!c.runArgs.includes('--network') && !c.runArgs.includes('--net'));
  }
});

test('a local backend has one origin for the browser, the runner and the container itself', () => {
  const c = m.backendContainer('local');
  const o = m.origins('local');
  assert.equal(o.url, LOCAL_URL);
  assert.equal(c.env.CONVEX_CLOUD_ORIGIN, o.url);
  assert.equal(c.env.CONVEX_SITE_ORIGIN, o.site);
  // Published on the same port inside as out, so the origin reaches the
  // backend from inside the container too (the website's stored files).
  assert.ok(c.runArgs.includes('127.0.0.1:13210:13210') && c.runArgs.includes('127.0.0.1:13211:13211'));
  const script = c.cmd.join(' ');
  assert.match(script, /--port 13210/);
  assert.match(script, /--site-proxy-port 13211/);
  // It stops rather than run on the image's own ports if the script it edits changes.
  assert.match(script, /grep -q/);
  assert.ok(!c.runArgs.includes('--add-host'));
  assert.ok(Object.values(o).every(m.isLoopbackUrl));
});

test('a tailnet backend is unchanged by the local way (7 Nov containers aren\'t made again)', () => {
  const c = m.backendContainer('tailnet', { name: 'mac.tail1.ts.net', ip: '100.64.0.1' });
  assert.deepEqual(c.cmd, []);
  assert.deepEqual(c.runArgs, ['-p', '127.0.0.1:13210:3210', '-p', '127.0.0.1:13211:3211', '-v', 'threadbear-convex-data:/convex/data', '--add-host', 'mac.tail1.ts.net:100.64.0.1']);
  assert.deepEqual(c.env, { CONVEX_CLOUD_ORIGIN: TAILNET_URL, CONVEX_SITE_ORIGIN: 'https://mac.tail1.ts.net:3211', DISABLE_BEACON: 'true' });
  assert.equal(m.origins('tailnet', 'mac.tail1.ts.net').url, TAILNET_URL);
});

test('only loopback URLs count as local', () => {
  for (const u of [LOCAL_URL, 'http://localhost:13210', 'http://[::1]:13210']) assert.ok(m.isLoopbackUrl(u), u);
  for (const u of [TAILNET_URL, 'https://happy-otter-123.convex.cloud', 'http://127.0.0.1.evil.com', 'not a url']) assert.ok(!m.isLoopbackUrl(u), u);
});

// Daybreak, 11 Nov 2026 (finding 101): moving to --local while Tailscale was
// stopped read its failed `serve status` as "nothing served", saved the
// local URL and left the backend's ports on the tailnet, saved for when
// Tailscale came back; later runs, now local, never looked again.
test("a Tailscale that can't say what it serves is never read as serving nothing", () => {
  const status = (stdout: string, code = 0, error?: Error) => ({ status: code, stdout, stderr: '', error });
  const served = JSON.stringify({ Web: { 'mac.tail1.ts.net:3210': { Handlers: { '/': { Proxy: 'http://127.0.0.1:13210' } } } } });
  assert.deepEqual(m.servedOn(status(served), 3210), [{ Proxy: 'http://127.0.0.1:13210' }]);
  assert.deepEqual(m.servedOn(status(served), 3211), []);
  assert.deepEqual(m.servedOn(status('{}'), 3210), []);
  assert.deepEqual(m.servedOn(status(''), 3210), []);
  assert.equal(m.servedOn(status('', 1), 3210), undefined); // its daemon not running
  assert.equal(m.servedOn(status(served, 1), 3210), undefined);
  assert.equal(m.servedOn(status('not json'), 3210), undefined);
  assert.equal(m.servedOn(status('[]'), 3210), undefined);
  assert.equal(m.servedOn(status('null'), 3210), undefined);
  assert.equal(m.servedOn(status(JSON.stringify({ Web: 'x' })), 3210), undefined);
  assert.equal(m.servedOn(status(JSON.stringify({ Web: { 'mac:3210': null } })), 3210), undefined);
  assert.equal(m.servedOn({ status: null, stdout: '', error: new Error('ENOENT') }, 3210), undefined); // didn't run
  assert.equal(m.servedOn(undefined, 3210), undefined);
});

test('a move off the tailnet stops unless it can see each port is off', () => {
  const ours = [{ Proxy: 'http://127.0.0.1:13210/' }];
  const step = (a: Partial<Parameters<typeof m.offTailnetStep>[0]>) => m.offTailnetStep({ cli: true, tailnetPort: 3210, localPort: 13210, moving: true, ...a });
  // Couldn't ask, or no Tailscale found: stops, so the tailnet URL stays and the next run tries again.
  assert.equal(step({ handlers: undefined }).do, 'fail');
  assert.equal(step({ cli: false, handlers: undefined }).do, 'fail');
  assert.match(step({ cli: false }).message ?? '', /can't find Tailscale/);
  // Serving it: off. Serving nothing, or only someone else's: nothing.
  assert.equal(step({ handlers: ours }).do, 'off');
  assert.equal(step({ handlers: [] }).do, 'nothing');
  assert.equal(step({ handlers: [{ Proxy: 'http://127.0.0.1:8080' }] }).do, 'nothing');
  // Ours and someone else's on one port: can't take only ours off.
  assert.equal(step({ handlers: [...ours, { Proxy: 'http://127.0.0.1:8080' }] }).do, 'fail');
  assert.equal(step({ handlers: [{}] }).do, 'nothing');
  // A local run that isn't a move still takes ours off, every time, and only says it when it can't ask.
  assert.equal(step({ moving: false, handlers: ours }).do, 'off');
  assert.equal(step({ moving: false, handlers: undefined }).do, 'note');
  assert.equal(step({ moving: false, cli: false }).do, 'nothing');
});

// Cross-lab review of that fix: a --tailnet run that served the ports and
// then stopped before saving its URL left a local URL, so a later --local
// run with Tailscale stopped only said it couldn't check. The note setup
// leaves before serving makes that run check too.
test('a local run after the backend was served on the tailnet has to see it off, URL or not', () => {
  assert.equal(m.mustSeeTailnetOff({ from: 'tailnet' }), true);
  assert.equal(m.mustSeeTailnetOff({ pending: true }), true);
  assert.equal(m.mustSeeTailnetOff({ from: undefined, pending: false }), false);
  const step = (moving: boolean) => m.offTailnetStep({ cli: true, handlers: undefined, tailnetPort: 3210, localPort: 13210, moving });
  assert.equal(step(m.mustSeeTailnetOff({ pending: true })).do, 'fail');
  assert.equal(step(m.mustSeeTailnetOff({ pending: false })).do, 'note');
});

// The order that makes it hold: the note is written before the first
// tailscale serve, and removed only after every port's step, in setup itself.
test('setup leaves the tailnet note before serving and clears it only after every port is off', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../../scripts/setup.mjs', import.meta.url), 'utf8');
  const write = src.indexOf('fs.writeFileSync(pendingFile');
  const serveLoop = src.indexOf('serve(tailnet.ts, tailnetPort, localPort)');
  const unserveLoop = src.indexOf('unserve(ts, tailnetPort, localPort, moving)');
  const remove = src.indexOf('for (const f of pendingFiles) fs.rmSync(f');
  assert.ok(write > 0 && write < serveLoop, 'written before serving');
  assert.ok(unserveLoop > 0 && unserveLoop < remove, 'removed after the ports');
});

// Daybreak 12 Nov (finding 110): setup before 4d8cdb23 left the note in the
// --home folder. An interrupted --tailnet run there, then a --local run on
// the same folder with Tailscale unable to say what it serves, found no note
// in the default folder and only noted it, leaving the ports served.
test('a note an older setup left in a custom --home still makes a local run see the ports off', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-pending-'));
  try {
    const def = path.join(root, 'Threadbear');
    const custom = path.join(root, 'custom-home');
    fs.mkdirSync(def, { recursive: true });
    fs.mkdirSync(custom, { recursive: true });
    const files = m.tailnetPendingFiles(def, custom, path);
    assert.deepEqual(files, [path.join(def, 'self-hosted-on-tailnet'), path.join(custom, 'self-hosted-on-tailnet')]);
    // The legacy note only, as the old setup left it.
    fs.writeFileSync(files[1]!, 'served\n');
    const moving = m.mustSeeTailnetOff({ from: undefined, pending: files.some((f) => fs.existsSync(f)) });
    assert.equal(moving, true);
    assert.equal(m.offTailnetStep({ cli: true, handlers: undefined, tailnetPort: 3210, localPort: 13210, moving }).do, 'fail');
    assert.equal(m.offTailnetStep({ cli: false, tailnetPort: 3210, localPort: 13210, moving }).do, 'fail');
    // The default folder as --home is looked at once.
    assert.deepEqual(m.tailnetPendingFiles(def, def + '/', path), [path.join(def, 'self-hosted-on-tailnet')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setup reads and clears the note in both folders', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../../scripts/setup.mjs', import.meta.url), 'utf8');
  assert.match(src, /tailnetPendingFiles\(DEFAULT_HOME, home, path\)/);
  assert.match(src, /pending: pendingFiles\.some\(\(f\) => fs\.existsSync\(f\)\)/);
});

// An address of your own (--url, 14 Nov 2026): for someone who already
// reaches their Mac their own way, so Threadbear needn't care how.
test('--url and --site-url self-host at your own address, together, and only those', () => {
  assert.deepEqual(m.selfHostedPlan({ flags: OWN }), { selfHosted: true, mode: 'url', url: OWN_URL, site: OWN_SITE });
  assert.deepEqual(m.selfHostedPlan({ flags: { selfHosted: true, ...OWN } }), { selfHosted: true, mode: 'url', url: OWN_URL, site: OWN_SITE });
  // Trailing slashes and default ports come off; other ports stay.
  assert.deepEqual(m.selfHostedPlan({ flags: { url: 'https://Tb.Example.com:443/', siteUrl: 'https://tb.example.com:8443' } }), { selfHosted: true, mode: 'url', url: 'https://tb.example.com', site: 'https://tb.example.com:8443' });
  // One without the other, or with another way, or the same address twice.
  assert.match(m.selfHostedPlan({ flags: { url: OWN_URL } }).fail ?? '', /go together/);
  assert.match(m.selfHostedPlan({ flags: { siteUrl: OWN_SITE } }).fail ?? '', /go together/);
  assert.ok(m.selfHostedPlan({ flags: { ...OWN, local: true } }).fail);
  assert.ok(m.selfHostedPlan({ flags: { ...OWN, tailnet: true } }).fail);
  assert.match(m.selfHostedPlan({ flags: { url: OWN_URL, siteUrl: OWN_URL + '/' } }).fail ?? '', /same address/);
  // What --tailnet makes would read back as the tailnet next time, and
  // setup takes this backend's own serve off the tailnet ports, so your proxy
  // can't be on them either.
  assert.match(m.selfHostedPlan({ flags: { url: TAILNET_URL, siteUrl: 'https://mac.tail1.ts.net:8444' } }).fail ?? '', /--tailnet/);
  assert.match(m.selfHostedPlan({ flags: { url: 'https://mac.tail1.ts.net:8443', siteUrl: 'https://mac.tail1.ts.net:3211' } }).fail ?? '', /--site-url .* --tailnet uses/);
  assert.ok(m.selfHostedPlan({ flags: { url: 'https://mac.tail1.ts.net:8443', siteUrl: 'https://mac.tail1.ts.net:6791' } }).fail);
  // Those ports on a name that isn't a tailnet one are fine.
  assert.equal(m.selfHostedPlan({ flags: { url: 'https://tb.example.com:3210', siteUrl: 'https://tb.example.com:3211' } }).mode, 'url');
  // But your own tailnet name on another port is yours.
  assert.equal(m.selfHostedPlan({ flags: { url: 'https://mac.tail1.ts.net:8443', siteUrl: 'https://mac.tail1.ts.net:8444' } }).mode, 'url');
  // A Mac joining another has no backend of its own.
  assert.ok(m.selfHostedPlan({ joining: true, flags: OWN }).fail);
});

test('only an https address a phone could reach is taken as your own', () => {
  for (const bad of ['https://mac.tail1.ts.net.:3210', 'https://tb.example.com.', 'http://threadbear.example.com', 'ftp://x.example.com', 'https://127.0.0.1:13210', 'https://localhost', 'https://[::1]:3210', 'https://user:pw@tb.example.com', 'https://tb.example.com/convex', 'https://tb.example.com/?a=1', 'https://tb.example.com/#x', 'https://happy-otter-123.convex.cloud', 'https://happy-otter-123.convex.site', 'not a url', '']) {
    assert.ok(m.ownAddress(bad, '--url').fail, bad);
  }
  for (const [good, origin] of [['https://tb.example.com', 'https://tb.example.com'], ['https://tb.example.com/', 'https://tb.example.com'], ['https://192.168.1.20:8443', 'https://192.168.1.20:8443'], [' https://tb.example.com ', 'https://tb.example.com']]) {
    assert.equal(m.ownAddress(good!, '--url').origin, origin, good);
  }
});

test('setup run again keeps your own address, and a flag moves it', () => {
  const was = { adminKeyFile: true, syncUrl: OWN_URL, syncSite: OWN_SITE };
  assert.equal(m.reachOf(OWN_URL), 'url');
  assert.equal(m.reachOf(TAILNET_URL), 'tailnet');
  assert.equal(m.reachOf(LOCAL_URL), 'local');
  assert.deepEqual(m.selfHostedPlan(was), { selfHosted: true, mode: 'url', url: OWN_URL, site: OWN_SITE });
  // Plain --self-hosted (the docs' command again) keeps it there too.
  assert.deepEqual(m.selfHostedPlan({ ...was, flags: { selfHosted: true } }), { selfHosted: true, mode: 'url', url: OWN_URL, site: OWN_SITE });
  // The same addresses again aren't a change; new ones are.
  assert.deepEqual(m.selfHostedPlan({ ...was, flags: OWN }), { selfHosted: true, mode: 'url', url: OWN_URL, site: OWN_SITE });
  assert.deepEqual(m.selfHostedPlan({ ...was, flags: { url: 'https://new.example.com', siteUrl: OWN_SITE } }), { selfHosted: true, mode: 'url', url: 'https://new.example.com', site: OWN_SITE, readdressed: true });
  // Moves to and from the other two ways.
  assert.deepEqual(m.selfHostedPlan({ ...was, flags: { local: true } }), { selfHosted: true, mode: 'local', from: 'url', was: { url: OWN_URL, site: OWN_SITE } });
  assert.deepEqual(m.selfHostedPlan({ ...was, flags: { tailnet: true } }), { selfHosted: true, mode: 'tailnet', from: 'url', was: { url: OWN_URL, site: OWN_SITE } });
  assert.deepEqual(m.selfHostedPlan({ adminKeyFile: true, syncUrl: TAILNET_URL, flags: OWN }), { selfHosted: true, mode: 'url', url: OWN_URL, site: OWN_SITE, from: 'tailnet' });
  assert.deepEqual(m.selfHostedPlan({ adminKeyFile: true, syncUrl: LOCAL_URL, flags: OWN }), { selfHosted: true, mode: 'url', url: OWN_URL, site: OWN_SITE, from: 'local' });
  // A setup that stopped before saving its URL can carry on with --url.
  assert.equal(m.selfHostedPlan({ adminKeyFile: true, flags: OWN }).mode, 'url');
  assert.match(m.selfHostedPlan({ adminKeyFile: true }).fail ?? '', /--url/);
  // Kept, but with no site saved: it asks rather than guess.
  assert.match(m.selfHostedPlan({ adminKeyFile: true, syncUrl: OWN_URL }).fail ?? '', /sync\.site/);
});

test('a backend at your own address uses it as its origin, with its ports left on loopback for your proxy', () => {
  const c = m.backendContainer('url', { url: OWN_URL, site: OWN_SITE });
  assert.deepEqual(c.env, { CONVEX_CLOUD_ORIGIN: OWN_URL, CONVEX_SITE_ORIGIN: OWN_SITE, DISABLE_BEACON: 'true' });
  assert.deepEqual(c.runArgs, ['-p', '127.0.0.1:13210:3210', '-p', '127.0.0.1:13211:3211', '-v', 'threadbear-convex-data:/convex/data']);
  assert.deepEqual(c.cmd, []);
  const o = m.origins('url', { url: OWN_URL, site: OWN_SITE });
  assert.equal(o.url, OWN_URL);
  assert.equal(o.site, OWN_SITE);
  // The dashboard stays on this Mac and talks to the backend there.
  assert.equal(o.dashboard, 'http://127.0.0.1:16791');
  assert.equal(o.dashboardBackend, LOCAL_URL);
  assert.equal(m.origins('tailnet', 'mac.tail1.ts.net').dashboardBackend, TAILNET_URL);
  assert.equal(m.origins('local').dashboardBackend, LOCAL_URL);
});

test('setup checks your address from this Mac and from inside Docker before it carries on', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../../scripts/setup.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(own\) await checkOwnAddress\(url, site, \{ quiet: prechecked \}\)/);
  // Cross-lab review, 14 Nov 2026: checked against a running backend before
  // anything changes, after the admin key (which marks the Mac self-hosted)
  // on the way through, with the live connection, and not on a dotfile path.
  const pre = src.indexOf('await checkOwnAddress(url, site, { fresh: true });');
  // Waited for, not a single quick try, and from a container set up like the new one.
  assert.match(src, /if \(await answers\(ADMIN_URL, 60\)\)/);
  assert.match(src, /docker\(\['run', '--rm', '--entrypoint', curl\[0\], BACKEND_IMAGE/);
  assert.ok(pre > 0 && pre < src.indexOf('ensureContainer(BACKEND_CONTAINER'), 'pre-check before the containers change');
  assert.ok(pre < src.indexOf('unserve(ts, tailnetPort, localPort, moving);'), 'pre-check before tailnet ports come off');
  assert.ok(src.indexOf("ok(`admin key saved in") < src.indexOf('if (own) await checkOwnAddress(url, site, {'), 'admin key before the check');
  assert.match(src, /new WebSocket\(wsUrl\)/);
  assert.ok(!src.includes('/.threadbear-setup-check-'));
  assert.match(src, /docker\(\['exec', BACKEND_CONTAINER, \.\.\.curl\]\)/);
  // A url run never asks Tailscale for this Mac's name, so it takes the
  // backend's own tailnet ports off (the else of `if (tailnet)`), as a local one does.
  assert.match(src, /else if \(own\) ok\(`your own address[^\n]*\n\s*else \{\n\s*tailnet = tailnetSelf\(\);/);
});

// Daybreak 150 (17 Nov 2026): an owner whose Caddy or nginx forwards their own address to
// 127.0.0.1:13210 and :13211 runs setup --self-hosted --local. Both ways publish those same ports
// and keep the data, so the proxy went on forwarding, share links and paired phones still reached
// the backend, and setup said share links only open on this Mac. Setup can't take the proxy down,
// so it now refuses the move while the old address still reaches the backend, before anything
// changes and again after, and otherwise says what it checked and what it can't.
test('a move off your own address keeps the old addresses, to check they no longer reach the backend', () => {
  const was = { adminKeyFile: true, syncUrl: OWN_URL, syncSite: OWN_SITE };
  assert.deepEqual(m.selfHostedPlan({ ...was, flags: { selfHosted: true, local: true } }).was, { url: OWN_URL, site: OWN_SITE });
  // Only a move off it: staying, new addresses, or moves between the other two ways have none.
  assert.equal(m.selfHostedPlan(was).was, undefined);
  assert.equal(m.selfHostedPlan({ ...was, flags: { url: 'https://new.example.com', siteUrl: OWN_SITE } }).was, undefined);
  assert.equal(m.selfHostedPlan({ adminKeyFile: true, syncUrl: TAILNET_URL, flags: { local: true } }).was, undefined);
  assert.equal(m.selfHostedPlan({ adminKeyFile: true, syncUrl: LOCAL_URL, flags: OWN }).was, undefined);
});

test("a move off your own address stops while the old proxy still forwards to the backend", () => {
  const version = { status: 200, body: '1.29.3' };
  const api404 = { status: 404, body: 'No route' };
  const site404 = { status: 404, body: 'No matching routes found' };
  const again = './threadbear setup --self-hosted --local';
  // The scenario: the proxy still forwards both addresses.
  const still = m.oldAddressStep({ mode: 'local', again, checks: [
    { addr: OWN_URL, want: version, got: version },
    { addr: OWN_URL, want: api404, got: api404 },
    { addr: OWN_SITE, want: site404, got: site404 },
  ] });
  assert.equal(still.do, 'fail');
  assert.match(still.message, /^https:\/\/threadbear\.example\.com and https:\/\/threadbear-site\.example\.com still reach this backend/);
  assert.match(still.message, /wouldn't be on this Mac only: anyone with a share link/);
  assert.match(still.message, /curl https:\/\/threadbear\.example\.com\/version/);
  assert.ok(still.message.endsWith(again));
  // A proxy that turns away /version but still forwards the rest is still forwarding.
  assert.equal(m.oldAddressStep({ mode: 'local', again, checks: [{ addr: OWN_URL, want: version, got: { status: 403, body: 'no' } }, { addr: OWN_URL, want: api404, got: api404 }] }).do, 'fail');
  // Only the website's still forwarded: that's enough to stop it.
  assert.equal(m.oldAddressStep({ mode: 'tailnet', again, checks: [{ addr: OWN_URL, want: version, got: { error: 'ECONNREFUSED' } }, { addr: OWN_SITE, want: site404, got: site404 }] }).do, 'fail');
  // Taken down: the proxy's own error page, or nothing answering, isn't the backend.
  const gone = m.oldAddressStep({ mode: 'local', again, checks: [{ addr: OWN_URL, want: version, got: { status: 502, body: 'Bad Gateway' } }, { addr: OWN_SITE, want: site404, got: { error: 'ENOTFOUND' } }] });
  assert.equal(gone.do, 'ok');
  // But that's only this Mac's view, said plainly: no local-only promise until the rules are gone.
  assert.match(gone.message, /didn't reach this backend when setup asked from this Mac, but that's all setup can see/);
  assert.match(gone.message, /share links and phones paired there may still reach it, so it isn't on this Mac only until then/);
  // A loopback that can't answer gives nothing to compare, so nothing matches it by accident.
  assert.equal(m.oldAddressStep({ mode: 'local', again, checks: [{ addr: OWN_URL, want: { error: 'ECONNREFUSED' }, got: { error: 'ECONNREFUSED' } }] }).do, 'ok');
});

test('every address a --url setup was given stays on record until a move off has checked it', () => {
  assert.equal(m.OWN_ADDRESSES_FILE, 'self-hosted-own-addresses.json');
  // A first --url run that stops before runner.json is saved still leaves them.
  const first = m.ownAddresses(undefined, { api: [OWN_URL], site: [OWN_SITE] });
  assert.deepEqual(first, { api: [OWN_URL], site: [OWN_SITE] });
  // New addresses add to the old, which a proxy may still forward too.
  assert.deepEqual(m.ownAddresses(JSON.stringify(first), { api: ['https://new.example.com'], site: [OWN_SITE] }), { api: [OWN_URL, 'https://new.example.com'], site: [OWN_SITE] });
  // Missing pieces (an older Mac's runner.json with no sync.site) are left out.
  assert.deepEqual(m.ownAddresses(undefined, { api: [undefined as unknown as string, OWN_URL], site: [undefined as unknown as string] }), { api: [OWN_URL], site: [] });
  // A damaged file loses only what isn't an address list.
  assert.deepEqual(m.ownAddresses('{"api":[3,"https://a.example"],"site":"x"}'), { api: ['https://a.example'], site: [] });
  assert.deepEqual(m.ownAddresses('not json'), { api: [], site: [] });
});

test('setup checks the old address before anything changes and again before runner.json moves, and says so at the end', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../../scripts/setup.mjs', import.meta.url), 'utf8');
  // On record before the containers change, in the default data folder whatever --home says.
  assert.match(src, /const ownAddressesFile = path\.join\(DEFAULT_HOME, OWN_ADDRESSES_FILE\);/);
  const record = src.indexOf('fs.writeFileSync(ownAddressesFile,');
  assert.ok(record > 0 && record < src.indexOf('ensureContainer(BACKEND_CONTAINER'));
  // A move off checks what's on record as well as this --home's runner.json.
  assert.match(src, /const old = own \? \{ api: \[\], site: \[\] \} : recordedAddresses\(/);
  const pre = src.indexOf('if (now && (await answers(ADMIN_URL, 60))) await checkOldAddressGone(old);');
  // A move off writes what it'll check on record first, so an older Mac's addresses stay asked about.
  const kept = src.indexOf("fs.writeFileSync(ownAddressesFile, JSON.stringify(old, null, 2) + '\\n');");
  assert.ok(kept > 0 && kept < pre);
  assert.ok(pre > 0 && pre < src.indexOf('ensureContainer(BACKEND_CONTAINER'), 'pre-check before the containers change');
  assert.ok(pre < src.indexOf('unserve(ts, tailnetPort, localPort, moving);'));
  const post = src.indexOf('const oldAddress = moveOff ? await checkOldAddressGone(old) : undefined;');
  assert.ok(post > src.indexOf('await waitForBackend();'), 'again on the moved backend');
  // Never cleared by setup: a pass is only this Mac's view, so later runs ask and say so again.
  assert.ok(!src.includes('fs.rmSync(ownAddressesFile'));
  // An older Mac's addresses from runner.json go on record when it moves to new ones.
  assert.match(src, /reachOf\(saved\.url\) === 'url' \? saved : \{\}/);
  assert.match(src, /recordedAddresses\(\{ api: \[before\.url, plan\.url\], site: \[before\.site, plan\.site\] \}\)/);
  const body = src.slice(src.indexOf('async function selfHostedBackend()'), src.indexOf('async function runnerJson('));
  assert.ok(body.includes('await checkOldAddressGone(old)'), 'inside selfHostedBackend, which runs before runnerJson writes the new sync.url');
  assert.ok(src.indexOf('sh = await selfHostedBackend();') < src.indexOf('await runnerJson(url, sh?.site);'));
  assert.match(src, /if \(step\.do === 'fail'\) throw new Fail\(step\.message\);/);
  // The end of setup doesn't call it this Mac only without saying what's left.
  assert.match(src, /on this Mac only\$\{sh\.oldAddress \? ' once your old proxy rules are gone \(below\)' : ''\}/);
  assert.match(src, /if \(sh\?\.oldAddress\) note\(`Your own address from before: \$\{sh\.oldAddress\}/);
});

// Daybreak 172: the backend owns the mirror's data and makes its admin key,
// so setup runs exactly the committed image bytes, never whatever a tag
// points at today.
test('both Convex images are pinned by a 64-hex manifest digest, not a tag', () => {
  for (const ref of [m.BACKEND_IMAGE, m.DASHBOARD_IMAGE]) {
    assert.match(ref, /^ghcr\.io\/convex\/convex-(backend|dashboard)@sha256:[0-9a-f]{64}$/);
  }
  assert.notEqual(m.BACKEND_IMAGE.split('@')[1], m.DASHBOARD_IMAGE.split('@')[1]);
});

test('setup itself refers to the images only through the pinned constants', async () => {
  const { readFile } = await import('node:fs/promises');
  const setup = await readFile(new URL('../../../scripts/setup.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(setup, /ghcr\.io\//, 'an image name in setup.mjs would bypass the pin');
  assert.doesNotMatch(setup, /docker\(\['pull'/, 'setup pulls only through pinnedImage');
  // Both are checked before either container is made, and each is made from
  // its pinned constant (the reviews' gap: the order, and what docker run gets).
  const checked = setup.indexOf('pinnedImage(docker, image)');
  const loop = setup.lastIndexOf('for (const image of [BACKEND_IMAGE, DASHBOARD_IMAGE])', checked);
  assert.ok(loop > 0 && checked - loop < 200, 'pinnedImage runs for both images');
  for (const made of ['ensureContainer(BACKEND_CONTAINER, BACKEND_IMAGE,', 'ensureContainer(DASHBOARD_CONTAINER, DASHBOARD_IMAGE,']) {
    assert.ok(setup.indexOf(made) > checked, `${made} comes after the check`);
  }
  assert.equal((setup.match(/ensureContainer\(/g) ?? []).length, 3, 'its definition and the two containers, nothing else');
  assert.match(setup, /docker\(\['run', '-d', '--name', name, [^\n]*, image, \.\.\.cmd\]/, 'docker run gets the image ensureContainer was given');
  // The throwaway container that checks the backend reaches itself runs after the pull too.
  assert.ok(setup.indexOf("'--rm', '--entrypoint', curl[0], BACKEND_IMAGE") > 0);
});

// A fake Docker: `images` maps the reference it was asked for to the
// RepoDigests of what it has under it.
function fakeDocker(images: Record<string, string[]>, pullable: Record<string, string[]> = {}) {
  const calls: string[][] = [];
  const docker = (args: string[]) => {
    calls.push(args);
    const ref = args.at(-1)!;
    if (args[0] === 'pull') {
      if (!pullable[ref]) return { status: 1 };
      images[ref] = pullable[ref];
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (!images[ref]) return { status: 1, stdout: '' };
      return { status: 0, stdout: args.includes('--format') ? JSON.stringify(images[ref]) : '[{}]' };
    }
    return { status: 1 };
  };
  return { docker, calls };
}

test('a missing image is pulled by exactly its digest and checked after', () => {
  const ref = m.BACKEND_IMAGE;
  const { docker, calls } = fakeDocker({}, { [ref]: [ref] });
  m.pinnedImage(docker, ref);
  assert.deepEqual(calls.map((c) => c.at(-1)), [ref, ref, ref]);
  assert.deepEqual(calls[1].slice(0, 1), ['pull']);
  for (const c of calls) assert.ok(!c.some((a) => /:[0-9a-f]{40}$/.test(a)), 'never the commit-shaped tag');
});

test('a tag reference is refused before Docker is asked anything', () => {
  const { docker, calls } = fakeDocker({});
  for (const ref of ['ghcr.io/convex/convex-backend:d1fcbeaf939502a23a0f4b7e9095a12e84866294', 'ghcr.io/convex/convex-backend:latest', 'ghcr.io/convex/convex-backend@sha256:abc']) {
    assert.throws(() => m.pinnedImage(docker, ref), /isn't pinned by digest/);
  }
  assert.equal(calls.length, 0);
});

test('an image whose RepoDigests lack the pinned digest stops setup before a container is made', () => {
  const ref = m.BACKEND_IMAGE;
  const other = `ghcr.io/convex/convex-backend@sha256:${'0'.repeat(64)}`;
  const { docker } = fakeDocker({ [ref]: [other] });
  assert.throws(() => m.pinnedImage(docker, ref), /doesn't carry that digest/);
  const { docker: failing } = fakeDocker({}, { [ref]: [] });
  assert.throws(() => m.pinnedImage(failing, ref), /doesn't carry that digest/);
});

test('retagging the commit-shaped tag to other bytes changes nothing setup runs', () => {
  const ref = m.BACKEND_IMAGE;
  const tag = 'ghcr.io/convex/convex-backend:d1fcbeaf939502a23a0f4b7e9095a12e84866294';
  const evil = `ghcr.io/convex/convex-backend@sha256:${'e'.repeat(64)}`;
  const { docker, calls } = fakeDocker({ [tag]: [evil], [ref]: [ref] });
  m.pinnedImage(docker, ref);
  assert.ok(calls.every((c) => c.at(-1) === ref));
});
