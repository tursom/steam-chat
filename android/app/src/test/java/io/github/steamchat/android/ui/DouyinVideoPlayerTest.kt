package io.github.steamchat.android.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.media3.common.Player
import android.graphics.Bitmap
import android.graphics.Canvas
import io.github.steamchat.android.AppState
import io.github.steamchat.android.Friend
import io.github.steamchat.android.Message
import io.github.steamchat.android.ThemeMode
import io.github.steamchat.android.ChatRepository
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import java.lang.reflect.Proxy
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = ComposeTestApplication::class, qualifiers = "w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DouyinVideoPlayerTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val url = "https://www.douyin.com/video/7687575973616905914"
    private val repository = ChatRepository(RuntimeEnvironment.getApplication(), sessionLoader = { null })
    private val loader = UiImageLoader(repository)

    @After fun tearDown() { loader.clear() }

    @Test fun nativeChatRendersDouyinLinkAsPlaybackCardWithoutResolvingItAutomatically() {
        val state = AppState(loggedIn = true, connected = true, steamOnline = true, accessAllowed = true,
            selectedPeer = "peer", selectedName = "好友", friends = listOf(Friend("peer", "好友")),
            messages = listOf(Message("video-link", "peer", "好友", url, false, "2026-10-05T06:57:00Z")))
        compose.setContent { SteamChatTheme(ThemeMode.DARK) {
            androidx.compose.material3.Surface(color = chatColors.bg) { ChatScreen(state, repository, loader) }
        } }
        compose.onNodeWithTag("douyin-video-card").assertIsDisplayed()
        compose.onNodeWithText("播放抖音视频").assertIsDisplayed()
        compose.onNodeWithTag("douyin-video-loading").assertDoesNotExist()
        compose.runOnIdle {
            val view = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            try {
                view.draw(Canvas(bitmap))
                val directory = File(requireNotNull(System.getProperty("steamChatScreenshotDir"))).apply { mkdirs() }
                File(directory, "steam-chat-douyin-video-card.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            } finally { bitmap.recycle() }
        }
    }

    @Test fun cardDoesNotResolveUntilClickedAndClosingCancelsTheRequest() {
        var calls = 0
        var cancelled = false
        compose.setContent {
            SteamChatTheme {
                DouyinVideoCard(MessagePart.Link(url, url), loader) {
                    calls++
                    try { awaitCancellation() } finally { cancelled = true }
                }
            }
        }
        compose.onNodeWithTag("douyin-video-card").assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, calls) }
        compose.onNodeWithText("播放抖音视频").performClick()
        compose.onNodeWithTag("douyin-video-loading").assertIsDisplayed()
        compose.runOnIdle { assertEquals(1, calls) }
        compose.onNodeWithTag("douyin-video-close").performClick()
        compose.onNodeWithTag("douyin-video-loading").assertDoesNotExist()
        compose.runOnIdle { assertTrue(cancelled) }
    }

    @Test fun unavailablePublicPageShowsFailureOriginalLinkAndRetry() {
        var calls = 0
        compose.setContent {
            SteamChatTheme {
                DouyinVideoDialog(url, {
                    calls++
                    error(if (calls == 1) "请尝试在抖音内观看" else "公开分享页仍不可播放")
                }, {})
            }
        }
        compose.onNodeWithTag("douyin-video-error").assertIsDisplayed()
        compose.onNodeWithText("请尝试在抖音内观看").assertIsDisplayed()
        compose.onNodeWithText("打开原链接").assertIsDisplayed()
        compose.onNodeWithText("重新解析").performClick()
        compose.onNodeWithText("公开分享页仍不可播放").assertIsDisplayed()
        compose.runOnIdle { assertEquals(2, calls) }
    }

    @Test fun changingMessageUrlCancelsOldResolutionAndDoesNotShowItsResult() {
        val link = mutableStateOf(url)
        val oldStarted = CompletableDeferred<Unit>()
        var oldCancelled = false
        compose.setContent {
            SteamChatTheme {
                DouyinVideoCard(MessagePart.Link(link.value, link.value), loader) {
                    oldStarted.complete(Unit)
                    try { awaitCancellation() } finally { oldCancelled = true }
                }
            }
        }
        compose.onNodeWithText("播放抖音视频").performClick()
        compose.onNodeWithTag("douyin-video-loading").assertIsDisplayed()
        compose.runOnIdle { assertTrue(oldStarted.isCompleted); link.value = "https://v.douyin.com/other/" }
        compose.onNodeWithTag("douyin-video-loading").assertDoesNotExist()
        compose.runOnIdle { assertTrue(oldCancelled) }
        compose.onNodeWithText("https://v.douyin.com/other/").assertIsDisplayed()
    }

    @Test fun removingChatCancelsLoadingInsteadOfKeepingItAliveBehindOtherScreens() {
        val visible = mutableStateOf(true)
        var cancelled = false
        compose.setContent {
            SteamChatTheme {
                if (visible.value) DouyinVideoDialog(url, {
                    try { awaitCancellation() } finally { cancelled = true }
                }, {})
            }
        }
        compose.onNodeWithTag("douyin-video-loading").assertIsDisplayed()
        compose.runOnIdle { visible.value = false }
        compose.onNodeWithTag("douyin-video-loading").assertDoesNotExist()
        compose.runOnIdle { assertTrue(cancelled) }
    }

    @Test fun playbackPausesInBackgroundAndReleasesListenersAndPlayerWhenClosed() {
        compose.runOnIdle {
            val events = mutableListOf<String>()
            val player = Proxy.newProxyInstance(Player::class.java.classLoader, arrayOf(Player::class.java)) { _, method, _ ->
                events += method.name
                null
            } as Player
            val owner = object : LifecycleOwner {
                val registry = LifecycleRegistry(this)
                override val lifecycle: Lifecycle get() = registry
            }
            owner.registry.currentState = Lifecycle.State.RESUMED
            var playing = true
            val release = bindVideoLifecycle(player, owner.lifecycle, {}, { playing = it })
            assertEquals(listOf("addListener"), events)
            owner.registry.currentState = Lifecycle.State.STARTED
            assertFalse(playing)
            assertTrue(events.contains("pause"))
            owner.registry.currentState = Lifecycle.State.CREATED
            val beforeResume = events.toList()
            owner.registry.currentState = Lifecycle.State.RESUMED
            assertEquals("Returning foreground must not auto-play", beforeResume, events)
            release()
            assertEquals(listOf("removeListener", "release"), events.takeLast(2))
            val afterRelease = events.toList()
            owner.registry.currentState = Lifecycle.State.CREATED
            assertEquals("Closed playback must no longer receive lifecycle events", afterRelease, events)
        }
    }
}
