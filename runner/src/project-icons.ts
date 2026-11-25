// Project icons (docs/protocol/projects.md, "Projects", "Icons"). A project shows
// the picture its own folders already have: an Xcode app icon, a web
// app's apple-touch-icon or favicon, a Chrome extension's icons, a Mac
// .icns. Finding one is a scan of file names, no model needed, so it's
// cheap enough to redo every hour and keep up with a repo that gets a new
// icon. A project with no picture anywhere gets an SF Symbol the librarian
// picks from SYMBOLS instead (librarian.ts).
//
// The picture is copied into the runner's data dir (a PNG of at most
// 256 px), so the app never reads from a repo and an icon
// doesn't vanish when a branch changes under it. One whose header says it's
// bigger than the icon budget (icon-budget.ts) is never a candidate or
// converted, and one that can't be converted isn't kept at all.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ImageRef } from './protocol.ts';
import { convertImage, pictureKind } from './images.ts';
import { ICON_MAX_PIXELS, ICON_MAX_SIDE, checkIcon } from './icon-budget.ts';

export type IconCandidate = {
  path: string;
  score: number;
  width?: number;
  height?: number;
};

const IMAGE_EXTS = new Set(['.png', '.svg', '.icns', '.ico', '.jpg', '.jpeg', '.webp']);
// Never where a project keeps its own icon: dependencies, build output,
// docs (mockups and screenshots) and tests.
const SKIP_DIRS = new Set([
  'node_modules', 'DerivedData', 'Pods', 'Carthage', 'vendor', 'out', 'coverage', 'target', 'venv', '__pycache__',
  'tmp', 'temp', 'docs', 'doc', 'screenshots', 'fixtures', 'Fixtures', 'test', 'tests', 'Tests', 'testdata', 'examples', 'example',
]);
// Folders that say nothing about whose icon is inside them.
const GENERIC_DIRS = new Set([
  'app', 'apps', 'src', 'source', 'sources', 'web', 'www', 'site', 'website', 'public', 'static', 'assets', 'asset', 'images', 'image', 'img',
  'icons', 'icon', 'resources', 'res', 'art', 'artwork', 'media', 'client', 'frontend', 'ios', 'macos', 'mac', 'mobile', 'desktop',
  'extension', 'packages', 'build', 'main', 'ui', 'branding', 'brand', 'logo', 'logos', 'design', 'graphics',
]);
// Below this it's a guess not worth showing.
export const MIN_SCORE = 45;
const MAX_DEPTH = 6;
// Entries looked at per folder, so a huge folder can't hold the runner up.
const MAX_ENTRIES = 40_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ICON_PX = 256;

// Finds the best picture in the folders, the first folder slightly
// preferred (it's usually the project's main repo). `names` are words a
// file named after the project would have (its title, its folders' names).
export async function findIcon(folders: string[], names: string[] = []): Promise<IconCandidate | undefined> {
  return (await findIcons(folders, names))[0];
}

// Every picture good enough to show, best first: when the best can't be
// copied here (an .icns on Linux, which nothing there converts), the next.
export async function findIcons(folders: string[], names: string[] = []): Promise<IconCandidate[]> {
  const words = [...new Set([...names, ...folders.map((f) => path.basename(f))].map(squash).filter((w) => w.length >= 3))];
  const all: IconCandidate[] = [];
  for (const [i, folder] of folders.entries()) {
    for (const c of await candidatesIn(folder, words)) {
      if (c.score < MIN_SCORE) continue;
      all.push({ ...c, score: c.score + (i === 0 ? 3 : 0) });
    }
  }
  return all.sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
}

function better(a: IconCandidate, b: IconCandidate): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if ((a.width ?? 0) !== (b.width ?? 0)) return (a.width ?? 0) > (b.width ?? 0);
  return a.path.length < b.path.length;
}

export async function candidatesIn(root: string, words: string[] = []): Promise<IconCandidate[]> {
  const out: IconCandidate[] = [];
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || seen > MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Asset catalogs' other image sets are the app's own artwork
        // (tab icons, illustrations), not its icon.
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || e.name.startsWith('dist') || e.name.endsWith('.imageset')) continue;
        subdirs.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = path.relative(root, full);
      if (e.name === 'manifest.json' || e.name === 'app.json') {
        const c = await fromManifest(full, root);
        if (c) out.push(c);
        continue;
      }
      const c = await scoreFile(full, rel, words);
      if (c) out.push(c);
    }
    for (const d of subdirs) await walk(d, depth + 1);
  };
  await walk(root, 0);
  return out;
}

// How likely a file is to be the project's icon, from its name and where
// it is; undefined when it isn't one at all.
export async function scoreFile(full: string, rel: string, words: string[] = []): Promise<IconCandidate | undefined> {
  const ext = path.extname(full).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return undefined;
  const name = path.basename(full, path.extname(full)).toLowerCase();
  const segments = rel.split(path.sep).map((s) => s.toLowerCase());
  const parent = segments.at(-2) ?? '';
  const inAppIconSet = segments.some((s) => s.endsWith('.appiconset'));
  const named = words.some((w) => squash(name).includes(w));

  let score: number;
  if (inAppIconSet) score = segments.some((s) => s === 'appicon.appiconset') ? 110 : 100;
  else if (ext === '.icns') score = /icon/.test(name) || named ? 85 : 60;
  else if (/^apple-touch-icon/.test(name)) score = 75;
  else if (/^(app[-_ ]?)?icon(?![a-z])/.test(name)) score = 70;
  else if (named && /^(icons?|assets?|images?|img|resources|public|static|art)$/.test(parent)) score = 70;
  else if (/^favicon/.test(name)) score = ext === '.svg' ? 55 : ext === '.ico' ? 40 : 50;
  else if (/icon/.test(name)) score = 55;
  else if (/^logo/.test(name)) score = 50;
  else return undefined;

  // Menu bar and toolbar icons are template images: one flat colour.
  if (/tray|menubar|menu-bar|statusbar|status-bar|toolbar|template/.test(name)) score -= 30;
  if (/tinted|dark|mono|maskable/.test(name)) score -= 10;
  if (parent === 'icons' || parent === 'icon') score += 5;
  score -= Math.max(0, segments.length - 3);
  // Under a folder named for something else (public/inventory/, a tool's
  // own folder in a repo of tools), it's that thing's icon, not the
  // project's.
  for (const s of segments.slice(0, -1)) {
    if (!GENERIC_DIRS.has(s) && !s.endsWith('.xcassets') && !s.endsWith('.appiconset') && !words.some((w) => squash(s).includes(w) || w.includes(squash(s)))) score -= 40;
  }

  // Over the icon budget, moving, or a size its header doesn't say: no icon.
  if (!(await withinBudget(full, ext))) return undefined;
  const size = await imageSize(full, ext);
  if (size?.width && size.height) {
    const aspect = size.width / size.height;
    // A wordmark, a banner or a screenshot, not an icon.
    if (aspect > 1.25 || aspect < 0.8) score -= 40;
    const px = Math.min(size.width, size.height);
    if (px < 32) score -= 30;
    else if (px < 64) score -= 15;
    else if (px >= 512) score += 10;
    else if (px >= 128) score += 5;
  }
  return { path: full, score, ...size };
}

// A Chrome extension's manifest.json ("icons", the biggest) or an Expo
// app.json ("expo.icon").
async function fromManifest(file: string, root: string): Promise<IconCandidate | undefined> {
  let json: Record<string, unknown>;
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    if (text.length > 200_000) return undefined;
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const dir = path.dirname(file);
  let rel: string | undefined;
  let score = 0;
  if (path.basename(file) === 'manifest.json' && 'manifest_version' in json && json.icons && typeof json.icons === 'object') {
    const icons = Object.entries(json.icons as Record<string, unknown>)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .sort((a, b) => Number(b[0]) - Number(a[0]));
    rel = icons[0]?.[1];
    score = 72;
  } else if (path.basename(file) === 'app.json') {
    const expo = json.expo as Record<string, unknown> | undefined;
    if (expo && typeof expo.icon === 'string') rel = expo.icon;
    score = 75;
  }
  if (!rel) return undefined;
  // A built copy's manifest (dist/) points at a built copy; the walk skips
  // those folders, so this is the source's.
  // A picture by its name, as the walk takes (IMAGE_EXTS), and a file of the
  // repo's own: not a link out of it, nor through a linked folder. A
  // manifest names whatever it likes (Daybreak, 8 Nov: "icon.msl").
  const full = path.resolve(dir, rel.replace(/^\//, ''));
  const ext = path.extname(full).toLowerCase();
  if (!IMAGE_EXTS.has(ext) || !full.startsWith(root + path.sep)) return undefined;
  try {
    if (!(await fs.promises.lstat(full)).isFile()) return undefined;
    const [real, realRoot] = await Promise.all([fs.promises.realpath(full), fs.promises.realpath(root)]);
    if (!real.startsWith(realRoot + path.sep)) return undefined;
  } catch {
    return undefined;
  }
  if (!(await withinBudget(full, ext))) return undefined;
  const size = await imageSize(full, ext);
  return { path: full, score, ...size };
}

// A file's bytes, when it's a file of at most MAX_FILE_BYTES; read from the
// one open file that was checked.
async function readIconFile(file: string): Promise<Buffer | undefined> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    // Non-blocking, so a FIFO swapped in for the file can't hold the open.
    fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

async function withinBudget(file: string, ext: string): Promise<boolean> {
  const bytes = await readIconFile(file);
  return Boolean(bytes && checkIcon(bytes, ext === '.svg').ok);
}

// A PNG's size from its header, an SVG's from its viewBox; .icns and .ico
// are square and nearly always big enough.
export async function imageSize(file: string, ext: string): Promise<{ width?: number; height?: number } | undefined> {
  try {
    if (ext === '.png') {
      const buf = await readHead(file, 24);
      if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return undefined;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (ext === '.svg') {
      const head = (await readHead(file, 4096)).toString('utf8');
      const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head);
      if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) };
      return undefined;
    }
    if (ext === '.icns') return { width: 512, height: 512 };
  } catch {
    return undefined;
  }
  return undefined;
}

async function readHead(file: string, n: number): Promise<Buffer> {
  const fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// A short hash of a file's bytes: whether the picture behind an icon has
// changed since it was copied.
export async function fileHash(file: string): Promise<string | undefined> {
  // Read once, from the open file that was checked, never more than
  // MAX_FILE_BYTES however the file changes under it.
  const bytes = await readIconFile(file);
  return bytes && crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 10);
}

// Copies a picture into `dir` as `<projectId>-<hash>`, as a PNG of at most
// ICON_PX (images.ts; an .icns or a 1024 px app icon would otherwise be a
// megabyte for a 16 pt dot). The file is read once, checked against the
// icon budget (icon-budget.ts, which takes no SVG) and only that copy is
// converted, so a repo can't swap a bigger one in between; a picture the
// converter can't make a small PNG of isn't kept at all (never the file as
// it was, which the app would then decode whole). The project's older
// copies go.
export async function storeIcon(src: string, dir: string, projectId: string, hash: string): Promise<ImageRef> {
  await fs.promises.mkdir(dir, { recursive: true });
  const bytes = await readIconFile(src);
  if (!bytes) throw new Error(`Picture not found (or over 10 MB): ${path.basename(src)}`);
  // Only a picture by its bytes, the ones read, is converted (images.ts,
  // pictureKind): one named .png that's something else is no icon.
  if (!pictureKind(bytes.subarray(0, 32))) throw new Error(`Not a picture: ${path.basename(src)}`);
  const checked = checkIcon(bytes, path.extname(src).toLowerCase() === '.svg');
  if (!checked.ok) throw new Error(`Not taken as an icon (${checked.reason}): ${path.basename(src)}`);
  const dest = path.join(dir, `${projectId}-${hash}.png`);
  const copy = path.join(dir, `.${projectId}-${hash}-${crypto.randomBytes(6).toString('hex')}.src`);
  let ref: ImageRef;
  try {
    await fs.promises.writeFile(copy, bytes, { mode: 0o600, flag: 'wx' });
    const small = Math.max(checked.size.width, checked.size.height) <= ICON_PX;
    const made = await convertImage(copy, dest, { format: 'png', decodeLimit: { side: ICON_MAX_SIDE, pixels: ICON_MAX_PIXELS }, ...(small ? {} : { maxPx: ICON_PX }) });
    const size = made && fs.existsSync(dest) ? await imageSize(dest, '.png') : undefined;
    if (!size?.width || !size.height || Math.max(size.width, size.height) > ICON_PX) {
      await fs.promises.rm(dest, { force: true });
      throw new Error(`Could not make a ${ICON_PX} px PNG of ${path.basename(src)} (sips, or ImageMagick on Linux)`);
    }
    ref = { path: dest, mediaType: 'image/png', ...size };
  } finally {
    await fs.promises.rm(copy, { force: true });
  }
  removeIcons(dir, projectId, path.basename(ref.path));
  return ref;
}

// Whether a copy made before (storeIcon) is one this release would make: a
// PNG of at most ICON_PX. Copies from before 24 Nov 2026 could be the repo's
// file as it was, whatever its size, or an SVG; the librarian makes those
// again (or picks a symbol).
export async function storedIconOk(image: ImageRef): Promise<boolean> {
  const bytes = await readIconFile(image.path);
  if (!bytes) return false;
  const checked = checkIcon(bytes, image.mediaType === 'image/svg+xml');
  return checked.ok && checked.kind === 'png' && Math.max(checked.size.width, checked.size.height) <= ICON_PX;
}

// storedIconOk, at once, for the runner's start (projects.ts): a copy an
// older release kept is dropped before any app is sent its path.
export function storedIconOkSync(image: ImageRef): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(image.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return false;
    const bytes = Buffer.alloc(st.size);
    const got = fs.readSync(fd, bytes, 0, st.size, 0);
    const checked = checkIcon(bytes.subarray(0, got), image.mediaType === 'image/svg+xml');
    return checked.ok && checked.kind === 'png' && Math.max(checked.size.width, checked.size.height) <= ICON_PX;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The picture as the phone can show it (sync.ts): a PNG within the icon
// budget, as it is. An older copy that's anything else (an SVG, which this
// drew with Quick Look or rsvg-convert, or a repo's file as it was) isn't
// sent. Throws when the file can't be read or isn't taken.
export async function phonePicture(iconPath: string, mediaType: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) throw new Error(`the phone can't show a ${mediaType} picture`);
  const bytes = await readIconFile(iconPath);
  if (!bytes) throw new Error('Could not read the icon');
  const checked = checkIcon(bytes, false);
  if (!checked.ok) throw new Error(`the icon isn't sent to the phone (${checked.reason})`);
  if (checked.kind !== 'png') throw new Error(`the icon isn't sent to the phone (a ${checked.kind}, not a PNG)`);
  return { bytes: new Uint8Array(bytes), mediaType: 'image/png' };
}

// Takes away a project's copies, all of them or all but `keep`.
export function removeIcons(dir: string, projectId: string, keep?: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (n.startsWith(projectId + '-') && n !== keep) fs.rmSync(path.join(dir, n), { force: true });
  }
}

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The SF Symbols the librarian picks from for a project with no picture.
// A fixed list rather than any name, so a made-up one can't turn up; each
// is checked to exist on macOS 14 (the app also falls back to a letter if
// one doesn't draw).
export const SYMBOLS = [
  'app', 'macwindow', 'iphone', 'laptopcomputer', 'desktopcomputer', 'server.rack', 'terminal', 'chevron.left.forwardslash.chevron.right',
  'curlybraces', 'hammer', 'wrench.and.screwdriver', 'screwdriver', 'gearshape', 'cpu', 'memorychip', 'externaldrive', 'cloud', 'network',
  'globe', 'link', 'lock', 'key', 'shield', 'envelope', 'bubble.left.and.bubble.right', 'text.bubble', 'phone', 'video', 'film',
  'play.rectangle', 'tv', 'camera', 'photo', 'paintbrush', 'paintpalette', 'pencil', 'square.and.pencil', 'scissors', 'wand.and.stars',
  'music.note', 'waveform', 'mic', 'headphones', 'speaker.wave.2', 'antenna.radiowaves.left.and.right', 'wifi', 'book', 'books.vertical',
  'character.book.closed', 'newspaper', 'doc.text', 'folder', 'archivebox', 'tray.full', 'list.clipboard', 'checklist', 'calendar', 'clock',
  'alarm', 'timer', 'arrow.triangle.2.circlepath', 'chart.bar', 'chart.line.uptrend.xyaxis', 'dollarsign.circle', 'creditcard', 'cart',
  'bag', 'storefront', 'gift', 'house', 'house.lodge', 'building.2', 'lamp.desk', 'sofa', 'bed.double', 'chair.lounge', 'washer',
  'refrigerator', 'robotic.vacuum', 'powerplug', 'lightbulb', 'ruler', 'level', 'car', 'bicycle', 'airplane', 'sailboat', 'map',
  'mappin.and.ellipse', 'location', 'tent', 'mountain.2', 'beach.umbrella', 'figure.pool.swim', 'leaf', 'tree', 'carrot', 'drop', 'flame',
  'bolt', 'sun.max', 'moon', 'snowflake', 'cloud.rain', 'pawprint', 'dog', 'cat', 'fish', 'bird', 'ant', 'ladybug', 'teddybear', 'heart',
  'cross.case', 'pills', 'figure.walk', 'figure.run', 'dumbbell', 'sportscourt', 'gamecontroller', 'puzzlepiece', 'dice', 'theatermasks',
  'popcorn', 'party.popper', 'birthday.cake', 'fork.knife', 'frying.pan', 'cup.and.saucer', 'wineglass', 'tshirt', 'graduationcap',
  'sparkles', 'star', 'flag', 'bell', 'person', 'person.2', 'brain', 'eye', 'magnifyingglass', 'square.stack.3d.up', 'cube', 'shippingbox',
  'printer',
];
