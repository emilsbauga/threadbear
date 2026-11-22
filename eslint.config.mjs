import mikecannLint from "mikecann-lint";

// This repo's TypeScript, for the rules below the pack's.
const TS = ["{runner,relay,convex,web}/**/*.{ts,tsx,mts,cts}"];

export default [
  // Lints the TypeScript in convex/, web/, relay/, runner/ and features/
  // (the GPUI specs' steps, typed by features/tsconfig.json). The rest is
  // Swift, Rust and the public site, each with checks of its own, and the
  // mock runner (plain JavaScript, never linted while it was in app/; check.sh
  // parses it). runner/
  // and features/ aren't React: their use... functions aren't hooks.
  ...(await mikecannLint({
    root: import.meta.dirname,
    ignores: [
      "app/**",
      "mock-runner/**",
      "desktop/**",
      "android-native/**",
      "ios/**",
      "dock/**",
      "site/**",
      "docs/**",
      "scripts/**",
      "runner/box/spike/**",
    ],
    untyped: ["runner/scripts/**"],
    notReact: ["runner/**", "relay/**", "features/**"],
  })),
  {
    // No any: use unknown and narrow it. (Floating and misused promises,
    // exhaustive switches and unused names come from mikecann-lint 0.2.)
    files: TS,
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Disables for rules this setup doesn't turn on, kept for editors that do.
    files: [
      "runner/src/adapters/acp/mcp-http.ts",
      "runner/src/adapters/codex/tools.ts",
      "runner/src/patch-trust.ts",
      "runner/test/unit/context-budget.test.ts",
      "web/src/link-policy.ts",
    ],
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
];
