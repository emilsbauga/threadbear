package com.mikerosoft.threadbear.kit

import java.net.URI

/**
 * What Threadbear opens without asking, for a link that came from anything
 * it doesn't fully trust: an agent's words, a web page, another Mac's runner
 * or the backend (SECURITY.md, "Links and files"; the iPhone's
 * LinkPolicy.swift, the parts a phone uses). The app's LinkGate is the only
 * place that hands a URL to the system, and decides with this.
 */
object LinkPolicy {
    sealed class Kind {
        /** http or https with a host: the browser, without asking. */
        data class Web(val url: String) : Kind()
        /** A file: on the Mac, never opened here. */
        data class File(val url: String) : Kind()
        /**
         * Any other scheme (`mailto:`, `slack:`, `intent:`): it starts another
         * app, which can act on what the link says, so only once Mike has said
         * yes to that link by name.
         */
        data class Ask(val url: String) : Kind()
        /** Nothing that can be opened: no scheme, or web with no host. */
        data object Refuse : Kind()
    }

    private val schemePattern = Regex("^([A-Za-z][A-Za-z0-9+.-]*):")

    /** The longest link looked at, of any kind (the desktop's MAX_LINK). */
    const val MAX_LINK = 8_192

    /**
     * The longest link that asks: its question shows all of it, and has to
     * fit on a screen, the desktop's alert too, which doesn't scroll
     * (Gemini's review). A real `mailto:` or app link is a few hundred at
     * most.
     */
    const val MAX_ASK_LINK = 1_024

    fun scheme(url: String): String? = schemePattern.find(url)?.groupValues?.get(1)?.lowercase()

    /**
     * Before the scheme is looked at, for every kind: too long, or with a
     * character that changes how the rest shows (a control such as a line
     * break or tab, a bidi override, a zero-width or other format
     * character, a line or paragraph separator, half a surrogate pair), is
     * refused. Such a link asked about could show one thing and open
     * another (Daybreak 167, 22 Nov 2026).
     */
    fun kind(url: String): Kind {
        if (url.length > MAX_LINK || hidesText(url)) return Kind.Refuse
        return when (scheme(url)) {
            null -> Kind.Refuse
            "http", "https" -> web(url)?.let { Kind.Web(it) } ?: Kind.Refuse
            "file" -> Kind.File(url)
            // One that asks is printable ASCII only: a space, a blank filler
            // (U+2800, U+3164) or a run of wide letters could push the rest
            // of it out of sight in the question (Gemini's reviews). A real
            // link percent-encodes anything else.
            else -> if (url.length > MAX_ASK_LINK || !url.all { it in '!'..'~' }) Kind.Refuse else Kind.Ask(url)
        }
    }

    /** Whether `text` has a character that hides or reorders what's around it (`kind`). */
    fun hidesText(text: String): Boolean {
        var i = 0
        while (i < text.length) {
            val c = text.codePointAt(i)
            when (Character.getType(c).toByte()) {
                Character.CONTROL, Character.FORMAT, Character.LINE_SEPARATOR, Character.PARAGRAPH_SEPARATOR,
                Character.SURROGATE,
                -> return true
            }
            i += Character.charCount(c)
        }
        return false
    }

    /**
     * An http(s) address with a host, else null. The scheme is compared
     * without case (`HTTPS:` is web too); anything else is not web.
     */
    fun web(url: String?): String? {
        if (url == null || url.length > MAX_LINK || hidesText(url)) return null
        val s = scheme(url)
        if (s != "http" && s != "https") return null
        val host = try {
            URI(url).host
        } catch (_: Exception) {
            null
        }
        return if (host.isNullOrEmpty()) null else url
    }

    /**
     * The words of the question for a link that asks, with all of the link
     * in them, as it will open: never cut in the middle, where what it says
     * to do could hide (Daybreak 167). `kind` keeps an asking link short
     * enough to show whole, and the dialog scrolls.
     */
    fun question(ask: Kind.Ask): Pair<String, String> =
        "Open this ${ask.url.substringBefore(':')} link?" to
            "It isn't a web page: it opens another app, which acts on what the link says. It's from a thread, so Threadbear asks first.\n\n${ask.url}"
}
