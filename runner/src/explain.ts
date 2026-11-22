// Explain (docs/protocol/settings.md, "Explain"): Mike selects a few words in a
// thread's transcript and asks what they mean. It's a little side
// conversation with the small model about that thread, a mini fork: the
// model is shown the selection, the message it came from and the last few
// messages, and its answer goes back to the app alone. Nothing is written
// to the thread, so the agent never sees it and its context doesn't grow.

export type ExplainTurn = { question?: string; answer: string };

export type ExplainInput = {
  selection: string;
  // The whole message the selection came from, when the app knows it.
  message?: string;
  first?: string;
  recent: { who: 'user' | 'assistant'; text: string }[];
  // Earlier answers in this side conversation, then the follow-up asked
  // now (none for the first look).
  earlier: ExplainTurn[];
  question?: string;
};

// Long enough for a selection out of a long reply; a whole page of code
// selected is cut, the start is what it's about.
export const SELECTION_CHARS = 2_000;
export const MESSAGE_CHARS = 6_000;
export const RECENT_MESSAGES = 8;
export const RECENT_CHARS = 1_500;
// Follow-ups kept: the last few are enough for "and what about…".
export const EARLIER_KEPT = 6;

export const EXPLAIN_SYSTEM = [
  "You explain things in a conversation between the user and their coding agent. The user has selected some words in it that they don't follow and wants them explained.",
  'Explain what the selected words mean here, in this conversation: what they refer to, and why they matter to what the agent is doing. Use the conversation to be specific, rather than giving a dictionary definition.',
  "Write plainly, like a colleague explaining over a coffee. Start with the answer itself, with no preamble and no restating the question. Keep it short: a few sentences, or a short list if there are several parts. Use Markdown only for lists, code and file names. Don't use em dashes.",
  "If the conversation doesn't say enough to know, say what it most likely means and that you're not sure.",
].join('\n\n');

const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n) + '…' : t);

export function explainPrompt(input: ExplainInput): string {
  const parts: string[] = [];
  if (input.first) parts.push(`How the conversation started (the user):\n${input.first}`);
  if (input.recent.length) {
    const lines = input.recent.map((m) => `${m.who === 'user' ? 'User' : 'Agent'}: ${m.text}`);
    parts.push(`The latest messages:\n\n${lines.join('\n\n')}`);
  }
  if (input.message) parts.push(`The message the user selected from:\n${cut(input.message, MESSAGE_CHARS)}`);
  parts.push(`What the user selected:\n"${cut(input.selection.trim(), SELECTION_CHARS)}"`);
  const earlier = input.earlier.slice(-EARLIER_KEPT);
  if (earlier.length) {
    const said = earlier.map((t, i) => (i === 0 && !t.question ? `You explained:\n${t.answer}` : `The user asked: ${t.question ?? ''}\nYou answered:\n${t.answer}`));
    parts.push(said.join('\n\n'));
  }
  parts.push(input.question ? `The user now asks: ${input.question}` : 'Explain what the user selected.');
  return parts.join('\n\n---\n\n');
}
