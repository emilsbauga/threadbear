import UserNotifications

/// Takes down notifications for threads that no longer need you, so the
/// phone isn't left holding ones already dealt with: opening the thread
/// here (ThreadView), the inbox saying it no longer needs you (it was seen
/// on the Mac, answered, archived), and the backend's silent push:clear for
/// the same while the app is closed (AppDelegate). The Android app does the
/// same (Push.clear).
enum DeliveredNotifications {
    /// The thread a shown notification is about: `threadId` from the push,
    /// else its `thread-id`.
    private static func threadId(of n: UNNotification) -> String? {
        let content = n.request.content
        if let id = content.userInfo["threadId"] as? String { return id }
        return content.threadIdentifier.isEmpty ? nil : content.threadIdentifier
    }

    static func clear(threadId: String) async {
        await remove { $0 == threadId }
    }

    /// Every shown notification but those for threads that still need you.
    static func keepOnly(needingYou: Set<String>) async {
        await remove { !needingYou.contains($0) }
    }

    private static func remove(where gone: (String) -> Bool) async {
        let center = UNUserNotificationCenter.current()
        let ids = await center.deliveredNotifications().compactMap { n in
            threadId(of: n).flatMap { gone($0) ? n.request.identifier : nil }
        }
        if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
    }
}
