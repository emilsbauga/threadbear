import Foundation
import Testing
@testable import ThreadbearKit

/// Code blocks coloured by their language (CodeBlockView). What each
/// language picks out follows the Mac's syntect grammars, so these check
/// the same words come out the same kind.
@Suite struct CodeHighlighterTests {
    /// The text of every run of `token`.
    private func words(_ code: String, _ language: String, _ token: CodeToken) -> [String] {
        (CodeHighlighter.runs(code, language: language) ?? []).filter { $0.token == token }.map(\.text)
    }

    private func kind(of word: String, in code: String, _ language: String) -> CodeToken? {
        CodeHighlighter.runs(code, language: language)?.first { $0.text == word }?.token
    }

    @Test func typescript() {
        let code = """
        import { query } from "./server";
        // the newest first
        export const list = query({
          handler: async (ctx): Promise<Order[]> => {
            const n = 50;
            return await ctx.db.query("orders").take(n) ?? null;
          },
        });
        """
        #expect(words(code, "ts", .keyword) == ["import", "from", "export", "const", "async", "=>", "const", "return", "await"])
        #expect(words(code, "ts", .string) == ["\"./server\"", "\"orders\""])
        #expect(words(code, "ts", .comment) == ["// the newest first"])
        #expect(words(code, "ts", .function) == ["query", "query", "take"])
        #expect(words(code, "ts", .type) == ["Promise", "Order"])
        #expect(words(code, "ts", .number) == ["50"])
        #expect(words(code, "ts", .constant) == ["null"])
        #expect(words("const s = `a ${b} \\n c`;", "js", .string) == ["`a ", " ", " c`"])
        #expect(words("const s = `a ${b} \\n c`;", "js", .escape) == ["\\n"])
    }

    @Test func jsxTagsAndAttributes() {
        let code = #"const App = () => <div className="x" onClick={go}>Hi</div>; if (a < b) return <br />;"#
        #expect(words(code, "tsx", .tag) == ["div", "div", "br"])
        #expect(words(code, "tsx", .attribute) == ["className", "onClick"])
        #expect(words(code, "tsx", .string) == ["\"x\""])
        // A less-than and a type's <T> aren't tags.
        #expect(words("let x: Array<Order> = a < b;", "ts", .tag).isEmpty)
    }

    @Test func sql() {
        let code = """
        SELECT id, COUNT(*) AS n FROM orders -- recent ones
        WHERE created_at > '2024-01-01' and total >= 10;
        """
        #expect(words(code, "sql", .keyword) == ["SELECT", "FROM", "WHERE"])
        #expect(words(code, "sql", .function) == ["COUNT"])
        #expect(words(code, "sql", .string) == ["'2024-01-01'"])
        #expect(words(code, "sql", .number) == ["10"])
        #expect(words(code, "sql", .comment) == ["-- recent ones"])
    }

    @Test func shell() {
        let code = """
        # deploy it
        export NAME="world $HOME"
        for f in *.txt; do echo "$f" | grep -v foo && rm -rf "$f"; done
        npx convex deploy 2>&1 | tail -5
        """
        #expect(words(code, "bash", .comment) == ["# deploy it"])
        #expect(words(code, "sh", .keyword) == ["export", "for", "in", "do", "done"])
        #expect(words(code, "zsh", .function) == ["echo", "grep", "rm", "npx", "tail"])
        // $HOME inside the quotes is plain, as on the Mac.
        #expect(words(code, "shell", .string) == ["\"world ", "\"", "\"", "\"", "\"", "\""])
    }

    @Test func jsonYamlToml() {
        #expect(words(#"{"name": "tb", "n": 1.5, "ok": true, "x": null}"#, "json", .string) == [#""name""#, #""tb""#, #""n""#, #""ok""#, #""x""#])
        #expect(words(#"{"n": 1.5, "ok": true, "x": null}"#, "json", .constant) == ["true", "null"])
        #expect(words(#"{"n": 1.5}"#, "json", .number) == ["1.5"])

        let yaml = """
        # config
        name: threadbear
        on:
          push:
            branches: [main, "dev"]
        steps:
          - run: npm test # quick
            retries: 3
        """
        #expect(words(yaml, "yaml", .tag) == ["name", "push", "branches", "steps", "run", "retries"])
        #expect(words(yaml, "yml", .constant) == ["on"])
        #expect(words(yaml, "yaml", .string) == ["threadbear", "main", "\"dev\"", "npm test"])
        #expect(words(yaml, "yaml", .comment) == ["# config", "# quick"])
        #expect(words(yaml, "yaml", .number) == ["3"])

        let toml = """
        [package]
        name = "tb" # the name
        edition = 2021
        debug = true
        features = [
          "a",
        ]
        x = { a = 1, b = "c" }
        """
        #expect(words(toml, "toml", .tag) == ["name", "edition", "debug", "features", "x", "a", "b"])
        #expect(words(toml, "toml", .string) == ["\"tb\"", "\"a\"", "\"c\""])
        #expect(words(toml, "toml", .number) == ["2021", "1"])
        #expect(words(toml, "toml", .constant) == ["true"])
        #expect(words(toml, "toml", .comment) == ["# the name"])
    }

    @Test func rustSwiftKotlinPythonGo() {
        let rust = "/// Docs\npub fn new<'a>(x: &'a str) -> Self { let c = 'c'; println!(\"{}\", self.len()); 0x1F }"
        #expect(words(rust, "rust", .comment) == ["/// Docs"])
        #expect(words(rust, "rs", .keyword) == ["pub", "fn", "'a", "'a", "str", "Self", "let"])
        #expect(words(rust, "rust", .function) == ["new", "len"])
        #expect(words(rust, "rust", .string) == ["'c'", "\"{}\""])
        #expect(words(rust, "rust", .variable) == ["self"])
        #expect(words(rust, "rust", .number) == ["0x1F"])
        #expect(words("for i in 0..10 {}", "rust", .number) == ["0", "10"])

        let swift = "@State private var copied = false\nfunc copy() -> Int { Text(\"Hi \\(name)\") }"
        #expect(words(swift, "swift", .keyword) == ["@State", "private", "var", "func"])
        #expect(words(swift, "swift", .function) == ["copy", "Text"])
        #expect(words(swift, "swift", .type) == ["Int"])
        #expect(words(swift, "swift", .string) == ["\"Hi ", "\""])
        #expect(words(swift, "swift", .constant) == ["false"])

        let kotlin = "fun greet(name: String) { val x = listOf(1); println(\"Hello $name\") }"
        #expect(words(kotlin, "kotlin", .keyword) == ["fun", "val"])
        #expect(words(kotlin, "kt", .function) == ["greet", "listOf", "println"])
        #expect(words(kotlin, "kotlin", .string) == ["\"Hello ", "\""])

        let python = """
        class Order(Base):
            \"\"\"An order.\"\"\"
            def total(self, n: int = 3) -> float:
                # add them up
                return sum(x for x in self.items if x is not None)
        """
        #expect(words(python, "python", .keyword) == ["class", "def", "return", "for", "in", "if", "is", "not"])
        #expect(words(python, "py", .type) == ["Order", "Base", "int", "float"])
        #expect(words(python, "python", .function) == ["total", "sum"])
        #expect(words(python, "python", .comment) == ["\"\"\"An order.\"\"\"", "# add them up"])
        #expect(words(python, "python", .constant) == ["None"])
        #expect(words(python, "python", .variable) == ["self", "self"])

        let go = "func main() {\n\tvar s string = `raw`\n\tif err != nil { fmt.Println(\"err\") }\n}"
        #expect(words(go, "go", .keyword) == ["func", "var", "if"])
        #expect(words(go, "go", .function) == ["main", "Println"])
        #expect(words(go, "golang", .type) == ["string"])
        #expect(words(go, "go", .string) == ["`raw`", "\"err\""])
        #expect(words(go, "go", .constant) == ["nil"])
    }

    @Test func htmlCssDiffMarkdown() {
        let html = #"<!DOCTYPE html><!-- note --><div class="card"><a href="/x">Link &amp; more</a></div>"#
        #expect(words(html, "html", .tag) == ["div", "a", "a", "div"])
        #expect(words(html, "html", .attribute) == ["class", "href"])
        #expect(words(html, "html", .string) == [#""card""#, #""/x""#])
        #expect(words(html, "html", .comment) == ["<!-- note -->"])
        #expect(words(html, "html", .constant) == ["html", "amp"])
        #expect(words(html, "html", .keyword) == ["DOCTYPE"])

        let css = """
        /* card */
        .card > a:hover, #id div { color: #fff; margin: 0 auto 10px; }
        @media (max-width: 600px) { .x { display: none !important; } }
        """
        #expect(words(css, "css", .comment) == ["/* card */"])
        #expect(words(css, "css", .attribute) == ["card", "id", "x"])
        #expect(words(css, "css", .tag) == ["a", "div"])
        #expect(words(css, "css", .type) == ["color", "margin", "max-width", "display"])
        #expect(words(css, "css", .constant) == ["fff", "auto", "none"])
        #expect(words(css, "css", .number) == ["0", "10", "600"])
        #expect(words(css, "css", .keyword) == ["px", "media", "px", "!important"])

        let diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n same\n-old\n+new"
        #expect(words(diff, "diff", .inserted) == ["+new"])
        #expect(words(diff, "patch", .deleted) == ["-old"])
        #expect(words(diff, "diff", .type) == ["@@ -1,2 +1,2 @@"])

        let markdown = "# Title\nSome **bold** and *it* with `code` and a [link](https://x.y).\n- item"
        #expect(words(markdown, "md", .title) == ["Title"])
        #expect(words(markdown, "markdown", .strong) == ["bold"])
        #expect(words(markdown, "md", .emphasis) == ["it"])
        #expect(words(markdown, "md", .literal) == ["code"])
        #expect(words(markdown, "md", .link) == ["https://x.y"])
    }

    @Test func unknownOrUntaggedStaysPlain() {
        #expect(CodeHighlighter.runs("before  1,840 ms", language: nil) == nil)
        #expect(CodeHighlighter.runs("let x = 1", language: "brainfuck") == nil)
        #expect(CodeHighlighter.runs("", language: "ts") == nil)
        #expect(!CodeHighlighter.knows("text"))
        #expect(CodeHighlighter.knows("TypeScript"))
    }

    @Test func tooBigStaysPlain() {
        let line = "const x = foo(\"bar\", 42); // why\n"
        let fits = String(repeating: line, count: CodeHighlighter.maxLines - 1)
        #expect(CodeHighlighter.runs(fits, language: "ts") != nil)
        let tooManyLines = String(repeating: "x\n", count: CodeHighlighter.maxLines + 1)
        #expect(CodeHighlighter.runs(tooManyLines, language: "ts") == nil)
        let tooLong = String(repeating: "x", count: CodeHighlighter.maxLength + 1)
        #expect(CodeHighlighter.runs(tooLong, language: "ts") == nil)
    }

    /// Whatever the code, the runs put back together are the code exactly:
    /// what's copied or selected from a block is never changed by colouring.
    @Test func runsAlwaysJoinBackToTheCode() {
        let samples = [
            "let s = \"emoji \\😀 inside\"; // 👋 hi\nconst ünï = 'x'",
            "\"unterminated\nnext line",
            "/* open comment",
            "`template ${a + `inner`} end",
            "'", "\"", "\\", "${", "@", "<", "</", "#", "0x", "1e-", "*", "**", "[", "](",
            "a:\n  - b: [c, {d: e}]\n  - |\n    text: here",
            "key = [\n  1,\n  \"two\",\n]\n[[array.of.tables]]",
            "<a href='x' b=\"y\" c>&#169; &nbsp</a><br/>",
            "@media screen { a { b: c } } d { e: f",
            "+\n-\n@@\n",
            "# h\n**x\n*y\n`z\n[a](b",
        ]
        let languages = ["ts", "tsx", "sql", "bash", "json", "yaml", "toml", "rust", "swift", "kotlin", "python", "go", "html", "css", "diff", "md"]
        for language in languages {
            for sample in samples {
                let runs = CodeHighlighter.runs(sample, language: language)
                #expect(runs?.map(\.text).joined() ?? sample == sample, "\(language): \(sample)")
                // Neighbouring runs of the same kind are merged.
                if let runs {
                    #expect(zip(runs, runs.dropFirst()).allSatisfy { $0.token != $1.token }, "\(language): \(sample)")
                }
            }
        }
    }

    /// A block at the size limit colours in well under a frame's worth of
    /// time (a 300-line block took a few ms on Tinker Desk), so the view can
    /// do it as it's drawn and keep it.
    @Test func aBlockAtTheLimitIsQuick() {
        let line = "const n = await ctx.db.query(\"orders\").take(5);\n"
        let code = String(repeating: line, count: CodeHighlighter.maxLines - 1)
        #expect(code.utf16.count <= CodeHighlighter.maxLength)
        let clock = ContinuousClock()
        let took = clock.measure { _ = CodeHighlighter.runs(code, language: "ts") }
        #expect(took < .milliseconds(250), "took \(took)")
    }
}
