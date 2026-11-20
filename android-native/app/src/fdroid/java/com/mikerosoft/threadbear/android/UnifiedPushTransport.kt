package com.mikerosoft.threadbear.android

import android.app.Activity
import android.content.Context
import com.mikerosoft.threadbear.kit.BackendApi
import com.mikerosoft.threadbear.kit.PhoneBackend
import com.mikerosoft.threadbear.kit.WebPush
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import org.unifiedpush.android.connector.data.ResolvedDistributor

/**
 * The fdroid build's notifications: UnifiedPush, through whatever push app
 * (a "distributor", such as ntfy) the phone has. The connector makes the
 * Web Push keys and decrypts each message; the backend (API 93) sends them
 * as Web Push with its VAPID key. No distributor, or an older backend, and
 * push is simply off.
 */
object StorePush : PushTransport {
    override fun available(context: Context): Boolean = UnifiedPush.getDistributors(context).isNotEmpty()

    override fun start(context: Context) = Unit

    // Web Push goes straight from the backend, so its pushOff (no relay) doesn't apply.
    override val usesRelay = false

    /**
     * Asks the distributor for an endpoint, with the backend's VAPID key.
     * Always null: the endpoint comes back to [ThreadbearPushService], which
     * registers it, as it does whenever the distributor gives a new one.
     */
    override suspend fun address(context: Context, backend: PhoneBackend, apiVersion: Int, cacheKey: String): PushAddress? {
        if (apiVersion < BackendApi.WEB_PUSH || !useDistributor(context)) return null
        val vapid = vapid(context, backend, cacheKey) ?: return null
        // A key the connector refuses (VapidNotValidException) means no push, not a crash.
        runCatching { UnifiedPush.register(context, messageForDistributor = "Threadbear", vapid = vapid) }
        return null
    }

    /** The distributor stops taking messages for this phone, and the old backend's key goes. */
    override suspend fun forget(context: Context) {
        prefs(context).edit().clear().commit()
        UnifiedPush.unregister(context)
    }

    override fun setup(context: Context): PushSetup = when {
        UnifiedPush.getDistributors(context).isEmpty() -> PushSetup.NO_DISTRIBUTOR
        UnifiedPush.getSavedDistributor(context) != null -> PushSetup.READY
        UnifiedPush.resolveDefaultDistributor(context) is ResolvedDistributor.Found -> PushSetup.READY
        else -> PushSetup.CHOOSE_DISTRIBUTOR
    }

    override fun choose(activity: Activity, done: () -> Unit) {
        UnifiedPush.tryPickDistributor(activity) { picked -> if (picked) done() }
    }

    /** The one already in use, else the phone's only or default push app, kept for next time. */
    private fun useDistributor(context: Context): Boolean {
        if (UnifiedPush.getAckDistributor(context) != null || UnifiedPush.getSavedDistributor(context) != null) return true
        val found = UnifiedPush.resolveDefaultDistributor(context) as? ResolvedDistributor.Found ?: return false
        UnifiedPush.saveDistributor(context, found.packageName)
        return true
    }

    /** The backend's VAPID key (phone:webPushKey), kept per pairing: it's the same for a deployment's life. */
    private suspend fun vapid(context: Context, backend: PhoneBackend, cacheKey: String): String? {
        val key = "vapid:$cacheKey"
        prefs(context).getString(key, null)?.let { return it }
        val vapid = runCatching { backend.webPushKey() }.getOrNull() ?: return null
        prefs(context).edit().putString(key, vapid).apply()
        return vapid
    }

    private fun prefs(context: Context) = context.getSharedPreferences("webpush", Context.MODE_PRIVATE)
}

/** UnifiedPush's side: a new endpoint to register, and each notification. */
class ThreadbearPushService : PushService() {
    private val model get() = (application as ThreadbearApplication).model

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val set = endpoint.pubKeySet ?: return
        val keys = WebPush.Keys(set.pubKey, set.auth)
        // The backend takes only https endpoints up to 2048 characters.
        if (!WebPush.validEndpoint(endpoint.url) || !keys.valid) return
        model.registerPush(PushAddress(endpoint.url, PushAddress.WEB_PUSH, keys))
    }

    override fun onMessage(message: PushMessage, instance: String) {
        if (!message.decrypted) return
        val m = WebPush.message(message.content) ?: return
        val threadId = Push.validThreadId(m.threadId) ?: return
        Push.show(this, threadId, m.sealed)
    }

    // Quiet, as a failed Firebase registration is: the next launch tries again.
    override fun onRegistrationFailed(reason: FailedReason, instance: String) = Unit

    override fun onUnregistered(instance: String) = model.pushUnregistered()
}
