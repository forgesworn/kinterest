package org.forgesworn.kinjar.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import org.forgesworn.kinjar.MainActivity
import org.forgesworn.kinjar.R

/**
 * Notification surfaces for the relay service. Two channels: the quiet
 * persistent one the foreground service is required to show, and the
 * tappable one a family update rides in.
 *
 * Ported in shape (not verbatim) from
 * charter/android/carrier/src/main/kotlin/.../service/Notifier.kt — see
 * RelayService.kt's kdoc for the three deliberate departures from charter.
 */
object Notifier {
    private const val CH_SERVICE = "jar.service"
    /** v2: channel settings are immutable once created,
     *  so the lock-screen override needs a fresh id; the old ones are deleted. */
    private const val CH_FAMILY = "family.v3"
    private val CH_FAMILY_LEGACY = listOf("family", "family.v2")
    const val SERVICE_NOTIF_ID = 1

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(
                CH_SERVICE,
                ctx.getString(R.string.notif_channel_service),
                NotificationManager.IMPORTANCE_MIN,
            ),
        )
        // LOCK SCREEN. Family updates stay OFF the lock
        // screen entirely: VISIBILITY_SECRET on the channel (which SystemUI
        // enforces whatever the "show sensitive content" setting says) and
        // on each notification. A per-notification PRIVATE was only honoured
        // with that setting OFF, and it is ON by default.
        nm.createNotificationChannel(
            NotificationChannel(
                CH_FAMILY,
                ctx.getString(R.string.notif_channel_family),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { lockscreenVisibility = Notification.VISIBILITY_SECRET },
        )
        CH_FAMILY_LEGACY.forEach { nm.deleteNotificationChannel(it) }
    }

    /** The persistent row the foreground service must show. Left PUBLIC on
     *  purpose (item I1): it says only that the app is keeping in touch, it
     *  names nobody and carries no amount, and the system requires it to be
     *  visible for the service to run at all. */
    fun serviceNotification(ctx: Context): Notification =
        Notification.Builder(ctx, CH_SERVICE)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(ctx.getString(R.string.notif_service_title))
            .setContentIntent(contentIntent(ctx, requestCode = 0))
            .setOngoing(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build()

    /** A tappable family update. [tag] both dedupes/replaces the row and
     *  seeds the content intent's request code, so distinct updates each get
     *  their own row rather than clobbering each other's [PendingIntent].
     *
     *  LOCK SCREEN. A family update names a child and
     *  usually carries an amount — "Alex asked for £4.50" — and a phone on a
     *  kitchen table shows its lock screen to whoever walks past. So it is
     *  [Notification.VISIBILITY_SECRET]: not shown on the lock screen at all,
     *  not even a redacted stand-in. The owner sees it once they unlock. */
    fun notify(ctx: Context, title: String, body: String, tag: String) {
        // The bridge can call this before RelayService has ever started
        // (the only other place that ensured channels) — without this, a
        // "family" channel that doesn't exist yet silently drops the post.
        ensureChannels(ctx)
        val n = Notification.Builder(ctx, CH_FAMILY)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(contentIntent(ctx, requestCode = tag.hashCode()))
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_SECRET)
            .build()
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Tag + id, not just id: SERVICE_NOTIF_ID (1) shares the plain-int
        // id space, and a tag whose hashCode happens to collide with it
        // would otherwise silently replace the ongoing foreground row.
        nm.notify(tag, tag.hashCode(), n)
    }

    private fun contentIntent(ctx: Context, requestCode: Int): PendingIntent =
        PendingIntent.getActivity(
            ctx,
            requestCode,
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
}
