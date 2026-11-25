// Telling what kind of refusal a backend error is. Its own file so the thread
// index (thread-index.ts) can read one without importing sync.ts, which
// imports it (mikecann-lint's no-import-cycle).

// What the backend said when this runner's key isn't allowed something
// (a runner key reaching past its own runner, docs/protocol/keys.md "Runner
// keys"), or undefined for any other error. The feature that asked turns
// itself off and says this once, rather than trying again.
export function forbiddenText(e: unknown): string | undefined {
  const data = (e as { data?: unknown } | null)?.data;
  if (data && typeof data === 'object' && (data as { kind?: unknown }).kind === 'forbidden') {
    const m = (data as { message?: unknown }).message;
    return typeof m === 'string' ? m : "This runner's key can't do that.";
  }
  // A subscription's error may only have the data as JSON in its message.
  const text = String((e as Error | null)?.message ?? e ?? '');
  const json = text.match(/\{[^{}]*"kind"\s*:\s*"forbidden"[^{}]*\}/)?.[0];
  if (!json) return undefined;
  try {
    const m = (JSON.parse(json) as { message?: unknown }).message;
    return typeof m === 'string' ? m : "This runner's key can't do that.";
  } catch {
    return "This runner's key can't do that.";
  }
}
