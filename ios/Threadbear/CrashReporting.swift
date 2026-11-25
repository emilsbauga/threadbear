import Foundation
#if !DEBUG
import Sentry
#endif

/// Crash and error reports to Sentry (project `threadbear`, tag
/// component: ios), from App Store and TestFlight installs only. Agents build and run this
/// app in the simulator and on Mike's phones all day, and an agent watcher
/// opens a thread for anything that reaches Sentry, so a Debug build, the
/// simulator and a development-signed install (install-phone.sh, which has
/// an embedded.mobileprovision; an App Store build has none) never report.
///
/// Crashes and errors only: no tracing, sessions, app-hang reports,
/// breadcrumbs, screenshots or PII. Watchdog terminations stay on.
enum CrashReporting {
    /// A public client key (it ships in every Sentry client); fine to commit.
    static let dsn = "https://c69460318b1f938fd1703c6578a059f6@o4508736647266304.ingest.us.sentry.io/4512336956293120"

    static func start() {
        #if !DEBUG && !targetEnvironment(simulator)
        guard Bundle.main.path(forResource: "embedded", ofType: "mobileprovision") == nil else { return }
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        SentrySDK.start { options in
            options.dsn = dsn
            // TestFlight builds have a
            // sandbox receipt; App Store ones don't.
            let testFlight = Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
            options.environment = testFlight ? "testflight" : "production"
            options.releaseName = "threadbear-ios@\(version)+\(build)"
            options.sendDefaultPii = false
            options.tracesSampleRate = 0
            options.enableAutoPerformanceTracing = false
            options.enableNetworkTracking = false
            options.enableCaptureFailedRequests = false
            options.enableAutoSessionTracking = false
            options.enableAppHangTracking = false
            options.enableWatchdogTerminationTracking = true
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            // Breadcrumbs could carry a thread's text.
            options.enableAutoBreadcrumbTracking = false
            options.enableNetworkBreadcrumbs = false
            options.maxBreadcrumbs = 0
        }
        SentrySDK.configureScope { scope in
            scope.setTag(value: "ios", key: "component")
        }
        #endif
    }
}
