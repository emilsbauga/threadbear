package com.mikerosoft.threadbear.kit

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PushTest {
    private val random = SecureRandom()
    private fun key() = ByteArray(32).also(random::nextBytes)

    /** As convex/pushSeal.ts seal(): nonce, ciphertext, tag, base64. */
    private fun seal(key: ByteArray, plain: String): String {
        val nonce = ByteArray(12).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return Base64.getEncoder().encodeToString(nonce + cipher.doFinal(plain.toByteArray()))
    }

    @Test fun opensWhatTheBackendSealed() {
        val k = key()
        assertEquals(PushSeal.Opened("Fix the dock badge", "Done ✓ it clears"), PushSeal.open(seal(k, """{"title":"Fix the dock badge","body":"Done ✓ it clears"}"""), k))
    }

    @Test fun anotherPhonesKeyOpensNothing() {
        assertNull(PushSeal.open(seal(key(), """{"title":"a","body":"b"}"""), key()))
    }

    @Test fun nonsenseOpensNothing() {
        val k = key()
        assertNull(PushSeal.open("not base64!", k))
        assertNull(PushSeal.open(Base64.getEncoder().encodeToString(ByteArray(10)), k))
        assertNull(PushSeal.open(seal(k, """{"title":"no body"}"""), k))
        assertNull(PushSeal.open(seal(k, """["not","an","object"]"""), k))
        assertNull(PushSeal.open(seal(k, """{"title":1,"body":2}"""), k))
        assertNull(PushSeal.open(seal(k, """{"title":"a","body":"b"}"""), ByteArray(16)))
    }
}

class WebPushTest {
    @Test fun readsTheBackendsMessage() {
        assertEquals(WebPush.Message("abc-123", "c2VhbGVk"), WebPush.message("""{"threadId":"abc-123","e":"c2VhbGVk"}""".toByteArray()))
        // No sealed text: still the thread, shown with the stand-in.
        assertEquals(WebPush.Message("abc", null), WebPush.message("""{"threadId":"abc"}""".toByteArray()))
    }

    @Test fun anythingElseIsNoMessage() {
        assertNull(WebPush.message("not json".toByteArray()))
        assertNull(WebPush.message("""{"e":"x"}""".toByteArray()))
        assertNull(WebPush.message("""{"threadId":5}""".toByteArray()))
        assertNull(WebPush.message("""["threadId"]""".toByteArray()))
    }

    @Test fun onlyHttpsEndpointsTheBackendTakes() {
        kotlin.test.assertTrue(WebPush.validEndpoint("https://ntfy.sh/upAbC123?up=1"))
        kotlin.test.assertFalse(WebPush.validEndpoint("http://ntfy.local/upAbC"))
        kotlin.test.assertFalse(WebPush.validEndpoint("https:///nohost"))
        kotlin.test.assertFalse(WebPush.validEndpoint("not a url"))
        kotlin.test.assertFalse(WebPush.validEndpoint("https://ntfy.sh/" + "a".repeat(2048)))
    }

    @Test fun keysAreBase64UrlWithoutPadding() {
        kotlin.test.assertTrue(WebPush.Keys("BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U", "tBHItJI5svbpez7KI4CCXg").valid)
        kotlin.test.assertFalse(WebPush.Keys("abc=", "tBHItJI5svbpez7KI4CCXg").valid)
        kotlin.test.assertFalse(WebPush.Keys("abc+/", "x").valid)
    }
}
