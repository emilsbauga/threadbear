import Foundation

/// Pictures among a message's words, as on the Mac (docs/protocol/threads.md,
/// "Pictures in a message"; the Mac's copy is app/Sources/ThreadbearCore/
/// Threads/InlinePictures.swift). In the composer each photo is a mark in
/// the text, U+FFFC, the character its chip attachment is, the k-th mark
/// standing for the k-th photo. A message carries `[Picture N]` markers
/// instead, and the runner puts picture N straight after its marker when
/// it goes to the agent.
public enum InlinePictures {
    public static let mark: Unicode.Scalar = "\u{FFFC}"
    public static let markString = String(Character(mark))

    public static func marker(_ number: Int) -> String { "[Picture \(number)]" }

    /// The same marker the runner reads (runner/src/pictures.ts).
    nonisolated(unsafe) private static let markerPattern = try! NSRegularExpression(pattern: #"\[Picture (\d{1,3})\]"#)

    public static func markCount(_ text: String) -> Int {
        text.unicodeScalars.reduce(0) { $1 == mark ? $0 + 1 : $0 }
    }

    /// Words put right for `count` photos: one mark each. Spare marks go;
    /// a photo with no mark gets one at the end.
    public static func normalized(_ text: String, count: Int) -> String {
        let marks = markCount(text)
        if marks == count { return text }
        if marks > count {
            var kept = 0
            var scalars = String.UnicodeScalarView()
            for scalar in text.unicodeScalars {
                if scalar == mark {
                    kept += 1
                    if kept > count { continue }
                }
                scalars.append(scalar)
            }
            return String(scalars)
        }
        var out = text
        for _ in marks..<count { out = appending(markString, to: out) }
        return out
    }

    static func appending(_ piece: String, to text: String) -> String {
        guard let last = text.unicodeScalars.last, !CharacterSet.whitespacesAndNewlines.contains(last) else { return text + piece }
        return text + " " + piece
    }

    /// The words as they're sent: the k-th mark as `[Picture first+k]`, or
    /// "" when there's nothing but photos, which go as they always did.
    public static func sentText(_ text: String, first: Int = 1) -> String {
        guard text.unicodeScalars.contains(mark) else { return text }
        if text.unicodeScalars.allSatisfy({ $0 == mark || CharacterSet.whitespacesAndNewlines.contains($0) }) { return "" }
        return messageText(text, first: first)
    }

    /// The words with the k-th mark as `[Picture first+k]`.
    public static func messageText(_ text: String, first: Int = 1) -> String {
        guard text.unicodeScalars.contains(mark) else { return text }
        var out = ""
        var number = first
        for scalar in text.unicodeScalars {
            if scalar == mark {
                out += marker(number)
                number += 1
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    /// `count` marks in place of `range` (UTF-16, clamped), with a space
    /// either side, as the Mac's composer puts them. Also says which photo
    /// the first one is (how many marks come before it) and where the
    /// cursor goes after them.
    public static func inserting(_ count: Int, in text: String, replacing range: NSRange) -> (text: String, firstIndex: Int, cursor: Int) {
        let ns = text as NSString
        let location = min(max(0, range.location), ns.length)
        let replace = NSRange(location: location, length: min(max(0, range.length), ns.length - location))
        func isSpace(_ index: Int) -> Bool {
            guard index >= 0, index < ns.length, let scalar = Unicode.Scalar(ns.character(at: index)) else { return false }
            return CharacterSet.whitespacesAndNewlines.contains(scalar)
        }
        var piece = location > 0 && !isSpace(location - 1) ? " " : ""
        piece += Array(repeating: markString, count: count).joined(separator: " ")
        if !isSpace(NSMaxRange(replace)) { piece += " " }
        let before = ns.substring(to: location)
        let out = ns.replacingCharacters(in: replace, with: piece)
        return (out, markCount(before), location + (piece as NSString).length)
    }

    /// The words without the `index`-th mark and one space beside it.
    public static func removingMark(_ index: Int, from text: String) -> String {
        var scalars = Array(text.unicodeScalars)
        var seen = 0
        guard let at = scalars.indices.first(where: { i in
            guard scalars[i] == mark else { return false }
            defer { seen += 1 }
            return seen == index
        }) else { return text }
        scalars.remove(at: at)
        if at < scalars.count, scalars[at] == " " {
            scalars.remove(at: at)
        } else if at > 0, scalars[at - 1] == " " {
            scalars.remove(at: at - 1)
        }
        return String(String.UnicodeScalarView(scalars))
    }

    /// The words without their photos' marks.
    public static func words(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.filter { $0 != mark }))
    }

    /// How many of a message's `count` pictures no marker places, as the
    /// runner counts them for its "[2 pictures]" line (sync.ts).
    public static func unplaced(_ text: String, count: Int) -> Int {
        let placed = Set(pieces(text).compactMap { piece -> Int? in
            if case .picture(let number) = piece, number <= count { return number }
            return nil
        })
        return count - placed.count
    }

    public enum Piece: Equatable, Sendable {
        case words(String)
        case picture(Int)
    }

    /// A message as words and chips, for drawing. The phone gets a
    /// message's words but not its pictures, so any `[Picture N]` from 1
    /// to 99 is a chip, the first naming each number, as the runner places
    /// them.
    public static func pieces(_ text: String) -> [Piece] {
        guard text.contains("[Picture ") else { return [.words(text)] }
        let ns = text as NSString
        var pieces: [Piece] = []
        var seen = Set<Int>()
        var last = 0
        for match in markerPattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard let number = Int(ns.substring(with: match.range(at: 1))), (1...99).contains(number), seen.insert(number).inserted else { continue }
            if match.range.location > last { pieces.append(.words(ns.substring(with: NSRange(location: last, length: match.range.location - last)))) }
            pieces.append(.picture(number))
            last = NSMaxRange(match.range)
        }
        if last < ns.length { pieces.append(.words(ns.substring(from: last))) }
        return pieces
    }
}
