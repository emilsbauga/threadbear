// How big a project icon may say it is before anything decodes it
// (docs/protocol/projects.md, "Icons"). Icons come from repos the librarian
// looks through by itself, so a small file that says it's 60,000 px square
// (a PNG's header is all it takes, the pixels compress to nothing) would have
// sips, ImageMagick or the desktop app allocate gigabytes to draw it (Daybreak,
// 24 Nov: "Automatically selected project icons are decoded without a pixel
// allocation bound"). Every picture an icon file holds is read from its own
// structure here, without decoding it, and an icon whose size can't be told
// for sure, that moves, that has anything a reader here doesn't follow, or
// that's over the budget is no icon at all. Only the kinds a project's icon
// most often comes in are taken, each read strictly: PNG, ICO and ICNS. The
// fix's cross-lab review found JPEG's and WebP's headers too loose to vouch
// for what a decoder would make of them, and an SVG is a program for its
// renderer rather than a size: three rounds each found a new way past a
// check of SVG text (a picture inside it, CDATA, a namespace prefix, CSS
// sizing, a <use> or mask fan-out, a declared encoding), so SVG isn't taken
// until it can be checked with a real parser. The desktop app holds its
// decode of one to the same numbers (desktop/gpui/src/projects_page.rs).
import zlib from 'node:zlib';
import { pictureKind, type PictureKind } from './images.ts';

export const ICON_MAX_SIDE = 4096;
export const ICON_MAX_PIXELS = ICON_MAX_SIDE * ICON_MAX_SIDE;
// What every picture in the file decodes to, in bytes, at its own depth: a
// 4096 px square at 8 bits RGBA, no more.
export const ICON_MAX_BYTES = ICON_MAX_PIXELS * 4;
// Pictures in one .ico or .icns (a full macOS set is ten).
export const ICON_MAX_FRAMES = 32;
// What a PNG's compressed text and colour profile may inflate to, each and in all.
const PNG_INFLATED_MAX = 1024 * 1024;
const PNG_INFLATED_TOTAL = 2 * 1024 * 1024;

type Picture = { width: number; height: number; bytes: number };
export type Size = { width: number; height: number };
export type IconCheck = { ok: true; kind: PictureKind; size: Size } | { ok: false; reason: string };

const ICON_KINDS = new Set<PictureKind>(['png', 'ico', 'icns']);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class Refused extends Error {}
const refuse = (reason: string): never => {
  throw new Refused(reason);
};

// Whether a file's bytes make an icon within the budget, and its biggest
// picture's size. `svg` says the file is meant as an SVG (by its name),
// which isn't taken.
export function checkIcon(bytes: Buffer, svg: boolean): IconCheck {
  try {
    if (svg) refuse("an SVG isn't taken as an icon");
    const kind = pictureKind(bytes.subarray(0, 32));
    if (!kind) return refuse('not a picture');
    if (!ICON_KINDS.has(kind)) return refuse(`a ${kind} isn't taken as an icon`);
    const pictures = kind === 'png' ? [png(bytes)] : kind === 'ico' ? ico(bytes) : icns(bytes);
    if (pictures.length === 0) refuse('no picture in it');
    if (pictures.length > ICON_MAX_FRAMES) refuse(`${pictures.length} pictures in one file`);
    let pixels = 0;
    let decoded = 0;
    let biggest: Picture = { width: 0, height: 0, bytes: 0 };
    for (const p of pictures) {
      if (!(p.width > 0 && p.height > 0)) refuse('a picture with no size');
      if (p.width > ICON_MAX_SIDE || p.height > ICON_MAX_SIDE) refuse(`${p.width} x ${p.height} px is over ${ICON_MAX_SIDE} px a side`);
      pixels += p.width * p.height;
      decoded += p.bytes;
      if (p.width * p.height > biggest.width * biggest.height) biggest = p;
    }
    if (pixels > ICON_MAX_PIXELS) refuse(`${pixels} px in all is over ${ICON_MAX_PIXELS}`);
    if (decoded > ICON_MAX_BYTES) refuse(`${decoded} bytes decoded is over ${ICON_MAX_BYTES}`);
    return { ok: true, kind, size: { width: biggest.width, height: biggest.height } };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.message };
    return { ok: false, reason: "its structure can't be read" };
  }
}

// ---------------------------------------------------------------- PNG

// Channels per colour type (PNG spec 11.2.2), and the bit depths each allows.
const PNG_TYPES: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

// A whole PNG, chunk by chunk to IEND: IHDR first and well formed, every
// chunk inside the file, no animation chunks anywhere (APNG), and compressed
// text and colour profiles inflated here, within a small limit, so one can't
// be a bomb of its own. Its decoded size counts its depth (16 bits a channel
// is twice 8), and anything narrower as the RGBA a decoder expands it to.
function png(buf: Buffer): Picture {
  if (buf.length < 8 + 25 || !buf.subarray(0, 8).equals(PNG_SIG)) refuse('not a PNG');
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') refuse('its header chunk is malformed');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24]!;
  const type = PNG_TYPES[buf[25]!];
  if (!type || !type.depths.includes(depth) || buf[26] !== 0 || buf[27] !== 0 || buf[28]! > 1) refuse('its header has values no PNG has');
  if (width > ICON_MAX_SIDE || height > ICON_MAX_SIDE) refuse(`${width} x ${height} px is over ${ICON_MAX_SIDE} px a side`);
  let at = 8;
  let inflated = 0;
  let sawData = false;
  for (;;) {
    if (at + 12 > buf.length) refuse('it ends before IEND');
    const len = buf.readUInt32BE(at);
    const name = buf.toString('latin1', at + 4, at + 8);
    if (len > buf.length - at - 12) refuse(`its ${name} chunk runs past the end`);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (name === 'acTL' || name === 'fcTL' || name === 'fdAT') refuse('it moves (APNG)');
    if (name === 'IDAT') sawData = true;
    if (name === 'zTXt' || name === 'iCCP' || name === 'iTXt') {
      const n = inflatedSize(name, data);
      if (n > PNG_INFLATED_MAX) refuse(`its ${name} chunk inflates past ${PNG_INFLATED_MAX} bytes`);
      inflated += n;
      if (inflated > PNG_INFLATED_TOTAL) refuse('its compressed text inflates too far in all');
    }
    at += 12 + len;
    if (name === 'IEND') break;
  }
  if (!sawData) refuse('no image data');
  // 8 bytes a pixel for 16-bit RGBA; anything narrower is decoded to RGBA.
  const bytesPerPixel = Math.max(4, (type!.channels * depth) / 8);
  return { width, height, bytes: width * height * bytesPerPixel };
}

// What a compressed chunk inflates to, stopping just past the limit.
function inflatedSize(name: string, data: Buffer): number {
  const keywordEnd = data.indexOf(0);
  if (keywordEnd < 1 || keywordEnd > 79) refuse(`its ${name} chunk is malformed`);
  let compressed: Buffer;
  if (name === 'iTXt') {
    if (data[keywordEnd + 1] !== 1) return 0; // not compressed
    // keyword\0 flag method language\0 translated keyword\0 text
    const lang = data.indexOf(0, keywordEnd + 3);
    const translated = lang < 0 ? -1 : data.indexOf(0, lang + 1);
    if (translated < 0) refuse('its iTXt chunk is malformed');
    compressed = data.subarray(translated + 1);
  } else {
    compressed = data.subarray(keywordEnd + 2);
  }
  try {
    return zlib.inflateSync(compressed, { maxOutputLength: PNG_INFLATED_MAX + 1 }).length;
  } catch {
    return refuse(`its ${name} chunk doesn't inflate within ${PNG_INFLATED_MAX} bytes`);
  }
}

// ---------------------------------------------------------------- ICO

// Every entry's own picture: an embedded PNG, read as above, or an
// uncompressed bitmap (its height counts the mask too, so half of it).
function ico(buf: Buffer): Picture[] {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) refuse('not an ICO');
  const count = buf.readUInt16LE(4);
  if (count === 0 || count > ICON_MAX_FRAMES || 6 + count * 16 > buf.length) refuse('its directory is malformed');
  const out: Picture[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const length = buf.readUInt32LE(entry + 8);
    const offset = buf.readUInt32LE(entry + 12);
    if (length < 40 || offset < 6 + count * 16 || offset > buf.length || length > buf.length - offset) refuse('an entry runs past the end');
    const data = buf.subarray(offset, offset + length);
    if (data.subarray(0, 8).equals(PNG_SIG)) {
      out.push(png(data));
      continue;
    }
    // BITMAPINFOHEADER or later: one plane, a depth a bitmap has, and no
    // compression (BI_RGB) or bit fields; never a JPEG or PNG inside it.
    const header = data.readUInt32LE(0);
    const width = data.readInt32LE(4);
    const doubled = data.readInt32LE(8);
    const planes = data.readUInt16LE(12);
    const bits = data.readUInt16LE(14);
    const compression = data.readUInt32LE(16);
    if (![40, 52, 56, 108, 124].includes(header) || planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bits) || (compression !== 0 && compression !== 3)) refuse('an entry is a bitmap of a kind not taken');
    if (width <= 0 || doubled <= 0 || doubled % 2 !== 0) refuse('an entry has no sensible size');
    out.push({ width, height: doubled / 2, bytes: width * (doubled / 2) * 4 });
  }
  return out;
}

// ---------------------------------------------------------------- ICNS

// An .icns's elements, the whole file and nothing past its stated end: a
// PNG read as above, the old fixed-size bitmaps and masks by their type,
// the table of contents and version skipped. A JPEG 2000 element, a nested
// set (the template, selected and dark ones, which hold elements of their
// own) or a type not named here is refused, as what's in it can't be told
// without decoding it.
const ICNS_FIXED: Record<string, number> = {
  'ICON': 32, 'ICN#': 32, 'icm#': 16, 'icm4': 16, 'icm8': 16, 'ics#': 16, 'ics4': 16, 'ics8': 16, 'is32': 16, 's8mk': 16,
  'icl4': 32, 'icl8': 32, 'il32': 32, 'l8mk': 32, 'ich#': 48, 'ich4': 48, 'ich8': 48, 'ih32': 48, 'h8mk': 48, 'it32': 128, 't8mk': 128,
};
const ICNS_ARGB: Record<string, number> = { ic04: 16, ic05: 32, icsb: 18 };
const ICNS_SKIPPED = new Set(['TOC ', 'icnV', 'name', 'info']);

function icns(buf: Buffer): Picture[] {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'icns' || buf.readUInt32BE(4) !== buf.length) refuse('not an ICNS, or not all of one');
  const out: Picture[] = [];
  let at = 8;
  let elements = 0;
  while (at < buf.length) {
    if (++elements > ICON_MAX_FRAMES * 2) refuse('too many elements');
    if (at + 8 > buf.length) refuse('an element runs past the end');
    const type = buf.toString('latin1', at, at + 4);
    const length = buf.readUInt32BE(at + 4);
    if (length < 8 || length > buf.length - at) refuse('an element runs past the end');
    const data = buf.subarray(at + 8, at + length);
    at += length;
    if (ICNS_SKIPPED.has(type)) continue;
    const argb = ICNS_ARGB[type];
    const fixed = ICNS_FIXED[type];
    if (data.subarray(0, 8).equals(PNG_SIG)) out.push(png(data));
    else if (argb && data.toString('latin1', 0, 4) === 'ARGB') out.push({ width: argb, height: argb, bytes: argb * argb * 4 });
    else if (fixed) out.push({ width: fixed, height: fixed, bytes: fixed * fixed * 4 });
    else refuse(`an element of a kind not taken (${JSON.stringify(type)})`);
  }
  return out;
}
