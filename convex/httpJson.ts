// Public JSON routes count wire bytes before decoding or parsing. A declared
// length is only an early refusal; chunked and dishonest lengths get the same cap.
export async function cappedJson(request: Request, maxBytes: number): Promise<Record<string, unknown> | 'tooBig' | null> {
  const length = request.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    void request.body?.cancel().catch(() => undefined);
    return 'tooBig';
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return 'tooBig';
      }
      parts.push(value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    const value: unknown = text ? JSON.parse(text) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    void reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
}
