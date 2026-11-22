package com.mikerosoft.threadbear.kit

import com.mikerosoft.threadbear.kit.DraftBlock.Span
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * ```slack, ```email and ```draft blocks (DraftBlockTests.swift): text for
 * Mike to send elsewhere, shown line for line with a Copy button. The Mac's
 * DraftBlockTests and the website's draft.test.ts check the same cases.
 */
class DraftBlockTest {
    @Test fun onlyTheDraftFencesCount() {
        assertEquals(DraftBlock.Kind.SLACK, DraftBlock.from("slack", "hi\n")?.kind)
        assertEquals(DraftBlock.Kind.EMAIL, DraftBlock.from("Email subject=x", "hi")?.kind)
        assertEquals(DraftBlock.Kind.DRAFT, DraftBlock.from("draft", "hi")?.kind)
        assertNull(DraftBlock.from("slackbot", "hi"))
        assertNull(DraftBlock.from(null, "hi"))
        assertNull(DraftBlock.from("slack", " \n\n"))
        assertEquals("a\nb", DraftBlock.from("slack", "a\r\nb\n\n")?.source)
        assertEquals("Slack draft", DraftBlock(DraftBlock.Kind.SLACK, "x").label)
        assertEquals("Email draft", DraftBlock(DraftBlock.Kind.EMAIL, "x").label)
        assertEquals("Draft", DraftBlock(DraftBlock.Kind.DRAFT, "x").label)
    }

    @Test fun everyLineStaysALine() {
        val draft = DraftBlock(DraftBlock.Kind.DRAFT, "*Threadbear, 6 Nov*\n• one\n• two\n\nThanks")
        assertEquals(listOf("*Threadbear, 6 Nov*", "• one", "• two", "", "Thanks"), draft.lines.map { l -> l.spans.joinToString("") { it.text } })
        // Only a Slack draft reads Slack's formatting.
        assertFalse(draft.lines[0].spans[0].bold)
        assertEquals(draft.source, draft.plainText)
    }

    @Test fun slackFormatting() {
        assertEquals(
            listOf(
                Span("Shipped", bold = true), Span(" "), Span("today", italic = true), Span(": "),
                Span("old", strike = true), Span(" "), Span("tb land", code = true), Span(" and "),
                Span("both", bold = true, italic = true),
            ),
            DraftBlock.slackSpans("*Shipped* _today_: ~old~ `tb land` and *_both_*"),
        )
    }

    @Test fun markersInsideWordsAndLoneOnesStayAsWritten() {
        for (text in listOf("2*3*4", "snake_case_name", "a * b * c", "*open only", "price: $5_000_")) {
            assertEquals(listOf(Span(text)), DraftBlock.slackSpans(text), text)
        }
    }

    @Test fun markdownBoldIsSlackBoldWithAStarEitherSide() {
        // Markdown's **bold** is Slack's *bold* with a star either side,
        // which is how Slack shows it too.
        assertEquals(listOf(Span("*"), Span("x", bold = true), Span("*")), DraftBlock.slackSpans("**x**"))
    }

    @Test fun linksAndMentions() {
        val spans = DraftBlock.slackSpans("See <https://example.com/a?b=1|the docs>, <https://x.dev> or <mailto:m@x.dev>; cc <@U123> in <#C9|general> <!here> & 1 < 2 &amp; <b>")
        assertEquals(listOf("https://example.com/a?b=1", "https://x.dev", "mailto:m@x.dev"), spans.mapNotNull { it.link })
        assertEquals("See the docs, https://x.dev or m@x.dev; cc @U123 in #general @here & 1 < 2 & <b>", spans.joinToString("") { it.text })
        // Other schemes aren't links.
        assertNull(DraftBlock.slackSpans("<javascript:alert(1)|x>").first().link)
        assertEquals("<javascript:alert(1)|x>", DraftBlock.slackSpans("<javascript:alert(1)|x>").joinToString("") { it.text })
    }

    @Test fun copyKeepsSlacksMarkersButSpellsOutLinks() {
        val draft = DraftBlock(DraftBlock.Kind.SLACK, "*Done* <https://x.dev/pr/1|the PR>\n<https://x.dev>\n> quoted &lt;tag&gt;")
        assertEquals("*Done* the PR (https://x.dev/pr/1)\nhttps://x.dev\n> quoted <tag>", draft.plainText)
        assertEquals(
            "<meta charset=\"utf-8\"><div><b>Done</b> <a href=\"https://x.dev/pr/1\">the PR</a><br><a href=\"https://x.dev\">https://x.dev</a><blockquote>quoted &lt;tag&gt;</blockquote></div>",
            draft.html,
        )
        assertTrue(draft.lines[2].quote)
    }

    @Test fun htmlIsEscaped() {
        val draft = DraftBlock(DraftBlock.Kind.EMAIL, "Hi <script>alert(\"x\")</script> & bye")
        assertEquals("<meta charset=\"utf-8\"><div>Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; bye</div>", draft.html)
    }

    // Cross-lab review, 6 Nov.
    @Test fun tokensInsideCodeStayAsWrittenAndALinkCanBeBold() {
        assertEquals(listOf(Span("<@U123>", code = true), Span(" and "), Span("a < b", code = true)), DraftBlock.slackSpans("`<@U123>` and `a < b`"))
        val url = "https://x.dev"
        assertEquals(listOf(Span("See ", bold = true), Span("docs", bold = true, link = url)), DraftBlock.slackSpans("*See <https://x.dev|docs>*"))
        assertEquals(listOf(Span("a", link = url), Span("b", italic = true)), DraftBlock.slackSpans("<https://x.dev|a>_b_"))
        // Copied as plain text, code keeps its tokens as typed too.
        assertEquals(
            "`<@U1>` @U1 `<https://x.dev|docs>` docs (https://x.dev)",
            DraftBlock(DraftBlock.Kind.SLACK, "`<@U1>` <@U1> `<https://x.dev|docs>` <https://x.dev|docs>").plainText,
        )
    }

    @Test fun hostileLinesStayQuick() {
        val start = System.nanoTime()
        DraftBlock.slackSpans("<".repeat(DraftBlock.MAX_FORMATTED_LINE))
        DraftBlock.slackSpans(" *a".repeat(DraftBlock.MAX_FORMATTED_LINE / 3))
        DraftBlock(DraftBlock.Kind.SLACK, "<".repeat(DraftBlock.MAX_SOURCE)).plainText
        DraftBlock(DraftBlock.Kind.SLACK, "<".repeat(DraftBlock.MAX_SOURCE - 1) + ">").plainText
        assertTrue((System.nanoTime() - start) / 1e9 < 2)
        // A line past the limit is shown as written; a draft past its limit stays code.
        val long = "*" + "a".repeat(DraftBlock.MAX_FORMATTED_LINE) + "*"
        assertEquals(listOf(Span(long)), DraftBlock.slackSpans(long))
        assertNull(DraftBlock.from("slack", "a".repeat(DraftBlock.MAX_SOURCE + 1)))
        // A placeholder character in the text itself turns formatting off for the line.
        assertEquals(listOf(Span("*a* ")), DraftBlock.slackSpans("*a* "))
    }

    @Test fun copiedHtmlKeepsIndentsAndLinedUpSpaces() {
        val draft = DraftBlock(DraftBlock.Kind.EMAIL, "    • nested\nA    B")
        assertEquals("<meta charset=\"utf-8\"><div>&nbsp;&nbsp;&nbsp;&nbsp;• nested<br>A &nbsp;&nbsp;&nbsp;B</div>", draft.html)
    }

    /**
     * The cases every app runs (shared/cases/draft-blocks.json): the desktop
     * app, the iPhone, the website and here. A case whose `differs` names
     * android is a known difference, skipped. `closed` is answered by parsing
     * the text as the phone draws it, a draft anywhere in it, quotes included.
     */
    @Test fun draftBlocksFollowTheSharedCases() {
        fun neutral(spans: List<Span>): JsonElement = JsonArray(
            spans.map { s ->
                val o = linkedMapOf<String, JsonElement>("text" to JsonPrimitive(s.text))
                if (s.bold) o["bold"] = JsonPrimitive(true)
                if (s.italic) o["italic"] = JsonPrimitive(true)
                if (s.strike) o["strike"] = JsonPrimitive(true)
                if (s.code) o["code"] = JsonPrimitive(true)
                s.link?.let { o["link"] = JsonPrimitive(it) }
                JsonObject(o)
            },
        )
        fun hasDraft(blocks: List<MarkdownBlock>): Boolean = blocks.any {
            it is MarkdownBlock.Draft || (it is MarkdownBlock.Quote && hasDraft(it.blocks))
        }
        val file = File("../../shared/cases/draft-blocks.json")
        val cases = (parseJson(file.readText()) as JsonObject).arr("cases")!!
        assertTrue(cases.size >= 50)
        for (c in cases) {
            val o = c as JsonObject
            if (o.obj("differs")?.str("android") != null) continue
            val name = o.str("name")!!
            val input = o.obj("input")!!
            fun draft() = DraftBlock(DraftBlock.Kind.entries.first { it.wire == input.str("kind") }, input.str("source")!!)
            val got: JsonElement = when (val op = input.str("op")) {
                "from" -> DraftBlock.from(input.str("language"), input.str("code")!!)?.let {
                    JsonObject(mapOf("kind" to JsonPrimitive(it.kind.wire), "source" to JsonPrimitive(it.source), "label" to JsonPrimitive(it.label)))
                } ?: JsonNull
                "lines" -> JsonArray(draft().lines.map { JsonObject(mapOf("quote" to JsonPrimitive(it.quote), "spans" to neutral(it.spans))) })
                "plainText" -> JsonPrimitive(draft().plainText)
                "html" -> JsonPrimitive(draft().html)
                "spans" -> neutral(DraftBlock.slackSpans(input.str("line")!!))
                "closed" -> JsonPrimitive(hasDraft(MarkdownBlock.parse(input.str("text")!!)))
                else -> fail("$name: no $op on Android")
            }
            assertEquals(o["expect"], got, name)
        }
    }

    /** A sent message with the Mac's edited drafts on its end (DraftBlockTests.swift, aSentMessageGivesBackItsEditedDrafts). */
    @Test fun aSentMessageGivesBackItsEditedDrafts() {
        val intro = "I edited your draft. Use my version below exactly as it is, not yours:"
        val one = "Send it\n\n$intro\n\n```email\nHi Geoff,\n\nCheers\n```"
        val split = DraftBlock.splitEdited(one)
        assertEquals("Send it", split?.words)
        assertEquals(listOf(DraftBlock(DraftBlock.Kind.EMAIL, "Hi Geoff,\n\nCheers")), split?.drafts)
        assertEquals("", DraftBlock.splitEdited("$intro\n\n```slack\nhey\n```")?.words)
        val many = "I edited your drafts. Use my versions below exactly as they are, not yours:"
        val two = "ok\n\n$many\n\n```draft\nrun `x`\n```\n\n````email\na\n```\nb\n```\n\nc\n````"
        assertEquals(listOf("run `x`", "a\n```\nb\n```\n\nc"), DraftBlock.splitEdited(two)?.drafts?.map { it.source })
        assertNull(DraftBlock.splitEdited("Send it"))
        assertNull(DraftBlock.splitEdited("$one\n\nand another thing"))
        assertNull(DraftBlock.splitEdited("He said $intro\n\n```email\nx\n```"))
        assertNull(DraftBlock.splitEdited("$intro\n\n```python\nx\n```"))
        // One intro with two drafts, or the many intro with one, isn't the Mac's.
        assertNull(DraftBlock.splitEdited("$intro\n\n```email\na\n```\n\n```slack\nb\n```"))
        assertNull(DraftBlock.splitEdited("$many\n\n```email\na\n```"))
        // A draft that quotes the line itself still comes apart at the real one.
        assertEquals("ok", DraftBlock.splitEdited("ok\n\n$intro\n\n```email\nThe app said:\n\n$intro\n```")?.words)
        // A long one is shown too, and Windows line ends are plain ones.
        val long = "x".repeat(DraftBlock.MAX_SOURCE + 1)
        assertEquals(long, DraftBlock.splitEdited("$intro\n\n```draft\n$long\n```")?.drafts?.first()?.source)
        assertEquals("a\nb", DraftBlock.splitEdited("$intro\n\n```email\na\r\nb\n```")?.drafts?.first()?.source)
        // The parity scenario's message, as the Mac sends it.
        val sent = "Send it\n\n$intro\n\n```email\nHi Geoff,\n\nI don't think it came through. Can you send it again please?\n```"
        assertEquals("Send it", DraftBlock.splitEdited(sent)?.words)
        assertEquals("Your edited email", DraftBlock.splitEdited(sent)?.drafts?.single()?.editedLabel)
        // A picture sent with it and no marker: the runner's "[1 picture]" line
        // after the fence stays with his words, for ThreadPictures.words to take off.
        assertEquals("Send it\n\n[1 picture]", DraftBlock.splitEdited("$sent\n\n[1 picture]")?.words)
        assertEquals("[2 pictures]", DraftBlock.splitEdited("$intro\n\n```email\nx\n```\n\n[2 pictures]")?.words)
        // Windows line ends all through come apart the same.
        assertEquals("Send it", DraftBlock.splitEdited(sent.replace("\n", "\r\n"))?.words)
        assertEquals("Your edited Slack message", DraftBlock(DraftBlock.Kind.SLACK, "x").editedLabel)
        assertEquals("Your edited draft", DraftBlock(DraftBlock.Kind.DRAFT, "x").editedLabel)
    }
}
