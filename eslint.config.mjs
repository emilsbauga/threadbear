import mikecannLint from "mikecann-lint";

export default [
  // Lints the TypeScript in convex/, web/, relay/ and runner/. The rest is
  // Swift, Rust, the public site and the GPUI specs' steps, each with checks
  // of its own. runner/ isn't React: its use... functions aren't hooks.
  ...(await mikecannLint({
    root: import.meta.dirname,
    ignores: [
      "app/**",
      "desktop/**",
      "android-native/**",
      "ios/**",
      "dock/**",
      "site/**",
      "docs/**",
      "features/**",
      "scripts/**",
      "runner/box/spike/**",
    ],
    untyped: ["runner/scripts/**"],
    notReact: ["runner/**", "relay/**"],
  })),
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
