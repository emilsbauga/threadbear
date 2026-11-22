// The composer's words around a send that fails after it left the
// composer (command.ts): put back above whatever is there now, and taken
// out again only as far as they were what was sent. Each is a pure update,
// used as a React state updater, so several failures in one update add up
// rather than overwrite each other. node --test web/src/composer-draft.test.ts

// A failed message's words, back above what's there now.
export function withFailed(cur: string, failed: string): string {
  const back = failed.trim();
  if (!back) return cur;
  return cur.trim() ? `${back}\n\n${cur}` : back;
}

// The backend has the message whose words were `sent`: take them out,
// keeping anything a failure put back above them meanwhile.
export function withoutSent(cur: string, sent: string): string {
  if (cur === sent) return '';
  if (sent && cur.endsWith(`\n\n${sent}`)) return cur.slice(0, -(sent.length + 2));
  return cur;
}
