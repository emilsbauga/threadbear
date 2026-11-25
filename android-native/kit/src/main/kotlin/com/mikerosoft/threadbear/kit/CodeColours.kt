package com.mikerosoft.threadbear.kit

/**
 * Colours for a code block's body, by its fence language: a small
 * hand-written tokenizer per language family, so it needs no grammar files
 * or network and runs in one pass. The Mac colours with syntect's Sublime
 * grammars; this aims at the same marks (keywords, strings, numbers,
 * comments, functions, types...) rather than every scope, and the app maps
 * each [CodeStyle] to the Mac theme's colour for that name.
 *
 * A language it doesn't know, a bare fence, or a block past [MAX_CHARS]
 * gets no spans and is drawn plain.
 */
object CodeColours {
    /** Past this a block is drawn plain, so a pasted log can't stall a frame. */
    const val MAX_CHARS = 20_000

    /** Spans in order, not overlapping; text between them is plain. */
    fun spans(code: String, language: String?): List<CodeSpan> {
        if (code.length > MAX_CHARS) return emptyList()
        val lang = languageFor(language) ?: return emptyList()
        val out = Spans()
        when (lang) {
            Lang.YAML -> yaml(code, out)
            Lang.TOML -> toml(code, out)
            Lang.HTML -> html(code, out)
            Lang.CSS -> css(code, out)
            Lang.DIFF -> diff(code, out)
            Lang.MARKDOWN -> markdown(code, out)
            else -> Lexer(code, lang.lexSpec, out).run(0, code.length)
        }
        return out.list
    }

    /** Whether a fence word gets colours. */
    fun supports(language: String?): Boolean = languageFor(language) != null

    internal fun languageFor(word: String?): Lang? = word?.lowercase()?.let { ALIASES[it] }
}

enum class CodeStyle { Keyword, Str, Escape, Number, Constant, Comment, Function, Type, Property, Tag, Attribute, Heading, Literal, Special, Inserted, Deleted }

data class CodeSpan(val start: Int, val end: Int, val style: CodeStyle)

internal class Spans {
    val list = ArrayList<CodeSpan>()
    fun add(start: Int, end: Int, style: CodeStyle) {
        if (end <= start) return
        val last = list.lastOrNull()
        if (last != null && last.style == style && last.end == start) list[list.size - 1] = last.copy(end = end)
        else list.add(CodeSpan(start, end, style))
    }
}

private fun words(s: String) = s.split(' ').filter { it.isNotEmpty() }.toHashSet()

/** How a C-like language reads: its words, comments and quotes. */
internal class Spec(
    val keywords: Set<String>,
    val types: Set<String> = emptySet(),
    val constants: Set<String> = words("true false null"),
    val special: Set<String> = emptySet(),
    /** Words that name the function or type after them. */
    val namesFunction: Set<String> = emptySet(),
    val namesType: Set<String> = emptySet(),
    val lineComments: List<String> = listOf("//"),
    val blockComment: Pair<String, String>? = "/*" to "*/",
    /** `'` opens a string; otherwise only a char literal ('a', '\n') and a Rust lifetime. */
    val singleQuoteStrings: Boolean = true,
    val tripleQuotes: List<String> = emptyList(),
    /** Backtick strings that may run over lines (JS templates, Go raw strings). */
    val backticks: Boolean = false,
    /** A Capitalised word is a type (Swift, Kotlin, Rust, TS). */
    val capsAreTypes: Boolean = false,
    val ignoreCase: Boolean = false,
    /** Characters past the first that keep a word going (shell's `-`). */
    val wordExtra: String = "",
    /** A string followed by `:` is a key (JSON). */
    val keysBeforeColon: Boolean = false,
    val jsx: Boolean = false,
    val shell: Boolean = false,
    /** `@name` is an annotation or decorator. */
    val atNames: Boolean = true,
)

internal enum class Lang(val spec: Spec?) {
    TS(
        Spec(
            keywords = words(
                "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends " +
                    "finally for from function get if implements import in instanceof interface keyof let namespace new of private protected " +
                    "public readonly return satisfies set static switch throw try type typeof var void while with yield",
            ),
            types = words("string number boolean any unknown never object symbol bigint Array Promise Record Map Set Partial Readonly"),
            constants = words("true false null undefined NaN Infinity"),
            special = words("this super"),
            namesFunction = words("function"),
            namesType = words("class interface type enum extends implements"),
            backticks = true, capsAreTypes = true, wordExtra = "$",
        ),
    ),
    TSX(null), // TS with JSX; built below
    SQL(
        Spec(
            keywords = words(
                "select from where and or not insert into values update set delete create table index view drop alter add column primary key " +
                    "foreign references unique default constraint join inner left right outer full cross on as group by order having limit " +
                    "offset distinct union all exists in is like between case when then else end asc desc returning with begin commit rollback " +
                    "transaction if replace cascade check grant revoke trigger database schema",
            ),
            types = words("int integer bigint smallint serial bigserial text varchar char boolean bool date time timestamp timestamptz real double numeric decimal json jsonb uuid blob float"),
            constants = words("true false null"),
            lineComments = listOf("--"), ignoreCase = true, atNames = false,
        ),
    ),
    SHELL(
        Spec(
            keywords = words("if then else elif fi for while until do done case esac in function return local export select time declare readonly"),
            constants = emptySet(),
            lineComments = listOf("#"), blockComment = null, wordExtra = "-./", shell = true, atNames = false,
        ),
    ),
    JSON(Spec(keywords = emptySet(), keysBeforeColon = true, atNames = false)),
    RUST(
        Spec(
            keywords = words(
                "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return " +
                    "static struct trait type unsafe use where while",
            ),
            types = words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Self"),
            constants = words("true false None Some Ok Err"),
            special = words("self super"),
            namesFunction = words("fn"), namesType = words("struct enum trait type impl"),
            singleQuoteStrings = false, capsAreTypes = true, atNames = false,
        ),
    ),
    SWIFT(
        Spec(
            keywords = words(
                "actor associatedtype async await break case catch class continue default defer do else enum extension fallthrough fileprivate " +
                    "final for func guard if import in init inout internal is let mutating nonisolated open operator override private protocol " +
                    "public repeat rethrows return some any static struct subscript switch throw throws try typealias var weak where while",
            ),
            types = words("Int Double Float String Bool Character Void Any"),
            constants = words("true false nil"),
            special = words("self Self super"),
            namesFunction = words("func"), namesType = words("class struct enum protocol extension actor typealias"),
            singleQuoteStrings = false, tripleQuotes = listOf("\"\"\""), capsAreTypes = true,
        ),
    ),
    KOTLIN(
        Spec(
            keywords = words(
                "abstract as break by catch class companion const constructor continue crossinline data do else enum external final finally " +
                    "for fun get if import in infix init inline inner interface internal is lateinit noinline object open operator out override " +
                    "package private protected public reified return sealed set suspend tailrec throw try typealias val var vararg when where while",
            ),
            types = words("Int Long Short Byte Double Float String Boolean Char Unit Any Nothing List Map Set"),
            constants = words("true false null"),
            special = words("this super it"),
            namesFunction = words("fun"), namesType = words("class interface object typealias"),
            singleQuoteStrings = false, tripleQuotes = listOf("\"\"\""), capsAreTypes = true,
        ),
    ),
    PYTHON(
        Spec(
            keywords = words(
                "and as assert async await break class continue def del elif else except finally for from global if import in is lambda " +
                    "nonlocal not or pass raise return try while with yield match case",
            ),
            types = words("int float str bool list dict set tuple bytes object type"),
            constants = words("True False None"),
            special = words("self cls"),
            namesFunction = words("def"), namesType = words("class"),
            lineComments = listOf("#"), blockComment = null, tripleQuotes = listOf("\"\"\"", "'''"),
        ),
    ),
    GO(
        Spec(
            keywords = words(
                "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return " +
                    "select struct switch type var",
            ),
            types = words("int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string bool byte rune error any"),
            constants = words("true false nil iota"),
            namesFunction = words("func"), namesType = words("type"),
            singleQuoteStrings = false, backticks = true, atNames = false,
        ),
    ),
    YAML(null), TOML(null), HTML(null), CSS(null), DIFF(null), MARKDOWN(null);

    companion object {
        val JSX_SPEC: Spec = TS.spec!!.let {
            Spec(
                keywords = it.keywords, types = it.types, constants = it.constants, special = it.special,
                namesFunction = it.namesFunction, namesType = it.namesType, backticks = true, capsAreTypes = true,
                wordExtra = "$", jsx = true,
            )
        }
    }
}

private val ALIASES: Map<String, Lang> = buildMap {
    for (w in listOf("ts", "typescript", "js", "javascript", "mjs", "cjs", "mts", "cts")) put(w, Lang.TS)
    for (w in listOf("tsx", "jsx")) put(w, Lang.TSX)
    put("sql", Lang.SQL)
    for (w in listOf("bash", "sh", "shell", "zsh")) put(w, Lang.SHELL)
    for (w in listOf("json", "jsonc", "json5")) put(w, Lang.JSON)
    for (w in listOf("yaml", "yml")) put(w, Lang.YAML)
    put("toml", Lang.TOML)
    for (w in listOf("rust", "rs")) put(w, Lang.RUST)
    put("swift", Lang.SWIFT)
    for (w in listOf("kotlin", "kt", "kts")) put(w, Lang.KOTLIN)
    for (w in listOf("python", "py")) put(w, Lang.PYTHON)
    for (w in listOf("go", "golang")) put(w, Lang.GO)
    for (w in listOf("html", "xml", "svg")) put(w, Lang.HTML)
    for (w in listOf("css", "scss")) put(w, Lang.CSS)
    for (w in listOf("diff", "patch")) put(w, Lang.DIFF)
    for (w in listOf("md", "markdown")) put(w, Lang.MARKDOWN)
}

private val Lang.lexSpec: Spec get() = if (this == Lang.TSX) Lang.JSX_SPEC else spec!!

/** `indexOf` that looks no further than `end`, so a stray quote can't make a pass quadratic. */
private fun String.indexIn(c: Char, from: Int, end: Int): Int {
    for (j in from until minOf(end, length)) if (this[j] == c) return j
    return -1
}

private fun isWordStart(c: Char) = c.isLetter() || c == '_'

/** One pass over a C-like language. */
private class Lexer(val s: String, val spec: Spec, val out: Spans) {
    private var i = 0
    /** The last thing that wasn't space, to tell `a < b` from a JSX tag. */
    private var prev = ' '
    private var prevWord: String? = null
    /** Inside `<tag ...>`: words are attributes until `>`. */
    private var inTag = false
    private var closingTag = false
    /** `{}` open inside the tag, where it's code again (`onClick={() => go()}`). */
    private var tagBraces = 0
    /** JSX nesting: [TAG] for an open element (its text is plain), else a `{}` expression's brace count. */
    private val jsx = ArrayDeque<Int>()
    /** A shell word here is the command run. */
    private var commandPos = true

    fun run(from: Int, to: Int) {
        i = from
        while (i < to) {
            val c = s[i]
            if (spec.jsx && !inTag && jsx.lastOrNull() == TAG) {
                // Text between tags is words, not code.
                when (c) {
                    '<' -> if (jsxTag(to)) continue
                    '{' -> jsx.addLast(1)
                }
                prev = '>'; prevWord = null
                i++; continue
            }
            if (c == '\n') {
                if (spec.shell) commandPos = true
                i++; continue
            }
            if (c.isWhitespace()) { i++; continue }
            if (comment(to)) continue
            if (string(to)) { after('"'); if (spec.shell) commandPos = false; continue }
            if (c.isDigit() || (c == '.' && i + 1 < to && s[i + 1].isDigit() && !prev.isLetterOrDigit())) { number(to); continue }
            if (spec.jsx && c == '<' && jsxTag(to)) continue
            if (spec.shell && c == '-' && (i == 0 || s[i - 1].isWhitespace())) {
                // A flag (`--in`, `-la`) is an argument, never a keyword.
                while (i < to && isWordChar(s[i])) i++
                after('a'); commandPos = false; continue
            }
            if (isWordStart(c) || (c == '$' && '$' in spec.wordExtra)) { word(to); continue }
            if (c == '@' && spec.atNames && i + 1 < to && isWordStart(s[i + 1])) {
                val start = i
                i++
                while (i < to && (s[i].isLetterOrDigit() || s[i] == '_' || s[i] == '.')) i++
                out.add(start, i, if (spec === Lang.PYTHON.spec) CodeStyle.Function else CodeStyle.Attribute)
                after('a'); continue
            }
            if (spec.shell) {
                if (c == '|' || c == ';' || c == '&' || c == '(' || c == '`') commandPos = true
                else if (c == '$') commandPos = false
            }
            if (spec.jsx) jsxPunctuation(c)
            after(c)
            i++
        }
    }

    private fun after(c: Char) { prev = c; prevWord = null }

    private fun jsxPunctuation(c: Char) {
        if (inTag) {
            if (c == '{') tagBraces++
            if (c == '}' && tagBraces > 0) tagBraces--
            if (c == '>' && prev != '=' && tagBraces == 0) {
                inTag = false
                when {
                    closingTag -> { while (jsx.isNotEmpty() && jsx.removeLast() != TAG) Unit }
                    prev != '/' -> if (jsx.size < 64) jsx.addLast(TAG)
                }
            }
            return
        }
        val top = jsx.lastOrNull() ?: return
        if (top == TAG) return
        if (c == '{') jsx[jsx.size - 1] = top + 1
        if (c == '}') { if (top <= 1) jsx.removeLast() else jsx[jsx.size - 1] = top - 1 }
    }

    private fun comment(to: Int): Boolean {
        for (lc in spec.lineComments) {
            if (!s.startsWith(lc, i)) continue
            // A `#` only starts a comment at a word's start (not shell's `$#` or a URL's `#frag`).
            if (lc == "#" && i > 0 && !s[i - 1].isWhitespace() && s[i - 1] != ';') return false
            val end = s.indexOf('\n', i).let { if (it < 0 || it > to) to else it }
            out.add(i, end, CodeStyle.Comment)
            i = end
            return true
        }
        val block = spec.blockComment ?: return false
        if (!s.startsWith(block.first, i)) return false
        val close = s.indexOf(block.second, i + block.first.length)
        val end = if (close < 0 || close + block.second.length > to) to else close + block.second.length
        out.add(i, end, CodeStyle.Comment)
        i = end
        return true
    }

    /** A string from `i`, if one starts here, with its escapes marked. */
    private fun string(to: Int): Boolean {
        val c = s[i]
        for (t in spec.tripleQuotes) {
            if (s.startsWith(t, i)) {
                val close = s.indexOf(t, i + 3)
                val end = if (close < 0 || close + 3 > to) to else close + 3
                body(i, end, escapes = true)
                i = end
                return true
            }
        }
        val multiline = c == '`' && spec.backticks
        when {
            c == '"' || multiline -> Unit
            c == '\'' && spec.singleQuoteStrings -> Unit
            c == '\'' -> return charOrLifetime(to)
            else -> return false
        }
        val start = i
        var j = i + 1
        // Shell's '...' and Go's `...` are raw.
        val escapes = !(spec.shell && c == '\'') && !(c == '`' && spec === Lang.GO.spec)
        while (j < to) {
            val d = s[j]
            if (d == '\\' && escapes) { j += 2; continue }
            if (d == c) { j++; break }
            if (d == '\n' && !multiline && !spec.shell) break
            j++
        }
        val end = minOf(j, to)
        if (spec.keysBeforeColon && c == '"' && nextNonSpace(end, to) == ':') out.add(start, end, CodeStyle.Property)
        else body(start, end, escapes)
        i = end
        return true
    }

    private fun body(start: Int, end: Int, escapes: Boolean) {
        if (!escapes) { out.add(start, end, CodeStyle.Str); return }
        var from = start
        var j = start
        while (j < end) {
            if (s[j] == '\\' && j + 1 < end) {
                out.add(from, j, CodeStyle.Str)
                out.add(j, j + 2, CodeStyle.Escape)
                j += 2
                from = j
            } else {
                j++
            }
        }
        out.add(from, end, CodeStyle.Str)
    }

    /** `'a'` and `'\n'` are chars; Rust's `'a` alone is a lifetime. */
    private fun charOrLifetime(to: Int): Boolean {
        val start = i
        if (i + 2 < to && s[i + 1] == '\\') {
            val close = s.indexIn('\'', i + 3, minOf(to, i + 12))
            if (close in 0 until minOf(to, i + 12)) { body(start, close + 1, true); i = close + 1; return true }
        }
        if (i + 2 < to && s[i + 2] == '\'') { out.add(start, i + 3, CodeStyle.Str); i += 3; return true }
        if (spec === Lang.RUST.spec && i + 1 < to && isWordStart(s[i + 1])) {
            var j = i + 1
            while (j < to && (s[j].isLetterOrDigit() || s[j] == '_')) j++
            out.add(start, j, CodeStyle.Keyword)
            i = j
            return true
        }
        return false
    }

    private fun number(to: Int) {
        val start = i
        i++
        while (i < to) {
            val d = s[i]
            if (d.isLetterOrDigit() || d == '_') i++
            else if (d == '.' && i + 1 < to && s[i + 1].isDigit()) i++
            else break
        }
        if (spec.shell) {
            commandPos = false
            // `v2.tar`, `1password-cli`: a word, not a number.
            if (i < to && s[i] in spec.wordExtra || s.substring(start, i).any { it.isLetter() }) {
                while (i < to && isWordChar(s[i])) i++
                after('a'); return
            }
        }
        out.add(start, i, CodeStyle.Number)
        after('0')
    }

    private fun isWordChar(c: Char) = c.isLetterOrDigit() || c == '_' || c in spec.wordExtra

    private fun word(to: Int) {
        val start = i
        i++
        while (i < to && isWordChar(s[i])) i++
        // Python's f"", b"", rb"": the prefix goes with the string.
        if (spec === Lang.PYTHON.spec && i - start <= 2 && i < to && (s[i] == '"' || s[i] == '\'') &&
            s.substring(start, i).all { it.lowercaseChar() in "rbfu" }
        ) {
            out.add(start, i, CodeStyle.Str)
            string(to)
            after('"')
            return
        }
        val w = s.substring(start, i)
        val key = if (spec.ignoreCase) w.lowercase() else w
        val next = nextNonSpace(i, to)
        val before = prevWord
        val style = when {
            inTag && tagBraces == 0 -> CodeStyle.Attribute
            spec.shell && commandPos && key !in spec.keywords && next != '=' -> CodeStyle.Function
            // A shell keyword is one only where a command could be (`for x in`): `npm i done` is words.
            key in spec.keywords && (!spec.shell || commandPos || key == "in") -> CodeStyle.Keyword
            key in spec.constants -> CodeStyle.Constant
            key in spec.special -> CodeStyle.Special
            before != null && before in spec.namesFunction -> CodeStyle.Function
            before != null && before in spec.namesType -> CodeStyle.Type
            key in spec.types -> CodeStyle.Type
            spec.shell -> null
            next == '(' || (next == '!' && spec === Lang.RUST.spec && i + 1 < to && s[i + 1] == '(') -> CodeStyle.Function
            !spec.ignoreCase && w.length > 1 && w.any { it.isLetter() } && w.none { it.isLowerCase() } -> CodeStyle.Constant
            spec.capsAreTypes && w[0].isUpperCase() -> CodeStyle.Type
            else -> null
        }
        if (style != null) out.add(start, i, style)
        if (spec.shell) {
            // After a command the words are its arguments, but `sudo`, `then` and the like run the next one.
            commandPos = (commandPos && key in spec.keywords && key !in SHELL_NAMERS) || key in SHELL_RUNNERS
        }
        prev = 'a'
        prevWord = key
    }

    /** `<div`, `</div>`, `<>` and `</>` in TSX and JSX, where a tag can start. */
    private fun jsxTag(to: Int): Boolean {
        val afterValue = prev.isLetterOrDigit() || prev == '_' || prev == ')' || prev == ']' || prev == '"'
        if (afterValue && prevWord !in JSX_BEFORE_TAG) return false
        var j = i + 1
        val closing = j < to && s[j] == '/'
        if (closing) j++
        if (j < to && s[j] == '>') {
            // A fragment.
            if (closing) { while (jsx.isNotEmpty() && jsx.removeLast() != TAG) Unit } else if (jsx.size < 64) jsx.addLast(TAG)
            i = j + 1
            after('>')
            return true
        }
        if (j >= to || !s[j].isLetter()) return false
        val nameStart = j
        while (j < to && (s[j].isLetterOrDigit() || s[j] == '.' || s[j] == '-' || s[j] == '_')) j++
        out.add(nameStart, j, if (s[nameStart].isUpperCase()) CodeStyle.Type else CodeStyle.Tag)
        i = j
        inTag = true
        closingTag = closing
        tagBraces = 0
        after('<')
        return true
    }

    private fun nextNonSpace(from: Int, to: Int): Char? {
        var j = from
        while (j < to && (s[j] == ' ' || s[j] == '\t')) j++
        return if (j < to) s[j] else null
    }

    private companion object {
        const val TAG = -1
        val JSX_BEFORE_TAG = setOf("return", "yield", "default", "await", "case")
        /** Keywords followed by a name, not a command: `for x`, `function go`. */
        val SHELL_NAMERS = setOf("for", "case", "select", "function", "in", "local", "export", "declare", "readonly")
        val SHELL_RUNNERS = setOf("sudo", "env", "xargs", "exec", "time", "nohup", "command", "then", "do", "else")
    }
}

// Line-based languages

private inline fun forLines(s: String, f: (start: Int, end: Int) -> Unit) {
    var start = 0
    while (start <= s.length) {
        val nl = s.indexOf('\n', start)
        val end = if (nl < 0) s.length else nl
        f(start, end)
        if (nl < 0) break
        start = nl + 1
    }
}

private fun firstNonSpace(s: String, start: Int, end: Int): Int {
    var j = start
    while (j < end && (s[j] == ' ' || s[j] == '\t')) j++
    return j
}

/** A scalar after a YAML key or TOML `=`: quoted, a number, a constant, or plain. */
private val VALUE_SPEC = Spec(keywords = emptySet(), constants = words("true false null yes no on off ~"), lineComments = listOf("#"), blockComment = null, atNames = false)

private fun yaml(s: String, out: Spans) {
    forLines(s, fun(start, end) {
        var j = firstNonSpace(s, start, end)
        if (j >= end) return
        if (s[j] == '#') { out.add(j, end, CodeStyle.Comment); return }
        if (s.startsWith("---", j) || s.startsWith("...", j)) { out.add(j, minOf(j + 3, end), CodeStyle.Keyword); return }
        while (j + 1 < end && s[j] == '-' && s[j + 1] == ' ') j = firstNonSpace(s, j + 1, end)
        val colon = yamlKeyEnd(s, j, end)
        if (colon > j) {
            out.add(j, colon, CodeStyle.Property)
            j = colon + 1
        }
        Lexer(s, VALUE_SPEC, out).run(j, end)
    })
}

/** Where a YAML `key:` ends (its colon), or -1. */
private fun yamlKeyEnd(s: String, from: Int, end: Int): Int {
    if (from >= end) return -1
    val c = s[from]
    if (c == '"' || c == '\'') {
        val close = s.indexIn(c, from + 1, end)
        return if (close in 0 until end - 1 && s[close + 1] == ':') close + 1 else -1
    }
    var j = from
    while (j < end) {
        val d = s[j]
        if (d == ':' && (j + 1 == end || s[j + 1] == ' ')) return if (j > from) j else -1
        if (d == '#' || d == '{' || d == '[' || d == '"' || d == '\'') return -1
        j++
    }
    return -1
}

private fun toml(s: String, out: Spans) {
    forLines(s, fun(start, end) {
        var j = firstNonSpace(s, start, end)
        if (j >= end) return
        if (s[j] == '#') { out.add(j, end, CodeStyle.Comment); return }
        if (s[j] == '[') {
            val close = s.indexIn(']', j, end).let { if (it < 0) end - 1 else it }
            val stop = if (close + 1 < end && s[close + 1] == ']') close + 2 else close + 1
            out.add(j, stop, CodeStyle.Heading)
            Lexer(s, VALUE_SPEC, out).run(stop, end)
            return
        }
        val eq = s.indexIn('=', j, end)
        if (eq in j until end) {
            var k = eq
            while (k > j && (s[k - 1] == ' ' || s[k - 1] == '\t')) k--
            out.add(j, k, CodeStyle.Property)
            j = eq + 1
        }
        Lexer(s, VALUE_SPEC, out).run(j, end)
    })
}

private fun diff(s: String, out: Spans) {
    forLines(s, fun(start, end) {
        if (start >= end) return
        val style = when {
            s.startsWith("+++", start) || s.startsWith("---", start) || s.startsWith("diff ", start) || s.startsWith("index ", start) -> CodeStyle.Heading
            s.startsWith("@@", start) -> CodeStyle.Attribute
            s[start] == '+' || s[start] == '>' -> CodeStyle.Inserted
            s[start] == '-' || s[start] == '<' -> CodeStyle.Deleted
            else -> return
        }
        out.add(start, end, style)
    })
}

private fun markdown(s: String, out: Spans) {
    var fence: String? = null
    forLines(s, fun(start, end) {
        val j = firstNonSpace(s, start, end)
        val open = fence
        if (open != null) {
            out.add(start, end, CodeStyle.Literal)
            if (s.startsWith(open, j)) fence = null
            return
        }
        if (s.startsWith("```", j) || s.startsWith("~~~", j)) {
            fence = s.substring(j, j + 3)
            out.add(j, end, CodeStyle.Literal)
            return
        }
        if (j < end && s[j] == '#') { out.add(j, end, CodeStyle.Heading); return }
        if (j < end && s[j] == '>') { out.add(j, end, CodeStyle.Comment); return }
        var k = j
        while (k < end) {
            val c = s[k]
            if (c == '`') {
                val close = s.indexIn('`', k + 1, end)
                if (close in 0 until end) { out.add(k, close + 1, CodeStyle.Literal); k = close + 1; continue }
            }
            if (c == ']' && k + 1 < end && s[k + 1] == '(') {
                val close = s.indexIn(')', k + 2, end)
                if (close in 0 until end) { out.add(k + 2, close, CodeStyle.Special); k = close + 1; continue }
            }
            k++
        }
    })
}

private fun html(s: String, out: Spans) {
    var i = 0
    val n = s.length
    while (i < n) {
        val c = s[i]
        if (s.startsWith("<!--", i)) {
            val close = s.indexOf("-->", i + 4)
            val end = if (close < 0) n else close + 3
            out.add(i, end, CodeStyle.Comment)
            i = end
            continue
        }
        if (c == '<' && i + 1 < n && (s[i + 1].isLetter() || s[i + 1] == '/' || s[i + 1] == '!' || s[i + 1] == '?')) {
            var j = i + 1
            if (s[j] == '/' || s[j] == '!' || s[j] == '?') j++
            val nameStart = j
            while (j < n && (s[j].isLetterOrDigit() || s[j] == '-' || s[j] == ':' || s[j] == '_')) j++
            out.add(nameStart, j, if (s[i + 1] == '!' || s[i + 1] == '?') CodeStyle.Keyword else CodeStyle.Tag)
            // Attributes up to the tag's end.
            while (j < n && s[j] != '>') {
                val d = s[j]
                when {
                    d == '"' || d == '\'' -> {
                        val close = s.indexOf(d, j + 1)
                        val end = if (close < 0) n else close + 1
                        out.add(j, end, CodeStyle.Str)
                        j = end
                    }
                    d.isLetter() || d == '_' || d == '@' || d == ':' -> {
                        val a = j
                        while (j < n && (s[j].isLetterOrDigit() || s[j] in "-_:@.")) j++
                        out.add(a, j, CodeStyle.Attribute)
                    }
                    else -> j++
                }
            }
            i = j + 1
            continue
        }
        if (c == '&') {
            val semi = s.indexIn(';', i, minOf(n, i + 11))
            if (semi in i + 2..i + 10 && s.substring(i + 1, semi).all { it.isLetterOrDigit() || it == '#' }) {
                out.add(i, semi + 1, CodeStyle.Escape)
                i = semi + 1
                continue
            }
        }
        i++
    }
}

private fun css(s: String, out: Spans) {
    var i = 0
    val n = s.length
    var depth = 0
    var inValue = false
    while (i < n) {
        val c = s[i]
        when {
            s.startsWith("/*", i) -> {
                val close = s.indexOf("*/", i + 2)
                val end = if (close < 0) n else close + 2
                out.add(i, end, CodeStyle.Comment); i = end
            }
            s.startsWith("//", i) && (i == 0 || s[i - 1] != ':') -> {
                val end = s.indexOf('\n', i).let { if (it < 0) n else it }
                out.add(i, end, CodeStyle.Comment); i = end
            }
            c == '"' || c == '\'' -> {
                val close = s.indexOf(c, i + 1)
                val end = if (close < 0) n else close + 1
                out.add(i, end, CodeStyle.Str); i = end
            }
            c == '{' -> { depth++; inValue = false; i++ }
            c == '}' -> { depth = maxOf(0, depth - 1); inValue = false; i++ }
            c == ';' -> { inValue = false; i++ }
            c == '@' -> {
                val a = i; i++
                while (i < n && (s[i].isLetterOrDigit() || s[i] == '-')) i++
                out.add(a, i, CodeStyle.Keyword)
            }
            c == '!' && s.startsWith("!important", i) -> { out.add(i, i + 10, CodeStyle.Keyword); i += 10 }
            inValue && c == '#' -> {
                val a = i; i++
                while (i < n && s[i].isLetterOrDigit()) i++
                out.add(a, i, CodeStyle.Constant)
            }
            inValue && (c.isDigit() || (c == '.' && i + 1 < n && s[i + 1].isDigit()) ||
                (c == '-' && i + 1 < n && s[i + 1].isDigit() && (i == 0 || !s[i - 1].isLetterOrDigit()))) -> {
                val a = i; i++
                while (i < n && (s[i].isLetterOrDigit() || s[i] == '.' || s[i] == '%')) i++
                out.add(a, i, CodeStyle.Number)
            }
            c.isLetter() || c == '-' || c == '_' || ((c == '.' || c == '#') && !inValue && i + 1 < n && (s[i + 1].isLetter() || s[i + 1] == '_' || s[i + 1] == '-')) -> {
                val a = i; i++
                while (i < n && (s[i].isLetterOrDigit() || s[i] == '-' || s[i] == '_')) i++
                var k = i
                while (k < n && (s[k] == ' ' || s[k] == '\t')) k++
                val next = if (k < n) s[k] else ' '
                val style = when {
                    inValue && next == '(' -> CodeStyle.Function
                    inValue -> CodeStyle.Constant
                    // In a rule, `name:` is a property; `a:hover` in a selector isn't.
                    depth > 0 && next == ':' && s[a] != '.' && s[a] != '#' -> CodeStyle.Type.also { inValue = true; i = k + 1 }
                    s[a] == '.' || s[a] == '#' -> CodeStyle.Attribute
                    else -> CodeStyle.Tag
                }
                out.add(a, if (style == CodeStyle.Type) k else i, style)
            }
            c == ':' && depth > 0 && !inValue -> { inValue = true; i++ }
            else -> i++
        }
    }
}
