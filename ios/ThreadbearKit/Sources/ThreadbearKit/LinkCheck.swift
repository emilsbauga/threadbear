import Foundation

/// What the phone's LinkGate decides a link with: LinkPolicy, after one
/// check before the scheme is looked at, for every kind. A link too long to
/// show whole, or with a character that changes how the rest shows (a
/// control, a bidi override, a zero-width or other format character, a line
/// or paragraph separator), is refused; and the question for one that asks
/// shows all of it, exactly the URL that opens. The question once showed the
/// first 200 and last 100 characters and opened the whole link, so what it
/// said to do could hide in the middle (Daybreak 167, 22 Nov 2026).
///
/// Its own file, as LinkPolicy.swift is a byte-for-byte copy of the frozen
/// Mac app's (app/Tests LinkPolicyTests.testThePhonesCopyIsTheSame). The
/// desktop app (open_policy.rs link_kind), Android (LinkPolicy.kt) and the
/// website (link-policy.ts) hold the same rule: shared/cases/link-policy.json.
public enum LinkCheck {
    /// The longest link looked at, of any kind (the desktop's MAX_LINK).
    public static let maxLink = 8_192
    /// The longest link that asks: its question shows all of it, and has to
    /// fit on a screen (the desktop's alert doesn't scroll).
    public static let maxAskLink = 1_024

    public static func kind(of url: URL) -> LinkPolicy.Kind {
        let text = url.absoluteString
        guard text.utf16.count <= maxLink, !hidesText(text) else { return .refuse }
        let kind = LinkPolicy.kind(of: url)
        // One that asks is printable ASCII only: a space, a blank filler or
        // a run of wide letters could push the rest out of sight. (URL(string:)
        // percent-encodes the rest, so this is a backstop here.)
        if case .ask = kind, text.utf16.count > maxAskLink || !text.unicodeScalars.allSatisfy({ (0x21...0x7E).contains($0.value) }) {
            return .refuse
        }
        return kind
    }

    /// Whether `text` has a character that hides or reorders what's around it.
    public static func hidesText(_ text: String) -> Bool {
        text.unicodeScalars.contains { scalar in
            switch scalar.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator, .surrogate: true
            default: false
            }
        }
    }

    /// The words of the question for a link that asks, with all of the link
    /// in them: `url.absoluteString`, the URL the gate then opens. Never cut
    /// in the middle; `kind` keeps it short enough to show whole, and the
    /// alert scrolls.
    public static func question(_ url: URL) -> (title: String, detail: String) {
        ("Open this \(url.scheme ?? "") link?",
         "It isn't a web page: it opens another app, which acts on what the link says. It's from a thread, so Threadbear asks first.\n\n\(url.absoluteString)")
    }
}
