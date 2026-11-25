package com.mikerosoft.threadbear.kit

/**
 * How much a moving picture may make the phone decode (the iPhone's
 * AnimationPlan, and more). Android's AnimatedImageDrawable plays every
 * frame there is, decoding each from the file's own size before scaling it
 * down: a small GIF of thousands of frames under the byte and size caps
 * kept the phone decoding for as long as its row was on screen (Daybreak
 * 166, 22 Nov 2026). So the frames and their times are read from the file
 * before anything plays, and one with too many frames, too many pixels
 * across them, or too many a second shows its first frame still.
 */
object AnimationLimits {
    const val MAX_FRAMES = 600
    /** Pixels decoded for one pass through every frame, at the file's own size (or the shown size, if bigger). */
    const val MAX_TOTAL_PIXELS = 400_000_000L
    /**
     * Pixels decoded a second at its fastest: a frame's pixels over its
     * shortest frame time, not the loop's average, which one long frame
     * could hide a fast run behind (Codex's and Gemini's reviews). About a
     * 1400-pixel-square picture at 60 frames a second.
     */
    const val MAX_PIXELS_PER_SECOND = 120_000_000L
    /**
     * The shortest a frame can really play: Android may pass a file's frame
     * times through as they are (a GIF's 0 or 10 ms too: not every version
     * clamps them, Gemini's review), so a 1 ms frame plays once a refresh:
     * 165 times a second on the fastest phone screens, so this allows for
     * 200 (Codex's review: 8 ms, 125 Hz, let a 165 Hz phone go over).
     */
    const val MIN_FRAME_MS = 5L
    /** Moving pictures playing at once, and their pixels a second together. More stay still. */
    const val MAX_PLAYING = 4
    const val MAX_PLAYING_PIXELS_PER_SECOND = 240_000_000L
}

/** What playing a moving picture costs: pixels decoded for one pass through its frames, and a second at its fastest. */
data class AnimationWork(val passPixels: Long, val pixelsPerSecond: Long)

object AnimationFrames {
    /** Frames, and the shortest time any of them plays for, in milliseconds. */
    data class Frames(val count: Int, val shortestMs: Long)

    /**
     * How many frames `data` has, for the formats Android plays (GIF, WebP,
     * APNG), counted from the file's own structure and stopping once past
     * `stopAfter`. Null for anything it can't count, or whose structure is
     * anything but regular (cut short, a block of the wrong size, a chunk
     * past the file's stated end), which then stays still: a decoder reads
     * an irregular file its own way, and could find frames this doesn't.
     */
    fun count(data: ByteArray, stopAfter: Int = AnimationLimits.MAX_FRAMES): Int? = scan(data, stopAfter)?.count

    fun scan(data: ByteArray, stopAfter: Int = AnimationLimits.MAX_FRAMES): Frames? = when {
        startsWith(data, "GIF87a") || startsWith(data, "GIF89a") -> gif(data, stopAfter)
        startsWith(data, "RIFF") && data.size >= 12 && ascii(data, 8, 4) == "WEBP" -> webp(data, stopAfter)
        data.size >= 8 && PNG.indices.all { data[it] == PNG[it] } -> png(data, stopAfter)
        else -> null
    }

    /**
     * What playing `data` costs, its frames decoded at `sourceWidth` by
     * `sourceHeight` (the decoder reads each whole before scaling) and shown
     * at `shownWidth` by `shownHeight`; or null when it mustn't play: frames
     * uncounted, one or none, or over any of AnimationLimits.
     */
    fun work(
        data: ByteArray,
        sourceWidth: Int,
        sourceHeight: Int,
        shownWidth: Int,
        shownHeight: Int,
        maxFrames: Int = AnimationLimits.MAX_FRAMES,
        maxTotalPixels: Long = AnimationLimits.MAX_TOTAL_PIXELS,
        maxPixelsPerSecond: Long = AnimationLimits.MAX_PIXELS_PER_SECOND,
    ): AnimationWork? {
        if (sourceWidth <= 0 || sourceHeight <= 0 || shownWidth <= 0 || shownHeight <= 0) return null
        val frames = scan(data, maxFrames) ?: return null
        if (frames.count < 2 || frames.count > maxFrames) return null
        // Both sides are under 2^31, so neither product overflows a Long.
        val frame = maxOf(sourceWidth.toLong() * sourceHeight, shownWidth.toLong() * shownHeight)
        if (frame > maxTotalPixels / frames.count) return null
        if (frame > maxPixelsPerSecond / 1000 * frames.shortestMs.coerceAtLeast(1)) return null
        val perSecond = (frame * 1000 + frames.shortestMs - 1) / frames.shortestMs.coerceAtLeast(1)
        return AnimationWork(frame * frames.count, perSecond.coerceAtLeast(1))
    }

    private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

    private fun startsWith(data: ByteArray, text: String) = data.size >= text.length && ascii(data, 0, text.length) == text

    private fun ascii(data: ByteArray, at: Int, n: Int) = String(data, at, n, Charsets.ISO_8859_1)

    private fun u8(data: ByteArray, at: Int) = data[at].toInt() and 0xFF

    private fun le16(data: ByteArray, at: Int) = u8(data, at) or (u8(data, at + 1) shl 8)

    private fun be16(data: ByteArray, at: Int) = (u8(data, at) shl 8) or u8(data, at + 1)

    private fun le24(data: ByteArray, at: Int) = u8(data, at) or (u8(data, at + 1) shl 8) or (u8(data, at + 2) shl 16)

    private fun le32(data: ByteArray, at: Int): Long = le24(data, at).toLong() or (u8(data, at + 3).toLong() shl 24)

    private fun be32(data: ByteArray, at: Int): Long = (be16(data, at).toLong() shl 16) or be16(data, at + 2).toLong()

    /** A frame's time as it can really play. */
    private fun frameMs(ms: Long) = ms.coerceAtLeast(AnimationLimits.MIN_FRAME_MS)

    /**
     * Image descriptors, walking the blocks to the trailer, each frame's
     * time from the graphic control block before it. Strict: a file cut
     * short, a block that isn't GIF's, or an extension whose fixed-size
     * block isn't its size (a graphic control block of other than four
     * bytes, an application block's name of other than eleven, a NETSCAPE
     * block under three, a plain text header of other than twelve), or a
     * frame that isn't wholly inside the picture's canvas (the decoder
     * works through a frame's whole width, canvas or not: Gemini's review),
     * is null. Skia reads those sizes whatever the file says, and
     * went on past where a looser walk stopped (Codex's reviews). Zero
     * bytes between blocks are padding some encoders write, skipped as
     * decoders skip them.
     */
    private fun gif(data: ByteArray, stopAfter: Int): Frames? {
        if (data.size < 13) return null
        val canvasWidth = le16(data, 6)
        val canvasHeight = le16(data, 8)
        var at = 13
        val flags = u8(data, 10)
        if (flags and 0x80 != 0) at += 3 * (1 shl ((flags and 0x07) + 1))
        var frames = 0
        var shortest = Long.MAX_VALUE
        var delayMs = 0L
        var sawZero = false
        fun skipSubBlocks(): Boolean {
            while (true) {
                if (at >= data.size) return false
                val n = u8(data, at)
                at += 1
                if (n == 0) return true
                at += n
            }
        }
        /** The next sub-block must be `size` long; then the rest are skipped. */
        fun fixed(size: Int): Boolean {
            if (at >= data.size || u8(data, at) != size) return false
            at += 1 + size
            return true
        }
        /** Sub-blocks of at least `least` bytes each, to the terminator (Skia reads that many of each). */
        fun atLeast(least: Int): Boolean {
            while (true) {
                if (at >= data.size) return false
                val n = u8(data, at)
                at += 1
                if (n == 0) return true
                if (n < least) return false
                at += n
            }
        }
        while (at < data.size) {
            when (u8(data, at)) {
                0x2C -> {
                    if (at + 10 > data.size) return null
                    val left = le16(data, at + 1)
                    val top = le16(data, at + 3)
                    val width = le16(data, at + 5)
                    val height = le16(data, at + 7)
                    if (width == 0 || height == 0 || left + width > canvasWidth || top + height > canvasHeight) return null
                    val local = u8(data, at + 9)
                    at += 10
                    if (local and 0x80 != 0) at += 3 * (1 shl ((local and 0x07) + 1))
                    // The LZW code size, then the image's data.
                    at += 1
                    if (!skipSubBlocks()) return null
                    frames++
                    shortest = minOf(shortest, frameMs(delayMs))
                    delayMs = 0
                    if (frames > stopAfter) return Frames(frames, shortest)
                }
                0x21 -> {
                    if (at + 1 >= data.size) return null
                    val label = u8(data, at + 1)
                    at += 2
                    when (label) {
                        0xF9 -> {
                            if (at + 6 > data.size || u8(data, at) != 4 || u8(data, at + 5) != 0) return null
                            delayMs = le16(data, at + 2) * 10L
                            at += 6
                        }
                        0xFF -> {
                            if (at + 12 > data.size || u8(data, at) != 11) return null
                            val app = ascii(data, at + 1, 11)
                            at += 12
                            if (app == "NETSCAPE2.0" || app == "ANIMEXTS1.0") {
                                if (!atLeast(3)) return null
                            } else if (!skipSubBlocks()) {
                                return null
                            }
                        }
                        0x01 -> if (!fixed(12) || !skipSubBlocks()) return null
                        else -> if (!skipSubBlocks()) return null
                    }
                }
                // Wuffs (Android's GIF decoder) ends the picture at any byte
                // but an extension or a frame, playing what came before;
                // older Skia skips a zero and reads on. So it's skipped and
                // the frames after it counted too (more frames can only make
                // it stiller), and a zero just before the end is an end
                // (Grok's review: a GIF ending 00 instead of 3B played).
                0x00 -> {
                    at += 1
                    sawZero = true
                }
                0x3B -> return if (frames == 0) null else Frames(frames, shortest)
                else -> return null
            }
        }
        // No trailer: cut short, unless a zero ended it.
        return if (sawZero && frames > 0) Frames(frames, shortest) else null
    }

    /**
     * ANMF chunks and their durations, read only up to the RIFF header's
     * stated end, as libwebp reads it (Codex's and Gemini's reviews:
     * chunks after it counted, and libwebp ignores them). A chunk past that
     * end, a stated end past the file, or an ANMF too short for its header
     * is null. A still WebP (no animation) is one frame.
     */
    private fun webp(data: ByteArray, stopAfter: Int): Frames? {
        val end = 8L + le32(data, 4)
        if (end < 12 || end > data.size) return null
        var at = 12L
        var frames = 0
        var shortest = Long.MAX_VALUE
        var image = false
        while (at < end) {
            if (at + 8 > end) return null
            val i = at.toInt()
            val type = ascii(data, i, 4)
            val size = le32(data, i + 4)
            val next = at + 8 + size + (size and 1)
            if (at + 8 + size > end) return null
            when (type) {
                "ANMF" -> {
                    if (size < 16) return null
                    frames++
                    shortest = minOf(shortest, frameMs(le24(data, i + 8 + 12).toLong()))
                    if (frames > stopAfter) return Frames(frames, shortest)
                }
                "VP8 ", "VP8L" -> image = true
            }
            at = next
        }
        return if (frames > 0) Frames(frames, shortest) else if (image) Frames(1, Long.MAX_VALUE) else null
    }

    /**
     * APNG's frames: the larger of what any acTL says and the fcTL chunks
     * there are, so neither can understate it, and the shortest time any
     * fcTL gives (a frame with no fcTL of its own counts as the shortest a
     * frame can play). A chunk cut short is null. A plain PNG is one.
     */
    private fun png(data: ByteArray, stopAfter: Int): Frames? {
        var at = 8L
        var declared = 0L
        var controls = 0
        var shortest = Long.MAX_VALUE
        var ended = false
        while (at + 8 <= data.size) {
            val i = at.toInt()
            val size = be32(data, i)
            val type = ascii(data, i + 4, 4)
            if (at + 12 + size > data.size) return null
            when (type) {
                "acTL" -> {
                    if (size < 8) return null
                    declared = maxOf(declared, be32(data, i + 8))
                }
                "fcTL" -> {
                    if (size < 26) return null
                    controls++
                    val num = be16(data, i + 8 + 20).toLong()
                    val den = be16(data, i + 8 + 22).toLong().takeIf { it > 0 } ?: 100L
                    shortest = minOf(shortest, frameMs(num * 1000 / den))
                    if (controls > stopAfter) return Frames(controls, shortest)
                }
                "IEND" -> {
                    ended = true
                    break
                }
            }
            at += 12 + size
        }
        if (!ended) return null
        val frames = maxOf(declared, controls.toLong(), 1L)
        if (frames > controls) shortest = minOf(shortest, AnimationLimits.MIN_FRAME_MS)
        if (frames > stopAfter) return Frames(stopAfter + 1, shortest)
        return Frames(frames.toInt(), shortest)
    }
}

/**
 * The moving pictures playing now, held to AnimationLimits' MAX_PLAYING
 * and MAX_PLAYING_PIXELS_PER_SECOND together: however many are on screen,
 * the phone decodes no more than that. One that doesn't get a place shows
 * its first frame until it's shown again.
 */
class PlaybackBudget(
    private val maxPlaying: Int = AnimationLimits.MAX_PLAYING,
    private val maxPixelsPerSecond: Long = AnimationLimits.MAX_PLAYING_PIXELS_PER_SECOND,
) {
    private var playing = 0
    private var rate = 0L

    /** A place for one decoding `pixelsPerSecond`, or false when there's no room. Give it back with [give]. */
    @Synchronized
    fun take(pixelsPerSecond: Long): Boolean {
        if (pixelsPerSecond <= 0 || playing >= maxPlaying || pixelsPerSecond > maxPixelsPerSecond - rate) return false
        playing++
        rate += pixelsPerSecond
        return true
    }

    @Synchronized
    fun give(pixelsPerSecond: Long) {
        playing = (playing - 1).coerceAtLeast(0)
        rate = (rate - pixelsPerSecond).coerceAtLeast(0)
    }

    val playingNow: Int @Synchronized get() = playing
}
