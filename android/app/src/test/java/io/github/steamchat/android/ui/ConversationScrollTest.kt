package io.github.steamchat.android.ui

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollToIndex
import io.github.steamchat.android.AppState
import io.github.steamchat.android.ChatRepository
import io.github.steamchat.android.Message
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, qualifiers = "w390dp-h844dp")
class ConversationScrollTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private fun messages(peer: String = "peer", count: Int = 80) = (0 until count).map {
        Message("$peer-$it", peer, "Friend", "row-$peer-$it", false, "2026-09-08T12:00:00Z")
    }
    private fun state(peer: String = "peer", rows: List<Message> = messages(peer)) = AppState(
        loggedIn = true, accessAllowed = true, connected = true, steamOnline = true,
        selectedPeer = peer, selectedName = "Friend", messages = rows)
    private fun show(value: androidx.compose.runtime.State<AppState>) {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        val loader = UiImageLoader(repository)
        compose.setContent { SteamChatTheme { ChatScreen(value.value, repository, loader) } }
    }

    @Test fun enteringLoadedConversationShowsNewestIncomingMessage() {
        show(mutableStateOf(state()))
        compose.onNodeWithText("row-peer-79").assertIsDisplayed()
    }

    @Test fun firstMessagesArrivingAfterEmptyLayoutScrollToBottom() {
        val value = mutableStateOf(state(rows = emptyList()))
        show(value)
        compose.onNodeWithText("暂无消息").assertIsDisplayed()
        compose.runOnIdle { value.value = state() }
        compose.onNodeWithText("row-peer-79").assertIsDisplayed()
    }

    @Test fun switchingConversationResetsTheInitialBottomPosition() {
        val value = mutableStateOf(state())
        show(value)
        compose.onNodeWithTag("chat-messages").performScrollToIndex(10)
        compose.runOnIdle { value.value = state("other") }
        compose.onNodeWithText("row-other-79").assertIsDisplayed()
    }

    @Test fun incomingOrRemoteEchoDoesNotPullReaderAwayFromHistory() {
        val value = mutableStateOf(state())
        show(value)
        compose.onNodeWithTag("chat-messages").performScrollToIndex(10)
        compose.onNodeWithText("row-peer-10").assertIsDisplayed()
        compose.runOnIdle { value.value = state(rows = messages(count = 81)) }
        compose.onNodeWithText("row-peer-10").assertIsDisplayed()
        compose.runOnIdle { value.value = state(rows = messages(count = 82).mapIndexed { i, m -> if (i == 81) m.copy(echo = true) else m }) }
        compose.onNodeWithText("row-peer-10").assertIsDisplayed()
    }

    @Test fun veryTallFinalMessageShowsItsBottomRatherThanItsTop() {
        val time = "2026-09-08T13:02:03Z"
        val rows = messages().dropLast(1) + Message("long", "peer", "Friend", (0 until 100).joinToString("\n") { "Long line $it" }, false, time)
        show(mutableStateOf(state(rows = rows)))
        compose.onNodeWithTag("chat-end").assertIsDisplayed()
        compose.onNodeWithText(displayTime(time)).assertIsDisplayed()
    }

    @Test fun sendingLocallyReturnsToNewestMessageFromHistory() {
        val value = mutableStateOf(state())
        show(value)
        compose.onNodeWithTag("chat-messages").performScrollToIndex(10)
        compose.runOnIdle {
            value.value = state(rows = messages() + Message("local:new", "peer", "Me", "New local send", true, "2026-09-08T12:00:00Z", pending = true))
        }
        compose.onNodeWithText("New local send").assertIsDisplayed()
    }

    @Test fun bottomFollowsBatchOfNewMessages() {
        val value = mutableStateOf(state())
        show(value)
        compose.onNodeWithText("row-peer-79").assertIsDisplayed()
        compose.runOnIdle { value.value = state(rows = messages(count = 95)) }
        compose.onNodeWithText("row-peer-94").assertIsDisplayed()
    }
}
