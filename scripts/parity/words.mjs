// Which of a scenario's words a screen's text doesn't have, for the parity
// run's iPhone (read from its picture, ocr.swift) and Android (its
// accessibility tree, android-shots.mjs) checks. Only letters and digits
// count, so a line wrapped mid-phrase, a curly quote or a space read
// twice by the text recognition isn't a missing word.
//
//   node scripts/parity/words.mjs <text file> <seed.json> <scenario number, from 1>
//   prints the missing words as JSON; exits 1 when any are missing
import fs from 'node:fs';

export const squash = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
export const missingWords = (shows, text) => {
  const have = squash(text);
  return shows.filter((w) => !have.includes(squash(w)));
};

if (import.meta.filename === process.argv[1]) {
  const [textFile, seedFile, n] = process.argv.slice(2);
  const t = JSON.parse(fs.readFileSync(seedFile, 'utf8')).threads[Number(n) - 1];
  const missing = missingWords(t.shows, fs.readFileSync(textFile, 'utf8'));
  console.log(JSON.stringify(missing));
  process.exit(missing.length ? 1 : 0);
}
