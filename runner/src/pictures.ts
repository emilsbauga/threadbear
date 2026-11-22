// Where a message's pictures go among its words (docs/protocol/threads.md,
// "Pictures in a message"). `[Picture N]` stands for images[N-1], and the
// picture goes straight after the first marker naming it, so "this
// [Picture 1] next to this [Picture 2]" reaches the agent with each
// picture where Mike pasted it. Pictures no marker names go first, as
// every picture did before markers (the phone's, an ask box's).
import type { ImageRef } from './protocol.ts';

export type MessagePart = { text: string } | { image: ImageRef };

const MARKER = /\[Picture (\d{1,3})\]/g;

export function placePictures(text: string, images: ImageRef[]): MessagePart[] {
  const cuts = pictureCuts(text, images.length);
  const placed = new Set(cuts.map((c) => c.index));
  const parts: MessagePart[] = [];
  images.forEach((image, i) => {
    if (!placed.has(i)) parts.push({ image });
  });
  let from = 0;
  for (const cut of cuts) {
    pushWords(parts, text.slice(from, cut.at));
    parts.push({ image: images[cut.index] });
    from = cut.at;
  }
  pushWords(parts, text.slice(from));
  return parts;
}

// Where each of `count` pictures goes: just after the first marker naming
// it, in the order the markers come. A marker naming no picture, or one
// already placed, is just words.
function pictureCuts(text: string, count: number): { at: number; index: number }[] {
  const placed = new Set<number>();
  const cuts: { at: number; index: number }[] = [];
  for (const m of text.matchAll(MARKER)) {
    const index = Number(m[1]) - 1;
    if (index < 0 || index >= count || placed.has(index)) continue;
    placed.add(index);
    cuts.push({ at: m.index + m[0].length, index });
  }
  return cuts;
}

// How many of a message's `count` pictures no marker places: the ones that
// go before the words.
export function unplacedPictures(text: string, count: number): number {
  return count - pictureCuts(text, count).length;
}

// The line a mirrored message ends with for the pictures no marker places
// (sync.ts toMessageDoc): "[1 picture]", "[3 pictures]".
// Only those it writes: never "[0 pictures]", "[1 pictures]" or a leading
// zero, which were typed (Codex's second review, 18 Nov).
const COUNT_LINE = /(?:^|\n\n)\[(?:1 picture|([2-9]|[1-9]\d{1,2}) pictures)\]$/;

/**
 * What a mirrored message's words say of its pictures, for a reader that
 * has only the words (relay.ts, a row from a runner from before API 87,
 * which doesn't say its count): how many it came
 * with, and the words without the line counting the unplaced ones. Words
 * alone can't tell a typed "[Picture 1]" from a picture, so this is the
 * most that fits: the count c for which the unplaced ones plus the markers
 * naming 1 to c come to c, largest first. One always does, as each marker
 * adds at most one going up.
 */
export function picturesSaid(text: string): { count: number; words: string } {
  const line = COUNT_LINE.exec(text);
  const unplaced = line ? Number(line[1] ?? 1) : 0;
  const words = line ? text.slice(0, line.index) : text;
  const named = [...new Set([...words.matchAll(MARKER)].map((m) => Number(m[1])))];
  for (let count = unplaced + named.length; count > unplaced; count--) {
    if (unplaced + named.filter((n) => n >= 1 && n <= count).length === count) return { count, words };
  }
  return { count: unplaced, words };
}

/**
 * A mirrored message's words without the line the owning runner added for
 * its `count` pictures (a row that says its count, API 87). Only that line:
 * one whose number isn't how many of `count` no marker places was typed,
 * not added, and stays.
 */
export function withoutCountLine(text: string, count: number): string {
  const line = COUNT_LINE.exec(text);
  if (!line) return text;
  const words = text.slice(0, line.index);
  return Number(line[1] ?? 1) === unplacedPictures(words, count) ? words : text;
}

// The Claude API turns down a text block of nothing but whitespace, as
// between two pictures pasted one after the other.
function pushWords(parts: MessagePart[], text: string): void {
  if (text.trim()) parts.push({ text });
}
