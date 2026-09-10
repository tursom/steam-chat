package io.github.steamchat.android.ui

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.github.steamchat.android.AppState
import io.github.steamchat.android.ChatRepository
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, qualifiers = "w390dp-h844dp")
class StickerPickerTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val names = listOf("Cat Cam talking", "Rumi : Why...?")

    @Test fun stickerSelectionSendsIndependentlyInsteadOfInsertingMarkup() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        val loader = UiImageLoader(repository)
        val sends = mutableListOf<String>()
        val inserts = mutableListOf<String>()
        compose.setContent { SteamChatTheme { InventoryPanel(AppState(stickers = names), loader, inserts::add, sends::add, true, {}) } }
        compose.onNodeWithText("贴纸").performClick()
        names.forEach { compose.onNodeWithText(it).performClick() }
        compose.runOnIdle { assertEquals(names, sends); assertTrue(inserts.isEmpty()) }
    }

    @Test fun friendlyInventoryTitleStillSendsCanonicalType() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        val loader = UiImageLoader(repository)
        val sends = mutableListOf<String>()
        val state = AppState(stickers = listOf("canonical-type"), stickerInventory = listOf(io.github.steamchat.android.Sticker("canonical-type", "Friendly title")))
        compose.setContent { SteamChatTheme { InventoryPanel(state, loader, {}, sends::add, true, {}) } }
        compose.onNodeWithText("贴纸").performClick()
        compose.onNodeWithText("Friendly title").performClick()
        compose.runOnIdle { assertEquals(listOf("canonical-type"), sends) }
    }

    @Test fun offlinePickerDoesNotSendStickers() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        val loader = UiImageLoader(repository)
        val sends = mutableListOf<String>()
        compose.setContent { SteamChatTheme { InventoryPanel(AppState(stickers = names), loader, {}, sends::add, false, {}) } }
        compose.onNodeWithText("贴纸").performClick()
        compose.onNodeWithText(names.first()).performClick()
        compose.runOnIdle { assertTrue(sends.isEmpty()) }
    }

    @Test fun sendingStickerClosesPickerAndPreservesTextDraft() {
        val repository = ChatRepository(RuntimeEnvironment.getApplication())
        val loader = UiImageLoader(repository)
        val state = AppState(loggedIn = true, accessAllowed = true, connected = true, steamOnline = true,
            selectedPeer = "peer", selectedName = "Friend", stickers = names)
        compose.setContent { SteamChatTheme { ChatScreen(state, repository, loader) } }
        compose.onNode(hasSetTextAction()).performTextInput("keep this draft")
        compose.onNodeWithContentDescription("表情与贴纸").performClick()
        compose.onNodeWithText("贴纸").performClick()
        compose.onNodeWithText(names.first()).performClick()
        compose.onNodeWithText("keep this draft").assertIsDisplayed()
        compose.onNodeWithText("Emoji").assertDoesNotExist()
    }
}
