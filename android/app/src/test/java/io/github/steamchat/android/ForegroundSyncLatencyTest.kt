package io.github.steamchat.android

import android.app.Application
import io.github.steamchat.android.data.ChatCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.WebSocket
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.lang.reflect.Proxy
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Timing repros: actual worker/catchUp/cache, synthetic HTTP only, no Steam login or sends. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, manifest = Config.NONE)
class ForegroundSyncLatencyTest {
    private lateinit var repository: ChatRepository
    private lateinit var scope: CoroutineScope
    private val scheduler = TestCoroutineScheduler()
    private var syncCalls = 0
    private var pendingMessage = false
    @Volatile private var friendsFail = false
    @Volatile private var friendsCode = 200
    private var syncFail = false
    private var syncDenied = false
    private var steam = "steam1"
    private var onFriends: () -> Unit = {}
    private val requests = CopyOnWriteArrayList<String>()
    private val releases = mutableListOf<CountDownLatch>()

    @Before fun setup() {
        val context = RuntimeEnvironment.getApplication()
        File(context.noBackupFilesDir, "session.enc").delete()
        File(context.noBackupFilesDir, "chat.sqlite").delete()
        repository = ChatRepository(context)
        // Drain/cancel initialization before replacing the private execution dependencies.
        val originalScope = field<CoroutineScope>("scope")
        runBlocking { originalScope.coroutineContext[Job]!!.cancelAndJoin() }
        scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(scheduler))
        setField("scope", scope)
        setField("now", { scheduler.currentTime + 1_000_000L })
        setField("base", "https://timing.invalid/".toHttpUrl())
        setField("cookie", "steam_chat_session=synthetic")
        setField("expires", Long.MAX_VALUE)
        setField("userId", "1")
        setField("foreground", true)
        val accountScope = JSONArray(listOf("https://timing.invalid/", "1", "steam1")).toString()
        setField("cacheScope", accountScope)
        setField("accountSteamId", "steam1")
        field<ChatCache>("cache").ingest(accountScope, JSONArray(), "initial", false, "peer1")
        field<MutableStateFlow<AppState>>("mutable").value = AppState(
            loggedIn = true, accessAllowed = true, backgroundEnabled = false,
            selectedPeer = "peer1", activeAccountId = "steam1"
        )
        // Keep connectSocket out of this HTTP sync repro; hints use its actual channel.
        setField("socket", Proxy.newProxyInstance(WebSocket::class.java.classLoader, arrayOf(WebSocket::class.java)) { _, method, _ ->
            when (method.name) { "cancel" -> null; "toString" -> "synthetic-socket"; else -> error("Unexpected socket call: ${method.name}") }
        })
        setField("client", OkHttpClient.Builder().addInterceptor { chain ->
            val path = chain.request().url.encodedPath
            requests += path
            var code = 200
            val body = when (path) {
                "/api/steam/status" -> """{"accessAllowed":true,"status":"online","activeAccount":{"steamId":"$steam"}}"""
                "/api/messages/sync" -> {
                    syncCalls++
                    if (syncFail) code = 503
                    if (syncDenied) code = 403
                    val items = JSONArray()
                    if (pendingMessage) items.put(JSONObject()
                        .put("syncId", "new").put("eventId", "new").put("id", "peer1")
                        .put("name", "Friend").put("message", "foreground message")
                        .put("sentAt", "2026-09-08T12:00:00Z").put("ordinal", 1).put("echo", false))
                    JSONObject().put("steamAccountId", steam).put("items", items)
                        .put("nextCursor", "cursor-$syncCalls").put("hasMore", false).toString()
                }
                "/api/friends" -> { code = if (friendsFail) 503 else friendsCode; onFriends(); """[{"id":"peer1","name":"Metadata friend"}]""" }
                "/api/emoticons" -> """{"emoticons":[],"stickers":[]}"""
                "/api/config" -> """{"wsPath":"/ws"}"""
                "/ws" -> { code = 503; "{}" }
                "/api/auth/logout" -> "{}"
                else -> error("Unexpected request: $path")
            }
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .apply {
                    if (path in listOf("/api/friends", "/api/emoticons"))
                        header("Set-Cookie", "steam_chat_session=metadata-must-not-rotate; Path=/; Secure; Max-Age=3600")
                }
                .code(code).message("synthetic").body(body.toResponseBody("application/json".toMediaType())).build()
        }.build())
    }

    @After fun cleanup() {
        releases.forEach { it.countDown() }
        scope.cancel()
        scheduler.runCurrent()
        field<ChatCache>("cache").close()
        field<OkHttpClient>("client").dispatcher.cancelAll()
        field<OkHttpClient>("client").connectionPool.evictAll()
    }

    @Test fun foregroundHintPublishesMessageWithoutMandatoryOneSecondSleep() {
        startWorker()
        pendingMessage = true
        hint()
        scheduler.runCurrent()
        assertEquals("A foreground sync hint should not impose a full second of latency", listOf("new"), repository.state.value.messages.map { it.key })
    }

    @Test fun friendsFailureMustNotDelayForegroundMessageSync() {
        friendsFail = true
        startWorker()
        assertEquals(1, syncCalls)
        awaitMetadata()
        assertEquals("Optional failures do not set sync retry", 0L, field<Long>("httpRetryAt"))
        friendsFail = false
        pendingMessage = true
        hint()
        scheduler.runCurrent()
        scheduler.advanceTimeBy(1_000)
        scheduler.runCurrent()
        assertEquals("Healthy message sync must not inherit a friends-only 503 backoff", listOf("new"), repository.state.value.messages.map { it.key })
    }

    @Test fun emptyMediaAndFailedFriendsAreThrottledIndependently() {
        friendsFail = true
        startWorker()
        awaitMetadata()
        repeat(5) { hint(); scheduler.runCurrent() }
        awaitMetadata()
        assertEquals(6, syncCalls)
        assertEquals(1, requests.count { it == "/api/friends" })
        assertEquals(1, requests.count { it == "/api/emoticons" })
        scheduler.advanceTimeBy(30_000)
        scheduler.runCurrent()
        awaitMetadata()
        assertEquals(2, requests.count { it == "/api/friends" })
        assertEquals(1, requests.count { it == "/api/emoticons" })
    }

    @Test fun deniedSyncHidesAccountAndRetriesWithoutBusyLooping() {
        syncDenied = true
        startWorker()
        assertFalse(repository.state.value.accessAllowed)
        repeat(5) { hint(); scheduler.runCurrent() }
        scheduler.advanceTimeBy(10)
        scheduler.runCurrent()
        assertEquals("Permission denial must not spin requests", 1, syncCalls)
        syncDenied = false
        scheduler.advanceTimeBy(29_990)
        scheduler.runCurrent()
        assertEquals(2, syncCalls)
        assertTrue(repository.state.value.accessAllowed)
    }

    @Test fun genuineSyncFailureUsesBoundedRetryAndSuccessClearsDeadline() {
        syncFail = true
        startWorker()
        repeat(5) { hint(); scheduler.runCurrent() }
        scheduler.advanceTimeBy(29_999)
        scheduler.runCurrent()
        assertEquals(1, syncCalls)
        syncFail = false
        pendingMessage = true
        scheduler.advanceTimeBy(1)
        scheduler.runCurrent()
        assertEquals(2, syncCalls)
        assertEquals(0L, field<Long>("httpRetryAt"))
        assertEquals(listOf("new"), repository.state.value.messages.map { it.key })
        hint(); scheduler.runCurrent()
        assertEquals(3, syncCalls)
    }

    @Test fun blockedMetadataDoesNotHoldGateOrDelayMessagesAndReconnect() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1).also { releases += it }
        onFriends = { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
        startWorker()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        assertFalse(field<Mutex>("gate").isLocked)
        repository.selectConversation("peer1", "Friend")
        pendingMessage = true
        setField("socket", null)
        hint(); scheduler.runCurrent()
        assertEquals(listOf("new"), repository.state.value.messages.map { it.key })
        assertTrue(requests.contains("/api/config"))
        release.countDown()
        awaitMetadata()
    }

    @Test fun accountSwitchCancelsOldMetadataAndCannotPublishItsResult() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1).also { releases += it }
        onFriends = { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
        startWorker()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        val oldCall = field<OkHttpClient>("client").dispatcher.runningCalls().first { it.request().url.encodedPath == "/api/friends" }
        steam = "steam2"
        friendsCode = 503
        hint(); scheduler.runCurrent()
        assertTrue(oldCall.isCanceled())
        assertEquals("steam2", repository.state.value.activeAccountId)
        release.countDown()
        awaitMetadata()
        assertTrue(repository.state.value.friends.isEmpty())
        assertTrue(repository.state.value.loggedIn)
    }

    @Test fun logoutCancelsBlockedMetadata() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1).also { releases += it }
        onFriends = { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
        startWorker()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        val call = field<OkHttpClient>("client").dispatcher.runningCalls().first { it.request().url.encodedPath == "/api/friends" }
        repository.logout()
        scheduler.runCurrent()
        assertTrue(call.isCanceled())
        release.countDown()
        awaitMetadata()
        assertFalse(repository.state.value.loggedIn)
        assertTrue(repository.state.value.friends.isEmpty())
    }

    @Test fun staleCookieUnauthorizedMetadataCannotEndRenewedSession() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1).also { releases += it }
        onFriends = { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
        friendsCode = 401
        startWorker()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        setField("cookie", "steam_chat_session=renewed")
        release.countDown()
        awaitMetadata()
        assertTrue(repository.state.value.loggedIn)
        assertEquals("steam_chat_session=renewed", field<String>("cookie"))
    }

    @Test fun currentMetadataUnauthorizedEndsSession() {
        friendsCode = 401
        startWorker()
        awaitMetadata()
        assertFalse(repository.state.value.loggedIn)
    }

    @Test fun metadataCannotRotateCookieOrPersistCredentials() {
        startWorker()
        awaitMetadata()
        assertEquals("Metadata friend", repository.state.value.friends.single().name)
        assertEquals("steam_chat_session=synthetic", field<String>("cookie"))
        assertFalse(File(RuntimeEnvironment.getApplication().noBackupFilesDir, "session.enc").exists())
    }

    @Test fun shortenedRetryDeadlineRunsBeforeNextPeriodicSync() {
        startWorker()
        awaitMetadata()
        // Model the deadline shortened by onAvailable after a config/action error.
        setField("httpRetryAt", scheduler.currentTime + 1_001_000L)
        hint(); scheduler.runCurrent()
        assertEquals(1, syncCalls)
        scheduler.advanceTimeBy(1_000)
        scheduler.runCurrent()
        assertEquals(2, syncCalls)
        assertEquals(0L, field<Long>("httpRetryAt"))
        scheduler.advanceTimeBy(1_000)
        scheduler.runCurrent()
        assertEquals("No polling after recovery", 2, syncCalls)
    }

    @Test fun repeatedSyncErrorsRemainBoundedDespiteHints() {
        syncFail = true
        startWorker()
        repeat(3) { round ->
            repeat(10) { hint(); scheduler.runCurrent() }
            assertEquals(round + 1, syncCalls)
            scheduler.advanceTimeBy(30_000)
            scheduler.runCurrent()
            assertEquals(round + 2, syncCalls)
        }
    }

    @Test fun socketFailureWakesSchedulerForReconnectBeforePeriodicSync() {
        startWorker()
        awaitMetadata()
        setField("socket", null)
        hint(); scheduler.runCurrent()
        awaitMetadata()
        assertEquals(1, requests.count { it == "/api/config" })
        val retry = field<Long>("reconnectAt") - (scheduler.currentTime + 1_000_000L)
        assertTrue(retry in 1..2000)
        scheduler.advanceTimeBy(retry)
        scheduler.runCurrent()
        assertEquals(2, requests.count { it == "/api/config" })
        awaitMetadata()
    }

    @Test fun currentMetadataForbiddenHidesAccountButPreservesLogin() {
        friendsCode = 403
        startWorker()
        awaitMetadata()
        assertTrue(repository.state.value.loggedIn)
        assertFalse(repository.state.value.accessAllowed)
        assertTrue(repository.state.value.messages.isEmpty())
    }

    private fun awaitMetadata() {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        do {
            scheduler.runCurrent()
            if (field<OkHttpClient>("client").dispatcher.runningCallsCount() == 0) {
                scheduler.runCurrent()
                return
            }
            Thread.sleep(5)
        } while (System.nanoTime() < deadline)
        fail("Synthetic HTTP did not finish")
    }

    private fun startWorker() {
        ChatRepository::class.java.getDeclaredMethod("startWorker").apply { isAccessible = true }.invoke(repository)
        scheduler.runCurrent()
        assertEquals(1, syncCalls)
    }
    private fun hint() { assertTrue(field<Channel<Unit>>("hints").trySend(Unit).isSuccess) }
    @Suppress("UNCHECKED_CAST")
    private fun <T> field(name: String): T = ChatRepository::class.java.getDeclaredField(name).apply { isAccessible = true }.get(repository) as T
    private fun setField(name: String, value: Any?) { ChatRepository::class.java.getDeclaredField(name).apply { isAccessible = true }.set(repository, value) }
}
