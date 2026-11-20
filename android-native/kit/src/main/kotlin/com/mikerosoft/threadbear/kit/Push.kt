package com.mikerosoft.threadbear.kit

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Opens what the backend sealed for this phone (convex/pushSeal.ts seal, the
 * iPhone's PushSeal): AES-256-GCM, a 12-byte nonce then ciphertext then the
 * 16-byte tag, base64, around {"title","body"}. The relay only ever sees the
 * sealed text (docs/push-relay.md). Nil when it doesn't open, and the app
 * shows its stand-in instead.
 */
object PushSeal {
    data class Opened(val title: String, val body: String)

    fun open(sealed: String, key: ByteArray): Opened? = try {
        val bytes = Base64.getDecoder().decode(sealed)
        if (key.size != 32 || bytes.size < 12 + 16) null else {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, bytes, 0, 12))
            val plain = cipher.doFinal(bytes, 12, bytes.size - 12)
            val o = Json.parseToJsonElement(String(plain, Charsets.UTF_8)) as? JsonObject
            val title = o?.get("title")?.jsonPrimitive?.takeIf { it.isString }?.content
            val body = o?.get("body")?.jsonPrimitive?.takeIf { it.isString }?.content
            if (title != null && body != null) Opened(title, body) else null
        }
    } catch (_: Exception) {
        null
    }
}

/**
 * Web Push (backend API 93), the fdroid build's notifications: the phone's
 * UnifiedPush distributor gives it an endpoint URL and Web Push keys, the
 * backend sends each notification there (RFC 8291 aes128gcm, with VAPID),
 * and the connector hands the app the decrypted body: JSON
 * `{"threadId": "...", "e": "<sealed, as FCM's data.e>"}`.
 */
object WebPush {
    /** The backend's limit on an endpoint (phone:registerDevice's apnsToken). */
    const val MAX_ENDPOINT = 2048

    /** The phone's UnifiedPush keys, as phone:registerDevice's `webPush` (base64url, no padding). */
    data class Keys(val p256dh: String, val auth: String) {
        val valid: Boolean get() = B64URL.matches(p256dh) && B64URL.matches(auth)
    }

    /** An endpoint the backend takes: https, and not past its length limit. */
    fun validEndpoint(url: String): Boolean =
        url.length <= MAX_ENDPOINT && runCatching { java.net.URI(url) }.getOrNull()?.let { it.scheme == "https" && !it.host.isNullOrEmpty() } == true

    data class Message(val threadId: String, val sealed: String?)

    /** A decrypted message's body: its thread and sealed text, or null for anything else. */
    fun message(body: ByteArray): Message? = try {
        val o = Json.parseToJsonElement(String(body, Charsets.UTF_8)) as? JsonObject
        val threadId = o?.get("threadId")?.jsonPrimitive?.takeIf { it.isString }?.content
        val sealed = o?.get("e")?.jsonPrimitive?.takeIf { it.isString }?.content
        threadId?.let { Message(it, sealed) }
    } catch (_: Exception) {
        null
    }

    private val B64URL = Regex("^[A-Za-z0-9_-]+$")
}
