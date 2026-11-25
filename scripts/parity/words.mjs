// Which of a scenario's words a screen's text doesn't have, for the parity
// run's iPhone (read from its picture, ocr.swift) and Android (its
// accessibility tree, android-shots.mjs) checks. Only letters and digits
// count, so a line wrapped mid-phrase, a curly quote or a space read
// twice by the text recognition isn't a missing word.
//
//   node scripts/parity/words.mjs <text file> <seed.json> <scenario number, from 1>
//   (the iPhone's check: one misread letter in a long phrase is let through)
//   prints the missing words as JSON; exits 1 when any are missing
import fs from 'node:fs';

export const squash = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
export const missingWords = (shows, text, { misreads = false } = {}) => {
  const have = squash(text);
  return shows.filter((w) => !have.includes(squash(w)) && !(misreads && nearly(have, squash(w))));
};

// The iPhone's words are read off its picture, and the text recognition
// reads the odd letter wrong: "Both say wait tor one good release" twice on
// 23 Nov. A phrase of 16 or more letters with one letter read as another
// still counts; a shorter one, or two letters off, doesn't. Android reads
// the screen's own text, so it never needs this.
function nearly(have, want) {
  if (want.length < 16 || have.length < want.length) return false;
  for (let i = 0; i + want.length <= have.length; i++) {
    let off = 0;
    for (let k = 0; k < want.length && off < 2; k++) if (have[i + k] !== want[k]) off++;
    if (off < 2) return true;
  }
  return false;
}

if (import.meta.filename === process.argv[1]) {
  const [textFile, seedFile, n] = process.argv.slice(2);
  const t = JSON.parse(fs.readFileSync(seedFile, 'utf8')).threads[Number(n) - 1];
  const missing = missingWords(t.shows, fs.readFileSync(textFile, 'utf8'), { misreads: true });
  console.log(JSON.stringify(missing));
  process.exit(missing.length ? 1 : 0);
}
