package io.github.steamchat.android

import android.app.Application
import io.github.steamchat.android.data.BilibiliShare
import io.github.steamchat.android.data.ChatCache
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, manifest = Config.NONE)
class BilibiliShareSendTest {
    private lateinit var repository: ChatRepository
    private lateinit var scope: CoroutineScope
    private lateinit var publicClient: OkHttpClient
    private lateinit var apiClient: OkHttpClient
    private val scheduler = TestCoroutineScheduler()
    private val sent = CopyOnWriteArrayList<JSONObject>()
    private val publicRequests = CopyOnWriteArrayList<Request>()
    private val releases = mutableListOf<CountDownLatch>()
    private var resolveCode = 302
    private var sendCode = 200
    private var onResolve: () -> Unit = {}
    private val share = "【恋愛脳(恋爱脑) / 七音阿卡莉-TV动画「契约之吻」ED-哔哩哔哩】 https://b23.tv/iULlJGW"
    private val canonical = "https://www.bilibili.com/video/av990800235"

    @Before fun setup() {
        publicClient = OkHttpClient.Builder().followRedirects(false).addInterceptor { chain ->
            publicRequests += chain.request()
            onResolve()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(resolveCode)
                .message("synthetic").header("Location", "https://www.bilibili.com/video/BV1hx4y1M7c5?p=1&share_source=COPY")
                .body("".toResponseBody()).build()
        }.build()
        apiClient = OkHttpClient.Builder().addInterceptor { chain ->
            val path = chain.request().url.encodedPath
            val body = when (path) {
                "/api/steam/status" -> """{"accessAllowed":true,"status":"online","activeAccount":{"steamId":"steam"}}"""
                "/message" -> {
                    assertEquals("steam_chat_session=synthetic", chain.request().header("Cookie"))
                    val buffer = okio.Buffer()
                    chain.request().body!!.writeTo(buffer)
                    val request = JSONObject(buffer.readUtf8())
                    sent += request
                    JSONObject().put("ok", true).put("item", JSONObject().put("eventId", "event-${sent.size}")
                        .put("message", request.getString("msg"))).toString()
                }
                "/api/auth/logout" -> "{}"
                else -> error("Unexpected request $path")
            }
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(if (path == "/message") sendCode else 200).message("synthetic")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }.build()
        repository = ChatRepository(RuntimeEnvironment.getApplication(), sessionLoader = { null }, httpClient = apiClient,
            bilibiliShare = BilibiliShare(publicClient))
        runBlocking { field<CoroutineScope>("scope").coroutineContext[Job]!!.cancelAndJoin() }
        scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(scheduler))
        set("scope", scope)
        set("base", "https://chat.invalid/".toHttpUrl())
        set("cookie", "steam_chat_session=synthetic")
        set("expires", Long.MAX_VALUE)
        set("cacheScope", "share-scope")
        set("accountSteamId", "steam")
        field<ChatCache>("cache").clearAll()
        field<MutableStateFlow<AppState>>("mutable").value = AppState(loggedIn = true, accessAllowed = true,
            connected = true, steamOnline = true, selectedPeer = "peer", username = "Me", backgroundEnabled = false)
    }

    @After fun cleanup() {
        releases.forEach { it.countDown() }
        scope.cancel()
        scheduler.runCurrent()
        publicClient.dispatcher.cancelAll()
        apiClient.dispatcher.cancelAll()
        field<ChatCache>("cache").close()
    }

    @Test fun shareIsConvertedBeforePostingAndPublicRequestsHaveNoChatCredentials() {
        repository.sendText(share)
        await { sent.size == 1 && repository.state.value.messages.singleOrNull()?.pending == false }
        assertEquals(canonical, sent.single().getString("msg"))
        assertEquals("peer", sent.single().getString("id"))
        assertEquals("steam", sent.single().getString("steamAccountId"))
        assertEquals(canonical, repository.state.value.messages.single().text)
        assertEquals("b23.tv", publicRequests.single().url.host)
        assertNull(publicRequests.single().header("Cookie"))
        assertNull(publicRequests.single().header("Authorization"))
    }

    @Test fun resolutionFailureDoesNotPostOrBackOffSyncAndManualRetryResolvesAgain() {
        resolveCode = 503
        repository.sendText(share)
        await { repository.state.value.messages.singleOrNull()?.failed == true }
        val failed = repository.state.value.messages.single()
        assertTrue(sent.isEmpty())
        assertFalse(failed.retryMayDuplicate)
        assertTrue(failed.error.contains("尚未发送"))
        assertEquals(0L, field<Long>("httpRetryAt"))
        resolveCode = 302
        repository.retryMessage(failed.key)
        await { sent.size == 1 && repository.state.value.messages.singleOrNull()?.pending == false }
        assertEquals(2, publicRequests.size)
        assertEquals(canonical, sent.single().getString("msg"))
    }

    @Test fun uncertainSendRetriesTheResolvedAvLinkWithoutResolvingAgain() {
        sendCode = 503
        repository.sendText(share)
        await { repository.state.value.messages.singleOrNull()?.failed == true }
        val failed = repository.state.value.messages.single()
        assertTrue(failed.retryMayDuplicate)
        assertEquals(canonical, failed.text)
        sendCode = 200
        repository.retryMessage(failed.key)
        scheduler.runCurrent()
        assertEquals(listOf(canonical, canonical), sent.map { it.getString("msg") })
        assertEquals(1, publicRequests.size)
    }

    @Test fun plainTextAndProseContainingLinksAreUnchanged() {
        val texts = listOf("hello", "看看这个 https://b23.tv/iULlJGW 很好听", "https://example.com/video/BV1hx4y1M7c5", "$share $share", "$share\n额外说明", "【备注】 请勿转发。$share")
        texts.forEach { repository.sendText(it) }
        scheduler.runCurrent()
        assertEquals(texts, sent.map { it.getString("msg") })
        assertTrue(publicRequests.isEmpty())
    }

    @Test fun resolvingDoesNotHoldGateAndKeepsTheOriginalRecipient() {
        val (entered, release) = blockResolution()
        repository.sendText(share)
        scheduler.runCurrent()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        assertFalse(field<Mutex>("gate").isLocked)
        repository.selectConversation("other-peer", "Other")
        scheduler.runCurrent()
        assertEquals("other-peer", repository.state.value.selectedPeer)
        repository.sendText("another message")
        scheduler.runCurrent()
        assertEquals("other-peer", sent.single().getString("id"))
        release.countDown()
        await { sent.size == 2 }
        assertEquals("peer", sent.last().getString("id"))
        assertEquals(canonical, sent.last().getString("msg"))
    }

    @Test fun logoutWhileResolvingCannotSendTheOldMessage() {
        val (entered, release) = blockResolution()
        repository.sendText(share)
        scheduler.runCurrent()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        repository.logout()
        scheduler.runCurrent()
        release.countDown()
        await { publicClient.dispatcher.runningCallsCount() == 0 }
        scheduler.runCurrent()
        assertTrue(sent.isEmpty())
        assertFalse(repository.state.value.loggedIn)
        assertTrue(repository.state.value.messages.isEmpty())
    }

    @Test fun accountChangeWhileResolvingDiscardsItsResult() {
        val (entered, release) = blockResolution()
        repository.sendText(share)
        scheduler.runCurrent()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        set("cacheScope", "different-account")
        release.countDown()
        await { publicClient.dispatcher.runningCallsCount() == 0 }
        scheduler.runCurrent()
        assertTrue(sent.isEmpty())
    }

    private fun blockResolution(): Pair<CountDownLatch, CountDownLatch> {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1).also { releases += it }
        onResolve = { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
        return entered to release
    }
    private fun await(check: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        do {
            scheduler.runCurrent()
            if (check()) return
            Thread.sleep(5)
        } while (System.nanoTime() < deadline)
        fail("Condition not met; state=${repository.state.value}")
    }
    private fun set(name: String, value: Any) = ChatRepository::class.java.getDeclaredField(name).apply { isAccessible = true }.set(repository, value)
    @Suppress("UNCHECKED_CAST") private fun <T> field(name: String): T = ChatRepository::class.java.getDeclaredField(name).apply { isAccessible = true }.get(repository) as T
}
