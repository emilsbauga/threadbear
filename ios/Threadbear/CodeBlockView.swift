import SwiftUI
import ThreadbearKit
import UIKit

/// A fenced code block in a reply, as the Mac draws it: a slim strip across
/// the top with the language on the left ("TypeScript" for ```ts, nothing
/// for a bare fence) and Copy on the right, then the code, coloured by its
/// language in the Mac's colours (CodeColours) and scrolling sideways rather
/// than wrapping.
struct CodeBlockView: View {
    let code: String
    let language: String?

    @State private var copied = false
    /// Which tap the "Copied" belongs to, so an older tap's timer doesn't
    /// put the copy icon back early.
    @State private var copies = 0
    @Environment(\.displayScale) private var displayScale
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Color.primary.opacity(0.1)).frame(height: 1 / displayScale)
            ScrollView(.horizontal, showsIndicators: false) {
                codeText.font(.system(.footnote, design: .monospaced)).padding(10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var codeText: Text {
        if let coloured = CodeColours.attributed(code, language: language, dark: colorScheme == .dark) {
            return Text(coloured)
        }
        return Text(code)
    }

    private var header: some View {
        HStack(spacing: 8) {
            if let language {
                Text(MarkdownBlock.languageName(language))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button(action: copy) {
                HStack(spacing: 4) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                    if copied { Text("Copied") }
                }
                .font(.caption.weight(copied ? .semibold : .regular))
                .frame(minWidth: 44, minHeight: 30, alignment: .trailing)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .foregroundStyle(copied ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary))
            .sensoryFeedback(.impact(weight: .light), trigger: copies)
            .accessibilityLabel(copied ? "Copied" : "Copy the code")
        }
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .frame(height: 30)
        // A shade apart from the code under it, darker in light mode and
        // lighter in dark.
        .background(Color(.tertiarySystemFill))
    }

    private func copy() {
        UIPasteboard.general.string = code
        copies += 1
        let tap = copies
        copied = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            if copies == tap { copied = false }
        }
    }
}

/// The Mac's code colours: gpui-component's Default Dark and Default Light
/// highlight themes (desktop/vendor/gpui-component/src/theme/
/// default-theme.json, `highlight.syntax`), by the names CodeHighlighter
/// gives. Diffs take the themes' created and deleted colours.
enum CodeColours {
    static func color(_ token: CodeToken, dark: Bool) -> Color? {
        let hex: UInt32? = switch token {
        case .keyword: dark ? 0x87B1F6 : 0x0433FF
        case .string: dark ? 0xA3E09F : 0x036A07
        case .escape: dark ? 0x68DC7C : 0x036A07
        case .number: dark ? 0xCC9E00 : 0x0433FF
        case .constant: dark ? 0xCC9E00 : 0xC5060B
        case .comment: dark ? 0x9D9D9D : 0x007FFF
        case .function: dark ? 0xB3C5F3 : 0x0000A2
        case .type: dark ? 0xCBA6F7 : 0x6F42C1
        case .property: dark ? 0xBCC4E0 : 0x333333
        case .tag: dark ? 0x419CFF : 0x0433FF
        case .attribute: dark ? 0x7FAEF9 : 0x957931
        case .title: dark ? 0xCC9E00 : 0x0433FF
        case .variable: dark ? 0x419CFF : 0xC5060B
        case .literal: dark ? 0xA3E09F : 0x6F42C1
        case .link: dark ? 0x7FAEF9 : 0x6A7293
        case .inserted: dark ? 0x4ADE80 : 0x16A34A
        case .deleted: dark ? 0xF87171 : 0xDC2626
        case .strong, .emphasis: nil
        }
        return hex.map { Color(red: Double($0 >> 16 & 0xFF) / 255, green: Double($0 >> 8 & 0xFF) / 255, blue: Double($0 & 0xFF) / 255) }
    }

    private nonisolated struct Key: Hashable, Sendable {
        let dark: Bool
        let language: String
        let code: String
    }

    /// Coloured blocks kept by appearance, language and text, so a long
    /// thread scrolling back and forth colours each block once. Costed by
    /// the code's length: about a day's replies.
    private static let kept = CostLRU<Key, AttributedString>(limit: 2_000_000)

    /// `code` coloured for `language`, or nil to draw it plain (no language,
    /// one CodeHighlighter doesn't know, or past its size limit). Its
    /// characters are the code's, so selecting and copying give the code.
    @MainActor static func attributed(_ code: String, language: String?, dark: Bool) -> AttributedString? {
        guard let language, CodeHighlighter.knows(language) else { return nil }
        let key = Key(dark: dark, language: language.lowercased(), code: code)
        if let kept = kept.value(for: key) { return kept }
        guard let runs = CodeHighlighter.runs(code, language: language) else { return nil }
        var text = AttributedString()
        for run in runs {
            var piece = AttributedString(run.text)
            if let token = run.token {
                if let color = color(token, dark: dark) { piece.foregroundColor = color }
                switch token {
                case .strong: piece.inlinePresentationIntent = .stronglyEmphasized
                case .emphasis, .link: piece.inlinePresentationIntent = .emphasized
                case .title where dark: piece.inlinePresentationIntent = .stronglyEmphasized
                default: break
                }
            }
            text.append(piece)
        }
        kept.set(text, for: key, cost: code.utf16.count)
        return text
    }
}
