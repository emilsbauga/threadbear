// Bundles agent/agent.ts into dist/agent.mjs: one file a bare Node 24 box
// can run with `node /agent.mjs`, no node_modules.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const agentBundle = path.join(here, "dist", "agent.mjs");

export async function buildAgent(): Promise<string> {
  await build({
    entryPoints: [path.join(here, "agent", "agent.ts")],
    outfile: agentBundle,
    bundle: true,
    format: "esm",
    target: "node24",
    // "neutral" rather than "node" so convex/browser resolves to its plain
    // build that uses the global WebSocket, not the node build that bundles
    // `ws` behind a createRequire shim.
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["import"],
    logLevel: "warning",
  });
  return agentBundle;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await buildAgent());
}
