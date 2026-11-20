// Box mode's patch loader (patches.ts isolatePatchCode): run as a child
// process of its own, it imports one patch file (from the bytes its trust
// hash was made from, when it has one, as the runner would), reads it as
// the runner does, and sends what's static in it as one line of JSON on fd 3,
// then exits.
// Nothing the patch's code starts outlives it.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readPatchModule, staticPatch } from './patches.ts';
import { verifiedUrl } from './verified-imports.ts';

type Input = {
  id: string;
  source: 'home' | 'project';
  file: string;
  mtimeMs: number;
  verified?: { hash: string; root: string; code: [string, string][]; edges: [string, [string, string][]][] };
};

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const p = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Input;
let out: unknown;
try {
  const url = p.verified
    ? verifiedUrl(
        p.verified.root,
        p.verified.hash,
        new Map(p.verified.code.map(([f, b]) => [f, Buffer.from(b, 'base64')])),
        new Map(p.verified.edges.map(([f, m]) => [f, new Map(m)])),
      )
    : `${pathToFileURL(p.file).href}?mtime=${p.mtimeMs}`;
  const mod = (await import(url)) as { default?: unknown };
  out = staticPatch(readPatchModule(p.id, p.source, p.file, mod.default));
} catch (e) {
  out = { info: { id: p.id, source: p.source, file: p.file, error: String((e as Error)?.message ?? e).split('\n')[0] }, panels: [], actions: [], hooks: [] };
}
// On fd 3, the reply's own channel (patches.ts loadInChild): stdout and
// stderr are the patch's, and thrown away.
fs.createWriteStream('', { fd: 3 }).end(JSON.stringify(out) + '\n', () => process.exit(0));
