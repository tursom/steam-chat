package io.github.steamchat.android.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import io.github.steamchat.android.AppState
import io.github.steamchat.android.ChatRepository
import io.github.steamchat.android.Friend
import io.github.steamchat.android.Message
import io.github.steamchat.android.RestSyncStatus
import io.github.steamchat.android.data.ChatCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger

/** Root integration tests: resizing changes constraints, not a copy of the layout algorithm. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = ComposeTestApplication::class, qualifiers = "w1400dp-h1000dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AdaptiveLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val width = mutableStateOf(1280.dp)
    private val height = mutableStateOf(900.dp)
    private val scheduler = TestCoroutineScheduler()
    private val httpRequests = AtomicInteger()
    private lateinit var repository: ChatRepository
    private lateinit var repositoryScope: CoroutineScope
    private lateinit var cache: ChatCache
    private lateinit var state: MutableStateFlow<AppState>
    private val cacheAccount = "adaptive-layout-fixture"
    private val first = "76561198000000001"
    private val second = "76561198000000002"
    private val names get() = mapOf(first to "林间晚风", second to "星河")

    @Before fun setUp() {
        // Never restore real credentials, start a sync worker, or issue real HTTP.
        val client = OkHttpClient.Builder().addInterceptor {
            httpRequests.incrementAndGet()
            throw IOException("Unexpected HTTP in adaptive layout test: ${it.request().url.encodedPath}")
        }.build()
        repository = ChatRepository(RuntimeEnvironment.getApplication(), sessionLoader = { null }, httpClient = client)
        runBlocking { field<CoroutineScope>("scope").coroutineContext[Job]!!.cancelAndJoin() }
        repositoryScope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(scheduler))
        setField("scope", repositoryScope)
        cache = field("cache")
        state = field("mutable")
        seedSession()
    }

    @After fun tearDown() {
        repositoryScope.cancel()
        cache.close()
        assertEquals("Layout tests must stay offline", 0, httpRequests.get())
    }

    @Test fun wideWorkspaceStartsEmptyAndSelectingEitherPeerHighlightsOnlyThatRow() {
        show()
        compose.onNodeWithTag("navigation-rail").assertIsDisplayed()
        compose.onNodeWithTag("conversation-pane").assertIsDisplayed()
        compose.onNodeWithTag("chat-empty").assertIsDisplayed()
        compose.onNodeWithText("选择一个会话").assertIsDisplayed()
        compose.onNodeWithTag("chat-pane").assertDoesNotExist()
        compose.onNodeWithTag("contact-$first").assertIsNotSelected()
        compose.onNodeWithTag("contact-$second").assertIsNotSelected()
        screenshot("android-tablet-empty")

        select(first)
        compose.onNodeWithTag("chat-empty").assertDoesNotExist()
        compose.onNodeWithTag("conversation-pane").assertIsDisplayed()
        compose.onNodeWithTag("chat-pane").assertIsDisplayed()
        compose.onNodeWithContentDescription("返回消息").assertDoesNotExist()
        compose.onNodeWithTag("contact-$first").assertIsSelected()
        message(first, 79).assertIsDisplayed()
        val contacts = compose.onNodeWithTag("conversation-pane").fetchSemanticsNode().boundsInRoot
        val chat = compose.onNodeWithTag("chat-pane").fetchSemanticsNode().boundsInRoot
        assertTrue("The two panes must not overlap", contacts.right <= chat.left)
        screenshot("android-tablet-split")

        select(second)
        compose.onNodeWithTag("contact-$first").assertIsNotSelected()
        compose.onNodeWithTag("contact-$second").assertIsSelected()
        message(second, 79).assertIsDisplayed()
        compose.runOnIdle { assertEquals(second, repository.state.value.selectedPeer) }
        // Keep a readable native screenshot alongside the diagnostic history fixtures.
        select(first)
        compose.runOnIdle {
            val texts = listOf("好久没种田了，今晚回星露谷逛逛？", "好呀，上次的存档还留着呢。", "等你上线，一起把温室修好？", "好呀，那晚上农场见。")
            state.value = state.value.copy(
                friends = state.value.friends.map { if (it.id == first) it.copy(gameName = "Stardew Valley") else it },
                conversations = state.value.conversations.map { it.copy(preview = if (it.id == first) texts.last() else "周末一起玩？", updatedAt = "2026-09-29T10:32:00Z") },
                messages = texts.mapIndexed { index, text -> Message("preview-$index", first, if (index % 2 == 0) "林间晚风" else "orbit", text, index % 2 == 1, "2026-09-29T10:${24 + index}:00Z") })
        }
        compose.onNode(hasText("好呀，那晚上农场见。") and hasAnyAncestor(hasTestTag("chat-messages"))).assertIsDisplayed()
        screenshot("steam-chat-android-tablet-native")
    }

    @Test fun exact600And840DpBoundariesSwitchNavigationAndAddTheSecondPane() {
        show(599)
        compose.onNodeWithTag("bottom-navigation").assertIsDisplayed()
        compose.onNodeWithTag("navigation-rail").assertDoesNotExist()
        compose.onNodeWithTag("chat-empty").assertDoesNotExist()

        resize(600)
        compose.onNodeWithTag("navigation-rail").assertIsDisplayed()
        compose.onNodeWithTag("bottom-navigation").assertDoesNotExist()
        compose.onNodeWithTag("chat-empty").assertDoesNotExist()
        compose.onNodeWithTag("nav-friends").performClick()
        settle()
        compose.onNodeWithTag("nav-friends").assertIsSelected()
        compose.onNodeWithText("2 人在线").assertIsDisplayed()
        select(first)
        compose.onNodeWithTag("conversation-pane").assertDoesNotExist()
        compose.onNodeWithTag("navigation-rail").assertIsDisplayed()
        compose.onNodeWithContentDescription("返回消息").assertIsDisplayed().performClick()
        settle()
        compose.onNodeWithTag("contact-list").assertIsDisplayed()
        compose.runOnIdle { assertEquals("", repository.state.value.selectedPeer) }

        resize(839)
        compose.onNodeWithTag("chat-empty").assertDoesNotExist()
        compose.onNodeWithTag("chat-pane").assertDoesNotExist()
        resize(840)
        compose.onNodeWithTag("conversation-pane").assertIsDisplayed()
        compose.onNodeWithTag("chat-pane").assertIsDisplayed()
        compose.onNodeWithTag("contact-$first").assertIsSelected()
        compose.runOnIdle { assertEquals(first, repository.state.value.selectedPeer) }
    }

    @Test fun shrinkingToPhoneKeepsChatUntilBackThenShowsListAndBottomNavigation() {
        show()
        select(first)
        compose.onNodeWithTag("message-input").performTextReplacement("手机切换草稿")
        resize(390)
        compose.onNodeWithTag("conversation-pane").assertDoesNotExist()
        compose.onNodeWithTag("navigation-rail").assertDoesNotExist()
        compose.onNodeWithTag("bottom-navigation").assertDoesNotExist()
        assertDraft("手机切换草稿")
        compose.onNodeWithContentDescription("返回消息").assertIsDisplayed().performClick()
        settle()
        compose.onNodeWithTag("contact-list").assertIsDisplayed()
        compose.onNodeWithTag("bottom-navigation").assertIsDisplayed()
        compose.onNodeWithTag("chat-pane").assertDoesNotExist()
        compose.runOnIdle { assertEquals("", repository.state.value.selectedPeer) }
        compose.onNodeWithTag("nav-settings").performClick()
        settle()
        compose.onNodeWithTag("settings-pane").assertIsDisplayed()
        compose.onNodeWithTag("nav-messages").performClick()
        settle()
        select(first)
        assertDraft("手机切换草稿")
        screenshot("android-tablet-resized-phone")
    }

    @Test fun openProfileChangesBetweenInlineAndDrawerAt1200WithoutLosingDraft() {
        show(1200)
        select(first)
        compose.onNodeWithTag("message-input").performTextReplacement("资料切换草稿")
        compose.onNodeWithContentDescription("好友资料").performClick()
        compose.onNodeWithTag("friend-details-inline").assertIsDisplayed()
        compose.onNodeWithTag("friend-details-drawer").assertDoesNotExist()
        compose.onNodeWithText(first).assertIsDisplayed()
        val messages = compose.onNodeWithTag("chat-messages").fetchSemanticsNode().boundsInRoot
        val profile = compose.onNodeWithTag("friend-details-inline").fetchSemanticsNode().boundsInRoot
        assertTrue("Inline details must sit beside the conversation", messages.right <= profile.left)
        screenshot("android-tablet-inline-profile")

        resize(1199)
        compose.onNodeWithTag("friend-details-inline").assertDoesNotExist()
        compose.onNodeWithTag("friend-details-drawer").assertIsDisplayed()
        compose.onNodeWithText(first).assertIsDisplayed()
        resize(1200)
        compose.onNodeWithTag("friend-details-drawer").assertDoesNotExist()
        compose.onNodeWithTag("friend-details-inline").assertIsDisplayed()
        compose.onNodeWithContentDescription("关闭好友资料").performClick()
        compose.onNodeWithTag("friend-details-inline").assertDoesNotExist()
        assertDraft("资料切换草稿")
        resize(840)
        compose.onNodeWithContentDescription("好友资料").performClick()
        compose.onNodeWithTag("friend-details-drawer").assertIsDisplayed()
        compose.onNodeWithContentDescription("关闭好友资料").performClick()
        assertDraft("资料切换草稿")
    }

    @Test fun eachPeerRetainsItsOwnDraftAndHistoryPositionWhenSwitching() {
        show()
        select(first)
        editAndReadHistory("第一位好友的草稿", 12)
        select(second)
        assertDraft("")
        message(second, 79).assertIsDisplayed()
        editAndReadHistory("第二位好友的草稿", 30)
        select(first)
        assertDraft("第一位好友的草稿")
        assertHistory(first, 12)
        select(second)
        assertDraft("第二位好友的草稿")
        assertHistory(second, 30)
    }

    @Test fun draftAndHistorySurviveResizingAndLeavingPhoneChatBeforeReturningWide() {
        show()
        select(first)
        editAndReadHistory("跨断点草稿", 12)
        listOf(839, 600, 599, 390).forEach { size ->
            resize(size)
            assertDraft("跨断点草稿")
            assertHistory(first, 12)
        }
        compose.onNodeWithContentDescription("返回消息").performClick()
        settle()
        compose.runOnIdle { assertEquals("", repository.state.value.selectedPeer) }
        resize(840)
        assertDraft("跨断点草稿")
        assertHistory(first, 12)
        resize(1200)
        assertDraft("跨断点草稿")
        assertHistory(first, 12)
    }

    @Test fun savedStateRestoresBothActiveAndPreviouslyVisitedPeerDraftsAndScroll() {
        val restoration = StateRestorationTester(compose)
        show(restoration = restoration)
        select(first)
        editAndReadHistory("恢复第一份草稿", 12)
        select(second)
        editAndReadHistory("恢复第二份草稿", 30)
        restoration.emulateSavedInstanceStateRestore()
        settle()
        assertDraft("恢复第二份草稿")
        assertHistory(second, 30)
        select(first)
        assertDraft("恢复第一份草稿")
        assertHistory(first, 12)
        select(second)
        assertDraft("恢复第二份草稿")
        assertHistory(second, 30)
    }

    @Test fun settingsHideSelectedPeerAllowUnreadAndReturningWideMarksItRead() {
        show()
        select(first)
        compose.onNodeWithTag("nav-settings").performClick()
        settle()
        compose.onNodeWithTag("settings-pane").assertIsDisplayed()
        compose.onNodeWithTag("chat-pane").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("Hidden conversations cannot stay selected", "", repository.state.value.selectedPeer)
            // Same foreground-peer input as repository catchUp; this is a live page after bootstrap.
            val incoming = item(first, 80).put("sentAt", Instant.now().toString())
            val notices = cache.ingest(cacheAccount, JSONArray().put(incoming), "live-1", false,
                repository.state.value.selectedPeer)
            assertEquals("A hidden conversation must remain eligible for notification", 1, notices.size)
            publishCache()
            assertEquals(1, repository.state.value.conversations.single { it.id == first }.unread)
        }
        compose.onNode(hasText("1") and hasAnyAncestor(hasTestTag("nav-messages")), useUnmergedTree = true)
            .assertIsDisplayed()
        compose.onNodeWithTag("nav-messages").performClick()
        settle()
        compose.onNodeWithTag("chat-pane").assertIsDisplayed()
        compose.onNodeWithTag("contact-$first").assertIsSelected()
        compose.runOnIdle {
            assertEquals(first, repository.state.value.selectedPeer)
            assertEquals(0, repository.state.value.conversations.single { it.id == first }.unread)
            assertEquals(0, cache.conversations(cacheAccount).single { it.id == first }.unread)
        }
        message(first, 80).assertIsDisplayed()
    }

    @Test fun queuedRestoreCannotReopenConversationAfterReturningToSettings() {
        show()
        select(first)
        compose.onNodeWithTag("nav-settings").performClick()
        settle()
        val gate = field<Mutex>("gate")
        assertTrue(gate.tryLock())
        try {
            compose.onNodeWithTag("nav-messages").performClick()
            settle() // The requested restoration is waiting behind a sync operation.
            compose.onNodeWithTag("nav-settings").performClick()
            settle()
            compose.runOnIdle {
                val incoming = item(first, 80).put("sentAt", Instant.now().toString())
                cache.ingest(cacheAccount, JSONArray().put(incoming), "queued-live", false, "")
                publishCache()
            }
        } finally { gate.unlock() }
        settle()
        compose.onNodeWithTag("settings-pane").assertIsDisplayed()
        compose.onNodeWithTag("chat-pane").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("", repository.state.value.selectedPeer)
            assertEquals(1, cache.conversations(cacheAccount).single { it.id == first }.unread)
        }
    }

    @Test fun selectionPublishesTheTargetMessagesInTheSameStateUpdate() {
        show()
        select(first)
        val observed = mutableListOf<AppState>()
        val observer = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        try {
            observer.launch(start = CoroutineStart.UNDISPATCHED) { repository.state.collect { observed += it } }
            compose.runOnIdle { repository.selectConversation(second, names.getValue(second)); scheduler.runCurrent() }
            compose.runOnIdle {
                val selected = observed.filter { it.selectedPeer == second }
                assertTrue(selected.isNotEmpty())
                assertTrue("New selection must not expose an empty or old-peer list", selected.all { snapshot ->
                    snapshot.messages.size == 80 && snapshot.messages.all { it.peerId == second }
                })
            }
        } finally { observer.cancel() }
    }

    @Test fun samePeerNotificationAfterSettingsWinsEvenWithoutAnIntermediateFrame() {
        show()
        select(first)
        val openSettings = compose.onNodeWithTag("nav-settings").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.runOnIdle {
            openSettings()
            // Same repository entry point as MainActivity's notification deep link.
            // Deliberately allow no UI frame for the intermediate cleared selection.
            repository.selectConversation(first, names.getValue(first))
            scheduler.runCurrent()
        }
        settle()
        compose.onNodeWithTag("chat-pane").assertIsDisplayed()
        compose.onNodeWithTag("settings-pane").assertDoesNotExist()
        compose.onNodeWithTag("nav-messages").assertIsSelected()
    }

    @Test fun oldAccountBundleCannotRestoreNavigationIntoTheNewAccount() {
        var changeAccountOnDispose = false
        val restoration = StateRestorationTester(compose)
        show(restoration = restoration, onRootDispose = {
            if (changeAccountOnDispose) state.value = state.value.copy(activeAccountId = "new-account", selectedPeer = "", selectedName = "", messages = emptyList())
        })
        select(first)
        compose.onNodeWithTag("nav-friends").performClick()
        settle()
        compose.onNodeWithContentDescription("好友资料").performClick()
        compose.onNodeWithTag("friend-details-inline").assertIsDisplayed()
        compose.runOnIdle { changeAccountOnDispose = true }
        restoration.emulateSavedInstanceStateRestore()
        compose.runOnIdle { changeAccountOnDispose = false }
        settle()
        compose.onNodeWithTag("nav-messages").assertIsSelected()
        compose.onNodeWithTag("chat-empty").assertIsDisplayed()
        compose.onNodeWithTag("friend-details-inline").assertDoesNotExist()
        resize(600)
        resize(1200)
        compose.runOnIdle { assertEquals("", repository.state.value.selectedPeer) }
    }

    @Test fun shortWindowCanClearUnreadFilterAfterItsLastConversationIsRead() {
        show()
        compose.runOnIdle {
            cache.ingest(cacheAccount, JSONArray().put(item(first, 80).put("sentAt", Instant.now().toString())), "unread-only", false, "")
            publishCache()
        }
        compose.onNodeWithText("未读", substring = false).performClick()
        resize(1000, 280)
        select(first)
        compose.onNodeWithText("暂无未读消息").assertIsDisplayed()
        compose.onNodeWithTag("clear-unread-filter").assertIsDisplayed().performClick()
        compose.onNodeWithTag("contact-$first").assertIsDisplayed()
        compose.onNodeWithTag("contact-$second").assertIsDisplayed()
    }

    @Test fun logoutClearsActiveAndHiddenDraftsAndActivityOwnedAttachments() {
        val restoration = StateRestorationTester(compose)
        show(restoration = restoration)
        populateBothPeers()
        // Exercise restored draft-key tracking too, not just keys visited in this composition.
        restoration.emulateSavedInstanceStateRestore()
        settle()
        assertDraft("private-draft-$second")
        compose.onNodeWithTag("pending-attachment").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(Uri.parse("content://adaptive-test/$first"), attachments().forPeer(first).uri)
            assertEquals(Uri.parse("content://adaptive-test/$second"), attachments().forPeer(second).uri)
        }
        compose.runOnIdle { repository.logout() }
        settle()
        compose.onNodeWithTag("chat-pane").assertDoesNotExist()
        compose.onNodeWithText("后台账号").assertIsDisplayed()
        assertAttachmentsEmpty()
        // Simulate a later successful login to the SAME identity; no HTTP/auth test is needed here.
        compose.runOnIdle { seedSession() }
        settle()
        assertBothPeersClean()
    }

    @Test fun changingAccountAndRevokingAccessDiscardDraftsAndAttachmentsEvenAfterReturning() {
        show()
        val original = repository.state.value
        populateBothPeers()
        compose.runOnIdle {
            state.value = original.copy(activeAccountId = "another-account", selectedPeer = "", messages = emptyList())
        }
        settle()
        assertAttachmentsEmpty()
        compose.runOnIdle { state.value = original }
        settle()
        assertBothPeersClean()

        populateBothPeers()
        compose.runOnIdle {
            state.value = original.copy(accessAllowed = false, selectedPeer = "", messages = emptyList())
        }
        settle()
        assertAttachmentsEmpty()
        compose.onNodeWithText("此账号尚无聊天访问权限").assertIsDisplayed()
        compose.runOnIdle { state.value = original }
        settle()
        assertBothPeersClean()
    }

    @Test fun attachmentViewModelRetainsPerPeerMemoryOnlyWithinItsOwnerAndScope() {
        val owner = object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
        try {
            val holder = ViewModelProvider(owner)[ConversationAttachments::class.java]
            holder.useScope("account-one")
            val uri = Uri.parse("content://adaptive-test/first")
            val pending = holder.forPeer(first)
            pending.uri = uri
            assertNull(holder.forPeer(second).uri)
            holder.useScope("account-one")
            val retained = ViewModelProvider(owner)[ConversationAttachments::class.java]
            assertSame(holder, retained)
            assertSame(pending, retained.forPeer(first))
            assertEquals(uri, retained.forPeer(first).uri)

            holder.useScope("account-two")
            assertNull(holder.forPeer(first).uri)
            holder.useScope("account-one")
            assertNull("Returning to an old account cannot resurrect its URI", holder.forPeer(first).uri)
            holder.forPeer(first).uri = uri
            owner.viewModelStore.clear()
            val recreated = ViewModelProvider(owner)[ConversationAttachments::class.java]
            assertNotSame(holder, recreated)
            recreated.useScope("account-one")
            assertNull("A new owner must not restore a temporary content grant", recreated.forPeer(first).uri)
        } finally {
            owner.viewModelStore.clear()
        }
    }

    @Test fun composerAndEnabledSendRemainInside280DpHeightOnTabletAndPhone() {
        show(1000, 280)
        select(first)
        compose.onNodeWithTag("message-input").performTextReplacement("短窗口也能发送")
        listOf(1000, 600, 390).forEach { size ->
            resize(size, 280)
            compose.onNodeWithTag("chat-messages").assertIsDisplayed()
            compose.onNodeWithTag("chat-composer").assertIsDisplayed()
            compose.onNodeWithTag("message-input").assertIsDisplayed()
            compose.onNodeWithTag("send-message").assertIsDisplayed().assertIsEnabled()
            val pane = compose.onNodeWithTag("chat-pane").fetchSemanticsNode().boundsInRoot
            listOf("message-input", "send-message").forEach { tag ->
                val control = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot
                assertTrue("$tag must fit entirely inside the short chat pane", control.top >= pane.top &&
                    control.bottom <= pane.bottom && control.left >= pane.left && control.right <= pane.right)
                assertTrue("$tag needs a usable touch target", control.height >= 48f)
            }
        }
        resize(1000, 280)
        screenshot("android-tablet-short-height")
    }

    private fun show(windowWidth: Int = 1280, windowHeight: Int = 900, restoration: StateRestorationTester? = null,
                     onRootDispose: (() -> Unit)? = null) {
        width.value = windowWidth.dp
        height.value = windowHeight.dp
        val content: @Composable () -> Unit = {
            DisposableEffect(Unit) { onDispose { onRootDispose?.invoke() } }
            Box(Modifier.size(width.value, height.value).testTag("test-viewport")) {
                ChatApp(repository, false, {}, {})
            }
        }
        if (restoration == null) compose.setContent(content) else restoration.setContent(content)
        settle()
    }

    private fun resize(windowWidth: Int, windowHeight: Int = 900) {
        compose.runOnIdle { width.value = windowWidth.dp; height.value = windowHeight.dp }
        settle()
    }

    private fun settle() {
        // A root LaunchedEffect may schedule repository selection AFTER Compose's first idle.
        repeat(2) {
            compose.waitForIdle()
            compose.runOnIdle { scheduler.runCurrent() }
        }
        compose.waitForIdle()
    }

    private fun select(peer: String) {
        compose.onNodeWithTag("contact-$peer").performClick()
        settle()
    }

    private fun editAndReadHistory(draft: String, index: Int) {
        compose.onNodeWithTag("message-input").performTextReplacement(draft)
        compose.onNodeWithTag("chat-messages").performScrollToIndex(index)
        assertHistory(repository.state.value.selectedPeer, index)
    }

    private fun assertDraft(expected: String) {
        compose.onNodeWithTag("message-input")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString(expected)))
    }

    private fun message(peer: String, index: Int) = compose.onNode(
        hasText("history-$peer-$index") and hasAnyAncestor(hasTestTag("chat-messages")))

    private fun assertHistory(peer: String, index: Int) {
        message(peer, index).assertIsDisplayed()
        compose.onNodeWithTag("chat-end").assertIsNotDisplayed()
    }

    private fun attachments() = ViewModelProvider(compose.activity)[ConversationAttachments::class.java]

    private fun populateBothPeers() {
        listOf(first, second).forEach { peer ->
            select(peer)
            compose.onNodeWithTag("message-input").performTextReplacement("private-draft-$peer")
            compose.runOnIdle {
                val uri = Uri.parse("content://adaptive-test/$peer")
                val bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
                val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
                bitmap.recycle()
                shadowOf(RuntimeEnvironment.getApplication().contentResolver)
                    .registerInputStream(uri, ByteArrayInputStream(bytes))
                attachments().forPeer(peer).uri = uri
            }
            compose.onNodeWithTag("pending-attachment").assertIsDisplayed()
        }
    }

    private fun assertAttachmentsEmpty() {
        compose.runOnIdle {
            assertNull(attachments().forPeer(first).uri)
            assertNull(attachments().forPeer(second).uri)
        }
    }

    private fun assertBothPeersClean() {
        listOf(first, second).forEach { peer ->
            select(peer)
            assertDraft("")
            compose.onNodeWithTag("pending-attachment").assertDoesNotExist()
        }
        assertAttachmentsEmpty()
    }

    private fun seedSession() {
        cache.clearAll()
        setField("sessionEnding", false)
        setField("cacheScope", cacheAccount)
        state.value = AppState(server = "https://adaptive.invalid", loggedIn = true, username = "orbit",
            activeAccountId = "tablet-account", accessAllowed = true, steamOnline = true, connected = true,
            restSyncStatus = RestSyncStatus.READY, restSyncText = "REST 同步完成", connectionText = "实时通道已连接",
            friends = names.map { (id, name) -> Friend(id, name, online = true) })
        val rows = JSONArray()
        listOf(first, second).forEach { peer -> repeat(80) { rows.put(item(peer, it)) } }
        cache.ingest(cacheAccount, rows, "bootstrap-complete", false, "")
        publishCache()
    }

    private fun item(peer: String, index: Int) = JSONObject()
        .put("syncId", "$peer-$index").put("eventId", "$peer-$index")
        .put("id", peer).put("name", names.getValue(peer)).put("echo", false)
        .put("message", "history-$peer-$index").put("ordinal", index)
        .put("sentAt", Instant.parse("2025-01-01T12:00:00Z").plusSeconds(index.toLong()).toString())

    // Kept here (as in OutgoingReconciliationTest) so production needs no test-only API.
    private fun publishCache() = ChatRepository::class.java.getDeclaredMethod("publishCache")
        .apply { isAccessible = true }.invoke(repository)

    private fun setField(name: String, value: Any) = ChatRepository::class.java.getDeclaredField(name)
        .apply { isAccessible = true }.set(repository, value)

    @Suppress("UNCHECKED_CAST")
    private fun <T> field(name: String): T = ChatRepository::class.java.getDeclaredField(name)
        .apply { isAccessible = true }.get(repository) as T

    private fun screenshot(name: String) {
        val directory = File(requireNotNull(System.getProperty("steamChatScreenshotDir")))
        directory.mkdirs()
        val bounds = compose.onNodeWithTag("test-viewport").fetchSemanticsNode().boundsInRoot
        compose.runOnIdle {
            val view = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            try {
                view.draw(Canvas(bitmap))
                val cropped = Bitmap.createBitmap(bitmap, bounds.left.toInt(), bounds.top.toInt(), bounds.width.toInt(), bounds.height.toInt())
                try { File(directory, "$name.png").outputStream().use { cropped.compress(Bitmap.CompressFormat.PNG, 100, it) } }
                finally { if (cropped !== bitmap) cropped.recycle() }
            } finally {
                bitmap.recycle()
            }
        }
    }
}
