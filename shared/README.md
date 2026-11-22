# Shared

What more than one app uses, so no app owns it and deleting one app (the
frozen Swift Mac app in `app/` first, docs/gpui-port.md) leaves the others
whole. Each app takes it from here; one that can't (a build that needs a real
file in its own folder) keeps a copy, and `runner/test/unit/shared-copies.test.ts`
checks the copy is the same bytes.

- `cases/`: one rule's test cases each, run by every app that has the rule
  (cases/README.md).
- `art/`: pictures in the apps: the Home page's Scheduled and Librarian
  pictures (desktop/gpui/src/home_page.rs) and the Swift app's "Try the new
  app" card (`gpui-app.png`, which goes when it does). The Swift app's
  `Resources/Art` is a link to this folder, so it holds only what goes in that
  bundle.
- `rich/`: Pele, the diagram library for `rich` blocks, and its licence.
  The desktop app builds it in (desktop/web/src/mac/rich.rs) and the Swift
  app's `Resources/Rich` links here. The iPhone app (`ios/Threadbear/Rich`) and
  Android (`android-native/app/src/main/assets`) keep copies.
- `icons/threadbear.png`: the bear, 1024 px, that the site's icons, the runner
  launcher's icon and the mock runner's sample project icon are made from.

Not here: the mock runner (`mock-runner/`, its own package), the real-screen
test tools (`features/tools`), Sentry's package (`ios/SentryBinary`).
`runner/test/unit/swift-app-paths.test.ts` fails when something outside
`app/` and `dock/` uses a path inside them: what's shared goes here instead.
