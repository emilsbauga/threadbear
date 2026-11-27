# Mock runner

A stand-in Threadbear runner that speaks the protocol (docs/protocol/) with
demo threads and no CLIs, for testing and looking at the apps without a real
runner: the desktop app's tests and dev tools (desktop/client/tests/mock_runner.rs,
desktop/core/tests/golden.rs, desktop/scripts/dev-app.sh `--mock`), the
behaviour specs in features/, and the frozen Swift app (its tests and
app/Tools scripts point here).

    npm ci                      # once, for ws
    node server.mjs --data-dir /tmp/tb-mock [--port 0] [--fixtures DIR]...

- `fixtures/`: the demo threads, a folder each (thread.json, events.ndjson,
  media/). Every one has a golden file of the rows it makes in
  `desktop/core/tests/golden` (UPDATE_GOLDEN=1 rewrites them, golden.rs says how).
- `make-synthetic.mjs`: makes the long synthetic threads for perf runs.
- Your own fixtures (`tb export` writes a real thread to `.fixtures/threads/<id>`
  at the repo's top) are private and gitignored: pass them with `--fixtures`.
- `TB_MOCK_COORDINATORS=1` adds the coordinator experiment and a project home
  for Threadbear, with synthetic helper conversations. `mock.coordinatorFinish`
  returns its first helper result for review. `mock.coordinatorVerify` accepts
  that result and marks the task done, updating the shared project state.
  Use `mock.coordinatorTaskBoard` for a board with grouped tasks, a live
  decision card, and the Tasks and Highlights actions.

It imports a few of the runner's own files (`../runner/src/`), so a change there
runs the desktop checks too (.github/workflows/desktop.yml).
