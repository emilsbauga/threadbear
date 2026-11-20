// presence: whether Mike is at this Mac, and whether its screen is locked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAtMac, parseScreenLocked } from '../../src/presence.ts';

test('isAtMac: the app connected and input in the last two minutes', () => {
  assert.equal(isAtMac(true, 1000), true);
  assert.equal(isAtMac(false, 1000), false);
  assert.equal(isAtMac(true, 3 * 60_000), false);
  assert.equal(isAtMac(true, undefined), false);
});

// release/2026-11-19 was signed over the lock screen, where the Secure
// Enclave hands back an empty signature: release signing waits for this.
test("parseScreenLocked: this user's console session, from ioreg's plist as JSON", () => {
  const of = (...users: Record<string, unknown>[]) => JSON.stringify({ IOConsoleLocked: false, IOConsoleUsers: users });
  const me = { kCGSSessionUserIDKey: 501, kCGSSessionOnConsoleKey: true, kCGSessionLongUserNameKey: 'Mike {Cann}' };
  assert.equal(parseScreenLocked(of({ ...me, CGSSessionScreenIsLocked: true }), 501), true);
  assert.equal(parseScreenLocked(of(me), 501), false);
  assert.equal(parseScreenLocked(of({ kCGSSessionUserIDKey: 502, kCGSSessionOnConsoleKey: false, CGSSessionScreenIsLocked: true }, me), 501), false, "another user's locked session isn't this one");
  assert.equal(parseScreenLocked(of({ ...me, kCGSSessionOnConsoleKey: false }, { kCGSSessionUserIDKey: 502, kCGSSessionOnConsoleKey: true }), 501), true, 'switched to another user');
  assert.equal(parseScreenLocked(of(), 501), true, 'the login window');
  assert.equal(parseScreenLocked(of(me), 50), true, 'uid 50 is not 501');
  assert.equal(parseScreenLocked(JSON.stringify([JSON.parse(of({ ...me, CGSSessionScreenIsLocked: true }))]), 501), true, 'Root inside an array');
  assert.equal(parseScreenLocked('', 501), false, "can't read it");
  assert.equal(parseScreenLocked('{}', 501), false);
});
