package io.github.steamchat.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import io.github.steamchat.android.ui.ChatApp
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val repository: ChatRepository get() = (application as ChatApplication).repository
    private var queuedPeer: String? = null
    private var notificationsAllowed by mutableStateOf(false)
    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        updateNotificationStatus()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        queuedPeer = savedInstanceState?.getString("notificationPeer")
        if (savedInstanceState == null) consumeNotificationIntent(intent)
        updateNotificationStatus()
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                repository.state.collect { state ->
                    if (state.loggedIn && Build.VERSION.SDK_INT >= 33 && !notificationsAllowed && !getPreferences(MODE_PRIVATE).getBoolean("notification-prompted", false)) {
                        getPreferences(MODE_PRIVATE).edit().putBoolean("notification-prompted", true).apply()
                        requestNotifications()
                    }
                    val peer = queuedPeer
                    if (peer != null && state.loggedIn && state.accessAllowed) {
                        queuedPeer = null
                        val name = state.conversations.firstOrNull { it.id == peer }?.name
                            ?: state.friends.firstOrNull { it.id == peer }?.name ?: peer
                        repository.selectConversation(peer, name)
                    }
                }
            }
        }
        setContent {
            ChatApp(repository, notificationsAllowed, ::requestNotifications, ::openNotificationSettings)
        }
    }

    override fun onStart() { super.onStart(); repository.onForegroundChanged(true) }
    override fun onResume() { super.onResume(); updateNotificationStatus() }
    override fun onStop() { repository.onForegroundChanged(false); super.onStop() }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("notificationPeer", queuedPeer)
        super.onSaveInstanceState(outState)
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumeNotificationIntent(intent)
        val state = repository.state.value
        queuedPeer?.takeIf { state.loggedIn && state.accessAllowed }?.let { peer ->
            queuedPeer = null
            repository.selectConversation(peer, state.conversations.firstOrNull { it.id == peer }?.name
                ?: state.friends.firstOrNull { it.id == peer }?.name ?: peer)
        }
    }
    private fun consumeNotificationIntent(intent: Intent?) {
        intent?.getStringExtra("peerId")?.takeIf { it.isNotBlank() && it.length <= 128 && it.none(Char::isISOControl) }
            ?.let { queuedPeer = it }
        intent?.removeExtra("peerId")
    }
    private fun updateNotificationStatus() {
        notificationsAllowed = NotificationManagerCompat.from(this).areNotificationsEnabled()
    }
    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            permissionRequest.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else openNotificationSettings()
    }
    private fun openNotificationSettings() {
        runCatching {
            startActivity(if (NotificationManagerCompat.from(this).areNotificationsEnabled()) ChatNotifications.settingsIntent(this)
                else Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        }
    }
}
