import Foundation

/// What a piece of a code block is, named after the Mac's highlight theme
/// (gpui-component's default-theme.json, `highlight.syntax`), so the phone
/// colours it the way the desktop does (CodeBlockView's palette).
public enum CodeToken: String, Sendable, Hashable, CaseIterable {
    case keyword, string, escape, number, constant, comment, function, type
    case property, tag, attribute, title, variable
    /// Markdown's `code` spans.
    case literal
    /// Markdown's **bold** and *italic*.
    case strong, emphasis
    /// A link's address in Markdown.
    case link
    /// A diff's added and removed lines, in the theme's created and deleted
    /// colours (the Mac leaves diffs plain).
    case inserted, deleted
}

/// A stretch of a code block: its text and what it is, nil for plain.
public struct CodeRun: Sendable, Hashable {
    public var token: CodeToken?
    public var text: String

    public init(_ token: CodeToken?, _ text: String) {
        self.token = token
        self.text = text
    }
}

/// Colours a fenced code block by its language, offline and in one pass, for
/// the phone's code blocks. A small hand-written tokenizer per family (C-like,
/// shell, SQL, Python, YAML, TOML, HTML, CSS, diff, Markdown) rather than
/// real grammars: what it picks out follows what syntect's Sublime grammars
/// pick out on the Mac (keywords, strings, numbers, comments, calls, types,
/// tags), checked against its output for each language on 24 Nov 2026.
public enum CodeHighlighter {
    /// Past these a block stays plain: colouring is linear, but SwiftUI
    /// laying out thousands of coloured runs isn't free, and a block that
    /// long is read for its shape, not its colours.
    public static let maxLength = 16_000
    public static let maxLines = 300

    /// The runs for `code`, which joined give back `code` exactly; nil when it
    /// stays plain: no language, one this doesn't know, or too big.
    public static func runs(_ code: String, language: String?) -> [CodeRun]? {
        guard let language, let lang = Lang(fence: language) else { return nil }
        let units = Array(code.utf16)
        guard !units.isEmpty, units.count <= maxLength else { return nil }
        var lines = 1
        for unit in units where unit == nl {
            lines += 1
            if lines > maxLines { return nil }
        }
        var lexer = Lexer(units: units)
        switch lang {
        case .yaml: lexer.yaml()
        case .toml: lexer.toml()
        case .diff: lexer.diff()
        case .markdown: lexer.markdown()
        case .html: lexer.html()
        case .css: lexer.css()
        default: lexer.code(Spec.of(lang))
        }
        return lexer.finish()
    }

    /// Whether `language` is one this colours.
    public static func knows(_ language: String) -> Bool { Lang(fence: language) != nil }
}

enum Lang {
    case ts, tsx, js, jsx, sql, shell, json, yaml, toml, rust, swift, kotlin, python, go, html, css, diff, markdown

    init?(fence: String) {
        switch fence.lowercased() {
        case "ts", "typescript", "mts", "cts": self = .ts
        case "tsx": self = .tsx
        case "js", "javascript", "mjs", "cjs", "node": self = .js
        case "jsx": self = .jsx
        case "sql", "psql", "postgres", "postgresql", "mysql", "sqlite", "plsql", "plpgsql": self = .sql
        case "bash", "sh", "shell", "zsh", "fish", "ksh": self = .shell
        case "json", "jsonc", "json5", "jsonl", "geojson": self = .json
        case "yaml", "yml": self = .yaml
        case "toml": self = .toml
        case "rust", "rs": self = .rust
        case "swift": self = .swift
        case "kotlin", "kt", "kts": self = .kotlin
        case "python", "py", "python3", "py3": self = .python
        case "go", "golang": self = .go
        case "html", "htm", "xml", "svg", "xhtml", "plist", "vue": self = .html
        case "css", "scss", "less": self = .css
        case "diff", "patch": self = .diff
        case "md", "markdown", "mdx": self = .markdown
        default: return nil
        }
    }
}

// MARK: - The language tables

struct Spec {
    var lineComments: [String] = ["//"]
    var blockComments: [(String, String)] = [("/*", "*/")]
    /// Longest first; each closes with itself.
    var quotes: [String] = ["\"", "'"]
    /// Quotes with no escapes inside.
    var rawQuotes: Set<String> = []
    /// Quotes that run on past the end of a line.
    var multilineQuotes: Set<String> = []
    var keywords: Set<String> = []
    var types: Set<String> = []
    var constants: Set<String> = ["true", "false", "null"]
    /// `this` and `self`.
    var special: Set<String> = []
    /// Words after which the next name is a function's, or a type's.
    var functionIntroducers: Set<String> = []
    var typeIntroducers: Set<String> = []
    var caseInsensitive = false
    var capitalisedAreTypes = true
    var callsAreFunctions = true
    var identifierDollar = false
    var rustLifetimes = false
    var jsx = false
    var arrowIsKeyword = false
    /// `#` starts a comment only at the start of a word, as in a shell.
    var hashComment = false
    var shell = false
    var pythonDocstrings = false
    /// What `@word` is: Swift's attributes are keywords on the Mac.
    var atWords: CodeToken?
    /// What a double-quoted string takes in.
    var interpolation: Lexer.Interpolation?

    static func of(_ lang: Lang) -> Spec {
        switch lang {
        case .ts, .tsx, .js, .jsx: return javascript(lang)
        case .sql: return sql
        case .shell: return shell
        case .json: return json
        case .rust: return rust
        case .swift: return swift
        case .kotlin: return kotlin
        case .python: return python
        case .go: return go
        default: return Spec()
        }
    }

    static func javascript(_ lang: Lang) -> Spec {
        var spec = Spec()
        spec.quotes = ["\"", "'", "`"]
        spec.multilineQuotes = ["`"]
        spec.keywords = [
            "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
            "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "finally",
            "for", "from", "function", "get", "if", "implements", "import", "in", "infer", "instanceof",
            "interface", "is", "keyof", "let", "namespace", "new", "of", "override", "private", "protected",
            "public", "readonly", "return", "satisfies", "set", "static", "super", "switch", "throw", "try",
            "type", "typeof", "var", "void", "while", "with", "yield", "module",
        ]
        spec.types = ["string", "number", "boolean", "any", "unknown", "never", "object", "bigint", "symbol"]
        spec.constants = ["true", "false", "null", "undefined", "NaN", "Infinity"]
        spec.special = ["this"]
        spec.functionIntroducers = ["function"]
        spec.typeIntroducers = ["class", "interface", "type", "enum", "extends", "implements"]
        spec.identifierDollar = true
        spec.jsx = lang == .tsx || lang == .jsx
        spec.arrowIsKeyword = true
        spec.atWords = .attribute
        return spec
    }

    static let sql: Spec = {
        var spec = Spec()
        spec.lineComments = ["--"]
        spec.keywords = [
            "add", "all", "alter", "asc", "begin", "by", "cascade", "case", "check", "column", "commit",
            "constraint", "create", "cross", "database", "default", "delete", "desc", "distinct", "drop",
            "else", "end", "exists", "foreign", "from", "full", "grant", "group", "having", "if", "index",
            "inner", "insert", "into", "join", "key", "left", "limit", "materialized", "offset", "on",
            "order", "outer", "primary", "references", "returning", "revoke", "right", "rollback", "schema",
            "select", "set", "table", "then", "transaction", "trigger", "truncate", "union", "unique",
            "update", "using", "values", "view", "when", "where", "with", "replace", "temporary", "temp",
            "function", "returns", "language", "declare", "over", "partition", "window", "lateral",
        ]
        spec.types = [
            "int", "integer", "bigint", "smallint", "serial", "bigserial", "text", "varchar", "char",
            "boolean", "bool", "date", "timestamp", "timestamptz", "time", "interval", "numeric",
            "decimal", "real", "float", "double", "uuid", "json", "jsonb", "bytea", "blob",
        ]
        spec.constants = ["true", "false", "null"]
        spec.caseInsensitive = true
        spec.capitalisedAreTypes = false
        return spec
    }()

    static let shell: Spec = {
        var spec = Spec()
        spec.lineComments = []
        spec.blockComments = []
        spec.rawQuotes = ["'"]
        spec.multilineQuotes = ["\"", "'"]
        spec.keywords = [
            "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in",
            "function", "return", "export", "local", "readonly", "declare", "select", "time",
        ]
        spec.constants = []
        spec.capitalisedAreTypes = false
        spec.callsAreFunctions = false
        spec.hashComment = true
        spec.shell = true
        spec.interpolation = .dollar
        return spec
    }()

    static let json: Spec = {
        var spec = Spec()
        spec.quotes = ["\""]
        spec.capitalisedAreTypes = false
        spec.callsAreFunctions = false
        return spec
    }()

    static let rust: Spec = {
        var spec = Spec()
        spec.quotes = ["\""]
        spec.multilineQuotes = ["\""]
        spec.keywords = [
            "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
            "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref",
            "return", "static", "struct", "super", "trait", "type", "unsafe", "use", "where", "while",
            "Self", "macro_rules", "yield",
            // The Mac's Rust grammar colours the primitives as keywords.
            "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize",
            "f32", "f64", "bool", "char", "str",
        ]
        spec.constants = ["true", "false"]
        spec.special = ["self"]
        spec.functionIntroducers = ["fn"]
        spec.typeIntroducers = ["struct", "enum", "trait", "type", "union"]
        spec.rustLifetimes = true
        return spec
    }()

    static let swift: Spec = {
        var spec = Spec()
        spec.quotes = ["\"\"\"", "\""]
        spec.multilineQuotes = ["\"\"\""]
        spec.keywords = [
            "actor", "any", "as", "associatedtype", "async", "await", "break", "case", "catch", "class",
            "continue", "default", "defer", "deinit", "do", "else", "enum", "extension", "fallthrough",
            "fileprivate", "final", "for", "func", "guard", "if", "import", "in", "init", "inout",
            "internal", "is", "lazy", "let", "mutating", "nonisolated", "open", "operator", "override",
            "private", "protocol", "public", "repeat", "required", "rethrows", "return", "some",
            "static", "struct", "subscript", "super", "switch", "throw", "throws", "try", "typealias",
            "var", "weak", "where", "while", "Self", "consuming", "borrowing", "sending",
        ]
        spec.constants = ["true", "false", "nil"]
        spec.special = ["self"]
        spec.functionIntroducers = ["func"]
        spec.typeIntroducers = ["struct", "class", "enum", "protocol", "extension", "actor", "typealias"]
        spec.atWords = .keyword
        spec.interpolation = .backslashParen
        return spec
    }()

    static let kotlin: Spec = {
        var spec = Spec()
        spec.quotes = ["\"\"\"", "\"", "'"]
        spec.multilineQuotes = ["\"\"\""]
        spec.keywords = [
            "abstract", "as", "break", "by", "catch", "class", "companion", "const", "continue", "data",
            "do", "else", "enum", "external", "final", "finally", "for", "fun", "if", "import", "in",
            "init", "inline", "interface", "internal", "is", "lateinit", "object", "open", "operator",
            "out", "override", "package", "private", "protected", "public", "return", "sealed",
            "suspend", "throw", "try", "typealias", "val", "var", "vararg", "when", "where", "while",
        ]
        spec.constants = ["true", "false", "null"]
        spec.special = ["this"]
        spec.functionIntroducers = ["fun"]
        spec.interpolation = .dollar
        spec.typeIntroducers = ["class", "interface", "object", "typealias"]
        spec.atWords = .attribute
        return spec
    }()

    static let python: Spec = {
        var spec = Spec()
        spec.lineComments = ["#"]
        spec.blockComments = []
        spec.quotes = ["\"\"\"", "'''", "\"", "'"]
        spec.multilineQuotes = ["\"\"\"", "'''"]
        spec.keywords = [
            "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
            "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
            "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "match",
            "case",
        ]
        spec.types = ["int", "float", "str", "bool", "bytes", "list", "dict", "set", "tuple", "object"]
        spec.constants = ["True", "False", "None"]
        spec.special = ["self", "cls"]
        spec.functionIntroducers = ["def"]
        spec.typeIntroducers = ["class"]
        spec.pythonDocstrings = true
        spec.atWords = .attribute
        return spec
    }()

    static let go: Spec = {
        var spec = Spec()
        spec.quotes = ["\"", "'", "`"]
        spec.rawQuotes = ["`"]
        spec.multilineQuotes = ["`"]
        spec.keywords = [
            "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for",
            "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return",
            "select", "struct", "switch", "type", "var",
        ]
        spec.types = [
            "bool", "byte", "complex64", "complex128", "error", "float32", "float64", "int", "int8",
            "int16", "int32", "int64", "rune", "string", "uint", "uint8", "uint16", "uint32", "uint64",
            "uintptr", "any",
        ]
        spec.constants = ["true", "false", "nil", "iota"]
        spec.functionIntroducers = ["func"]
        spec.typeIntroducers = ["type"]
        spec.capitalisedAreTypes = false
        return spec
    }()
}

// MARK: - The tokenizer

private let nl: UInt16 = 10
private func ascii(_ c: Character) -> UInt16 { UInt16(c.asciiValue!) }

private func isLetter(_ u: UInt16) -> Bool { (u >= 65 && u <= 90) || (u >= 97 && u <= 122) || u == 95 || u >= 0x80 }
private func isDigit(_ u: UInt16) -> Bool { u >= 48 && u <= 57 }
private func isWordChar(_ u: UInt16) -> Bool { isLetter(u) || isDigit(u) }
private func isUpper(_ u: UInt16) -> Bool { u >= 65 && u <= 90 }
private func isLower(_ u: UInt16) -> Bool { u >= 97 && u <= 122 }
private func isSpace(_ u: UInt16) -> Bool { u == 32 || u == 9 || u == 13 }

struct Lexer {
    let u: [UInt16]
    var i = 0
    private var runs: [CodeRun] = []
    /// Where the plain text not yet in `runs` starts.
    private var plainFrom = 0
    /// TOML arrays still open at a line's end, whose next lines are values.
    private var tomlArrays = 0

    init(units: [UInt16]) { self.u = units }

    func at(_ k: Int) -> UInt16 { k < u.count && k >= 0 ? u[k] : 0 }

    func starts(_ s: String, at k: Int) -> Bool {
        var k = k
        for unit in s.utf16 {
            guard k < u.count, u[k] == unit else { return false }
            k += 1
        }
        return true
    }

    func text(_ a: Int, _ b: Int) -> String { String(decoding: u[a ..< b], as: UTF16.self) }

    /// Marks `a..<b` as `token`; what's between the last mark and `a` is plain.
    mutating func mark(_ a: Int, _ b: Int, _ token: CodeToken?) {
        guard b > a else { return }
        if a > plainFrom { append(nil, text(plainFrom, a)) }
        append(token, text(a, b))
        plainFrom = b
    }

    private mutating func append(_ token: CodeToken?, _ piece: String) {
        if let last = runs.last, last.token == token {
            runs[runs.count - 1].text += piece
        } else {
            runs.append(CodeRun(token, piece))
        }
    }

    mutating func finish() -> [CodeRun] {
        if plainFrom < u.count { append(nil, text(plainFrom, u.count)) }
        return runs
    }

    func lineEnd(from k: Int) -> Int {
        var k = k
        while k < u.count, u[k] != nl { k += 1 }
        return k
    }

    func wordEnd(from k: Int, dollar: Bool = false) -> Int {
        var k = k
        while k < u.count, isWordChar(u[k]) || (dollar && u[k] == 36) { k += 1 }
        return k
    }

    func nextNonSpace(from k: Int) -> Int {
        var k = k
        while k < u.count, isSpace(u[k]) { k += 1 }
        return k
    }

    /// Whether only spaces come before `k` on its line.
    func lineStartsAt(_ k: Int) -> Bool {
        var j = k - 1
        while j >= 0, u[j] != nl {
            if !isSpace(u[j]) { return false }
            j -= 1
        }
        return true
    }

    /// A number from `i`: digits, letters (hex, suffixes, exponents) and a
    /// point followed by a digit, but not a range's `..`.
    mutating func number() {
        let start = i
        i += 1
        while i < u.count {
            let c = u[i]
            if isWordChar(c) {
                i += 1
            } else if c == ascii("."), isDigit(at(i + 1)) {
                i += 1
            } else if c == ascii("-") || c == ascii("+"), u[i - 1] == ascii("e") || u[i - 1] == ascii("E"),
                      isDigit(at(i + 1)), !(u[start] == ascii("0") && (at(start + 1) == ascii("x") || at(start + 1) == ascii("X")))
            {
                // 1e-5, but not 0x1e-5.
                i += 1
            } else {
                break
            }
        }
        mark(start, i, .number)
    }

    /// A string opened by `quote` at `i`, with escapes picked out unless it's
    /// raw; a single-line quote stops at the line's end.
    mutating func string(_ quote: String, raw: Bool, multiline: Bool, as token: CodeToken = .string,
                         interpolation: Interpolation? = nil)
    {
        let quoteLength = quote.utf16.count
        var start = i
        i += quoteLength
        while i < u.count {
            if starts(quote, at: i) {
                i += quoteLength
                break
            }
            if u[i] == nl, !multiline { break }
            if let interpolation, let end = interpolationEnd(interpolation, at: i) {
                // What's interpolated is code, plain here as on the Mac.
                mark(start, i, token)
                i = end
                start = i
                continue
            }
            if !raw, u[i] == ascii("\\"), i + 1 < u.count, u[i + 1] != nl {
                mark(start, i, token)
                // Never between the halves of a surrogate pair.
                let escapeEnd = min(u.count, (0xD800 ... 0xDBFF).contains(u[i + 1]) ? i + 3 : i + 2)
                mark(i, escapeEnd, token == .string ? .escape : token)
                i = escapeEnd
                start = i
                continue
            }
            i += 1
        }
        mark(start, i, token)
    }

    enum Interpolation { case dollar, dollarBrace, backslashParen }

    /// Where an interpolation starting at `k` ends: `$name` and `${…}` in a
    /// shell or Kotlin, `${…}` in a template literal, `\(…)` in Swift.
    func interpolationEnd(_ kind: Interpolation, at k: Int) -> Int? {
        let open: UInt16, close: UInt16
        switch kind {
        case .dollar where at(k) == ascii("$") && isLetter(at(k + 1)):
            return wordEnd(from: k + 1)
        case .dollar, .dollarBrace:
            guard at(k) == ascii("$"), at(k + 1) == ascii("{") else { return nil }
            (open, close) = (ascii("{"), ascii("}"))
        case .backslashParen:
            guard at(k) == ascii("\\"), at(k + 1) == ascii("(") else { return nil }
            (open, close) = (ascii("("), ascii(")"))
        }
        var depth = 0
        var j = k + 1
        while j < u.count, u[j] != nl {
            if u[j] == open { depth += 1 }
            if u[j] == close {
                depth -= 1
                if depth == 0 { return j + 1 }
            }
            j += 1
        }
        return nil
    }

    // MARK: C-like, shell, SQL, Python, JSON

    mutating func code(_ spec: Spec) {
        /// What the last word asked of the next name: a function's or a type's.
        var expect: CodeToken?
        /// The last character that wasn't a space, for telling a JSX tag
        /// from a less-than and a member from a word.
        var previous: UInt16 = nl
        var inJSXTag = false
        var jsxBraces = 0
        var commandPosition = true

        while i < u.count {
            let c = u[i]
            let start = i

            if c == nl {
                i += 1
                previous = nl
                if spec.shell { commandPosition = true }
                continue
            }
            if isSpace(c) {
                i += 1
                continue
            }
            if let comment = spec.blockComments.first(where: { starts($0.0, at: i) }) {
                var k = i + comment.0.utf16.count
                while k < u.count, !starts(comment.1, at: k) { k += 1 }
                i = min(u.count, k + comment.1.utf16.count)
                mark(start, i, .comment)
                continue
            }
            if spec.lineComments.contains(where: { starts($0, at: i) })
                || (spec.hashComment && c == ascii("#") && (start == 0 || isSpace(u[start - 1]) || u[start - 1] == nl))
            {
                i = lineEnd(from: i)
                mark(start, i, .comment)
                continue
            }
            if spec.rustLifetimes, c == ascii("'") {
                // 'a is a lifetime, 'a' and '\n' are characters.
                if isLetter(at(i + 1)), at(i + 2) != ascii("'") {
                    i = wordEnd(from: i + 1)
                    mark(start, i, .keyword)
                    previous = ascii("a")
                    continue
                }
                string("'", raw: false, multiline: false)
                previous = ascii("'")
                continue
            }
            if let quote = spec.quotes.first(where: { starts($0, at: i) }) {
                let docstring = spec.pythonDocstrings && quote.utf16.count == 3 && lineStartsAt(start)
                let interpolation: Interpolation? = switch quote {
                case "\"", "\"\"\"": spec.interpolation
                case "`": spec.identifierDollar ? .dollarBrace : nil
                default: nil
                }
                string(quote, raw: spec.rawQuotes.contains(quote), multiline: spec.multilineQuotes.contains(quote),
                       as: docstring ? .comment : .string, interpolation: interpolation)
                previous = ascii("\"")
                commandPosition = false
                continue
            }
            if isDigit(c) || (c == ascii(".") && isDigit(at(i + 1)) && !isWordChar(previous) && previous != ascii(".")) {
                if spec.shell, commandPosition {
                    // A word in a command's place, like ./run.sh or 7z.
                } else {
                    number()
                    previous = ascii("0")
                    continue
                }
            }
            if spec.shell {
                if c == ascii("$") {
                    // $VAR, ${VAR}, $(cmd): plain, as on the Mac, but a
                    // $(…) starts a new command.
                    if at(i + 1) == ascii("(") {
                        i += 2
                        commandPosition = true
                    } else {
                        i += 1
                        i = wordEnd(from: i)
                    }
                    previous = ascii("$")
                    continue
                }
                if c == ascii("|") || c == ascii(";") || c == ascii("&") || c == ascii("(") || c == ascii("`") {
                    // A new command follows, but not after a redirect's
                    // >& or &>.
                    commandPosition = !(c == ascii("&") && (previous == ascii(">") || at(i + 1) == ascii(">")))
                    if c == ascii("&") || c == ascii("|"), at(i + 1) == c { i += 1 }
                    i += 1
                    previous = c
                    continue
                }
                if commandPosition, !isSpace(c) {
                    // The command: a word up to a space or an operator.
                    var k = i
                    while k < u.count, !isSpace(u[k]), u[k] != nl, u[k] != ascii(";"), u[k] != ascii("|"),
                          u[k] != ascii("&"), u[k] != ascii(")"), u[k] != ascii("\""), u[k] != ascii("'")
                    {
                        k += 1
                    }
                    let word = text(i, k)
                    i = k
                    if spec.keywords.contains(word) {
                        mark(start, i, .keyword)
                        // `if`, `then`, `do` and the like start a command again.
                        commandPosition = !["in", "function", "export", "local", "readonly", "declare", "for", "case", "select"].contains(word)
                    } else if word.contains("=") || word.hasPrefix("[") || word.hasPrefix("-") {
                        // An assignment, a test or a flag: plain.
                        commandPosition = word.contains("=")
                    } else if isLetter(c) || c == ascii(".") || c == ascii("/") || c == ascii("~") || isDigit(c) {
                        mark(start, i, .function)
                        commandPosition = false
                    } else {
                        commandPosition = false
                    }
                    previous = ascii("a")
                    continue
                }
                if isLetter(c) {
                    i = wordEnd(from: i)
                    if spec.keywords.contains(text(start, i)), ["then", "do", "else", "in", "esac", "fi", "done"].contains(text(start, i)) {
                        mark(start, i, .keyword)
                        commandPosition = text(start, i) != "in"
                    }
                    previous = ascii("a")
                    continue
                }
                i += 1
                previous = c
                continue
            }
            if spec.jsx, c == ascii("<") {
                // <div …> or </div>, not a less-than or a type's <T>.
                let slash = at(i + 1) == ascii("/")
                let nameStart = slash ? i + 2 : i + 1
                // A closing tag can follow anything; an opening one only what
                // can't end a value.
                if isLetter(at(nameStart)), slash || (!isWordChar(previous) && previous != ascii(")") && previous != ascii("]")) {
                    let nameEnd = wordEndJSX(from: nameStart)
                    mark(nameStart, nameEnd, .tag)
                    i = nameEnd
                    inJSXTag = true
                    jsxBraces = 0
                    previous = ascii("a")
                    continue
                }
            }
            if inJSXTag {
                if c == ascii("{") { jsxBraces += 1 }
                if c == ascii("}") { jsxBraces -= 1 }
                if c == ascii(">"), jsxBraces <= 0 {
                    inJSXTag = false
                    i += 1
                    previous = nl
                    continue
                }
                if jsxBraces <= 0, isLetter(c) {
                    i = wordEndJSX(from: i)
                    mark(start, i, .attribute)
                    previous = ascii("a")
                    continue
                }
            }
            if spec.arrowIsKeyword, c == ascii("="), at(i + 1) == ascii(">") {
                i += 2
                mark(start, i, .keyword)
                previous = ascii(">")
                continue
            }
            if c == ascii("@"), let token = spec.atWords, isLetter(at(i + 1)) {
                i = wordEnd(from: i + 1)
                while at(i) == ascii("."), isLetter(at(i + 1)) { i = wordEnd(from: i + 1) }
                mark(start, i, token)
                previous = ascii("a")
                continue
            }
            if isLetter(c) || (spec.identifierDollar && c == ascii("$")) {
                i = wordEnd(from: i, dollar: spec.identifierDollar)
                let word = text(start, i)
                let key = spec.caseInsensitive ? word.lowercased() : word
                let afterDot = previous == ascii(".")
                var token: CodeToken?
                if !afterDot, spec.keywords.contains(key) {
                    token = .keyword
                    if spec.functionIntroducers.contains(key) {
                        expect = .function
                    } else if spec.typeIntroducers.contains(key) {
                        expect = .type
                    }
                    mark(start, i, token)
                    // A space, so `return <div>` is still a tag.
                    previous = 32
                    continue
                }
                if !afterDot, spec.constants.contains(key) {
                    token = .constant
                } else if !afterDot, spec.special.contains(key) {
                    token = .variable
                } else if !afterDot, spec.types.contains(key) {
                    token = .type
                } else if let expected = expect {
                    token = expected
                } else if spec.callsAreFunctions, at(i) == ascii("(") {
                    token = .function
                } else if spec.capitalisedAreTypes, isUpper(c), u[start ..< i].contains(where: isLower) {
                    token = .type
                }
                expect = nil
                mark(start, i, token)
                previous = ascii("a")
                continue
            }
            // Generic parameters and the like don't end what `fn` or `class` expects.
            if c != ascii("<") && c != ascii("*") { expect = nil }
            i += 1
            previous = c
        }
    }

    /// A JSX tag or attribute name: letters, digits, `-`, `.` and `:`.
    func wordEndJSX(from k: Int) -> Int {
        var k = k
        while k < u.count, isWordChar(u[k]) || u[k] == ascii("-") || u[k] == ascii(".") || u[k] == ascii(":") { k += 1 }
        return k
    }

    // MARK: YAML and TOML

    /// A scalar after a key or a list's dash: a number, a constant, a quoted
    /// or a bare string (bare ones are strings on the Mac too), up to a
    /// comment.
    mutating func yamlValue(end: Int) {
        var k = nextNonSpace(from: i)
        i = k
        guard k < end else { return }
        let c = u[k]
        if c == ascii("\"") || c == ascii("'") {
            string(c == ascii("\"") ? "\"" : "'", raw: c == ascii("'"), multiline: false)
            comment(upTo: end)
            return
        }
        if c == ascii("[") || c == ascii("{") {
            // A flow list or map: its items, one at a time.
            while i < end {
                let d = u[i]
                if d == ascii("\"") || d == ascii("'") {
                    string(d == ascii("\"") ? "\"" : "'", raw: d == ascii("'"), multiline: false)
                } else if d == ascii("#"), isSpace(at(i - 1)) {
                    mark(i, end, .comment)
                    i = end
                } else if isWordChar(d) || d == ascii("-") || d == ascii(".") {
                    let s = i
                    while i < end, ![ascii(","), ascii("]"), ascii("}"), ascii(":")].contains(u[i]) { i += 1 }
                    var e = i
                    while e > s, isSpace(u[e - 1]) { e -= 1 }
                    if at(i) == ascii(":") {
                        mark(s, e, .tag)
                    } else {
                        mark(s, e, scalarToken(text(s, e)))
                    }
                } else {
                    i += 1
                }
            }
            return
        }
        if c == ascii("|") || c == ascii(">") || c == ascii("&") || c == ascii("*") || c == ascii("!") {
            // Block scalar markers, anchors, aliases and tags.
            k = i
            while k < end, !isSpace(u[k]) { k += 1 }
            mark(i, k, c == ascii("!") ? .type : .keyword)
            i = k
            yamlValue(end: end)
            return
        }
        if c == ascii("#") {
            comment(upTo: end)
            return
        }
        // Up to a " #" comment.
        var e = k
        while e < end, !(u[e] == ascii("#") && isSpace(at(e - 1))) { e += 1 }
        var valueEnd = e
        while valueEnd > k, isSpace(u[valueEnd - 1]) { valueEnd -= 1 }
        mark(k, valueEnd, scalarToken(text(k, valueEnd)))
        i = e
        comment(upTo: end)
    }

    func scalarToken(_ value: String) -> CodeToken {
        switch value {
        case "true", "false", "True", "False", "yes", "no", "on", "off", "null", "~", "Null", "NULL": return .constant
        default: break
        }
        if let first = value.utf16.first, isDigit(first) || ((first == ascii("-") || first == ascii(".")) && value.utf16.count > 1),
           Double(value.replacingOccurrences(of: "_", with: "")) != nil || value.hasPrefix("0x")
        {
            return .number
        }
        return .string
    }

    mutating func comment(upTo end: Int) {
        let k = nextNonSpace(from: i)
        if k < end, u[k] == ascii("#") {
            mark(k, end, .comment)
            i = end
        }
    }

    mutating func yaml() {
        while i < u.count {
            let end = lineEnd(from: i)
            i = nextNonSpace(from: i)
            // List dashes.
            while i + 1 <= end, at(i) == ascii("-"), i + 1 == end || isSpace(at(i + 1)) {
                i = nextNonSpace(from: i + 1)
            }
            if i < end, u[i] == ascii("#") {
                mark(i, end, .comment)
            } else if starts("---", at: i) || starts("...", at: i) {
                // A document marker: plain.
            } else if i < end, let colon = keyColon(from: i, end: end) {
                var keyEnd = colon
                while keyEnd > i, isSpace(u[keyEnd - 1]) { keyEnd -= 1 }
                // On the Mac a bare `on:` is a boolean, every other key a tag.
                let key = text(i, keyEnd)
                mark(i, keyEnd, ["on", "off", "yes", "no", "true", "false"].contains(key) ? .constant : .tag)
                i = colon + 1
                yamlValue(end: end)
            } else if i < end {
                yamlValue(end: end)
            }
            i = end + 1
        }
    }

    /// Where a `key:` line's colon is: followed by a space or the line's end,
    /// outside quotes.
    func keyColon(from k: Int, end: Int) -> Int? {
        var k = k
        if u[k] == ascii("\"") || u[k] == ascii("'") {
            let q = u[k]
            k += 1
            while k < end, u[k] != q { k += 1 }
            k += 1
        }
        while k < end {
            if u[k] == ascii(":"), k + 1 == end || isSpace(at(k + 1)) { return k }
            if u[k] == ascii("#"), isSpace(at(k - 1)) { return nil }
            if u[k] == ascii("\"") || u[k] == ascii("'") || u[k] == ascii("[") || u[k] == ascii("{") { return nil }
            k += 1
        }
        return nil
    }

    mutating func toml() {
        while i < u.count {
            let end = lineEnd(from: i)
            i = nextNonSpace(from: i)
            if i < end, u[i] == ascii("#") {
                mark(i, end, .comment)
            } else if i < end, tomlArrays > 0 {
                tomlPairs(end: end, expectKey: false)
            } else if i < end, u[i] == ascii("[") {
                // A table header: plain on the Mac, with a trailing comment.
                while i < end, u[i] != ascii("#") { i += 1 }
                if i < end { mark(i, end, .comment) }
            } else if i < end {
                tomlPairs(end: end)
            }
            i = end + 1
        }
    }

    /// `key = value` pairs, also inside `{ … }` on one line.
    mutating func tomlPairs(end: Int, expectKey startsWithKey: Bool = true) {
        var expectKey = startsWithKey
        while i < end {
            let c = u[i]
            if isSpace(c) || c == ascii(",") || c == ascii("{") || c == ascii("}") || c == ascii("[") || c == ascii("]") {
                if c == ascii("[") { tomlArrays += 1 }
                if c == ascii("]") { tomlArrays = max(0, tomlArrays - 1) }
                if c == ascii(",") || c == ascii("{") { expectKey = c == ascii("{") || inInlineTable(before: i) }
                i += 1
                continue
            }
            if c == ascii("#") {
                mark(i, end, .comment)
                i = end
                return
            }
            if c == ascii("=") {
                expectKey = false
                i += 1
                continue
            }
            if c == ascii("\"") || c == ascii("'") {
                let triple = starts(c == ascii("\"") ? "\"\"\"" : "'''", at: i)
                let quote = c == ascii("\"") ? (triple ? "\"\"\"" : "\"") : (triple ? "'''" : "'")
                string(quote, raw: c == ascii("'"), multiline: triple, as: expectKey ? .tag : .string)
                continue
            }
            let s = i
            while i < end, !isSpace(u[i]), ![ascii("="), ascii(","), ascii("}"), ascii("]"), ascii("#")].contains(u[i]) { i += 1 }
            if expectKey {
                mark(s, i, .tag)
            } else {
                let value = text(s, i)
                mark(s, i, value == "true" || value == "false" ? .constant : (isDigit(u[s]) || u[s] == ascii("-") || u[s] == ascii("+")) ? .number : nil)
            }
        }
    }

    func inInlineTable(before k: Int) -> Bool {
        var depth = 0
        var k = k - 1
        while k >= 0, u[k] != nl {
            if u[k] == ascii("}") || u[k] == ascii("]") { depth -= 1 }
            if u[k] == ascii("{") { if depth == 0 { return true }; depth += 1 }
            if u[k] == ascii("[") { if depth == 0 { return false }; depth += 1 }
            k -= 1
        }
        return false
    }

    // MARK: Diff

    mutating func diff() {
        while i < u.count {
            let end = lineEnd(from: i)
            let c = at(i)
            if starts("+++", at: i) || starts("---", at: i) || starts("diff ", at: i) || starts("index ", at: i) {
                mark(i, end, .strong)
            } else if starts("@@", at: i) {
                mark(i, end, .type)
            } else if c == ascii("+") {
                mark(i, end, .inserted)
            } else if c == ascii("-") {
                mark(i, end, .deleted)
            }
            i = end + 1
        }
    }

    // MARK: Markdown

    mutating func markdown() {
        var inFence = false
        while i < u.count {
            let end = lineEnd(from: i)
            let k = nextNonSpace(from: i)
            if starts("```", at: k) || starts("~~~", at: k) {
                inFence.toggle()
                mark(k, end, .literal)
            } else if inFence {
                mark(i, end, .literal)
            } else if at(k) == ascii("#") {
                var h = k
                while at(h) == ascii("#") { h += 1 }
                if h == end || isSpace(at(h)) {
                    mark(nextNonSpace(from: h), end, .title)
                } else {
                    i = k
                    markdownInline(end: end)
                }
            } else {
                i = k
                markdownInline(end: end)
            }
            i = end + 1
        }
    }

    mutating func markdownInline(end: Int) {
        while i < end {
            let c = u[i]
            if c == ascii("`") {
                var k = i + 1
                while k < end, u[k] != ascii("`") { k += 1 }
                if k < end {
                    mark(i + 1, k, .literal)
                    i = k + 1
                    continue
                }
            }
            if starts("**", at: i) || starts("__", at: i) {
                let marker = text(i, i + 2)
                if let close = find(marker, from: i + 2, end: end), close > i + 2 {
                    mark(i + 2, close, .strong)
                    i = close + 2
                    continue
                }
            }
            if c == ascii("*") || (c == ascii("_") && !isWordChar(at(i - 1))), !isSpace(at(i + 1)), at(i + 1) != c, i + 1 < end {
                if let close = find(text(i, i + 1), from: i + 1, end: end), close > i + 1 {
                    mark(i + 1, close, .emphasis)
                    i = close + 1
                    continue
                }
            }
            if c == ascii("]"), at(i + 1) == ascii("(") {
                if let close = find(")", from: i + 2, end: end) {
                    mark(i + 2, close, .link)
                    i = close + 1
                    continue
                }
            }
            i += 1
        }
    }

    func find(_ s: String, from k: Int, end: Int) -> Int? {
        var k = k
        while k < end {
            if starts(s, at: k) { return k }
            k += 1
        }
        return nil
    }

    // MARK: HTML

    mutating func html() {
        while i < u.count {
            let c = u[i]
            if starts("<!--", at: i) {
                let start = i
                i = find("-->", from: i + 4, end: u.count).map { $0 + 3 } ?? u.count
                mark(start, i, .comment)
            } else if c == ascii("<"), at(i + 1) == ascii("!") || at(i + 1) == ascii("?") {
                // <!DOCTYPE html>, <?xml …?>
                let nameEnd = wordEndJSX(from: i + 2)
                mark(i + 2, nameEnd, .keyword)
                i = nameEnd
                tagAttributes(as: .constant)
            } else if c == ascii("<"), isLetter(at(i + 1)) || (at(i + 1) == ascii("/") && isLetter(at(i + 2))) {
                let nameStart = at(i + 1) == ascii("/") ? i + 2 : i + 1
                let nameEnd = wordEndJSX(from: nameStart)
                mark(nameStart, nameEnd, .tag)
                i = nameEnd
                tagAttributes()
            } else if c == ascii("&") {
                var k = i + 1
                while k < u.count, k - i < 12, isWordChar(u[k]) || u[k] == ascii("#") { k += 1 }
                if at(k) == ascii(";"), k > i + 1 {
                    mark(i + 1, k, .constant)
                    i = k + 1
                } else {
                    i += 1
                }
            } else {
                i += 1
            }
        }
    }

    /// A tag's attributes up to its `>`; a doctype's words are constants.
    mutating func tagAttributes(as token: CodeToken = .attribute) {
        while i < u.count, u[i] != ascii(">") {
            let c = u[i]
            if c == ascii("\"") || c == ascii("'") {
                string(c == ascii("\"") ? "\"" : "'", raw: true, multiline: true)
            } else if isLetter(c) {
                let s = i
                i = wordEndJSX(from: i)
                mark(s, i, token)
            } else if c == ascii("<") {
                return
            } else {
                i += 1
            }
        }
        i += 1
    }

    // MARK: CSS

    mutating func css() {
        /// Inside a rule's braces, and whether before or after the colon.
        var depthInRule = 0
        var inValue = false
        var depth = 0
        var parens = 0
        /// Whether the statement under way is a declaration, worked out at
        /// its first word so the look ahead happens once a statement.
        var statementIsDeclaration: Bool?
        while i < u.count {
            let c = u[i]
            let start = i
            if starts("/*", at: i) {
                i = find("*/", from: i + 2, end: u.count).map { $0 + 2 } ?? u.count
                mark(start, i, .comment)
                continue
            }
            if starts("//", at: i), i == 0 || isSpace(at(i - 1)) || at(i - 1) == nl {
                i = lineEnd(from: i)
                mark(start, i, .comment)
                continue
            }
            if c == ascii("\"") || c == ascii("'") {
                string(c == ascii("\"") ? "\"" : "'", raw: false, multiline: false)
                continue
            }
            if c == ascii("{") || c == ascii("}") || c == ascii(";") {
                if c != ascii(";") {
                    depth += c == ascii("{") ? 1 : -1
                    depthInRule = depth
                }
                inValue = false
                statementIsDeclaration = nil
                i += 1
                continue
            }
            if c == ascii("(") { parens += 1 }
            if c == ascii(")") { parens -= 1 }
            if c == ascii("@"), isLetter(at(i + 1)) {
                i = wordEndCSS(from: i + 1)
                mark(start + 1, i, .keyword)
                continue
            }
            if c == ascii("!"), isLetter(at(i + 1)) {
                i = wordEndCSS(from: i + 1)
                mark(start, i, .keyword)
                continue
            }
            // Is this a declaration (property: value) or a selector? A nested
            // rule's selector looks like a property, so look for its colon.
            if statementIsDeclaration == nil, !isSpace(c), c != nl {
                statementIsDeclaration = depthInRule > 0 && declarationAhead(from: i)
            }
            let declaring = inValue || statementIsDeclaration == true || parens > 0
            if c == ascii(":"), declaring {
                inValue = true
                i += 1
                continue
            }
            if declaring {
                if inValue {
                    if c == ascii("#"), isWordChar(at(i + 1)) {
                        i = wordEnd(from: i + 1)
                        mark(start + 1, i, .constant)
                        continue
                    }
                    if isDigit(c) || (c == ascii(".") && isDigit(at(i + 1))) || (c == ascii("-") && isDigit(at(i + 1))) {
                        i += 1
                        while i < u.count, isDigit(u[i]) || u[i] == ascii(".") { i += 1 }
                        mark(start, i, .number)
                        let unitStart = i
                        while i < u.count, isLetter(u[i]) || u[i] == ascii("%") { i += 1 }
                        mark(unitStart, i, .keyword)
                        continue
                    }
                    if isLetter(c) || c == ascii("-") {
                        i = wordEndCSS(from: i)
                        mark(start, i, at(i) == ascii("(") ? .function : .constant)
                        continue
                    }
                } else if isLetter(c) || c == ascii("-") {
                    i = wordEndCSS(from: i)
                    mark(start, i, .type)
                    continue
                }
                i += 1
                continue
            }
            // Selectors.
            if (c == ascii(".") || c == ascii("#")), isLetter(at(i + 1)) || at(i + 1) == ascii("-") {
                i = wordEndCSS(from: i + 1)
                mark(start + 1, i, .attribute)
                continue
            }
            if c == ascii(":") {
                // :hover, ::before: plain, as on the Mac.
                i += 1
                while at(i) == ascii(":") { i += 1 }
                i = wordEndCSS(from: i)
                continue
            }
            if isLetter(c) {
                i = wordEndCSS(from: i)
                mark(start, i, .tag)
                continue
            }
            i += 1
        }
    }

    func wordEndCSS(from k: Int) -> Int {
        var k = k
        while k < u.count, isWordChar(u[k]) || u[k] == ascii("-") { k += 1 }
        return k
    }

    /// Whether a `name:` here is a declaration: a colon before any `{`, `;`
    /// or `}`, not followed by a selector's `{`.
    func declarationAhead(from k: Int) -> Bool {
        var k = k
        var sawColon = false
        while k < u.count {
            let c = u[k]
            if c == ascii(";") || c == ascii("}") { return sawColon }
            if c == ascii("{") { return false }
            if c == ascii(":") { sawColon = true }
            if c == nl, sawColon { return true }
            k += 1
        }
        return sawColon
    }
}
