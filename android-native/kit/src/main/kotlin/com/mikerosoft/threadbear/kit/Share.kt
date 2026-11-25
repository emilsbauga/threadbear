package com.mikerosoft.threadbear.kit

import java.net.URI
import kotlinx.serialization.json.JsonObject

/**
 * A thread's sharing by link, as its row carries it (backend API 8;
 * docs/protocol/runners.md, "Sharing"): `link` is shared, `off` keeps the
 * slug so sharing again brings the same link back. Anything else (the old
 * "people") reads as not shared.
 */
data class PhoneShare(val access: String, val slug: String) {
    val byLink get() = access == "link"

    companion object {
        /** Null for a thread never shared, or a share in a shape this phone doesn't know. */
        fun read(o: JsonObject?): PhoneShare? {
            val slug = o?.str("slug")?.takeIf { it.isNotEmpty() } ?: return null
            return PhoneShare(o.str("access") ?: "off", slug)
        }
    }
}

/** Where a shared thread's page is: `<site>/s/<slug>` (docs/website.md, "Sharing"). */
object ShareLinks {
    private val SLUG = Regex("^[A-Za-z0-9_-]+$")

    /**
     * The website's address: what the backend says (phone:me's `site`, its
     * CONVEX_SITE_URL, which a self-hosted backend serves anywhere), else a
     * cloud deployment's `.convex.site` twin of its `.convex.cloud` URL, as
     * the runner's siteOf. Null when neither: the phone can't know it.
     */
    fun site(deploymentUrl: String?, advertised: String?): String? {
        advertised?.trim()?.takeIf { it.isNotEmpty() }?.let { return origin(it) }
        val url = deploymentUrl?.trim()?.trimEnd('/') ?: return null
        val host = try { URI(url).host?.lowercase() } catch (_: Exception) { null } ?: return null
        if (!host.endsWith(".convex.cloud")) return null
        return url.replace(".convex.cloud", ".convex.site")
    }

    /** An http(s) address with nothing after its origin but a path, without its last slash. */
    private fun origin(raw: String): String? {
        val uri = try { URI(raw) } catch (_: Exception) { return null }
        if (uri.scheme !in setOf("https", "http") || uri.host.isNullOrEmpty()) return null
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
        return raw.trimEnd('/')
    }

    /** The thread's link, or null without a site or for something that isn't a slug (base64url). */
    fun link(site: String?, slug: String): String? {
        if (site == null || !SLUG.matches(slug)) return null
        return "$site/s/$slug"
    }
}

/**
 * What a tap on the share sheet asks for, kept as the pending command's
 * value ([value]) so the sheet can show it at once. A new link remembers the
 * slug it replaces, so the old link hides until the row has the new one.
 */
sealed interface ShareAsk {
    val value: String
    /** phone:share's `access`. */
    val access: String

    data object On : ShareAsk {
        override val value get() = "link"
        override val access get() = "link"
    }
    data object Off : ShareAsk {
        override val value get() = "off"
        override val access get() = "off"
    }
    data class NewLink(val replacing: String) : ShareAsk {
        override val value get() = "new:$replacing"
        override val access get() = "link"
    }

    companion object {
        fun of(value: String?): ShareAsk? = when {
            value == null -> null
            value == On.value -> On
            value == Off.value -> Off
            value.startsWith("new:") -> NewLink(value.removePrefix("new:"))
            else -> null
        }
    }
}

/**
 * The share sheet as it shows: the thread's share with a tap on its way
 * ([ShareSheet.view]) on top, as the website's ShareControl
 * (web/src/share.tsx) does with its command.
 */
data class ShareView(
    /** What the switch shows. */
    val on: Boolean,
    /** The link to show; null while there's none yet or it's being replaced. */
    val link: String?,
    /** Copy and Send: only once the link really opens (the row says shared). */
    val canSend: Boolean,
    /** The words under the switch. */
    val says: String,
    /** The switch's spinner. */
    val switching: Boolean,
    /** New link's spinner. */
    val renewing: Boolean,
    /** On, with a link on its way (spinning where the link goes). */
    val making: Boolean,
    /** Nothing takes taps: a command is on its way, or just done. */
    val locked: Boolean,
    /** Done and the row has caught up: the command can be let go, so the controls take taps again. */
    val settled: Boolean,
    /** A refusal, a sleeping Mac, a time-out, or no website address. */
    val note: String?,
    /** What the switch asks for. */
    val toggle: ShareAsk,
    /** What New link asks for, when there's a link to replace. */
    val newLink: ShareAsk?,
)

object ShareSheet {
    const val REFUSED = "The runner couldn't change this thread's sharing."
    const val NO_SITE = "This server doesn't say where its website is, so there's no link to show."
    const val SHARED = "Anyone with the link can read this thread, and new replies show up as they come in. No sign-in."
    const val PRIVATE = "Only you can see this thread."

    /**
     * [state] and [value] are the thread's share command and its value
     * ([ShareAsk.value]); [offline] is its runner's name while it's offline.
     */
    fun view(share: PhoneShare?, site: String?, state: PendingCommand, value: String?, offline: String? = null): ShareView {
        val asked = if (state.holdsChange) ShareAsk.of(value) else null
        val on = when (asked) {
            ShareAsk.On, is ShareAsk.NewLink -> true
            ShareAsk.Off -> false
            null -> share?.byLink == true
        }
        val replacing = asked is ShareAsk.NewLink && share?.slug == asked.replacing
        val link = if (on && share != null && !replacing) ShareLinks.link(site, share.slug) else null
        val caughtUp = (share?.byLink == true) == on && !replacing && (asked !is ShareAsk.On || share != null)
        // Spinning until the row shows what was asked, even once the runner's said done.
        val going = !caughtUp && when (state) {
            is PendingCommand.Sending, is PendingCommand.Queued, is PendingCommand.Taken, is PendingCommand.Done -> true
            PendingCommand.Idle, is PendingCommand.Failed, is PendingCommand.TimedOut -> false
        }
        val note = state.failure(REFUSED)
            ?: offline?.takeIf { state.waiting && state !is PendingCommand.TimedOut }?.let { "Waiting for $it, which is offline. It happens when it's back." }
            ?: state.timedOutNote
            ?: NO_SITE.takeIf { on && site == null }
        return ShareView(
            on = on,
            link = link,
            canSend = link != null && share?.byLink == true,
            says = if (on) SHARED else PRIVATE,
            switching = going && asked !is ShareAsk.NewLink,
            renewing = going && asked is ShareAsk.NewLink,
            making = on && link == null && site != null,
            locked = state.locked,
            settled = state is PendingCommand.Done && caughtUp,
            note = note,
            toggle = if (on) ShareAsk.Off else ShareAsk.On,
            newLink = if (link != null && share?.byLink == true) ShareAsk.NewLink(share.slug) else null,
        )
    }
}
