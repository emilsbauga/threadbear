// Threadbear's own patch (docs/protocol/patches.md, "Patches"): how threads work in
// this repo, the worktrees panel and a typecheck after each turn. No buttons
// for the checks, as Mike never pressed them and agents run ./check.sh anyway.
export default {
  // The bear's paw, so its panel reads as Threadbear's own next to another
  // patch's (Tandem's, say).
  icon: "pawprint",
  // A worktree per thread (docs/thread-worktrees.md): each new thread in
  // this repo works on a thread/<id8> branch in its own worktree, and
  // `tb land` puts it on main once the quick check passes. Setup links
  // node_modules to the main checkout's (see worktree-setup.sh). `keep`
  // reuses an archived thread's worktree, Swift build caches and all, for
  // the next thread: in a fresh one the app's first build took 5 to 10
  // minutes, as SwiftPM's cache only works in the folder it was built in.
  worktree: {
    setup: "./worktree-setup.sh",
    check: "./check.sh --quick",
    keep: ["app/.build", "dock/.build"],
  },
  panels: [
    // Several threads work on this repo at once, each in its own worktree:
    // which ones have work that isn't on main yet, and which are dirty.
    // Spares (set aside for the next thread) are nobody's, so they're left out.
    {
      title: "Worktrees",
      icon: "arrow.triangle.branch",
      items: async ({ sh }) => {
        const out = await sh(`git worktree list --porcelain | awk -v RS= '!/\\nlocked threadbear spare/ { sub(/^worktree /, ""); sub(/\\n.*/, ""); print }' | while read -r dir; do
          [ -d "$dir" ] || continue
          branch=$(git -C "$dir" branch --show-current); [ -n "$branch" ] || branch="detached"
          ahead=$(git -C "$dir" rev-list --count main..HEAD 2>/dev/null || echo 0)
          dirty=$(git -C "$dir" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
          printf '%s\t%s\t%s\t%s\n' "$dir" "$branch" "$ahead" "$dirty"
        done`);
        return out.trim().split("\n").filter(Boolean).map((line) => {
          const [dir, branch, ahead, dirty] = line.split("\t");
          const bits = [branch, Number(ahead) ? `${ahead} ahead of main` : "nothing ahead of main"];
          if (Number(dirty)) bits.push(`${dirty} uncommitted`);
          return {
            title: dir.split("/").slice(-2).join("/"),
            detail: bits.join(" · "),
            icon: "folder",
            tone: Number(dirty) ? "attention" : Number(ahead) ? undefined : "done",
          };
        });
      },
    },
  ],
  hooks: [
    // After a turn that touched the runner's TypeScript: a few seconds, and
    // the agent hears about a type error before it moves on.
    { title: "Runner typecheck", on: "turn.end", run: "cd runner && npx tsc --noEmit -p .", edited: "runner/src/**/*.ts" },
  ],
};
