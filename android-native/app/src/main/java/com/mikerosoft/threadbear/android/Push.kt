package com.mikerosoft.threadbear.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import android.app.Activity
import com.mikerosoft.threadbear.kit.PhoneBackend
import com.mikerosoft.threadbear.kit.PushSeal
import com.mikerosoft.threadbear.kit.WebPush
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Where the backend reaches this phone: a Firebase token (platform
 * "android"), or a UnifiedPush endpoint URL with its Web Push keys
 * ("webpush", backend API 93). Either goes in registerDevice's apnsToken.
 */
data class PushAddress(val token: String, val platform: String, val webPush: WebPush.Keys? = null) {
    companion object {
        const val FIREBASE = "android"
        const val WEB_PUSH = "webpush"
    }
}

/** How far this phone's push is set up, for Settings. */
enum class PushSetup {
    READY,
    /** fdroid: no UnifiedPush app on the phone, so no notifications. */
    NO_DISTRIBUTOR,
    /** fdroid: more than one, and none picked yet. */
    CHOOSE_DISTRIBUTOR,
}

/**
 * How notifications reach the phone, each store's own (`StorePush` in
 * src/github: Firebase through the push relay; in src/fdroid: UnifiedPush).
 * Everything else about a notification is shared, in [Push].
 */
interface PushTransport {
    /** Whether this build can get notifications at all on this phone. */
    fun available(context: Context): Boolean

    /** Called once, from the Application. */
    fun start(context: Context)

    /**
     * Whether the backend's `pushOff` (no relay and no Apple key) means no
     * notifications for this phone: true for Firebase, which goes through
     * the relay; UnifiedPush doesn't, so the fdroid build ignores it.
     */
    val usesRelay: Boolean

    /**
     * This phone's address for the backend, or null when there's none yet:
     * UnifiedPush's arrives later, through its service, which registers it.
     * [cacheKey] names the pairing, for anything kept per backend.
     */
    suspend fun address(context: Context, backend: PhoneBackend, apiVersion: Int, cacheKey: String): PushAddress?

    /** Unpairing: the transport forgets this phone, so the old backend can't reach it. */
    suspend fun forget(context: Context)

    fun setup(context: Context): PushSetup

    /** Lets the person pick a push app ([PushSetup.CHOOSE_DISTRIBUTOR]); [done] once one's picked. */
    fun choose(activity: Activity, done: () -> Unit)
}

/**
 * Notifications, the iPhone's PushKey and notification extension in one:
 * this phone's 32-byte key that the backend seals each notification with,
 * showing one, and the pairing lock that keeps an old pairing's from
 * showing. The registration (AppModel.registerPush) hands the backend this
 * phone's address from [transport] and that key.
 */
object Push {
    /** This store's way in (src/github or src/fdroid). */
    val transport: PushTransport get() = StorePush

    const val CHANNEL = "threads"

    /**
     * Posting a notification and changing the pairing take this lock, and
     * the pairing's generation goes up with each change (AppModel's
     * pairingChanged): a notification opened for one pairing is never posted
     * once it's gone, rather than posted and then taken back down.
     */
    val lock = Any()
    @Volatile var generation = 0
        private set

    /**
     * True from a pairing change that forgets the old server until the transport
     * has forgotten this phone: nothing is posted in between, as a push from
     * the old server could still arrive and be opened then.
     */
    @Volatile private var quiet = false

    /**
     * The pairing changed: in-flight notifications are dropped. With [forget]
     * (another server, or none) the shown ones go, the push key is retired
     * in the same step (so nothing the old server sealed opens from here on),
     * and posting stays off until [forget] has finished forgetting the address.
     */
    fun pairingChanged(context: Context, forget: Boolean) = synchronized(lock) {
        generation++
        if (forget) {
            quiet = true
            clearAll(context)
            PushKeyStore(context).clear()
        }
    }

    /** Off for a github build without a google-services.json, or an fdroid one with no UnifiedPush app. */
    fun available(context: Context): Boolean = transport.available(context)

    /** Called once, from the Application. */
    fun start(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        // One channel: Threadbear's notifications are all "a thread wants you".
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Threads", NotificationManager.IMPORTANCE_HIGH))
        transport.start(context)
    }

    /** Whether this backend sends this phone notifications at all (`pushOff` only counts for the relay). */
    fun sentBy(identity: com.mikerosoft.threadbear.kit.PhoneIdentity?): Boolean =
        !transport.usesRelay || identity?.sendsNotifications != false

    fun permitted(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /**
     * What a thread id can be, from a push or another app's intent: a
     * runner's UUID, "test" from push:test. Anything else (a "/" that would
     * break the navigation route) is dropped.
     */
    fun validThreadId(id: String?): String? = id?.takeIf { Regex("^[A-Za-z0-9_-]{1,100}$").matches(it) }

    /** Shows one: the sealed title and text opened with this phone's key, else the stand-in. */
    fun show(context: Context, threadId: String, sealed: String?) {
        if (!permitted(context)) return
        // The generation and the key are read together, under the lock a
        // pairing change takes: either both are the old pairing's (and the
        // posting check below drops it) or both the new one's, never the new
        // generation with the old key. Mid-change (quiet), or unpaired,
        // nothing from the old backend is shown.
        val (opening, key) = synchronized(lock) {
            if (quiet || !PairingStore(context).paired()) return
            generation to PushKeyStore(context).load()
        }
        val opened = if (sealed != null && key != null) PushSeal.open(sealed, key) else null
        val open = Intent(context, MainActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("threadId", threadId)
            // The id makes each thread's PendingIntent its own: extras don't, and
            // two ids with the same hashCode would both open the later thread.
            .setIdentifier("thread:$threadId")
        // One per thread (its id as the request code and the tag): a newer one replaces it.
        val tap = PendingIntent.getActivity(context, threadId.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(opened?.title ?: "Threadbear")
            .setContentText(opened?.body ?: "A thread needs you")
            .setStyle(NotificationCompat.BigTextStyle().bigText(opened?.body ?: "A thread needs you"))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        synchronized(lock) {
            // The pairing changed while this was being opened (push services call
            // us off the main thread): it was for the old one, so it's dropped.
            if (quiet || opening != generation || !PairingStore(context).paired()) return
            try {
                NotificationManagerCompat.from(context).notify(threadId, 1, n)
            } catch (_: SecurityException) {
                // The permission was taken away between the check and here.
            }
        }
    }

    /**
     * Unpairing: the transport forgets this phone (Firebase deletes its
     * token, so the old backend's next send comes back UNREGISTERED and it
     * drops the phone; UnifiedPush unregisters from the distributor, so the
     * endpoint stops working), and a new push key is made for the next pairing.
     */
    suspend fun forget(context: Context) {
        try {
            PushKeyStore(context).clear()
            runCatching { transport.forget(context) }
        } finally {
            synchronized(lock) { quiet = false }
        }
    }

    /** Unpairing takes down every notification the old pairing left. */
    fun clearAll(context: Context) = NotificationManagerCompat.from(context).cancelAll()

    /** Opening a thread clears its notification, as does a silent clear from the backend. */
    fun clear(context: Context, threadId: String) = NotificationManagerCompat.from(context).cancel(threadId, 1)
}

/**
 * The 32 random bytes the backend seals notifications to (the iPhone's
 * PushKeyStore): made here once and sent only to the phone's own backend,
 * kept encrypted with a key in the Android Keystore that never leaves it,
 * as the pairing token is.
 */
class PushKeyStore(context: Context) {
    private val prefs = context.getSharedPreferences("push", Context.MODE_PRIVATE)

    fun load(): ByteArray? = prefs.getString("key", null)?.let { runCatching { open(it) }.getOrNull() }

    fun clear() { prefs.edit().remove("key").commit() }

    fun loadOrCreate(): ByteArray? = load() ?: runCatching {
        val bytes = ByteArray(32).also(SecureRandom()::nextBytes)
        prefs.edit().putString("key", seal(bytes)).commit()
        bytes
    }.getOrNull()

    private fun keystoreKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return gen.generateKey()
    }

    private fun seal(bytes: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keystoreKey())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(bytes), Base64.NO_WRAP)
    }

    private fun open(sealed: String): ByteArray {
        val bytes = Base64.decode(sealed, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, bytes, 0, 12))
        return cipher.doFinal(bytes, 12, bytes.size - 12)
    }

    private companion object {
        const val ALIAS = "threadbear-push"
    }
}
