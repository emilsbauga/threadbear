package com.mikerosoft.threadbear.kit

import com.mikerosoft.threadbear.kit.CodeStyle.Attribute
import com.mikerosoft.threadbear.kit.CodeStyle.Comment
import com.mikerosoft.threadbear.kit.CodeStyle.Constant
import com.mikerosoft.threadbear.kit.CodeStyle.Deleted
import com.mikerosoft.threadbear.kit.CodeStyle.Escape
import com.mikerosoft.threadbear.kit.CodeStyle.Function
import com.mikerosoft.threadbear.kit.CodeStyle.Heading
import com.mikerosoft.threadbear.kit.CodeStyle.Inserted
import com.mikerosoft.threadbear.kit.CodeStyle.Keyword
import com.mikerosoft.threadbear.kit.CodeStyle.Number
import com.mikerosoft.threadbear.kit.CodeStyle.Property
import com.mikerosoft.threadbear.kit.CodeStyle.Special
import com.mikerosoft.threadbear.kit.CodeStyle.Str
import com.mikerosoft.threadbear.kit.CodeStyle.Tag
import com.mikerosoft.threadbear.kit.CodeStyle.Type
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CodeColoursTest {
    /** Each coloured piece as its text and style, in order. */
    private fun marks(code: String, language: String?): List<Pair<String, CodeStyle>> =
        CodeColours.spans(code, language).map { code.substring(it.start, it.end) to it.style }

    private fun styleOf(code: String, language: String, piece: String): CodeStyle? =
        marks(code, language).firstOrNull { it.first == piece }?.second

    @Test fun typescript() {
        val code = """
            // load it
            export async function load(id: string): Promise<User> {
              const n = 42;
              return fetchUser(`/u/${'$'}{id}`, "a\n", true);
            }
        """.trimIndent()
        assertEquals(
            listOf(
                "// load it" to Comment, "export" to Keyword, "async" to Keyword, "function" to Keyword, "load" to Function,
                "string" to Type, "Promise" to Type, "User" to Type, "const" to Keyword, "42" to Number, "return" to Keyword,
                "fetchUser" to Function, "`/u/\${id}`" to Str, "\"a" to Str, "\\n" to Escape, "\"" to Str, "true" to Constant,
            ),
            marks(code, "ts"),
        )
    }

    @Test fun tsxTagsAndTheirTextIsWords() {
        val code = """
            return (
              <div className="row" onClick={() => go(1)}>
                Don't if this
                <Avatar size={2} />
              </div>
            );
        """.trimIndent()
        val m = marks(code, "tsx")
        assertTrue("div" to Tag in m)
        assertTrue("className" to Attribute in m)
        assertTrue("\"row\"" to Str in m)
        assertTrue("go" to Function in m)
        assertTrue("Avatar" to Type in m)
        // The text between tags isn't read as code: no keyword, no runaway string.
        assertTrue(m.none { it.first == "if" || it.first.startsWith("'") }, m.toString())
        assertEquals(2, m.count { it == "div" to Tag })
    }

    @Test fun lessThanIsNotATag() {
        assertTrue(marks("if (a < b) { x = c > d }", "tsx").none { it.second == Tag })
    }

    @Test fun sqlIgnoresCase() {
        assertEquals(
            listOf("SELECT" to Keyword, "count" to Function, "FROM" to Keyword, "where" to Keyword, "'x'" to Str, "-- why" to Comment),
            marks("SELECT count(*) FROM t where name = 'x' -- why", "sql"),
        )
    }

    @Test fun shell() {
        val m = marks("# set up\nif [ -n \"\$X\" ]; then\n  npm install --in done # ok\nfi\necho a#b", "bash")
        assertEquals("# set up" to Comment, m.first())
        assertTrue("if" to Keyword in m && "then" to Keyword in m && "fi" to Keyword in m)
        assertTrue("npm" to Function in m && "echo" to Function in m)
        // Arguments and flags aren't commands or keywords; `#` mid-word isn't a comment.
        assertTrue(m.none { it.first == "install" || it.first == "--in" || it.first == "done" }, m.toString())
        assertTrue("# ok" to Comment in m)
        assertTrue(m.none { it.first.contains("#b") })
        assertEquals(listOf("for" to Keyword, "in" to Keyword, "do" to Keyword, "echo" to Function, "done" to Keyword), marks("for x in a b; do echo; done", "sh"))
    }

    @Test fun jsonKeysAndValues() {
        assertEquals(
            listOf("\"name\"" to Property, "\"tb\"" to Str, "\"n\"" to Property, "1.5" to Number, "\"ok\"" to Property, "null" to Constant),
            marks("""{"name": "tb", "n": 1.5, "ok": null}""", "json"),
        )
    }

    @Test fun yamlAndToml() {
        assertEquals(
            listOf("# ci" to Comment, "name" to Property, "on" to Property, "branches" to Property, "\"main\"" to Str, "retries" to Property, "3" to Number),
            marks("# ci\nname: build\non:\n  - branches: [\"main\"]\nretries: 3", "yaml"),
        )
        assertEquals(
            listOf("[package]" to Heading, "name" to Property, "\"tb\"" to Str, "edition" to Property, "2021" to Number, "# yes" to Comment),
            marks("[package]\nname = \"tb\"\nedition = 2021 # yes", "toml"),
        )
    }

    @Test fun rustLifetimesAndChars() {
        val m = marks("fn first<'a>(s: &'a str) -> char { println!(\"hi\"); 'x' }", "rs")
        assertEquals(
            listOf(
                "fn" to Keyword, "first" to Function, "'a" to Keyword, "'a" to Keyword, "str" to Type, "char" to Type,
                "println" to Function, "\"hi\"" to Str, "'x'" to Str,
            ),
            m,
        )
    }

    @Test fun pythonKotlinSwiftGo() {
        assertEquals(Str, styleOf("x = f\"hi {y}\"", "python", "f\"hi {y}\""))
        assertEquals(Function, styleOf("@cache\ndef go(self): pass", "py", "@cache"))
        assertEquals(Special, styleOf("@cache\ndef go(self): pass", "py", "self"))
        assertEquals(Str, styleOf("s = \"\"\"a\nb\"\"\"", "py", "\"\"\"a\nb\"\"\""))
        assertEquals(Attribute, styleOf("@Composable fun Row() {}", "kotlin", "@Composable"))
        assertEquals(Function, styleOf("@Composable fun Row() {}", "kt", "Row"))
        assertEquals(Type, styleOf("struct Card: View { let x: Int = nil }", "swift", "Card"))
        assertEquals(Constant, styleOf("struct Card: View { let x: Int = nil }", "swift", "nil"))
        assertEquals(Str, styleOf("s := `raw\\n`", "go", "`raw\\n`"))
    }

    @Test fun htmlCssDiffMarkdown() {
        val h = marks("<!-- c --><a href=\"/x\" data-id='1'>Tom &amp; Jo</a>", "html")
        assertEquals(listOf("<!-- c -->" to Comment, "a" to Tag, "href" to Attribute, "\"/x\"" to Str, "data-id" to Attribute, "'1'" to Str, "&amp;" to Escape, "a" to Tag), h)
        val c = marks(".card > p:hover { color: #fff; margin: 4px 0; }", "css")
        assertTrue(".card" to Attribute in c && "p" to Tag in c && "color" to Type in c && "#fff" to Constant in c && "4px" to Number in c, c.toString())
        assertEquals(
            listOf("--- a/x" to Heading, "+++ b/x" to Heading, "@@ -1 +1 @@" to Attribute, "-old" to Deleted, "+new" to Inserted),
            marks("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same", "diff"),
        )
        val md = marks("# Title\nSome `code` and [link](https://x.y)\n```\nraw\n```", "md")
        assertEquals("# Title" to Heading, md.first())
        assertTrue("`code`" to CodeStyle.Literal in md && "https://x.y" to Special in md && "raw" to CodeStyle.Literal in md, md.toString())
    }

    @Test fun unknownOrBareStaysPlain() {
        assertEquals(emptyList(), CodeColours.spans("if (x) { return 1 }", null))
        assertEquals(emptyList(), CodeColours.spans("if (x) { return 1 }", "brainfuck"))
        assertTrue(CodeColours.supports("TypeScript") && CodeColours.supports("ZSH") && !CodeColours.supports("text"))
    }

    @Test fun aHugeBlockStaysPlain() {
        val line = "const x = 1; // c\n"
        val big = line.repeat(CodeColours.MAX_CHARS / line.length + 1)
        assertEquals(emptyList(), CodeColours.spans(big, "ts"))
        assertTrue(CodeColours.spans(line.repeat(100), "ts").isNotEmpty())
    }

    @Test fun strayMarksDontMakeItSlow() {
        val n = CodeColours.MAX_CHARS - 10
        val worst = mapOf("html" to "&", "rs" to "'\\", "md" to "](", "yaml" to "\"a\n", "toml" to "[a\n", "ts" to "/", "tsx" to "<a{")
        val started = System.nanoTime()
        for ((lang, piece) in worst) CodeColours.spans(piece.repeat(n / piece.length), lang)
        val ms = (System.nanoTime() - started) / 1_000_000
        assertTrue(ms < 2000, "took $ms ms")
    }

    @Test fun spansAreOrderedAndInBounds() {
        val samples = mapOf(
            "ts" to "let a = 'x\nb' + `c", "tsx" to "<a>{x}</", "rs" to "'", "sh" to "echo \"unterminated",
            "py" to "\"\"\"open", "css" to "a { color: ", "html" to "<a href=\"", "yaml" to "a: 'b", "json" to "{\"a",
            "md" to "```\nx", "toml" to "[a", "sql" to "/* x", "go" to "`x", "swift" to "\"\"\"", "kotlin" to "'\\",
        )
        for ((lang, code) in samples) {
            var end = 0
            for (span in CodeColours.spans(code, lang)) {
                assertTrue(span.start >= end && span.end > span.start && span.end <= code.length, "$lang: $span in ${code.length}")
                end = span.end
            }
        }
    }
}
