package io.github.steamchat.android

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest

class ConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    override fun onCreate() {
        super.onCreate()
        ChatNotifications.channels(this)
        val repository = (application as ChatApplication).repository
        val notification = ChatNotifications.connection(this, repository.state.value)
        if (Build.VERSION.SDK_INT >= 34) startForeground(ChatNotifications.SERVICE_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else startForeground(ChatNotifications.SERVICE_ID, notification)
        scope.launch {
            repository.state.collectLatest { state ->
                if (!state.backgroundEnabled) { stopSelf(); return@collectLatest }
                getSystemService(NotificationManager::class.java).notify(ChatNotifications.SERVICE_ID, ChatNotifications.connection(this@ConnectionService, state))
            }
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        (application as ChatApplication).repository.onServiceStarted()
        return START_STICKY
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
}

internal object ChatNotifications {
    const val SERVICE_ID = 1
    private const val CONNECTION = "connection"
    private const val MESSAGES = "messages"
    fun settingsIntent(context: Context): Intent = Intent(android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
        .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
        .putExtra(android.provider.Settings.EXTRA_CHANNEL_ID, MESSAGES)
    fun settingsSummary(context: Context): String {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) return "系统通知未允许"
        val channel = manager.getNotificationChannel(MESSAGES) ?: return "消息通知类别未创建"
        val importance = when {
            channel.importance == NotificationManager.IMPORTANCE_NONE -> "消息通知已关闭"
            channel.importance >= NotificationManager.IMPORTANCE_HIGH -> "高重要性"
            else -> "非高重要性"
        }
        return "$importance · ${if (channel.sound == null) "无提示音" else "有提示音"}"
    }
    fun test(context: Context): Boolean {
        channels(context)
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled() || manager.getNotificationChannel(MESSAGES)?.importance == NotificationManager.IMPORTANCE_NONE) return false
        val notification = NotificationCompat.Builder(context, MESSAGES)
            .setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("Steam Chat")
            .setContentText("通知测试").setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setAutoCancel(true)
            .setTimeoutAfter(15000).setContentIntent(intent(context)).build()
        return runCatching { manager.notify("notification-test", 3, notification); true }.getOrDefault(false)
    }
    fun channels(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannels(listOf(
            NotificationChannel(CONNECTION, "连接状态", NotificationManager.IMPORTANCE_LOW),
            NotificationChannel(MESSAGES, "聊天消息", NotificationManager.IMPORTANCE_HIGH).apply { lockscreenVisibility = Notification.VISIBILITY_PRIVATE }
        ))
    }
    private fun intent(context: Context, peer: String = ""): PendingIntent {
        val intent = Intent().setClassName(context, "io.github.steamchat.android.MainActivity")
            .setAction(if (peer.isEmpty()) "io.github.steamchat.android.OPEN" else "io.github.steamchat.android.PEER.$peer")
            .putExtra("peerId", peer).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    fun connection(context: Context, state: AppState): Notification = NotificationCompat.Builder(context, CONNECTION)
        .setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("Steam Chat")
        .setContentText(if (!state.loggedIn) "未登录" else state.connectionText)
        .setOngoing(true).setOnlyAlertOnce(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setContentIntent(intent(context)).setCategory(NotificationCompat.CATEGORY_SERVICE).build()
    fun message(context: Context, state: AppState, message: Message) {
        if (!state.loggedIn || !state.notificationsEnabled || !state.accessAllowed || message.echo) return
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val notification = NotificationCompat.Builder(context, MESSAGES)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(if (state.notificationPreview) message.name else "Steam Chat")
            .setContentText(if (state.notificationPreview) message.text.take(200) else "收到新消息")
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE).setContentIntent(intent(context, message.peerId)).build()
        runCatching { context.getSystemService(NotificationManager::class.java).notify("peer:${message.peerId}", 2, notification) }
    }
    fun clearPeer(context: Context, peer: String) { context.getSystemService(NotificationManager::class.java).cancel("peer:$peer", 2) }
    fun clearMessages(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.tag?.startsWith("peer:") == true }.forEach { manager.cancel(it.tag, it.id) }
    }
}
