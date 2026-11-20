package com.mikerosoft.threadbear.android

import android.app.Activity
import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.mikerosoft.threadbear.kit.PhoneBackend
import kotlinx.coroutines.tasks.await

/**
 * The github build's notifications: Firebase through the push relay
 * (docs/push-relay.md), set up from the build's config (none means push is
 * off). Showing one is shared (Push.show).
 */
object StorePush : PushTransport {
    override fun available(context: Context): Boolean = BuildConfig.FIREBASE_APP_ID.isNotEmpty()

    override val usesRelay = true

    override fun start(context: Context) {
        if (!available(context) || FirebaseApp.getApps(context).isNotEmpty()) return
        val options = FirebaseOptions.Builder()
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
            .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
            .setApplicationId(BuildConfig.FIREBASE_APP_ID)
            .setApiKey(BuildConfig.FIREBASE_API_KEY)
            .build()
        FirebaseApp.initializeApp(context, options)
    }

    /** This phone's Firebase token, or null when push is off or Firebase can't say. */
    override suspend fun address(context: Context, backend: PhoneBackend, apiVersion: Int, cacheKey: String): PushAddress? {
        if (!available(context)) return null
        val token = runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull() ?: return null
        return PushAddress(token, PushAddress.FIREBASE)
    }

    /** Firebase deletes the token: the old backend's next send comes back UNREGISTERED. */
    override suspend fun forget(context: Context) {
        if (available(context)) FirebaseMessaging.getInstance().deleteToken().await()
    }

    override fun setup(context: Context) = PushSetup.READY

    override fun choose(activity: Activity, done: () -> Unit) = Unit
}

/** Firebase's side: a new token to register, and each notification. */
class ThreadbearMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        (application as ThreadbearApplication).model.registerPush(PushAddress(token, PushAddress.FIREBASE))
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val threadId = Push.validThreadId(message.data["threadId"]) ?: return
        Push.show(this, threadId, message.data["e"])
    }
}
