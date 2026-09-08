package io.github.steamchat.android.ui

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
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
