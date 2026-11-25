package com.mikerosoft.threadbear.kit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject

/** The phone's copy of the Mac's LinkPolicy: a reply's link to another app waits for a yes, a web page opens (Daybreak, 7 Nov). */
class LinkPolicyTest {
    @Test fun onlyWebPagesOpenWithoutAsking() {
        for (web in listOf("https://example.com/", "HTTP://localhost:5173/")) assertIs<LinkPolicy.Kind.Web>(LinkPolicy.kind(web), web)
        for (other in listOf("shortcuts://run-shortcut?name=x", "tel:123", "JaVaScRiPt:alert(1)", "itms-services://?action=download-manifest",
            "prefs:root=General", "threadbear://pair?url=x", "intent://x#Intent;scheme=y;end")) {
            assertIs<LinkPolicy.Kind.Ask>(LinkPolicy.kind(other), other)
        }
        assertIs<LinkPolicy.Kind.File>(LinkPolicy.kind("file:///etc/hosts"))
    }

    @Test fun noSchemeOrNoHostIsRefused() {
        assertEquals(LinkPolicy.Kind.Refuse, LinkPolicy.kind("/a/b.md"))
        assertEquals(LinkPolicy.Kind.Refuse, LinkPolicy.kind("https:///path"))
        assertEquals(LinkPolicy.Kind.Refuse, LinkPolicy.kind("https://"))
    }

    /** Daybreak 167: the question showed the first 200 and last 100 characters, and opened all of it. */
    @Test fun theQuestionShowsTheWholeLinkItOpens() {
        val long = "x-app://do?" + "a=1&".repeat(200) + "send=everything"
        val ask = assertIs<LinkPolicy.Kind.Ask>(LinkPolicy.kind(long))
        assertEquals(long, ask.url, "what opens is the link as written")
        val (title, detail) = LinkPolicy.question(ask)
        assertEquals("Open this x-app link?", title)
        assertTrue(detail.endsWith("\n\n" + long), "the whole link, byte for byte, as it opens")
    }

    @Test fun oneLengthLimitBeforeTheScheme() {
        val ask = "x-app://" + "a".repeat(LinkPolicy.MAX_ASK_LINK - 8)
        assertIs<LinkPolicy.Kind.Ask>(LinkPolicy.kind(ask))
        assertEquals(LinkPolicy.Kind.Refuse, LinkPolicy.kind(ask + "a"), "an asking link too long to show whole")
        assertEquals(LinkPolicy.Kind.Refuse, LinkPolicy.kind("mailto:" + "a".repeat(10_000)))
        val web = "https://x.dev/" + "a".repeat(LinkPolicy.MAX_LINK - 14)
        assertIs<LinkPolicy.Kind.Web>(LinkPolicy.kind(web), "a web page opens without a question")
        assertEquals(LinkPolicy.Kind.Refuse, LinkPolicy.kind(web + "a"))
        assertEquals(LinkPolicy.Kind.Refuse, LinkPolicy.kind("file:///" + "a".repeat(LinkPolicy.MAX_LINK)))
        assertIs<LinkPolicy.Kind.Ask>(LinkPolicy.kind("mailto:mike@example.com?subject=Hi%20there&body=Line%0Atwo"), "an ordinary mailto still asks")
    }

    @Test fun charactersThatHideTextAreRefused() {
        for (c in listOf("\r", "\n", "\t", "\u0000", "\u007f", "\u0085", "\u202e", "\u202d", "\u2066", "\u2069", "\u200e", "\u200f", "\u061c",
            "\u200b", "\u200d", "\u2060", "\ufeff", "\u00ad", "\u2028", "\u2029", "\udb40\udc01", "\ud800")) {
            for (url in listOf("x-app://do?to=me${c}&to=you", "https://example.com/${c}x", "file:///tmp/${c}a")) {
                assertEquals(LinkPolicy.Kind.Refuse, LinkPolicy.kind(url), url.map { "%04x".format(it.code) }.joinToString())
            }
        }
        // One that asks is printable ASCII (Gemini's reviews: blank fillers
        // and wide letters push its end out of sight); letters from any
        // language are fine percent-encoded, and in a web address.
        for (blank in listOf("x-app://café/日本", "x-app://a\u2800b", "x-app://a\u3164b", "x-app://a b", "x-app://Ｗ")) {
            assertEquals(LinkPolicy.Kind.Refuse, LinkPolicy.kind(blank), blank)
        }
        assertIs<LinkPolicy.Kind.Ask>(LinkPolicy.kind("x-app://caf%C3%A9"))
        assertIs<LinkPolicy.Kind.Web>(LinkPolicy.kind("https://example.com/café/日本"))
    }

    /** The cases the desktop app, the iPhone and the website run too (shared/cases/link-policy.json). */
    @Test fun linksFollowTheSharedCases() {
        val cases = (parseJson(File("../../shared/cases/link-policy.json").readText()) as JsonObject).arr("cases")!!
        assertTrue(cases.size >= 40)
        for (c in cases) {
            val o = c as JsonObject
            if (o.obj("differs")?.str("android") != null) continue
            val kind = when (LinkPolicy.kind(o.str("input")!!)) {
                is LinkPolicy.Kind.Web -> "web"
                is LinkPolicy.Kind.Ask -> "ask"
                is LinkPolicy.Kind.File -> "file"
                LinkPolicy.Kind.Refuse -> "refuse"
            }
            assertEquals(o.str("expect"), kind, o.str("name"))
        }
    }
}
