// tb patch-check <file>: loads a patch file in tb's own process, as the
// runner would, and says what's wrong with it now, rather than after the
// runner reads the folder again (docs/protocol/patches.md). Loading runs
// the file's top-level code, as the runner's import does, but none of its
// commands or functions, and it skips the trust check: a project's patch
// still waits to be trusted in the app.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPatchModule } from './patches.ts';

export type PatchCheck = { file: string; error?: string; ids: string[] };

export async function checkPatchFile(file: string): Promise<PatchCheck> {
  const full = path.resolve(file);
  const id = path.basename(full, path.extname(full));
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(full).mtimeMs;
  } catch {
    return { file: full, error: `can't read ${full}`, ids: [] };
  }
  try {
    // The query loads the file again after an edit, as the runner's does.
    const mod = (await import(`${pathToFileURL(full).href}?mtime=${mtimeMs}`)) as { default?: unknown };
    const loaded = readPatchModule(id, 'home', full, mod.default);
    if (loaded.info.error) return { file: full, error: loaded.info.error, ids: [] };
    return { file: full, ids: [...loaded.actions, ...loaded.panels, ...loaded.hooks].map((x) => x.id) };
  } catch (e) {
    return { file: full, error: (e instanceof Error ? e.message : String(e)).split('\n')[0], ids: [] };
  }
}

export async function patchCheckCommand(files: string[], json: boolean): Promise<number> {
  if (!files.length) {
    console.error('Which file? tb patch-check <file.ts>...');
    return 1;
  }
  const results: PatchCheck[] = [];
  for (const f of files) results.push(await checkPatchFile(f));
  if (json) console.log(JSON.stringify(results, null, 2));
  else for (const r of results) console.log(r.error ? `${r.file}: ERROR ${r.error}` : `${r.file}: ok (${r.ids.join(', ') || 'nothing in it'})`);
  return results.some((r) => r.error) ? 1 : 0;
}
