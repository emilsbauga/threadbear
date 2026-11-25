import SwiftUI
import ThreadbearKit
import UserNotifications

@main
struct ThreadbearApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()
    @State private var quick = QuickAskModel()
    /// A threadbear://quickask link opened from outside: never taken, as any app
    /// claiming the scheme could have caught it (and its token) first.
    @State private var refusedQuickAsk = false
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // The old quick ask log kept what was said and spoken: gone on the first launch after.
        QuickAskLogFile.removeOldLog()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(quick)
                // Every link in the app: a web page opens, another app's
                // link asks first (LinkGate).
                .linksThroughGate()
                .onAppear {
                    delegate.model = model
                    delegate.pushTaps.open = { [model] threadId in model.openThreadId = threadId }
                    quick.keep = { [model] record in try await model.keepQuickAsk(record) }
                    quick.sendFollowUp = { [model] threadId, text in
                        guard let backend = model.backend else { throw TransportError.server("Not paired with a Mac.") }
                        _ = try await backend.send(threadId: threadId, text: text)
                    }
                    quick.onKept = { [model] threadId in model.openThreadId = threadId }
                }
                .onChange(of: scenePhase, initial: true) { _, phase in
                    quick.scenePhaseChanged(to: phase)
                    switch phase {
                    case .background:
                        model.wentToBackground()
                        // About 1.2 GB, and the GPU's off limits in the background.
                        WhisperEngine.shared.unload()
                    case .active:
                        model.comingBack()
                        Dictation.prepare()
                    default: break
                    }
                }
                // Ask for notifications once paired, including straight
                // after pairing, not only on a launch that was already paired.
                .onChange(of: model.isPaired, initial: true) { _, paired in
                    // Not for a scripted quick ask: the prompt would keep the app from going
                    // active, which is when the debug question is asked.
                    if paired, !model.isFake, !ProcessInfo.processInfo.arguments.contains("-QuickAskDebugQuestion") {
                        // Not for a backend that can't send any (a self-hosted one):
                        // the permission would be for nothing.
                        Task {
                            if await model.backendSendsNotifications() { delegate.askForNotifications() }
                        }
                    }
                }
                // threadbear://quickask and threadbear://pair links are never taken from here: any app can
                // claim the scheme, so the Mac's code is read by the app's own
                // scanner instead (Daybreak 127), and an opened one says so.
                // threadbear://open is Voice Type's keyboard button: coming forward is all
                // it wants, and passing it on would show a "not a pairing link" error.
                .onOpenURL { url in
                    if url.host() == "open" { return }
                    switch QuickAskSetup.parse(url.absoluteString) {
                    // A Quick Ask link, or a setup code somehow opened as one: both
                    // are read by Settings › Ask's own scanner instead.
                    case .failure(.link), .failure(.unusable), .success: refusedQuickAsk = true
                    case .failure(.notQuickAsk):
                        // A pairing link from outside is refused, saying to scan
                        // the code in the app; anything else is "not a pairing code".
                        model.askToPair(url.absoluteString, from: .opened)
                    }
                }
                // Cancel leaves the saved pairing and the kept runner keys as they were:
                // nothing is saved until the yes, and then only once the token works.
                .alert(model.pairingGate.pending?.title ?? "",
                       isPresented: Binding(get: { model.pairingGate.pending != nil }, set: { if !$0 { model.pairingGate.cancel() } }),
                       presenting: model.pairingGate.pending) { request in
                    // Takes this request, the one shown, at once: a Task here ran
                    // after the dismissal had cancelled it.
                    Button("Pair") { model.acceptPairing(request) }
                    Button("Cancel", role: .cancel) { model.pairingGate.cancel() }
                } message: { request in
                    Text(request.message)
                }
                .alert("Threadbear doesn't take Quick Ask links", isPresented: $refusedQuickAsk) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text(QuickAskSetup.linkRefusal)
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(QuickAskModel.self) private var quick

    var body: some View {
        @Bindable var quick = quick
        Group {
            if model.isPaired {
                InboxView()
            } else {
                PairView()
            }
        }
        // Quick ask goes over whatever's showing, from the Action button or the inbox's mic.
        .fullScreenCover(isPresented: $quick.isPresented) {
            QuickAskView { threadId in
                quick.close()
                model.openThreadId = threadId
            }
            .environment(quick)
        }
    }
}

/// Push: asks once it's paired, hands the APNs token to the model, and
/// opens the thread a notification is about.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var model: AppModel?
    /// Opens a tapped push's thread, once `model` is there to open it.
    let pushTaps = PushTaps()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // First, to catch a crash at launch. App Store builds only.
        CrashReporting.start()
        UNUserNotificationCenter.current().delegate = self
        WhisperModel.shared.reconnect()
        _ = DictationWords.shared  // takes -ThreadbearAddWords
        #if DEBUG
        WhisperEngine.testFromLaunchArguments()
        SelfShot.fromLaunchArguments()
        #endif
        return true
    }

    func askForNotifications() {
        Task { @MainActor in
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            if granted { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    /// Whisper's download finishing with the app closed (WhisperModel).
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == WhisperModel.sessionId else { completionHandler(); return }
        Task { @MainActor in
            WhisperModel.shared.backgroundCompletion = completionHandler
            WhisperModel.shared.reconnect()
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in model?.didRegister(apnsToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in model?.report(error) }
    }

    // The completion-handler forms, not `async`: Swift calls an async
    // delegate method's handler from a background thread when its task
    // ends, and UIKit asserts it's on main, which crashed the app on a
    // tapped push (THREADBEAR-12). Each handler is called on the main actor.

    /// Banners show while the app's open too, since the push is usually
    /// about a thread other than the one on screen.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in completionHandler([.banner, .sound]) }
    }

    /// The backend's silent push:clear: the thread no longer needs you, so its
    /// notification comes down (DeliveredNotifications). Background pushes
    /// need the remote-notification background mode (Info.plist).
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard let threadId = userInfo["clear"] as? String else { completionHandler(.noData); return }
        Task { @MainActor in
            await DeliveredNotifications.clear(threadId: threadId)
            completionHandler(.newData)
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
        let threadId = response.notification.request.content.userInfo["threadId"] as? String
        pushTaps.tapped(threadId: threadId, done: completionHandler)
    }
}
