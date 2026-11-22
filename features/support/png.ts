// Reads the PNGs the apps' `screenshot` writes (8-bit RGB or RGBA, not
// interlaced), for steps that check what was drawn.
import fs from 'node:fs';
import zlib from 'node:zlib';

export interface Picture { width: number; height: number; channels: number; data: Buffer }

export function readPng(file: string): Picture {
  const bytes = fs.readFileSync(file);
  let at = 8;
  let width = 0, height = 0, channels = 0;
  const idat: Buffer[] = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) throw new Error(`${file}: only 8-bit RGB or RGBA PNGs are read here`);
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[y * stride + x - channels] : 0;
      const b = y > 0 ? data[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? data[(y - 1) * stride + x - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[y * stride + x] = (line[x] + add) & 0xff;
    }
  }
  return { width, height, channels, data };
}

/** How many different colours are in a box of the picture, in its pixels. */
export function coloursIn(p: Picture, left: number, top: number, width: number, height: number): number {
  const seen = new Set<number>();
  for (let y = Math.max(0, top); y < Math.min(p.height, top + height); y++) {
    for (let x = Math.max(0, left); x < Math.min(p.width, left + width); x++) {
      const i = (y * p.width + x) * p.channels;
      seen.add((p.data[i] << 16) | (p.data[i + 1] << 8) | p.data[i + 2]);
    }
  }
  return seen.size;
}
