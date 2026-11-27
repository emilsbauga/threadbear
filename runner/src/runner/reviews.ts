// Design reviews (show_options): making, answering and recovering them (reviews.ts has the files).
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import { fitReview, keepPictureMarkers, reviewImages, reviewInput, reviewDraft, reviewReply, sameDraft, type ReviewInput } from '../reviews.ts';
import type { ImageRef } from '../protocol.ts';
import type { DesignReview, ReviewDraft, ReviewUserMark } from '../protocol.ts';
import { ErrorCode, RpcError } from '../protocol.ts';
import type { QueuedSend } from '../store.ts';
import { parkRecord } from '../place.ts';
import { copyImageInto, extForMediaType, imageRefFor, readImageInfo } from '../media.ts';
import { paths } from '../config.ts';
import { copyReviewMedia } from '../review-media.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SendOptions, ThreadState } from '../runner.ts';
import { fromMike } from './messages.ts';

export const reviewsPart = {
  createReview(this: Runner, threadId: string, raw: ReviewInput): { review: DesignReview } {
    const st = this.mustGet(threadId);
    this.checkAccepting();
    const input = reviewInput(raw, st.rec.cwd);
    const id = crypto.randomUUID();
    const dir = path.join(this.store.mediaDir(threadId), 'reviews', id);
    const now = this.isoNow();
    try {
      const options = input.options.map(({shots: sources, ...option}) => {
        const shots = sources.map(s => ({...(s.title ? {title: s.title} : {}),
          ...(s.kind && s.kind !== 'image' ? copyReviewMedia(dir, s.path, s.kind) : {image: copyImageInto(dir, s.path)}),
          ...(s.marks?.length ? {marks: s.marks} : {})}));
        // image stays the first shot for clients that show one per option
        // (a video's, sound's or page's still); shots only when there's more to say
        // than that one picture, marks included, so marks always live on a shot.
        return {...option, image: shots[0].image, ...(shots.length > 1 || shots[0].title || 'media' in shots[0] || 'marks' in shots[0] ? {shots} : {})};
      });
      const review: DesignReview = { id, title: input.title, ...(input.note ? {note: input.note} : {}), ...(input.recommended ? {recommended: input.recommended} : {}), options,
        status: 'pending', revision: 0, createdAt: now, updatedAt: now, draft: {notes: {}} };
      this.persistReview(st, review);
      return {review: structuredClone(review)};
    } catch (e) {
      // Only remove imports if the review was not committed. If an event
      // append failed after the record save, startup repairs its card.
      if (!st.rec.reviews?.some(r => r.id === id)) fs.rmSync(dir, {recursive: true, force: true});
      throw e;
    }
  },

  listReviews(this: Runner, threadId: string): { reviews: DesignReview[] } {
    return { reviews: structuredClone((this.mustGet(threadId).rec.reviews ?? [])
      .filter(review => review.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) };
  },

  // reviewId may be the start of one (8 characters or more), as an agent's
  // review: link often gives, matched among answered and cancelled reviews
  // too, so an old link still opens; only one it names alone.
  getReview(this: Runner, threadId: string, reviewId: string): { review: DesignReview } {
    const st = this.mustGet(threadId);
    const all = st.rec.reviews ?? [];
    if (!all.some(r => r.id === reviewId) && reviewId.length >= 8) {
      const starts = all.filter(r => r.id.startsWith(reviewId));
      if (starts.length === 1) return {review: structuredClone(starts[0]!)};
    }
    return {review: structuredClone(this.mustReview(st, reviewId))};
  },

  saveReview(this: Runner, threadId: string, reviewId: string, revision: number, raw: ReviewDraft): { review: DesignReview } {
    const st = this.mustGet(threadId);
    this.checkAccepting();
    const review = this.mustReview(st, reviewId);
    this.checkReviewRevision(review, revision);
    const draft = this.keepReplyImages(st, review, reviewDraft(review, withSavedImages(review, raw)));
    const next = {...review, draft, revision: review.revision + 1, updatedAt: this.isoNow()};
    this.persistReview(st, next);
    return {review: structuredClone(next)};
  },

  respondReview(this: Runner, threadId: string, reviewId: string, revision: number, raw: ReviewDraft): { review: DesignReview; turnId?: string } {
    const st = this.mustGet(threadId);
    const review = this.mustReview(st, reviewId);
    // Its pictures kept by their contents, so a retry that names the same
    // ones from inbox/ is the same answer.
    const draft = this.keepReplyImages(st, review, reviewDraft(review, withSavedImages(review, raw), true));
    // A dropped WebSocket response must not send Mike's answer twice.
    if (review.status === 'answered' && sameDraft(review.response, draft)) {
      this.kickQueue(st);
      return {review: structuredClone(review), turnId: review.replyTurnId};
    }
    this.checkAccepting();
    this.checkReviewRevision(review, revision);
    const turnId = crypto.randomUUID();
    const next: DesignReview = {...review, draft, response: draft, status: 'answered', revision: review.revision + 1, updatedAt: this.isoNow(), replyTurnId: turnId};
    const message: QueuedSend = {turnId, text: reviewReply(review, draft), images: reviewImages(draft), reviewId, reviewResponse: draft};
    // The answer and outbox live in one atomic thread.json write. Publish
    // the card only after it succeeds, then start the queued reply.
    this.persistReview(st, next, [...st.rec.queue, message], true);
    this.cli(st, { kind: 'stay' });
    this.markDirty(st);
    this.kickQueue(st);
    return {review: structuredClone(next), turnId};
  },

  // A coordinator decision accepted a message already on its way to the
  // agent. Save the review's answer without sending a second message.
  recordReviewReply(this: Runner, threadId: string, reviewId: string, reply: ReviewDraft): void {
    const st = this.mustGet(threadId);
    const review = this.mustReview(st, reviewId);
    if (review.status !== 'pending') return;
    const draft = reviewDraft(review, reply, true);
    this.persistReview(st, { ...review, draft, response: draft, status: 'answered', revision: review.revision + 1, updatedAt: this.isoNow() });
  },

  cancelReview(this: Runner, threadId: string, reviewId: string, revision: number): {review: DesignReview} {
    const st = this.mustGet(threadId);
    this.checkAccepting();
    const review = this.mustReview(st, reviewId);
    this.checkReviewRevision(review, revision);
    const next: DesignReview = {...review, status: 'cancelled', revision: review.revision + 1, updatedAt: this.isoNow()};
    this.persistReview(st, next);
    return {review: structuredClone(next)};
  },

  // Mike often answers a review by typing in the thread instead of picking
  // in the review window. Left pending, it kept the thread in Needs you
  // (even mid-turn) with nothing left to do. So his own message, from the
  // app or the phone, closes every open review as superseded; the card
  // and window stay readable. Runner, schedule and agent-to-thread
  // messages aren't him and leave reviews open.
  supersedeReviews(this: Runner, st: ThreadState, text: string, opts: SendOptions): void {
    if (!fromMike(text, opts)) return;
    for (const review of st.rec.reviews ?? []) {
      if (review.status !== 'pending' || this.coordinators?.keepsDesignReview(st.rec.id, review.id)) continue;
      this.persistReview(st, {...review, status: 'superseded', revision: review.revision + 1, updatedAt: this.isoNow()});
    }
  },

  // A reply's pictures, copied in beside the review's own (reviews/<id>/reply)
  // so a draft outlives inbox/'s week and the queued answer has them after a
  // restart. Only what media.import put in inbox/, or ones already kept here:
  // a draft's path is never a way to read some other file. Named by their
  // contents, so saving the same picture twice keeps one copy.
  // Each mark's cut-out (marks[].image) is kept the same way.
  keepReplyImages(this: Runner, st: ThreadState, review: DesignReview, draft: ReviewDraft): ReviewDraft {
    if (!draft.images?.length && !draft.marks?.some(m => m.image)) return draft;
    const dir = path.join(this.store.mediaDir(st.rec.id), 'reviews', review.id, 'reply');
    const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    const under = (file: string, folder: string) => file.startsWith(folder + path.sep);
    // Made first, so its real path is the one its copies will have (/var
    // and /private/var are one folder on a Mac).
    fs.mkdirSync(dir, {recursive: true});
    const inbox = real(paths.inbox(this.cfg.home));
    const kept = real(dir);
    const keep = (img: ImageRef): ImageRef => {
      const name = path.basename(img.path);
      let file: string;
      try {
        if (fs.lstatSync(img.path).isSymbolicLink()) throw new Error('link');
        file = fs.realpathSync(img.path);
      } catch {
        throw new RpcError(ErrorCode.badParams, `Picture not found: ${name}`);
      }
      if (under(file, kept)) return imageRefFor(file, img.mediaType);
      if (!under(file, inbox)) throw new RpcError(ErrorCode.badParams, `A reply's pictures come through media.import: ${name}`);
      const info = readImageInfo(file);
      if (!info) throw new RpcError(ErrorCode.badParams, `Not a picture that can be sent: ${name}`);
      const bytes = fs.readFileSync(file);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);
      const target = path.join(dir, `${hash}.${extForMediaType(info.mediaType)}`);
      if (!fs.existsSync(target)) {
        // Whole or not at all: a half-written copy would keep its name.
        const temp = `${target}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temp, bytes);
        fs.renameSync(temp, target);
      }
      return imageRefFor(target, info.mediaType);
    };
    return {...draft,
      ...(draft.images?.length ? {images: draft.images.map(keep)} : {}),
      ...(draft.marks?.length ? {marks: draft.marks.map(m => (m.image ? {...m, image: keep(m.image)} : m))} : {})};
  },

  // Whether a reply picture is one keepReplyImages made for this review:
  // directly in its reply folder, not a link. The review's id must be one
  // folder name, or a moved log's "../.." could point it at another
  // thread's (Codex's review, 17 Nov).
  ownReplyImage(this: Runner, st: ThreadState, reviewId: string, img: ImageRef): boolean {
    if (typeof reviewId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(reviewId) || !img || typeof img !== 'object' || typeof img.path !== 'string') return false;
    const reviewsDir = path.join(this.store.mediaDir(st.rec.id), 'reviews');
    try {
      const kept = fs.realpathSync(path.join(reviewsDir, reviewId, 'reply'));
      if (path.dirname(path.dirname(kept)) !== fs.realpathSync(reviewsDir)) return false;
      return !fs.lstatSync(img.path).isSymbolicLink() && path.dirname(fs.realpathSync(img.path)) === kept;
    } catch {
      return false;
    }
  },

  // The review with only its own reply pictures (ownReplyImage).
  // A mark whose cut-out isn't one of them stays, without it.
  ownReplyImages(this: Runner, st: ThreadState, review: DesignReview): DesignReview {
    const fitImages = (draft: ReviewDraft): ReviewDraft => {
      if (!draft.images) return draft;
      const all: unknown[] = Array.isArray(draft.images) ? draft.images : [];
      const keep = all.map(img => this.ownReplyImage(st, review.id, img as ImageRef));
      if (Array.isArray(draft.images) && keep.every(Boolean)) return draft;
      const images = all.filter((_, i) => keep[i]) as ImageRef[];
      const {images: _, ...rest} = draft;
      // The words' markers follow (keepPictureMarkers).
      const reply = typeof rest.reply === 'string' ? {reply: keepPictureMarkers(rest.reply, keep)} : {};
      return images.length ? {...rest, ...reply, images} : {...rest, ...reply};
    };
    const fit = (draft: ReviewDraft | undefined): ReviewDraft | undefined => {
      if (!draft) return draft;
      const next = fitImages(draft);
      const marks = this.ownMarkImages(st, review.id, next.marks);
      return marks === next.marks ? next : {...next, marks};
    };
    const draft = fit(review.draft)!;
    const response = fit(review.response);
    return draft === review.draft && response === review.response ? review : {...review, draft, ...(response ? {response} : {})};
  },

  // Marks with only cut-outs that are this review's own (ownReplyImage); the
  // same list when nothing changed.
  ownMarkImages(this: Runner, st: ThreadState, reviewId: string, marks: unknown): ReviewUserMark[] | undefined {
    if (!Array.isArray(marks)) return marks as ReviewUserMark[] | undefined;
    const bad = (m: unknown) => Boolean(m && typeof m === 'object' && 'image' in m && !this.ownReplyImage(st, reviewId, (m as ReviewUserMark).image as ImageRef));
    if (!marks.some(bad)) return marks as ReviewUserMark[];
    return marks.map(m => {
      if (!bad(m)) return m as ReviewUserMark;
      const {image: _, ...rest} = m as ReviewUserMark;
      return rest;
    });
  },

  mustReview(this: Runner, st: ThreadState, id: string): DesignReview {
    const review = st.rec.reviews?.find(r => r.id === id);
    if (!review) throw new RpcError(ErrorCode.badParams, `Review not found: ${id}`);
    return review;
  },

  checkReviewRevision(this: Runner, review: DesignReview, revision: number): void {
    if (review.status !== 'pending') throw new RpcError(ErrorCode.badParams, `This review is ${review.status}.`);
    if (!Number.isSafeInteger(revision) || review.revision !== revision) throw new RpcError(ErrorCode.badParams, 'This review changed. Reload it before saving or sending your answer.');
  },

  persistReview(this: Runner, st: ThreadState, review: DesignReview, queue = st.rec.queue, wake = false): void {
    const previous = st.rec.reviews ?? [];
    const reviews = previous.some(r => r.id === review.id)
      ? previous.map(r => r.id === review.id ? review : r)
      : [...previous, review];
    const next = {...st.rec, reviews, queue};
    // Mike's answer brings it back from a snooze or the archive (place.ts).
    if (wake) parkRecord(next, {kind: 'reviewAnswered'}, this.clock.now());
    this.store.save(next);
    if (wake) parkRecord(st.rec, {kind: 'reviewAnswered'}, this.clock.now());
    // An answer queued is new work: its last finish no longer counts for
    // threads waiting on it (runner/hibernation.ts).
    if (queue.length > st.rec.queue.length) {
      delete next.finished;
      delete st.rec.finished;
    }
    // Preserve the record object used by any in-flight deliver() callback.
    Object.assign(st.rec, next);
    this.emit(st, {type: 'review.updated', review});
  },

  recoverReviews(this: Runner, st: ThreadState): void {
    // Reviews save their record before their event. Threads without reviews
    // need no extra log scan (the common case, including long transcripts).
    if (!st.rec.reviews?.length && !st.rec.queue.some(q => q?.reviewId)) return;
    // An answer already queued keeps only its review's own pictures. First,
    // before reading the log: a moved thread's log is the other runner's
    // word, and anything below that throws would leave this undone, with
    // the queue sent next (Codex's review, 17 Nov). Nothing in it can throw.
    // The words' markers follow what's kept (keepPictureMarkers).
    st.rec.queue = st.rec.queue.map(q => {
      if (!q?.reviewId) return q;
      const own = (list: unknown): [ImageRef[], boolean[]] => {
        const all: unknown[] = Array.isArray(list) ? list : [];
        const keep = all.map(img => this.ownReplyImage(st, q.reviewId!, img as ImageRef));
        return [all.filter((_, i) => keep[i]) as ImageRef[], keep];
      };
      const [images, keep] = own(q.images);
      const text = keepPictureMarkers(q.text, keep);
      let reviewResponse = q.reviewResponse;
      if (reviewResponse && typeof reviewResponse === 'object' && 'images' in reviewResponse) {
        const [kept, keptMask] = own(reviewResponse.images);
        reviewResponse = {...reviewResponse, images: kept, ...(typeof reviewResponse.reply === 'string' ? {reply: keepPictureMarkers(reviewResponse.reply, keptMask)} : {})};
      }
      if (reviewResponse && typeof reviewResponse === 'object' && 'marks' in reviewResponse) {
        const marks = this.ownMarkImages(st, q.reviewId, reviewResponse.marks);
        if (marks !== reviewResponse.marks) reviewResponse = {...reviewResponse, marks};
      }
      return {...q, text, images, ...(reviewResponse ? {reviewResponse} : {})};
    });
    const log = this.store.log(st.rec.id);
    const latest = new Map<string, DesignReview>();
    const sent = new Set(st.rec.reviewDeliveries ?? []);
    for (const event of log.read(1, log.lastSeq)) {
      if (event.type === 'review.updated' && event.review && typeof event.review === 'object' && typeof event.review.id === 'string') latest.set(event.review.id, event.review);
    }
    const reviews = new Map((st.rec.reviews ?? []).map(r => [r.id, r]));
    // One from the log, as a moved thread's is the other runner's word: its
    // files only this thread's own copies (Daybreak 159, 21 Nov 2026), and
    // one with none left isn't recovered.
    const media = this.store.mediaDir(st.rec.id);
    for (const [id, logged] of latest) {
      if (reviews.has(id) && !(reviews.get(id)!.revision < logged.revision)) continue;
      const review = fitReview(logged, { threadId: st.rec.id, now: media, final: media }, true);
      if (review?.id === id) reviews.set(id, review);
    }
    // A reply's pictures are only ever this thread's own copies: a moved
    // thread's log is the other runner's word, and could name any file here
    // (Codex's review, 17 Nov).
    for (const [id, review] of reviews) reviews.set(id, this.ownReplyImages(st, review));
    if (reviews.size) st.rec.reviews = [...reviews.values()];
    // The delivery marker is written after session.send, not merely after
    // user.message. A failed turn.started append leaves the answer unsent.
    st.rec.queue = st.rec.queue.filter(q => !q.reviewId || !sent.has(q.reviewId));
    for (const [id, review] of reviews) {
      if (review.status === 'answered' && review.replyTurnId && review.response && !sent.has(id) && !st.rec.queue.some(q => q.reviewId === id)) {
        st.rec.queue.push({turnId: review.replyTurnId, text: reviewReply(review, review.response), images: reviewImages(review.response), reviewId: id, reviewResponse: review.response});
      }
      if (latest.get(id)?.revision !== review.revision) this.emit(st, {type: 'review.updated', review});
    }
    if (reviews.size) this.markDirty(st);
  },
};

export type ReviewsPart = RunnerPart<typeof reviewsPart>;

// A client from before reply pictures (the frozen Swift app) sends a draft
// without `images`: the pictures already saved stay, rather than going with
// their [Picture N] still in the words. `images: []` takes them away. The
// same for marks, from a client that doesn't draw them (the phone, or
// an older desktop app).
function withSavedImages(review: DesignReview, raw: ReviewDraft): ReviewDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const images = !('images' in raw) && review.draft.images?.length ? {images: review.draft.images} : {};
  const marks = !('marks' in raw) && review.draft.marks?.length ? {marks: review.draft.marks} : {};
  return 'images' in images || 'marks' in marks ? {...raw, ...images, ...marks} : raw;
}
