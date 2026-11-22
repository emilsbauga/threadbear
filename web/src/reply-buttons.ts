// Reply buttons (docs/protocol/events.md, "Reply buttons"): a reply's
// [title](button:<id>) link drawn as a button that starts a thread with a
// brief the agent wrote, or sends a message to a thread. The part with no
// React or Convex in it, so it can be tested alone:
// node --test web/src/reply-buttons.test.ts
import type { CommandState } from './command.ts';

// As a message row carries it (convex/schema.ts messageButton).
export type MessageButton = { id: string; title: string; kind: 'start' | 'send'; target?: string; pressedThreadId?: string; failed?: string };

export type ButtonLook =
  | { kind: 'ready'; tip: string }
  | { kind: 'pressing'; tip: string }
  // Still on its way but nothing heard in a while: no spinner, still locked.
  | { kind: 'slow'; tip: string }
  | { kind: 'pressed'; threadId?: string; tip: string }
  | { kind: 'failed'; error: string; tip: string };

// What the button shows: the row's state, with this page's own press on top
// until the row catches up (a row outside the live tail never does).
// press: what this page's own press is doing (command.ts).
export function buttonLook(b: MessageButton, press: CommandState<unknown>): ButtonLook {
  const where = b.kind === 'start' ? `Starts a thread${b.target ? ` in ${b.target}` : ''}` : `Sends a message${b.target ? ` to "${b.target}"` : ''}`;
  if (b.pressedThreadId) return { kind: 'pressed', threadId: b.pressedThreadId, tip: b.kind === 'start' ? 'Pressed. Opens the thread it started.' : 'Pressed. Opens the thread it messaged.' };
  if (press.kind === 'done') return { kind: 'pressed', threadId: press.threadId, tip: 'Pressed.' };
  if (press.kind === 'sending') return { kind: 'pressing', tip: 'Sending' };
  if (press.kind === 'waiting') return { kind: 'pressing', tip: press.taken ? 'Sent to the Mac' : 'Waiting for the Mac to pick this up' };
  if (press.kind === 'slow') return { kind: 'slow', tip: !press.id ? 'Still trying to reach the server' : press.taken ? 'The Mac has this but hasn’t said how it went yet' : 'The Mac hasn’t picked this up yet' };
  const error = press.kind === 'failed' ? press.error : b.failed;
  if (error) return { kind: 'failed', error, tip: `Didn't work: ${error}. Press to try again.` };
  return { kind: 'ready', tip: where };
}
