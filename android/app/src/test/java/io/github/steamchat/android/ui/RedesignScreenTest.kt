package io.github.steamchat.android.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import io.github.steamchat.android.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId

/** Redesign behaviors plus light/dark screenshots for comparison with the mockups; synthetic data only. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = ComposeTestApplication::class, qualifiers = "w390dp-h844dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RedesignScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val peer = "76561198000000001"
    private fun at(day: LocalDate, hour: Int, minute: Int) =
        LocalDateTime.of(day, LocalTime.of(hour, minute)).atZone(ZoneId.systemDefault()).toInstant().toString()
    private val today = LocalDate.now()
    private val friends = listOf(
        Friend(peer, "林间晚风", online = true, gameName = "Counter-Strike 2"),
        Friend("76561198000000002", "星河", online = true),
        Friend("76561198000000003", "阿柚"))
    private val chatState = AppState(loggedIn = true, username = "orbit", connected = true, steamOnline = true, accessAllowed = true,
        selectedPeer = peer, selectedName = "林间晚风", friends = friends, messages = listOf(
            Message("y1", peer, "林间晚风", "周末有空吗？", false, at(today.minusDays(1), 19, 2)),
            Message("y2", peer, "orbit", "有，怎么了", true, at(today.minusDays(1), 19, 10)),
            Message("t1", peer, "林间晚风", "晚上要不要一起开黑？", false, at(today, 22, 26)),
            Message("t2", peer, "林间晚风", "八点，我开好房间叫你", false, at(today, 22, 26)),
            Message("t3", peer, "orbit", "好啊，八点见！", true, at(today, 22, 29)),
            Message("local:t4", peer, "orbit", "顺便把语音也开着", true, at(today, 22, 30), pending = true),
            Message("local:t5", peer, "orbit", "记得带上上次那个配置", true, at(today, 22, 31), failed = true, error = "发送结果未确认")))
    private val listState = AppState(loggedIn = true, username = "orbit", connected = true, steamOnline = true, accessAllowed = true,
        restSyncStatus = RestSyncStatus.READY, friends = friends, conversations = listOf(
            Conversation(peer, "林间晚风", preview = "晚上八点开黑，别迟到", updatedAt = at(today, 22, 41), unread = 2),
            Conversation("76561198000000002", "星河", preview = "[图片]", updatedAt = at(today, 21, 7)),
            Conversation("76561198000000003", "阿柚", preview = "好的，明天见", updatedAt = at(today.minusDays(1), 20, 0))))

    @Test fun groupedMessagesShowOneAvatarPerRunAndDateChips() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        compose.setContent { SteamChatTheme(ThemeMode.LIGHT) { ChatScreen(chatState, repository, UiImageLoader(repository)) } }
        compose.onNodeWithText("昨天").assertIsDisplayed()
        compose.onNodeWithText("今天").assertIsDisplayed()
        // Header avatar plus one per incoming run (yesterday's single message, today's pair).
        compose.onAllNodesWithText("林").assertCountEquals(3)
        compose.onNodeWithText("正在玩 Counter-Strike 2").assertIsDisplayed()
        compose.onNodeWithText("重试").assertIsDisplayed()
        screenshot("redesign-chat-light")
    }

    @Test fun darkThemeRendersChatListAndSettings() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        val loader = UiImageLoader(repository)
        val screen = androidx.compose.runtime.mutableIntStateOf(0)
        compose.setContent {
            SteamChatTheme(ThemeMode.DARK) {
                androidx.compose.material3.Surface(color = chatColors.bg) {
                    when (screen.intValue) {
                        0 -> ChatScreen(chatState, repository, loader)
                        1 -> ContactScreen(listState, repository, loader, false, {}, {})
                        2 -> ContactScreen(listState, repository, loader, true, {}, {})
                        else -> SettingsScreen(listState.copy(activeAccountId = peer, server = "https://chat.example.com/"), repository, loader, true, {}, {})
                    }
                }
            }
        }
        compose.onNodeWithText("晚上要不要一起开黑？").assertIsDisplayed()
        screenshot("redesign-chat-dark")
        compose.runOnIdle { screen.intValue = 1 }
        compose.onNodeWithText("晚上八点开黑，别迟到").assertIsDisplayed()
        screenshot("redesign-list-dark")
        compose.runOnIdle { screen.intValue = 2 }
        compose.onNodeWithText("游戏中 · 1").assertIsDisplayed()
        compose.onNodeWithText("在线 · 1").assertIsDisplayed()
        compose.onNodeWithText("离线 · 1").assertIsDisplayed()
        screenshot("redesign-friends-dark")
        compose.runOnIdle { screen.intValue = 3 }
        compose.onNodeWithText("主题").performScrollTo().assertIsDisplayed()
        screenshot("redesign-settings-dark")
    }

    @Test fun lightListAndFriendsScreenshots() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        val loader = UiImageLoader(repository)
        val friendsTab = androidx.compose.runtime.mutableStateOf(false)
        compose.setContent { SteamChatTheme(ThemeMode.LIGHT) { ContactScreen(listState, repository, loader, friendsTab.value, {}, {}) } }
        compose.onNodeWithText("未读").assertIsDisplayed()
        screenshot("redesign-list-light")
        compose.runOnIdle { friendsTab.value = true }
        compose.onNodeWithText("2 人在线").assertIsDisplayed()
        screenshot("redesign-friends-light")
    }

    @Test fun themeSelectionPersistsAcrossRepositoryInstances() {
        val context = RuntimeEnvironment.getApplication()
        val repository = ChatRepository(context)
        compose.setContent {
            val state = repository.state.collectAsState().value
            SteamChatTheme(state.themeMode) { SettingsScreen(state.copy(loggedIn = true, username = "orbit"), repository, UiImageLoader(repository), true, {}, {}) }
        }
        compose.onNodeWithTag("theme-dark").performScrollTo().performClick()
        compose.onNodeWithTag("theme-dark").assertIsSelected()
        compose.runOnIdle { assertEquals(ThemeMode.DARK, repository.state.value.themeMode) }
        assertEquals(ThemeMode.DARK, ChatRepository(context).state.value.themeMode)
        screenshot("redesign-settings-theme-dark")
        compose.onNodeWithTag("theme-system").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(ThemeMode.SYSTEM, repository.state.value.themeMode) }
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
