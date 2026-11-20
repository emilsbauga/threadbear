// A path with an 8.3 short alias, for the tests that need two spellings of one
// folder. GitHub's Windows runners spell TEMP that way (C:\Users\RUNNER~1) and
// a profile folder longer than eight characters can turn up in a cwd, while
// git and the product's own code give the long form. Only Windows has them,
// and only a volume with 8.3 names switched on makes one; a test that needs
// one says why it didn't run when there isn't.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './fakes.ts';

export const IS_WINDOWS = process.platform === 'win32';

export const NO_SHORT_NAMES = 'This volume has 8.3 short names switched off, so there is no second spelling of a folder to test with';

// The 8.3 form of an existing path (every part of it that has one), or
// undefined when it has none: Scripting.FileSystemObject is what Windows
// itself answers with.
export function shortPathOf(p: string): string | undefined {
  if (!IS_WINDOWS) return undefined;
  const kind = fs.statSync(p).isDirectory() ? 'GetFolder' : 'GetFile';
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).${kind}('${p.replace(/'/g, "''")}').ShortPath`],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    return out && out.toLowerCase() !== p.toLowerCase() && out.includes('~') ? out : undefined;
  } catch {
    return undefined;
  }
}

// A new folder under `root` whose name is long enough to have an alias, with
// both spellings: `long` as the disk has it, `short` as 8.3. Undefined off
// Windows, or where the volume makes no short names.
export function aliasedDir(root: string = tmpDir()): { long: string; short: string } | undefined {
  if (!IS_WINDOWS) return undefined;
  const long = path.join(root, 'a_directory_with_a_long_name');
  fs.mkdirSync(long, { recursive: true });
  const short = shortPathOf(long);
  return short ? { long, short } : undefined;
}
