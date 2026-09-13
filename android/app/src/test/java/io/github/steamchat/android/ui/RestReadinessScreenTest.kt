package io.github.steamchat.android.ui

import android.app.Application
import android.content.Context
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.github.steamchat.android.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class RestReadinessScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun configuredServerOpensCredentialsWithoutSelector() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("chat-settings", Context.MODE_PRIVATE).edit()
            .putString("server", "https://saved.invalid/").commit()
        val repository = ChatRepository(context)
        compose.setContent { ChatApp(repository, false, {}, {}) }
        compose.onNodeWithText("后台账号").assertIsDisplayed()
        compose.onNodeWithText("连接服务器").assertDoesNotExist()
    }

    @Test fun retryScreenHasRecoveryActionsWithoutServerSelector() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        compose.setContent { SteamChatTheme {
            RestorationScreen(AppState(server = "https://saved.invalid/", restoration = SessionRestoration.RETRY), repository)
        } }
        compose.onNodeWithText("重试").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("退出会话并重新登录").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("更换服务器").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("连接服务器").assertDoesNotExist()
    }

    @Test fun steamOfflineKeepsSendDisabledEvenWithConnectedSocket() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        compose.setContent { SteamChatTheme {
            ChatScreen(AppState(loggedIn = true, accessAllowed = true, steamOnline = false, connected = true,
                selectedPeer = "peer"), repository, UiImageLoader(repository))
        } }
        compose.onNodeWithContentDescription("选择图片").assertIsNotEnabled()
        compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput("blocked")
        compose.onNodeWithContentDescription("发送消息").assertIsNotEnabled()
    }

    @Test fun steamOnlineWithBlockedSocketEnablesImageAndTextSend() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        val state = AppState(loggedIn = true, accessAllowed = true, steamOnline = true,
            connected = false, selectedPeer = "peer", selectedName = "Friend")
        compose.setContent { SteamChatTheme { ChatScreen(state, repository, UiImageLoader(repository)) } }
        compose.onNodeWithContentDescription("选择图片").assertIsEnabled()
        compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput("REST message")
        compose.onNodeWithContentDescription("发送消息").assertIsEnabled()
    }
}
