package com.mikerosoft.threadbear.kit

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject

/**
 * Sharing a thread by link from Android (backend API 8, phone:share): the
 * link from the website's address and the row's slug, the command's
 * arguments, and what the share sheet shows while one is on its way.
 */
class ShareTest {
    private val site = "https://happy-bear-123.convex.site"
    private val shared = PhoneShare("link", "abc_DEF-1")
    private val off = PhoneShare("off", "abc_DEF-1")

    @Test fun theRowsShareIsRead() {
        val row = parseJson("""{"threadId":"t","runnerId":"r","title":"t","cwd":"/w","accountId":"a","provider":"claude","status":"idle","needsYou":false,"unread":false,"preview":"","lastActivityAt":1,"share":{"access":"link","slug":"abc"}}""") as JsonObject
        assertEquals(PhoneShare("link", "abc"), PhoneThread.read(row).share)
        assertTrue(PhoneThread.read(row).share!!.byLink)
        // Never shared: no share. A share in a shape this phone doesn't know never stops the row.
        assertNull(PhoneShare.read(parseJson("""{"access":"link"}""") as JsonObject))
        // "people" (gone since API 8) reads as not shared.
        assertFalse(PhoneShare.read(parseJson("""{"access":"people","slug":"x"}""") as JsonObject)!!.byLink)
    }

    @Test fun phoneMeSaysWhereTheWebsiteIs() {
        val me = PhoneIdentity.read(parseJson("""{"name":"pixel","expiresAt":"2027-02-18T00:00:00.000Z","apiVersion":97,"site":"https://tb-site.example.com"}""") as JsonObject)
        assertEquals("https://tb-site.example.com", me.site)
    }

    @Test fun theWebsiteIsTheBackendsWordElseTheCloudTwin() {
        // The backend's own CONVEX_SITE_URL wins: a self-hosted one serves its site anywhere.
        assertEquals("https://tb-site.example.com", ShareLinks.site("https://mac.tail1.ts.net", "https://tb-site.example.com/"))
        assertEquals("http://127.0.0.1:23211", ShareLinks.site("http://127.0.0.1:23210", "http://127.0.0.1:23211"))
        // An older backend says nothing: a cloud deployment's site is its .convex.site twin.
        assertEquals(site, ShareLinks.site("https://happy-bear-123.convex.cloud", null))
        assertEquals("https://x.eu-west-1.convex.site", ShareLinks.site("https://x.eu-west-1.convex.cloud/", ""))
        // A self-hosted one that says nothing has no address the phone can know.
        assertNull(ShareLinks.site("https://mac.tail1.ts.net", null))
        assertNull(ShareLinks.site(null, null))
        // Only a web address.
        assertNull(ShareLinks.site("https://mac.tail1.ts.net", "javascript:alert(1)"))
        assertNull(ShareLinks.site("https://mac.tail1.ts.net", "https://x.example.com/?a=1"))
    }

    @Test fun theLinkIsSiteSlashSSlashSlug() {
        assertEquals("$site/s/abc_DEF-1", ShareLinks.link(site, "abc_DEF-1"))
        assertNull(ShareLinks.link(null, "abc"))
        // A slug is base64url: anything else isn't one.
        assertNull(ShareLinks.link(site, "../x"))
        assertNull(ShareLinks.link(site, ""))
    }

    @Test fun theCommandsArguments() = runTest {
        val t = FakeTransport()
        val b = PhoneBackend(t, "tok")
        b.share("t1", ShareAsk.On)
        b.share("t1", ShareAsk.Off)
        b.share("t1", ShareAsk.NewLink("abc"))
        assertEquals(listOf("phone:share", "phone:share", "phone:share"), t.calls.map { it.first })
        assertEquals("""{"threadId":"t1","access":"link","token":"tok"}""", JsonObject(t.calls[0].second).toString())
        assertEquals("""{"threadId":"t1","access":"off","token":"tok"}""", JsonObject(t.calls[1].second).toString())
        // newLink only when asked: an older backend's validator would refuse an unknown false too.
        assertEquals("""{"threadId":"t1","access":"link","newLink":true,"token":"tok"}""", JsonObject(t.calls[2].second).toString())
    }

    @Test fun aTapsAskComesBackFromItsValue() {
        for (ask in listOf(ShareAsk.On, ShareAsk.Off, ShareAsk.NewLink("abc"))) assertEquals(ask, ShareAsk.of(ask.value))
        assertNull(ShareAsk.of(null))
        assertNull(ShareAsk.of("people"))
        // The switch asks for the other way from what it shows.
        assertEquals(ShareAsk.Off, ShareSheet.view(shared, site, PendingCommand.Idle, null).toggle)
        assertEquals(ShareAsk.On, ShareSheet.view(off, site, PendingCommand.Idle, null).toggle)
        assertEquals(ShareAsk.On, ShareSheet.view(null, site, PendingCommand.Idle, null).toggle)
    }

    @Test fun notSharedSaysOnlyYou() {
        val v = ShareSheet.view(off, site, PendingCommand.Idle, null)
        assertFalse(v.on)
        assertNull(v.link)
        assertFalse(v.canSend)
        assertEquals("Only you can see this thread.", v.says)
        assertFalse(v.locked)
        assertNull(v.note)
    }

    @Test fun sharedShowsTheLinkToCopyAndSend() {
        val v = ShareSheet.view(shared, site, PendingCommand.Idle, null)
        assertTrue(v.on)
        assertEquals("$site/s/abc_DEF-1", v.link)
        assertTrue(v.canSend)
        assertEquals("Anyone with the link can read this thread, and new replies show up as they come in. No sign-in.", v.says)
        assertEquals(ShareAsk.NewLink("abc_DEF-1"), v.newLink)
    }

    @Test fun turningItOnShowsAtOnceAndSpinsUntilTheRowSaysSo() {
        val queued = PendingCommand.Queued("c1", 0)
        // Never shared: on at once, no link yet.
        val first = ShareSheet.view(null, site, queued, ShareAsk.On.value)
        assertTrue(first.on)
        assertNull(first.link)
        assertTrue(first.making)
        assertTrue(first.switching)
        assertTrue(first.locked)
        // Shared before: the same link comes back, but it doesn't work until the runner's done it.
        val again = ShareSheet.view(off, site, queued, ShareAsk.On.value)
        assertEquals("$site/s/abc_DEF-1", again.link)
        assertFalse(again.canSend)
        assertNull(again.newLink)
        // Done but the row hasn't caught up: still spinning.
        val doneEarly = ShareSheet.view(off, site, PendingCommand.Done("c1", null), ShareAsk.On.value)
        assertTrue(doneEarly.switching)
        assertFalse(doneEarly.settled)
        // The row says so: the link works, and the command can be let go.
        val caughtUp = ShareSheet.view(shared, site, PendingCommand.Done("c1", null), ShareAsk.On.value)
        assertFalse(caughtUp.switching)
        assertTrue(caughtUp.canSend)
        assertTrue(caughtUp.settled)
    }

    @Test fun turningItOffHidesTheLinkAtOnce() {
        val v = ShareSheet.view(shared, site, PendingCommand.Sending(0), ShareAsk.Off.value)
        assertFalse(v.on)
        assertNull(v.link)
        assertFalse(v.canSend)
        assertTrue(v.switching)
        assertFalse(v.renewing)
    }

    @Test fun aNewLinkHidesTheOldOneUntilTheSlugChanges() {
        val ask = ShareAsk.NewLink("abc_DEF-1").value
        val waiting = ShareSheet.view(shared, site, PendingCommand.Taken("c1", 0), ask)
        assertTrue(waiting.on)
        assertNull(waiting.link)
        assertTrue(waiting.renewing)
        assertFalse(waiting.switching)
        assertTrue(waiting.locked)
        val fresh = ShareSheet.view(PhoneShare("link", "newSlug"), site, PendingCommand.Taken("c1", 0), ask)
        assertEquals("$site/s/newSlug", fresh.link)
        assertTrue(fresh.canSend)
        assertFalse(fresh.renewing)
    }

    @Test fun aRefusalPutsItBackWithWhy() {
        val refused = ShareSheet.view(off, site, PendingCommand.Failed("c1", "No such thread"), ShareAsk.On.value)
        assertFalse(refused.on)
        assertFalse(refused.locked)
        assertEquals("No such thread", refused.note)
        val silent = ShareSheet.view(off, site, PendingCommand.Failed(null, null), ShareAsk.On.value)
        assertEquals(ShareSheet.REFUSED, silent.note)
    }

    @Test fun aSleepingMacIsSaid() {
        // Its runner's offline: said at once, and the change stays shown.
        val asleep = ShareSheet.view(off, site, PendingCommand.Queued("c1", 0), ShareAsk.On.value, offline = "Mike's MacBook")
        assertTrue(asleep.on)
        assertEquals("Waiting for Mike's MacBook, which is offline. It happens when it's back.", asleep.note)
        // Nothing heard in time: the time-out's own words, and taps again.
        val late = ShareSheet.view(off, site, PendingCommand.TimedOut("c1", false), ShareAsk.On.value)
        assertTrue(late.on)
        assertFalse(late.locked)
        assertEquals(PendingCommand.TimedOut("c1", false).timedOutNote, late.note)
    }

    @Test fun noWebsiteAddressIsSaid() {
        val v = ShareSheet.view(shared, null, PendingCommand.Idle, null)
        assertTrue(v.on)
        assertNull(v.link)
        assertFalse(v.making)
        assertEquals(ShareSheet.NO_SITE, v.note)
    }
}
