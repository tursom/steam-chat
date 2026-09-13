package io.github.steamchat.android.ui

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.runtime.mutableStateOf
import io.github.steamchat.android.RestSyncStatus
import io.github.steamchat.android.Conversation
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.github.steamchat.android.ChatNotifications
import io.github.steamchat.android.AppState
import io.github.steamchat.android.ChatRepository
import io.github.steamchat.android.Message
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, qualifiers = "w390dp-h844dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NativeScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun httpsConfigurationScreenRenders() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        compose.setContent { ChatApp(repository, false, {}, {}) }
        compose.onNodeWithText("连接服务器").assertIsDisplayed()
        compose.onNodeWithText("后端 HTTPS 地址").assertIsDisplayed()
        screenshot("android-setup")
    }

    @Test fun chatAndInventoryAreNativeComposableScreens() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        val state = AppState(loggedIn = true, username = "orbit", connected = true, steamOnline = true,
            accessAllowed = true, selectedPeer = "76561198000000001", selectedName = "林间晚风",
            messages = listOf(
                Message("first", "76561198000000001", "林间晚风", "晚上要不要一起开黑？", false, "2026-09-07T14:28:00Z"),
                Message("second", "76561198000000001", "orbit", "好啊，八点见！", true, "2026-09-07T14:29:00Z")
            ))
        val loader = UiImageLoader(repository)
        compose.setContent { SteamChatTheme { ChatScreen(state, repository, loader) } }
        compose.onNodeWithText("晚上要不要一起开黑？").assertIsDisplayed()
        screenshot("android-chat")
        compose.onNodeWithContentDescription("表情与贴纸").performClick()
        compose.onNodeWithText("Emoji").assertIsDisplayed().performClick()
        compose.onNodeWithText("😀").assertIsDisplayed()
        screenshot("android-emoji")
    }

    @Test fun notificationSettingsRenderAndPostALocalTestOnAndroid15() {
        val context = RuntimeEnvironment.getApplication()
        org.robolectric.Shadows.shadowOf(context).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        ChatNotifications.channels(context)
        val repository = ChatRepository(context)
        val state = AppState(loggedIn = true, username = "orbit", accessAllowed = true)
        val loader = UiImageLoader(repository)
        compose.setContent {
            SteamChatTheme { SettingsScreen(state, repository, loader, true, {}, {}) }
        }
        compose.onNodeWithText("消息通知类别").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("发送测试通知").performScrollTo().assertIsDisplayed().performClick()
        compose.runOnIdle {
            val notice = context.getSystemService(android.app.NotificationManager::class.java).activeNotifications.single()
            org.junit.Assert.assertEquals("notification-test", notice.tag)
            org.junit.Assert.assertEquals("messages", notice.notification.channelId)
        }
        screenshot("android-notification-settings")
    }

    @Test fun syncStatusUsesOneHeaderIconAndDetailsStayCollapsed() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        val loader = UiImageLoader(repository)
        val state = mutableStateOf(AppState(loggedIn = true, accessAllowed = true, connected = true,
            steamOnline = true, username = "orbit", restSyncStatus = RestSyncStatus.READY,
            restSyncText = "REST 同步完成", connectionText = "实时通道已连接",
            conversations = listOf(Conversation("peer", "好友", preview = "最近一条消息"))))
        compose.setContent { SteamChatTheme { ContactScreen(state.value, repository, loader, false, {}, {}) } }
        compose.onNodeWithText("REST 同步完成").assertDoesNotExist()
        compose.onNodeWithContentDescription("刷新").assertIsDisplayed()
        val title = compose.onNodeWithText("Steam Chat").fetchSemanticsNode().boundsInRoot
        val icon = compose.onNodeWithTag("sync-status").fetchSemanticsNode().boundsInRoot
        org.junit.Assert.assertTrue(icon.left >= title.right)
        org.junit.Assert.assertEquals(title.center.y, icon.center.y, 1f)
        screenshot("android-header-sync")
        compose.onNodeWithTag("sync-status").performClick()
        compose.onNodeWithText("REST 同步完成").assertIsDisplayed()
        compose.onNodeWithText("实时通道已连接").assertIsDisplayed()
        compose.onNodeWithText("关闭").performClick()
        compose.runOnIdle { state.value = state.value.copy(connected = false) }
        compose.onNodeWithContentDescription("同步状态：已同步，使用 REST 接收消息").assertIsDisplayed()
        compose.onNodeWithText("REST 同步完成").assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(restSyncStatus = RestSyncStatus.FAILED) }
        compose.onNodeWithContentDescription("同步状态：同步失败").assertIsDisplayed()
    }

    private fun screenshot(name: String) {
        val dir = File(requireNotNull(System.getProperty("steamChatScreenshotDir")))
        dir.mkdirs()
        compose.runOnIdle {
            val view = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
