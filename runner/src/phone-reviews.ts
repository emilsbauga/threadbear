// A design review for the phone (docs/protocol/events.md, "Reviews on the phone"):
// its words, choices and notes, with each still named by an opaque source
// instead of its path on this Mac. Nothing path-like goes: not the option's
// files, its live url, nor the pictures pasted into a draft on the Mac
// (ReviewDraft.images, which are absolute paths).
//
// Stills go up only once the phone opens a review (reviewStills, from the
// designReviews command in sync.ts), not as reviews are made, so a review
// nobody reads on the phone never leaves the Mac.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DesignReview, ReviewDraft } from './protocol.ts';
import { convertImage } from './images.ts';
import { readShareImage, shrinkWouldDo } from './share-images.ts';

export function reviewImageSource(reviewId: string, imagePath: string): string {
  return `review:${reviewId}:${crypto.createHash('sha256').update(imagePath).digest('hex')}`;
}

// Every shot's still, as its option lists them.
function shotsOf(option: DesignReview['options'][number]) {
  return option.shots ?? [{ image: option.image }];
}

// What the phone may see of a draft: the picks, notes and reply. Not its
// pictures, which are local paths; an answer from the phone keeps the ones
// saved on the Mac (withSavedImages in runner/reviews.ts).
export function phoneDraft(d: ReviewDraft) {
  return {
    notes: d.notes ?? {},
    ...(d.pickedId !== undefined ? { pickedId: d.pickedId } : {}),
    ...(d.pickedIds ? { pickedIds: d.pickedIds } : {}),
    ...(d.reply !== undefined ? { reply: d.reply } : {}),
    ...(d.none ? { none: true as const } : {}),
  };
}

// noPreview: sources whose still can't go to the phone (gone, or not a
// picture even after shrinking), so it says so rather than waiting.
export function phoneReview(review: DesignReview, noPreview: ReadonlySet<string> = new Set()) {
  return {
    id: review.id, title: review.title, status: review.status, revision: review.revision,
    ...(review.note ? { note: review.note } : {}),
    ...(review.recommended ? { recommended: review.recommended } : {}),
    draft: phoneDraft(review.response ?? review.draft),
    options: review.options.map((option) => ({
      id: option.id, title: option.title,
      ...(option.note ? { note: option.note } : {}),
      ...(option.reference ? { reference: true } : {}),
      shots: shotsOf(option).map((shot) => {
        const src = reviewImageSource(review.id, shot.image.path);
        return {
          src,
          ...(shot.title ? { title: shot.title } : {}),
          kind: shot.media?.mediaType === 'text/html' ? 'page' : shot.media?.mediaType.startsWith('audio/') ? 'audio' : shot.media ? 'video' : 'image',
          ...(noPreview.has(src) ? { preview: false } : {}),
        };
      }),
    })),
  };
}

// An answer from the phone, as the runner takes it. Built field by field
// from what was checked, so nothing else (pictures above all, which would
// name files on this Mac) comes in with it. Notes come as a list: an option
// id can be any text, and Convex refuses an object key that isn't plain
// ASCII or starts with "$".
export function draftFromPhone(raw: unknown): ReviewDraft {
  const bad = () => new Error('Invalid review answer.');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad();
  const r = raw as Record<string, unknown>;
  const notes: Record<string, string> = {};
  if (!Array.isArray(r.notes)) throw bad();
  for (const n of r.notes) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || typeof n.text !== 'string') throw bad();
    // Object.create(null)-safe: an id of "__proto__" still lands as a key.
    Object.defineProperty(notes, n.id, { value: n.text, enumerable: true, writable: true, configurable: true });
  }
  const out: ReviewDraft = { notes };
  if (r.pickedId !== undefined) {
    if (typeof r.pickedId !== 'string') throw bad();
    out.pickedId = r.pickedId;
  }
  if (r.pickedIds !== undefined) {
    if (!Array.isArray(r.pickedIds) || !r.pickedIds.every((id) => typeof id === 'string')) throw bad();
    out.pickedIds = r.pickedIds as string[];
  }
  if (r.reply !== undefined) {
    if (typeof r.reply !== 'string') throw bad();
    out.reply = r.reply;
  }
  if (r.none === true) out.none = true;
  return out;
}

// Longest side of a still shrunk for the phone: plenty for its screen.
const PHONE_STILL_PX = 2400;

// read: the file to send; within: the folder it must be in when it's read
// (readShareImage: no links, nothing outside). The row in Convex is named by
// src alone, never the path.
export type ReviewStill = { src: string; read: string; within: string };

// A review's stills ready to go up, and the ones that can't. Only files in
// the review's own media folder (`<thread media>/reviews/<id>`, where
// createReview copies them), not links, go: a review that came across in a
// move names paths that runner chose, so a path alone proves nothing. A still
// over the reply-picture limit (10 MB; a review takes 25) or in a format the
// phone doesn't take is shrunk to a JPEG in a `phone` folder beside it once,
// and that copy goes instead.
export async function reviewStills(review: DesignReview, threadMedia: string | undefined): Promise<{ stills: ReviewStill[]; noPreview: Set<string> }> {
  const stills: ReviewStill[] = [];
  const noPreview = new Set<string>();
  const seen = new Set<string>();
  const within = threadMedia && /^[a-zA-Z0-9-]{1,200}$/.test(review.id) ? path.join(threadMedia, 'reviews', review.id) : undefined;
  for (const option of review.options) {
    for (const shot of shotsOf(option)) {
      const file = shot.image.path;
      const src = reviewImageSource(review.id, file);
      if (seen.has(src)) continue;
      seen.add(src);
      const ready = within ? await phoneStill(file, within) : undefined;
      if (ready) stills.push({ src, read: ready, within: within! });
      else noPreview.add(src);
    }
  }
  return { stills, noPreview };
}

// Nothing here throws: a failure is only "no preview", as an error's text
// would name a path on this Mac and go to the phone as the command's note.
async function phoneStill(file: string, within: string): Promise<string | undefined> {
  try {
    return await shrunkStill(file, within);
  } catch {
    return undefined;
  }
}

async function shrunkStill(file: string, within: string): Promise<string | undefined> {
  const first = readShareImage(file, within);
  if (!('skip' in first)) return file;
  if (!shrinkWouldDo(first.skip)) return undefined;
  // Named for the still's whole path, so a.png and a.webp never share one.
  const small = path.join(within, 'phone', `${crypto.createHash('sha256').update(file).digest('hex').slice(0, 16)}-${path.basename(file)}.jpg`);
  if (!fs.existsSync(small)) {
    fs.mkdirSync(path.dirname(small), { recursive: true });
    // The converter gets a copy read through the checked file's own
    // descriptor, never the name again: the file swapped for a link in
    // between would otherwise hand it a picture from anywhere.
    const copy = `${small}.source`;
    const part = `${small}.part.jpg`;
    try {
      if (!copyChecked(file, within, copy)) return undefined;
      // Made aside and renamed, so one cut short never passes for the still.
      if (!(await convertImage(copy, part, { format: 'jpeg', quality: 80, maxPx: PHONE_STILL_PX }))) return undefined;
      fs.renameSync(part, small);
    } finally {
      fs.rmSync(copy, { force: true });
      fs.rmSync(part, { force: true });
    }
  }
  return 'skip' in readShareImage(small, within) ? undefined : small;
}

// A review takes stills up to 25 MB; a little room over that.
const STILL_MAX_BYTES = 30 * 1024 * 1024;

// Copies `file` to `to` if it's a plain file inside `within` (by its real
// path), opened without following a link and read through that descriptor.
function copyChecked(file: string, within: string, to: string): boolean {
  const real = fs.realpathSync(file);
  const rel = path.relative(fs.realpathSync(within), real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    const atReal = fs.statSync(real);
    if (!st.isFile() || st.size > STILL_MAX_BYTES || st.ino !== atReal.ino || st.dev !== atReal.dev) return false;
    const bytes = Buffer.alloc(st.size);
    let got = 0;
    while (got < bytes.length) {
      const n = fs.readSync(fd, bytes, got, bytes.length - got, got);
      if (n === 0) break;
      got += n;
    }
    fs.rmSync(to, { force: true }); // one left by a run that stopped partway
    fs.writeFileSync(to, bytes.subarray(0, got), { flag: 'wx' });
    return true;
  } finally {
    fs.closeSync(fd);
  }
}
