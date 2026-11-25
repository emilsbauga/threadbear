// A node:test reporter that writes the test files that passed: at least one
// test passed and none failed, one path per line. check.sh records each one
// with the key of what it read (scripts/check-cache.mjs), so the next check
// skips it while nothing it reads changes. A file that didn't load, or
// crashed, has a test:fail and isn't written. Nor is one with a test that
// skipped itself or is a todo: why it skipped (no esbuild installed, not a
// Mac, no Xcode) isn't in its key, and the next check may well have it
// (Codex's review, 22 Nov 2026). Plain .mjs so node loads it without a
// loader.
export default async function* passedFiles(source) {
  const passed = new Set();
  const failed = new Set();
  for await (const event of source) {
    const file = event.data?.file;
    if (!file) continue;
    if (event.type === 'test:pass' && (event.data.skip !== undefined || event.data.todo !== undefined)) failed.add(file);
    else if (event.type === 'test:pass') passed.add(file);
    else if (event.type === 'test:fail') failed.add(file);
  }
  for (const f of passed) if (!failed.has(f)) yield `${f}\n`;
}
