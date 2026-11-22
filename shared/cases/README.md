# Shared cases

The same rules are written once per app: the desktop app (Rust, `desktop/core`),
the iPhone kit (Swift, `ios/ThreadbearKit`), the Android kit (Kotlin,
`android-native/kit`) and the website (TypeScript, `web/src`). Each file here is one
rule's cases, and every app it names runs every case through its own copy, so the
copies can't drift apart unseen. No app owns this folder (../README.md).

## A file

```json
{
  "about": "What the rule is and where each copy lives.",
  "platforms": ["desktop", "ios", "android", "web"],
  "cases": [
    { "name": "what this case is for", "input": "...", "expect": "..." },
    { "name": "...", "input": "...", "expect": "...",
      "differs": { "android": "why Android does something else, and which is right" } }
  ]
}
```

- `platforms`: the apps whose tests read the file: `desktop`, `ios`, `android`,
  `web`, and `mac` for the frozen Swift Mac app (`app/`, only for files it already
  read). `runner/test/unit/shared-cases.test.ts` checks that each named app has a
  test naming the file's path in a string (`"shared/cases/<file>.json"`), and that no
  other app does.
- `input` and `expect`: whatever the rule takes and gives, in plain JSON, the same
  for every app. `inbox-urgency.json` is older and spells them `thread`, `urgency`
  and `counted`.
- `differs`: a known difference. An app named there skips the case, so its tests
  pass, but the difference is written down and counted (the guard test prints the
  count). Fix the app and take its name out, rather than adding more.

## Adding one

1. Write `<rule>.json` here, with cases gathered from every app's own tests.
2. In each app's tests, load it by its path from the repo's top and run every case,
   skipping those whose `differs` names that app. Use the path in full in a string,
   as the guard looks for it: Rust `concat!(env!("CARGO_MANIFEST_DIR"),
   "/../../shared/cases/<rule>.json")`, Swift `#filePath` up to the repo then
   `"shared/cases/<rule>.json"`, Kotlin `File("../../shared/cases/<rule>.json")`, the
   website `new URL('../../shared/cases/<rule>.json', import.meta.url)`.
3. List the apps in `platforms`.

A change here runs every app's checks (check.sh and the workflows' path lists name
`shared/cases/`).
