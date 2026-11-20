// The secrets folder made private on Windows, as chmod 700 makes it on a Mac
// (docs/gpui-port/runner-windows-plan.md, slice 5). There, chmod only sets
// or clears read-only, so the folder keeps what it inherits from
// %LOCALAPPDATA%, and any grant someone added to it. %LOCALAPPDATA% is
// already this user's, SYSTEM's and the Administrators' only, as Windows
// makes a profile, but a profile whose folders someone has opened up (a
// shared PC, a backup tool, a folder moved to another drive) would pass
// that on to the runner's keys.
//
// So the runner's helper (win32-helper.ps1, privateDir) replaces the
// folder's access list whole: inheriting nothing, full control for this
// user and SYSTEM (backups, the antivirus) only, passed on to everything
// in it, and every file already there made to take just that. Then it
// reads them all back. main.ts waits for it before the token is written.
//
// It keeps nothing out that runs as this user, threads included: the
// secrets guard and the RPC's check of the caller are for that.

import fs from 'node:fs';
import { win32Helper } from './win32-helper.ts';

type Ask = (op: string, params: Record<string, string>) => Promise<string>;

// Undefined when it's done (or there's nothing to do off Windows), and why
// not otherwise. Makes the folder if it isn't there.
export async function makePrivate(dir: string, deps: { ask?: Ask; platform?: NodeJS.Platform } = {}): Promise<string | undefined> {
  if ((deps.platform ?? process.platform) !== 'win32') return undefined;
  const ask = deps.ask ?? ((op, params) => win32Helper().ask(op, params));
  try {
    fs.mkdirSync(dir, { recursive: true });
    await ask('privateDir', { path: dir });
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}
