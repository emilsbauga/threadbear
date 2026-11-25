#if DEBUG
import UIKit

/// `-ThreadbearSelfShot <name>` (debug builds): four seconds after launch,
/// the app draws its own window into `<tmp>/<name>.png` and prints the path.
/// For screenshots when `simctl io screenshot` hangs, as it did on Tinker
/// Desk on 24 Nov 2026 (every simulator, home screen too). Copy it out with
/// `xcrun simctl get_app_container <sim> com.mikecann.threadbear data`, then
/// `tmp/<name>.png` under it.
enum SelfShot {
    static func fromLaunchArguments() {
        let args = ProcessInfo.processInfo.arguments
        guard let at = args.firstIndex(of: "-ThreadbearSelfShot"), at + 1 < args.count else { return }
        let name = args[at + 1]
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            let window = UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first
            guard let window else { return print("SELFSHOT no window") }
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name).png")
            do {
                try image.pngData()?.write(to: url)
                print("SELFSHOT \(url.path)")
            } catch {
                print("SELFSHOT failed: \(error)")
            }
        }
    }
}
#endif
