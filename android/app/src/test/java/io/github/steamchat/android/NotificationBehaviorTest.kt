package io.github.steamchat.android

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, manifest = Config.NONE)
class NotificationBehaviorTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val manager get() = context.getSystemService(NotificationManager::class.java)
    private val state = AppState(loggedIn = true, accessAllowed = true)
    private fun message(peer: String, text: String = "private message") = Message(peer, peer, "Friend", text, false, "2026-09-07T12:00:00Z")

    @Test fun privateNotificationOmitsContentAndOpensExactConversation() {
        ChatNotifications.channels(context)
        ChatNotifications.message(context, state, message("peer1"))
        val posted = manager.activeNotifications.single().notification
        assertEquals("Steam Chat", posted.extras.getString(Notification.EXTRA_TITLE))
        assertEquals("收到新消息", posted.extras.getString(Notification.EXTRA_TEXT))
        assertEquals(Notification.VISIBILITY_PRIVATE, posted.visibility)
        val intent = Shadows.shadowOf(posted.contentIntent).savedIntent
        assertEquals("peer1", intent.getStringExtra("peerId"))
        assertEquals("io.github.steamchat.android.MainActivity", intent.component?.className)
    }

    @Test fun notificationsReplacePerPeerAndCanBeClearedWithoutRemovingServiceNotice() {
        ChatNotifications.channels(context)
        manager.notify(ChatNotifications.SERVICE_ID, ChatNotifications.connection(context, state))
        ChatNotifications.message(context, state, message("peer1"))
        ChatNotifications.message(context, state, message("peer1", "newer"))
        ChatNotifications.message(context, state, message("peer2"))
        assertEquals(3, manager.activeNotifications.size)
        ChatNotifications.clearPeer(context, "peer1")
        assertEquals(2, manager.activeNotifications.size)
        ChatNotifications.clearMessages(context)
        assertEquals(ChatNotifications.SERVICE_ID, manager.activeNotifications.single().id)
    }

    @Test fun logoutDeniedAccessMutedAndOwnMessagesCannotNotify() {
        ChatNotifications.channels(context)
        ChatNotifications.message(context, state.copy(loggedIn = false), message("peer"))
        ChatNotifications.message(context, state.copy(accessAllowed = false), message("peer"))
        ChatNotifications.message(context, state.copy(notificationsEnabled = false), message("peer"))
        ChatNotifications.message(context, state, message("peer").copy(echo = true))
        assertTrue(manager.activeNotifications.isEmpty())
    }
}
