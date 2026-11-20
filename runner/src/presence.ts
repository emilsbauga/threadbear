// Whether Mike is at this Mac: the Mac app is connected and he's used the
// keyboard or mouse in the last AT_MAC_IDLE_MS. The phone only buzzes while
// he isn't (docs/convex-backend.md, "Notifications and presence"), so a
// thread needing him while he's at his desk shows on the Mac alone, and
// reaches his phone if he walks away without seeing to it.
import { execFile } from 'node:child_process';
import { win32Helper } from './win32-helper.ts';

export const AT_MAC_IDLE_MS = 2 * 60_000;

// Time since the last keyboard or mouse event, from IOKit's HIDIdleTime
// (nanoseconds). Undefined if it can't be read. Asynchronous: ioreg walks
// the IORegistry, which takes a second or two on a Mac busy rendering, and
// a synchronous run froze the whole runner for that long every 15 seconds.
// On Windows the runner's helper asks GetLastInputInfo, for the session the
// runner runs in (win32-helper.ps1, idle).
export function hidIdleMs(): Promise<number | undefined> {
  if (process.platform === 'win32') return win32Helper().ask('idle').then(parseIdle, () => undefined);
  // IOKit is a Mac's; a Linux runner has no idle time to read.
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'], { encoding: 'utf8', timeout: 5000 }, (_err, stdout) => {
      const ns = stdout?.match(/"HIDIdleTime" = (\d+)/)?.[1];
      resolve(ns === undefined ? undefined : Number(ns) / 1_000_000);
    });
  });
}

// Whether this user's screen is locked, or their session isn't the one on
// the console (another user's, or the login window), from IOKit's console
// sessions. A Touch ID prompt can't show there, and over the lock screen
// the Secure Enclave's SSH provider hands back an empty signature as if it
// had signed (release/2026-11-19, signed eight minutes after the screen
// saver locked the Mac while HIDIdleTime still said someone was there).
// False off a Mac, or when it can't be read: the release's own check
// (upstream.ts selfCheck) still stops a bad signature.
export function screenLocked(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    // The plist, as JSON: a name with braces in it can't upset a parse.
    execFile('/bin/sh', ['-c', '/usr/sbin/ioreg -a -n Root -d 1 -k IOConsoleUsers | /usr/bin/plutil -convert json -o - -'], { encoding: 'utf8', timeout: 5000 }, (_err, stdout) => {
      resolve(parseScreenLocked(stdout ?? '', process.getuid?.() ?? -1));
    });
  });
}

// Root's properties as JSON (above): locked unless `uid` has the console
// session and it isn't locked; false when there's no session list to read.
export function parseScreenLocked(json: string, uid: number): boolean {
  let users: unknown;
  try {
    // Root's dictionary, or (some ioreg versions) an array holding it.
    const parsed = JSON.parse(json) as unknown;
    const root = (Array.isArray(parsed) ? parsed[0] : parsed) as { IOConsoleUsers?: unknown } | undefined;
    users = root?.IOConsoleUsers;
  } catch {
    return false;
  }
  if (!Array.isArray(users)) return false;
  const mine = (users as Record<string, unknown>[]).find((u) => u?.kCGSSessionUserIDKey === uid && u?.kCGSSessionOnConsoleKey === true);
  return !mine || mine.CGSSessionScreenIsLocked === true;
}

export function isAtMac(appConnected: boolean, idleMs: number | undefined): boolean {
  return appConnected && idleMs !== undefined && idleMs < AT_MAC_IDLE_MS;
}

// The helper's answer to idle: whole milliseconds, or undefined.
export function parseIdle(text: string): number | undefined {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined;
}
