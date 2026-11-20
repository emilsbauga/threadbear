// A tiny HTTP server that records every request and answers from a handler,
// so the adapters can be checked without a Fly or Daytona account.
import http from "node:http";
import type { AddressInfo } from "node:net";

export type Seen = {
  method: string;
  path: string; // pathname only
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
  json?: any;
};

export type Reply = { status?: number; json?: unknown; text?: string };

export async function fakeServer(handler: (req: Seen) => Reply | undefined) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = Buffer.concat(chunks).toString("utf8");
      const r: Seen = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
      };
      if ((req.headers["content-type"] ?? "").includes("json") && body) r.json = JSON.parse(body);
      seen.push(r);
      const reply = handler(r) ?? { status: 404, text: `no fake for ${r.method} ${r.path}` };
      res.statusCode = reply.status ?? 200;
      if (reply.json !== undefined) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(reply.json));
      } else {
        res.end(reply.text ?? "");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
