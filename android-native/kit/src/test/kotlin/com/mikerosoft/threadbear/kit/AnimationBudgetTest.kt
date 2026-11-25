package com.mikerosoft.threadbear.kit

import java.io.ByteArrayOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Daybreak 166 (22 Nov 2026): a small moving picture of thousands of frames
 * passed every byte and size cap and played every frame. Its frames are now
 * counted from the file first, as the iPhone's AnimationPlan does.
 */
class AnimationBudgetTest {
    @Test fun gifFramesAreCounted() {
        assertEquals(1, AnimationFrames.count(gif(1)))
        assertEquals(12, AnimationFrames.count(gif(12)))
        assertEquals(12, AnimationFrames.count(gif(12, colorTables = true)), "colour tables skipped right")
        // Counting stops once it's past the limit, however many there are.
        assertEquals(AnimationLimits.MAX_FRAMES + 1, AnimationFrames.count(gif(5_000)))
    }

    /** Pixels for a frame of w by h, shown at the same size. */
    private fun work(data: ByteArray, w: Int, h: Int) = AnimationFrames.work(data, w, h, w, h)

    @Test fun framesJustUnderAndOverTheLimits() {
        // 100 ms frames (the files below), 10x10.
        assertNotNull(work(gif(AnimationLimits.MAX_FRAMES), 10, 10), "600 frames play")
        assertNull(work(gif(AnimationLimits.MAX_FRAMES + 1), 10, 10), "601 stay still")
        // Pixels across every frame: 100 frames of 2000x2000 is 400 million.
        assertNotNull(AnimationFrames.work(gif(100, delayCs = 100), 2000, 2000, 2000, 2000))
        assertNull(AnimationFrames.work(gif(101, delayCs = 100), 2000, 2000, 2000, 2000))
        assertNull(work(gif(1), 10, 10), "one frame is a still")
    }

    /** Gemini's review: the decoder reads every frame at the file's own size, whatever it's shown at. */
    @Test fun framesCountAtTheFilesOwnSize() {
        val wide = gif(600, delayCs = 100)
        // 50,000 x 1,000 shown 1400 x 28: the source's pixels count.
        assertNull(AnimationFrames.work(wide, 50_000, 1_000, 1400, 28))
        assertNotNull(AnimationFrames.work(wide, 500, 10, 1400, 28), "and the shown size, when it's the bigger")
        assertNull(AnimationFrames.work(gif(2), Int.MAX_VALUE, Int.MAX_VALUE, 10, 10), "no overflow")
    }

    /** Codex's and Gemini's reviews: a pass within budget can still loop fast enough to keep the phone busy. */
    @Test fun pixelsASecondAreBoundedAtTheFastest() {
        // 2000x2000, 10 frames: 40 million a pass.
        assertNotNull(AnimationFrames.work(gif(10, delayCs = 10), 2000, 2000, 2000, 2000), "10 a second: 40 million a second")
        assertNull(AnimationFrames.work(gif(10, delayCs = 2), 2000, 2000, 2000, 2000), "50 a second: 200 million")
        // A GIF frame of 0 or 10 ms may play once a refresh (Gemini's review).
        assertNull(AnimationFrames.work(gif(10, delayCs = 0), 2000, 2000, 2000, 2000))
        assertEquals(AnimationLimits.MIN_FRAME_MS, AnimationFrames.scan(gif(10, delayCs = 0))!!.shortestMs)
        assertEquals(10L, AnimationFrames.scan(gif(10, delayCs = 1))!!.shortestMs)
        // One long frame can't hide a fast run: 99 at 20 ms and one of 10 s.
        val burst = gif(100, delays = List(99) { 2 } + 1000)
        assertNull(AnimationFrames.work(burst, 2000, 2000, 2000, 2000))
        // A slow small one costs at least one pixel a second, so it gets a place.
        val slow = assertNotNull(AnimationFrames.work(gif(2, delayCs = 10_000), 10, 10, 10, 10))
        assertTrue(slow.pixelsPerSecond >= 1)
    }

    /** WebP and APNG frame times pass through Android unclamped, so a 1 ms frame plays once a refresh. */
    @Test fun fastWebpFramesCountAtTheRefreshRate() {
        assertEquals(AnimationLimits.MIN_FRAME_MS, AnimationFrames.scan(webp(5, durationMs = 1))!!.shortestMs)
        assertNull(AnimationFrames.work(webp(2, durationMs = 1), 1200, 1000, 1200, 1000), "1.2 MP 125 times a second")
    }

    @Test fun everyMovingFormatHasTheSameBudget() {
        for ((name, make) in listOf<Pair<String, (Int) -> ByteArray>>("gif" to { gif(it) }, "webp" to { webp(it) }, "apng" to { apng(it) })) {
            assertEquals(7, AnimationFrames.count(make(7)), name)
            assertEquals(100L, AnimationFrames.scan(make(7))!!.shortestMs, "$name: 100 ms a frame")
            assertNotNull(work(make(AnimationLimits.MAX_FRAMES), 10, 10), name)
            assertNull(work(make(AnimationLimits.MAX_FRAMES + 1), 10, 10), name)
        }
        // APNG: whichever of acTL (any of them) and the fcTL chunks says more.
        assertNull(work(apng(3, declared = 100_000), 10, 10))
        assertNull(work(apng(AnimationLimits.MAX_FRAMES + 1, declared = 2), 10, 10))
        assertNull(work(apng(3, declared = 100_000, secondDeclared = 2), 10, 10), "a second acTL can't lower it")
    }

    @Test fun whatCantBeCountedStaysStill() {
        assertNull(AnimationFrames.count(byteArrayOf(1, 2, 3)))
        assertNull(work("GIF89a".toByteArray() + ByteArray(7) + byteArrayOf(0x55), 10, 10), "a block GIF doesn't have")
        assertNull(work(ByteArray(64), 10, 10))
    }

    /** Codex's review: a graphic control block that says it's shorter than four bytes, which Skia reads past. */
    @Test fun aMalformedGraphicControlBlockStaysStill() {
        val head = gif(2)
        val body = head.copyOf(head.size - 1) + byteArrayOf(0x21, 0xF9.toByte(), 0x00, 0x3B, 0x02, 0, 0, 0) + gif(3000).drop(13 + 19).toByteArray()
        assertNull(AnimationFrames.count(body))
    }

    /** Gemini's review: zero bytes between blocks are padding, not the end. */
    @Test fun paddingBetweenBlocksIsSkipped() {
        val g = gif(3)
        val padded = g.copyOf(g.size - 1) + byteArrayOf(0, 0) + g.copyOfRange(13 + 19, g.size)
        assertEquals(6, AnimationFrames.count(padded))
    }

    /** Cut short, a decoder reads what it can its own way: still. */
    @Test fun aFileCutShortStaysStill() {
        for ((name, whole) in listOf("gif" to gif(10), "webp" to webp(10), "apng" to apng(10))) {
            assertNotNull(AnimationFrames.count(whole), name)
            assertNull(AnimationFrames.count(whole.copyOf(whole.size / 2)), name)
        }
    }

    /** Codex's review: NETSCAPE's loop block is three bytes, and Skia reads three whatever it says. */
    @Test fun aShortLoopBlockStaysStill() {
        val g = gif(2)
        val bad = g.copyOf(g.size - 1) + byteArrayOf(0x21, 0xFF.toByte(), 11) + "NETSCAPE2.0".toByteArray() + byteArrayOf(1, 1, 0, 0x3B, 0) + g.copyOfRange(13 + 19, g.size)
        assertNull(AnimationFrames.count(bad))
    }

    /** Grok's review: Android's GIF decoder ends the picture at a zero byte, playing the frames before it. */
    @Test fun aZeroInPlaceOfTheTrailerCountsTheFramesBefore() {
        val g = gif(10)
        val zeroEnd = g.copyOf()
        zeroEnd[g.size - 1] = 0
        assertEquals(10, AnimationFrames.count(zeroEnd))
        // Frames after a zero count too: more frames only keeps it stiller.
        val two = g.copyOf(g.size - 1) + byteArrayOf(0) + g.copyOfRange(13 + 19, g.size)
        assertEquals(20, AnimationFrames.count(two))
    }

    /** Codex's review: a 165 Hz screen plays a 1 ms WebP frame 165 times a second. */
    @Test fun theFrameFloorAllowsForTheFastestScreens() {
        assertTrue(1000 / AnimationLimits.MIN_FRAME_MS >= 165)
        assertNull(AnimationFrames.work(webp(2, durationMs = 1), 960, 1000, 960, 1000), "960x1000 at 200 a second is over")
    }

    /** Gemini's review: a frame wider than the canvas is decoded at its own width. */
    @Test fun aFrameBiggerThanItsCanvasStaysStill() {
        val g = gif(3)
        assertNotNull(AnimationFrames.count(g))
        // The second frame's descriptor: 65535 wide on a 1x1 canvas.
        val firstFrame = 13 + 19 + 8
        val second = firstFrame + 10 + 5 + 8
        assertEquals(0x2C, g[second].toInt())
        val wide = g.copyOf()
        wide[second + 5] = 0xFF.toByte()
        wide[second + 6] = 0xFF.toByte()
        assertNull(AnimationFrames.count(wide))
        val shifted = g.copyOf()
        shifted[second + 1] = 1
        assertNull(AnimationFrames.count(shifted), "one pixel off the canvas")
    }

    /** Codex's review: every NETSCAPE sub-block is read three bytes at least. */
    @Test fun aLaterShortNetscapeBlockStaysStill() {
        val g = gif(2)
        val bad = g.copyOf(g.size - 1) + byteArrayOf(0x21, 0xFF.toByte(), 11) + "NETSCAPE2.0".toByteArray() + byteArrayOf(3, 1, 0, 0, 1, 0x3B, 0) + g.copyOfRange(13 + 19, g.size)
        assertNull(AnimationFrames.count(bad))
    }

    /** Codex's and Gemini's reviews: libwebp reads only to the RIFF header's stated end. */
    @Test fun webpChunksPastItsStatedEndStayStill() {
        val w = webp(2, durationMs = 20)
        val extra = "ANMF".toByteArray() + le(16) + ByteArray(12) + byteArrayOf(0x60, 0xEA.toByte(), 0) + ByteArray(1)
        val after = assertNotNull(AnimationFrames.scan(w + extra), "a chunk after the stated end is ignored, as libwebp ignores it")
        assertEquals(2, after.count)
        assertEquals(20L, after.shortestMs)
        val stated = w.copyOf()
        val bigger = le(w.size - 8 + extra.size + 100)
        bigger.copyInto(stated, 4)
        assertNull(AnimationFrames.scan(stated + extra), "a stated end past the file")
    }

    @Test fun onlyAFewPlayAtOnce() {
        val budget = PlaybackBudget(maxPlaying = 4, maxPixelsPerSecond = 1_000)
        repeat(4) { assertTrue(budget.take(100)) }
        assertFalse(budget.take(100), "a fifth stays still")
        budget.give(100)
        assertTrue(budget.take(100), "until one stops")
        assertEquals(4, budget.playingNow)
        val rate = PlaybackBudget(maxPlaying = 10, maxPixelsPerSecond = 1_000)
        assertTrue(rate.take(600))
        assertFalse(rate.take(500), "over the pixels a second together")
        assertTrue(rate.take(400))
        assertFalse(PlaybackBudget().take(0), "nothing counted, nothing played")
    }

    @Test fun manyVisibleAnimationsStayWithinTheTotal() {
        val budget = PlaybackBudget()
        val each = AnimationLimits.MAX_PIXELS_PER_SECOND
        val playing = (0 until 50).count { budget.take(each) }
        assertTrue(playing * each <= AnimationLimits.MAX_PLAYING_PIXELS_PER_SECOND)
        assertTrue(playing <= AnimationLimits.MAX_PLAYING)
        assertTrue(playing >= 1)
    }

    // ---- files, made by hand: a frame each, a byte of picture in it.

    private fun gif(frames: Int, colorTables: Boolean = false, delayCs: Int = 10, delays: List<Int>? = null): ByteArray {
        val out = ByteArrayOutputStream()
        out.write("GIF89a".toByteArray())
        // 1x1, global colour table of 2 entries when asked.
        out.write(byteArrayOf(1, 0, 1, 0, if (colorTables) 0x80.toByte() else 0, 0, 0))
        if (colorTables) out.write(ByteArray(6))
        // Netscape loop extension.
        out.write(byteArrayOf(0x21, 0xFF.toByte(), 11) + "NETSCAPE2.0".toByteArray() + byteArrayOf(3, 1, 0, 0, 0))
        repeat(frames) {
            val d = delays?.get(it) ?: delayCs
            out.write(byteArrayOf(0x21, 0xF9.toByte(), 4, 0, d.toByte(), (d shr 8).toByte(), 0, 0))
            out.write(byteArrayOf(0x2C, 0, 0, 0, 0, 1, 0, 1, 0, if (colorTables) 0x80.toByte() else 0))
            if (colorTables) out.write(ByteArray(6))
            out.write(byteArrayOf(2, 2, 0x44, 0x01, 0))
        }
        out.write(0x3B)
        return out.toByteArray()
    }

    private fun le(n: Int) = byteArrayOf(n.toByte(), (n shr 8).toByte(), (n shr 16).toByte(), (n shr 24).toByte())
    private fun be(n: Int) = byteArrayOf((n shr 24).toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte())

    private fun webp(frames: Int, durationMs: Int = 100): ByteArray {
        val body = ByteArrayOutputStream()
        body.write("WEBP".toByteArray())
        body.write("VP8X".toByteArray() + le(10) + ByteArray(10))
        body.write("ANIM".toByteArray() + le(6) + ByteArray(6))
        repeat(frames) { body.write("ANMF".toByteArray() + le(17) + ByteArray(12) + byteArrayOf(durationMs.toByte(), (durationMs shr 8).toByte(), 0) + ByteArray(2) + byteArrayOf(0)) }
        val b = body.toByteArray()
        return "RIFF".toByteArray() + le(b.size) + b
    }

    private fun apng(frames: Int, declared: Int = frames, secondDeclared: Int? = null): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        fun chunk(type: String, data: ByteArray) = out.write(be(data.size) + type.toByteArray() + data + ByteArray(4))
        chunk("IHDR", ByteArray(13))
        chunk("acTL", be(declared) + be(0))
        secondDeclared?.let { chunk("acTL", be(it) + be(0)) }
        // delay 1/10 s.
        val fctl = ByteArray(20) + byteArrayOf(0, 1, 0, 10) + ByteArray(2)
        repeat(frames) { chunk("fcTL", fctl); chunk(if (it == 0) "IDAT" else "fdAT", ByteArray(4)) }
        chunk("IEND", ByteArray(0))
        return out.toByteArray()
    }
}
