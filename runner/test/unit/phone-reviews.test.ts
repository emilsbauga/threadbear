import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { draftFromPhone, phoneReview, reviewImageSource, reviewStills } from '../../src/phone-reviews.ts';
import type { DesignReview } from '../../src/protocol.ts';
import { makePng } from '../helpers/png.ts';

const review: DesignReview = {
  id: 'review-id', title: 'Pick a layout', recommended: 'A', status: 'pending', revision: 0,
  createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z', draft: { notes: {} },
  options: [{ id: 'A', title: 'First', image: { path: '/private/first.png', mediaType: 'image/png' }, url: 'http://localhost:3000/private',
    shots: [{ title: 'Overview', image: { path: '/private/first.png', mediaType: 'image/png' }, media: { path: '/private/page.html', mediaType: 'text/html' } }] },
  { id: 'B', title: 'Today', reference: true, image: { path: '/private/ref.png', mediaType: 'image/png' } }],
};

test('phone reviews keep choices and labels without exposing local paths or HTML', () => {
  const dto = phoneReview(review);
  assert.equal(dto.recommended, 'A');
  assert.equal(dto.options[1].reference, true);
  assert.equal(dto.options[0].shots[0].kind, 'page');
  assert.equal(dto.options[0].shots[0].title, 'Overview');
  assert.ok(!JSON.stringify(dto).includes('/private'));
  assert.deepEqual(dto.draft, { notes: {} });
});

test("a draft's pasted pictures, which are paths on the Mac, never reach the phone", () => {
  const withImages: DesignReview = {
    ...review,
    draft: { pickedIds: ['A'], notes: { A: 'Tighter' }, reply: 'Go', images: [{ path: '/Users/me/Library/Application Support/Threadbear/threads/t/media/reviews/r/reply/abc.png', mediaType: 'image/png' }] },
  };
  const dto = phoneReview(withImages);
  assert.deepEqual(dto.draft, { pickedIds: ['A'], notes: { A: 'Tighter' }, reply: 'Go' });
  assert.ok(!JSON.stringify(dto).includes('/Users/'), JSON.stringify(dto));
  // An answered review shows its response, which is cleaned the same way.
  const answered = phoneReview({ ...withImages, status: 'answered', response: withImages.draft });
  assert.ok(!JSON.stringify(answered).includes('/Users/'));
  assert.ok(!('images' in answered.draft));
});

test("the phone's answer is rebuilt field by field, notes from a list", () => {
  const draft = draftFromPhone({ pickedIds: ['A'], notes: [{ id: '$odd', text: 'one' }, { id: 'Café', text: 'two' }, { id: '__proto__', text: 'three' }], reply: 'Go', images: [{ path: '/etc/passwd' }] });
  assert.deepEqual(Object.keys(draft.notes), ['$odd', 'Café', '__proto__']);
  assert.equal(draft.notes['__proto__'], 'three');
  assert.equal(draft.reply, 'Go');
  assert.ok(!('images' in draft), 'pictures from the phone are never taken: they would name files on this Mac');
  assert.throws(() => draftFromPhone({ notes: { A: 'object' } }));
  assert.throws(() => draftFromPhone({ notes: [], pickedIds: [1] }));
});

test("a review's stills: only files in its own folder, not links, each once", async () => {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reviews-'));
  try {
    const dir = path.join(media, 'reviews', review.id);
    fs.mkdirSync(dir, { recursive: true });
    const good = path.join(dir, 'a.png');
    fs.writeFileSync(good, makePng(40, 30));
    const junk = path.join(dir, 'b.png');
    fs.writeFileSync(junk, 'not a picture at all');
    // A picture elsewhere on the Mac, named outright and through a link.
    const elsewhere = path.join(media, 'private.png');
    fs.writeFileSync(elsewhere, makePng(10, 10));
    const link = path.join(dir, 'link.png');
    fs.symlinkSync(elsewhere, link);
    const still = (p: string) => ({ path: p, mediaType: 'image/png' });
    const r: DesignReview = { ...review, options: [
      { id: 'A', title: 'A', image: still(good), shots: [{ image: still(good) }, { image: still(good), title: 'again' }] },
      { id: 'B', title: 'B', image: still(junk) },
      { id: 'C', title: 'C', image: still(path.join(dir, 'gone.png')) },
      { id: 'D', title: 'D', image: still(elsewhere) },
      { id: 'E', title: 'E', image: still(link) },
    ] };
    const { stills, noPreview } = await reviewStills(r, media);
    assert.deepEqual(stills, [{ src: reviewImageSource(r.id, good), read: good, within: dir }], 'the same still goes once');
    assert.deepEqual([...noPreview].sort(), [junk, path.join(dir, 'gone.png'), elsewhere, link].map((p) => reviewImageSource(r.id, p)).sort());
    const dto = phoneReview(r, noPreview);
    assert.equal(dto.options[0].shots[0].preview, undefined);
    assert.ok(dto.options.slice(1).every((o) => o.shots[0].preview === false));
    // A review id that would lead out of the folder sends nothing.
    assert.equal((await reviewStills({ ...r, id: '../x' }, media)).stills.length, 0);
  } finally {
    fs.rmSync(media, { recursive: true, force: true });
  }
});

// A BMP of noise: over the 10 MB a reply picture may be, and a format the
// phone's pictures don't take.
function bigBmp(file: string): void {
  const w = 1900, h = 1900, row = (w * 3 + 3) & ~3, size = row * h;
  const head = Buffer.alloc(54);
  head.write('BM', 0);
  head.writeUInt32LE(54 + size, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(w, 18);
  head.writeInt32LE(h, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(size, 34);
  fs.writeFileSync(file, Buffer.concat([head, crypto.randomBytes(size)]));
}

test('a still too big for the phone goes as a shrunk JPEG beside it', { skip: !['darwin', 'win32'].includes(process.platform) && 'needs sips, or Windows\' own imaging' }, async () => {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reviews-'));
  try {
    const dir = path.join(media, 'reviews', review.id);
    fs.mkdirSync(dir, { recursive: true });
    const big = path.join(dir, 'big.bmp');
    bigBmp(big);
    assert.ok(fs.statSync(big).size > 10 * 1024 * 1024);
    const r: DesignReview = { ...review, options: [{ id: 'A', title: 'A', image: { path: big, mediaType: 'image/bmp' } }] };
    const { stills, noPreview } = await reviewStills(r, media);
    assert.equal(noPreview.size, 0);
    assert.equal(stills.length, 1);
    assert.equal(path.dirname(stills[0]!.read), path.join(dir, 'phone'));
    assert.ok(fs.statSync(stills[0]!.read).size <= 10 * 1024 * 1024);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'phone')), [path.basename(stills[0]!.read)], 'no copy or part file left behind');
    // Made once: the next open sends the same file.
    assert.deepEqual((await reviewStills(r, media)).stills, stills);
  } finally {
    fs.rmSync(media, { recursive: true, force: true });
  }
});

test("a still that can't be shrunk is only no preview, never an error naming a path", async () => {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reviews-'));
  try {
    const dir = path.join(media, 'reviews', review.id);
    fs.mkdirSync(dir, { recursive: true });
    const big = path.join(dir, 'big.bmp');
    bigBmp(big);
    fs.writeFileSync(path.join(dir, 'phone'), 'a file where the folder goes');
    const r: DesignReview = { ...review, options: [{ id: 'A', title: 'A', image: { path: big, mediaType: 'image/bmp' } }] };
    const { stills, noPreview } = await reviewStills(r, media);
    assert.equal(stills.length, 0);
    assert.equal(noPreview.size, 1);
  } finally {
    fs.rmSync(media, { recursive: true, force: true });
  }
});
