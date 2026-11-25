import Foundation

/// A thread's sharing by link, as its row carries it (backend API 7; docs/website.md,
/// "Sharing"). "off" keeps the slug, so sharing again brings the same link back.
public struct ThreadShare: Codable, Sendable, Hashable {
    public var access: String
    public var slug: String

    public init(access: String, slug: String) {
        self.access = access
        self.slug = slug
    }

    /// Anyone with the link can read it. Anything else ("off", or "people"
    /// from a record of the days of sharing by email) is off.
    public var isOn: Bool { access == "link" }
}

/// What a tap on the share sheet asks for (phone:share).
public enum ShareRequest: String, Equatable, Sendable {
    case on
    case off
    /// Shared under a new link: the old one stops working.
    case newLink

    public var access: String { self == .off ? "off" : "link" }
}

/// What the share sheet shows: the row, with the change tapped here on top
/// until the runner has made it or refused it.
public struct SharingState: Equatable, Sendable {
    public var on: Bool
    /// The link to copy and send. Nil while off, while the first link or a
    /// new one is on its way, or with no website known.
    public var link: URL?
    /// A link is on its way and not on the row yet.
    public var making: Bool
    /// Takes no taps.
    public var busy: Bool
    /// The control whose command is on its way: the switch (.on, .off) or New link.
    public var spinning: ShareRequest?
    /// Where a command that's taking a while has got to.
    public var note: String?
    public var failure: String?
}

/// Sharing a thread by link from the phone, as the website's Share control
/// (web/src/share.tsx, ShareControl) and the Mac's share button do: a
/// `share` command the thread's runner applies (phone:share, backend API 8).
public enum ThreadSharing {
    /// The website's address: what the backend says (phone:me's `site`), else
    /// a cloud deployment's .convex.site twin, as the runner's siteOf does. Nil
    /// for a self-hosted backend that doesn't say, which serves its site
    /// elsewhere (docs/self-hosting.md).
    public static func site(said: String?, deploymentURL: URL?) -> URL? {
        if let said = said?.trimmingCharacters(in: .whitespaces), let url = URL(string: said),
           ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host() != nil {
            return trimmed(url)
        }
        guard let deploymentURL, let host = deploymentURL.host(), host.hasSuffix(".convex.cloud"),
              var parts = URLComponents(url: deploymentURL, resolvingAgainstBaseURL: false) else { return nil }
        parts.host = String(host.dropLast(".convex.cloud".count)) + ".convex.site"
        parts.path = ""
        return parts.url.map(trimmed)
    }

    /// `<site>/s/<slug>`. The slug is base64url; anything else is escaped so
    /// it stays one piece of the path.
    public static func link(site: URL, slug: String) -> URL? {
        guard !slug.isEmpty, let escaped = slug.addingPercentEncoding(withAllowedCharacters: slugAllowed) else { return nil }
        return URL(string: trimmed(site).absoluteString + "/s/" + escaped)
    }

    /// The pending command's value (PendingCommands.Entry), which says what
    /// was asked and, for a new link, the slug it replaces.
    public static func value(_ request: ShareRequest, replacing slug: String?) -> String {
        request == .newLink ? "newLink:" + (slug ?? "") : request.rawValue
    }

    public static func shown(_ share: ThreadShare?, site: URL?, command: PendingCommand, value: String?) -> SharingState {
        var asked: ShareRequest?
        var replacing: String?
        if command.holdsChange, let value {
            if value.hasPrefix("newLink:") {
                asked = .newLink
                replacing = String(value.dropFirst("newLink:".count))
            } else {
                asked = ShareRequest(rawValue: value)
            }
        }
        let on = asked.map { $0 != .off } ?? share?.isOn ?? false
        // A new link that hasn't reached the row: the old one is on its way out.
        let stale = asked == .newLink && share?.slug == replacing
        let slug = on && !stale ? share?.slug : nil
        let link = slug.flatMap { s in site.flatMap { Self.link(site: $0, slug: s) } }
        let spinning: ShareRequest? = switch command {
        case .sending, .queued, .taken: asked
        default: nil
        }
        return SharingState(
            on: on, link: link, making: on && slug == nil && (stale || asked != nil), busy: command.locked,
            spinning: spinning, note: command.timedOutNote,
            failure: command.failure("The Mac couldn't change how this thread is shared.")
        )
    }

    private static let slugAllowed: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-_")
        return set
    }()

    private static func trimmed(_ url: URL) -> URL {
        var s = url.absoluteString
        while s.hasSuffix("/") { s.removeLast() }
        return URL(string: s) ?? url
    }
}
