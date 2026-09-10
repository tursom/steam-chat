package io.github.steamchat.android

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import io.github.steamchat.android.data.ChatCache
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.lang.reflect.Proxy
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/** Real repository workers, virtual retry clock, intercepted HTTP; never contacts Steam. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, manifest = Config.NONE)
class BackgroundReconnectTest {
    private lateinit var repository: ChatRepository
    private lateinit var scope: CoroutineScope
    private val scopes = mutableListOf<CoroutineScope>()
    private val scheduler = TestCoroutineScheduler()
    private val requests = CopyOnWriteArrayList<String>()
    private var syncCode = 503
    private var configCode = 200
    private var canceled = 0
    private var onSync: () -> Unit = {}
    private var onConfig: () -> Unit = {}
    private var steam = "steam1"
    private val sockets = CopyOnWriteArrayList<Pair<FakeSocket, WebSocketListener>>()
    private val releases = mutableListOf<java.util.concurrent.CountDownLatch>()
    private lateinit var networkCallback: ConnectivityManager.NetworkCallback

    @Before fun setup() {
        val context = RuntimeEnvironment.getApplication()
        File(context.noBackupFilesDir, "session.enc").delete()
        File(context.noBackupFilesDir, "chat.sqlite").delete()
        repository = ChatRepository(context)
        runBlocking { field<CoroutineScope>("scope").coroutineContext[Job]!!.cancelAndJoin() }
        scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(scheduler)).also { scopes += it }
        set("scope", scope)
        set("now", { scheduler.currentTime + 1_000_000L })
        set("base", "https://reconnect.invalid/".toHttpUrl())
        set("cookie", "steam_chat_session=synthetic")
        set("expires", Long.MAX_VALUE)
        set("userId", "1")
        set("foreground", true)
        val account = JSONArray(listOf("https://reconnect.invalid/", "1", "steam1")).toString()
        set("cacheScope", account)
        set("accountSteamId", "steam1")
        field<ChatCache>("cache").ingest(account, JSONArray(), "initial", false, "")
        field<MutableStateFlow<AppState>>("mutable").value = AppState(loggedIn = true, accessAllowed = true,
            backgroundEnabled = false, activeAccountId = "steam1")
        networkCallback = shadowOf(context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).networkCallbacks.single()
        set("client", OkHttpClient.Builder().addInterceptor { chain ->
            val path = chain.request().url.encodedPath
            requests += path
            var code = 200
            val body = when (path) {
                "/api/steam/status" -> """{"accessAllowed":true,"status":"online","activeAccount":{"steamId":"$steam"}}"""
                "/api/messages/sync" -> { onSync(); code = syncCode; """{"steamAccountId":"$steam","items":[],"nextCursor":"next","hasMore":false}""" }
                "/api/config" -> { onConfig(); code = configCode; """{"wsPath":"/ws"}""" }
                "/api/friends" -> "[]"
                "/api/emoticons" -> "{}"
                "/ws" -> { code = 503; "{}" }
                "/message" -> { code = 503; "{}" }
                "/api/auth/logout" -> "{}"
                else -> error("Unexpected network request: $path")
            }
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code)
                .message("synthetic").body(body.toResponseBody("application/json".toMediaType())).build()
        }.build())
    }

    @After fun cleanup() {
        releases.forEach { it.countDown() }
        scopes.forEach { it.cancel() }
        scheduler.runCurrent()
        runBlocking { scopes.forEach { it.coroutineContext[Job]!!.join() } }
        field<OkHttpClient>("client").dispatcher.cancelAll()
        field<OkHttpClient>("client").connectionPool.evictAll()
        field<ChatCache>("cache").close()
    }

    @Test fun syncBackoffDoesNotBlockSocketRetry() {
        start()
        drain()
        assertEquals("WS must be attempted even when sync fails", 1, count("/ws"))
        scheduler.advanceTimeBy(2_000); scheduler.runCurrent(); drain()
        assertTrue("WS retry must not wait 30 seconds for sync", count("/ws") >= 2)
        assertEquals(1, count("/api/messages/sync"))
    }

    @Test fun foregroundReturnInvalidatesIdleSocketAndResetsBothDeadlines() {
        idleSocket()
        set("foreground", false)
        set("httpRetryAt", 1_030_000L); set("reconnectAt", 1_060_000L)
        syncCode = 200
        repository.onForegroundChanged(true)
        scheduler.runCurrent(); drain()
        assertEquals("Old idle socket must be canceled on foreground return", 1, canceled)
        assertTrue(count("/ws") > 0)
        assertTrue("Foreground immediately retries sync", count("/api/messages/sync") >= 1)
    }

    @Test fun defaultNetworkReplacementInvalidatesSocketWithoutWaitingForHttpGate() {
        idleSocket()
        val gate = field<kotlinx.coroutines.sync.Mutex>("gate")
        runBlocking { gate.lock() }
        try {
            networkCallback.onAvailable(org.robolectric.util.ReflectionHelpers.callConstructor(Network::class.java, org.robolectric.util.ReflectionHelpers.ClassParameter.from(Int::class.javaPrimitiveType, 101)))
            scheduler.runCurrent()
            assertEquals("Network replacement cannot wait behind blocking HTTP", 1, canceled)
            assertFalse(repository.state.value.connected)
        } finally { gate.unlock() }
        scheduler.runCurrent(); drain()
    }

    @Test fun configFailureDoesNotPoisonHealthySyncAndIsRateLimited() {
        syncCode = 200; configCode = 503
        start(); drain()
        assertEquals("Config failure belongs to WS retry only", 0L, field<Long>("httpRetryAt"))
        repeat(20) { field<Channel<Unit>>("hints").trySend(Unit); scheduler.runCurrent() }
        drain()
        assertEquals(1, count("/api/config"))
        assertTrue(count("/api/messages/sync") > 1)
    }

    @Test fun failureCallbackAndReconnectProceedWhileRealSyncHttpIsBlocked() {
        fakeTransport()
        syncCode = 200
        start(); drain(); open(sockets.single())
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1).also { releases += it }
        onSync = { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
        field<Job>("worker").cancel(); scheduler.runCurrent()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO).also { scopes += it; set("scope", it) }
        ChatRepository::class.java.getDeclaredMethod("startWorker").apply { isAccessible = true }.invoke(repository)
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        assertTrue(field<kotlinx.coroutines.sync.Mutex>("gate").isLocked)
        val old = sockets.single()
        old.second.onFailure(old.first, java.io.IOException("lost"), null)
        assertFalse("Failure must update UI while HTTP is blocked", repository.state.value.connected)
        scheduler.advanceTimeBy(2_000); scheduler.runCurrent()
        await { sockets.size == 2 }
        // A network restore cancels only the obsolete GET and reconnects without waiting for its completion.
        val read = field<Call>("activeRead")
        networkCallback.onAvailable(network(101))
        assertTrue(read.isCanceled())
        scheduler.runCurrent()
        await { sockets.size == 3 }
        open(sockets.last())
        assertTrue(repository.state.value.connected)
        onSync = {}
        release.countDown()
        await { !field<kotlinx.coroutines.sync.Mutex>("gate").isLocked }
    }

    @Test fun staleOpenFailureAndMessageCannotAffectReplacementSocket() {
        fakeTransport(); start(); drain()
        val old = sockets.single()
        open(old)
        networkCallback.onAvailable(network(101)); scheduler.runCurrent(); drain()
        val replacement = sockets.last()
        assertNotSame(old.first, replacement.first)
        open(replacement); scheduler.runCurrent(); drain()
        val syncs = count("/api/messages/sync")
        old.second.onMessage(old.first, """{"type":"message"}""")
        old.second.onFailure(old.first, java.io.IOException("obsolete unauthorized"), response(old.first.request(), 401))
        open(old)
        scheduler.runCurrent(); drain()
        assertTrue(repository.state.value.loggedIn)
        assertTrue(repository.state.value.connected)
        assertSame(replacement.first, field<WebSocket>("socket"))
        assertEquals(syncs, count("/api/messages/sync"))
    }

    @Test fun hungHandshakeIsCanceledAndRetriedWithinBound() {
        fakeTransport(); start(); drain()
        val first = sockets.single().first
        scheduler.advanceTimeBy(20_000); scheduler.runCurrent(); drain()
        assertTrue(first.canceled)
        assertFalse(repository.state.value.connected)
        scheduler.advanceTimeBy(2_000); scheduler.runCurrent(); drain()
        assertEquals(2, sockets.size)
    }

    @Test fun duplicateNetworkAndForegroundSignalsDoNotCreateStormOrLoseReplacement() {
        fakeTransport(); start(); drain(); open(sockets.single())
        networkCallback.onAvailable(network(101)); scheduler.runCurrent(); drain()
        open(sockets.last())
        repeat(20) { networkCallback.onAvailable(network(101)); repository.onForegroundChanged(true) }
        scheduler.runCurrent(); drain()
        assertEquals(2, sockets.size)
        networkCallback.onAvailable(network(102)); scheduler.runCurrent(); drain()
        repeat(20) { networkCallback.onAvailable(network(103 + it)) }
        networkCallback.onLost(network(101)) // Losing the old default must not cancel the new one.
        scheduler.runCurrent(); drain()
        assertEquals(2, sockets.size)
        scheduler.advanceTimeBy(1_000); scheduler.runCurrent(); drain()
        assertEquals("Flapping signals coalesce, without moving recovery arbitrarily far away", 3, sockets.size)
        open(sockets.last())
        networkCallback.onLost(network(101))
        assertTrue(repository.state.value.connected)
    }

    @Test fun configUnauthorizedEndsSessionAndStopsRetries() {
        configCode = 401
        start(); drain()
        assertFalse(repository.state.value.loggedIn)
        scheduler.advanceTimeBy(60_000); scheduler.runCurrent(); drain()
        assertEquals(1, count("/api/config"))
    }

    @Test fun configForbiddenClearsAccountWithoutLoggingOut() {
        configCode = 403
        start(); drain()
        assertTrue(repository.state.value.loggedIn)
        assertFalse(repository.state.value.accessAllowed)
        assertTrue(repository.state.value.messages.isEmpty())
    }

    @Test fun renewedCookieDoesNotMakeLiveSocketFailureInvisible() {
        fakeTransport(); start(); drain(); open(sockets.single())
        set("cookie", "steam_chat_session=renewed")
        val old = sockets.single()
        old.second.onFailure(old.first, java.io.IOException("offline"), null)
        assertFalse(repository.state.value.connected)
        scheduler.advanceTimeBy(2_000); scheduler.runCurrent(); drain()
        assertEquals(2, sockets.size)
        assertEquals("steam_chat_session=renewed", sockets.last().first.request().header("Cookie"))
    }

    @Test fun recoveryDoesNotAutomaticallyRetryUncertainMessagePost() {
        fakeTransport()
        field<MutableStateFlow<AppState>>("mutable").value = repository.state.value.copy(selectedPeer = "peer1")
        repository.sendText("synthetic test message")
        scheduler.runCurrent()
        assertEquals(1, count("/message"))
        assertTrue(repository.state.value.messages.single().failed)
        networkCallback.onAvailable(network(101)); scheduler.runCurrent(); drain()
        scheduler.advanceTimeBy(60_000); scheduler.runCurrent(); drain()
        assertEquals("Only an explicit manual retry may resend", 1, count("/message"))
    }

    @Test fun configTimeoutCancelsCallAndRetriesWithoutWaitingForSyncBackoff() {
        fakeTransport()
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1).also { releases += it }
        onConfig = { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
        start()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        val call = field<OkHttpClient>("client").dispatcher.runningCalls().single { it.request().url.encodedPath == "/api/config" }
        scheduler.advanceTimeBy(15_000); scheduler.runCurrent()
        assertTrue(call.isCanceled())
        onConfig = {}; release.countDown(); drain()
        scheduler.advanceTimeBy(2_000); scheduler.runCurrent(); drain()
        assertEquals(1, sockets.size)
        assertEquals(1, count("/api/messages/sync"))
    }

    @Test fun accountSwitchRejectsOldSocketCallbacksAndReconnectsForNewScope() {
        fakeTransport(); syncCode = 200
        start(); drain(); open(sockets.single())
        val old = sockets.single()
        steam = "steam2"
        field<Channel<Unit>>("hints").trySend(Unit); scheduler.runCurrent(); drain()
        assertTrue(old.first.canceled)
        assertEquals("steam2", repository.state.value.activeAccountId)
        assertEquals(2, sockets.size)
        open(sockets.last())
        open(old)
        old.second.onFailure(old.first, java.io.IOException("old account"), response(old.first.request(), 403))
        scheduler.runCurrent(); drain()
        assertTrue(repository.state.value.accessAllowed)
        assertTrue(repository.state.value.connected)
        assertEquals("steam2", repository.state.value.activeAccountId)
    }

    @Test fun pausedBackgroundDoesNotReconnectUntilForegroundReturns() {
        fakeTransport(); start(); drain(); open(sockets.single())
        repository.onForegroundChanged(false); scheduler.runCurrent()
        assertTrue(sockets.single().first.canceled)
        networkCallback.onAvailable(network(101))
        scheduler.advanceTimeBy(60_000); scheduler.runCurrent(); drain()
        assertEquals(1, sockets.size)
        assertEquals("后台连接已暂停", repository.state.value.connectionText)
        repository.onForegroundChanged(true); scheduler.runCurrent(); drain()
        assertEquals(2, sockets.size)
    }

    @Test fun logoutCancelsPendingConfigAndRejectsItsLateResult() {
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1).also { releases += it }
        onConfig = { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
        fakeTransport(); start()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        val call = field<OkHttpClient>("client").dispatcher.runningCalls().single { it.request().url.encodedPath == "/api/config" }
        repository.logout(); scheduler.runCurrent()
        assertTrue(call.isCanceled())
        release.countDown(); drain()
        assertFalse(repository.state.value.loggedIn)
        assertTrue(sockets.isEmpty())
        scheduler.advanceTimeBy(60_000); scheduler.runCurrent(); drain()
        assertEquals(1, count("/api/config"))
    }

    private class FakeSocket(private val request: Request) : WebSocket {
        var canceled = false
        override fun request() = request
        override fun queueSize() = 0L
        override fun send(text: String) = true
        override fun send(bytes: okio.ByteString) = true
        override fun close(code: Int, reason: String?) = true
        override fun cancel() { canceled = true }
    }
    private fun fakeTransport() {
        set("socketFactory", WebSocket.Factory { request, listener ->
            FakeSocket(request).also { sockets += it to listener }
        })
    }
    private fun response(request: Request, code: Int) = Response.Builder().request(request)
        .protocol(Protocol.HTTP_1_1).code(code).message("synthetic").build()
    private fun open(pair: Pair<FakeSocket, WebSocketListener>) = pair.second.onOpen(pair.first, response(pair.first.request(), 101))
    private fun network(id: Int): Network = org.robolectric.util.ReflectionHelpers.callConstructor(Network::class.java,
        org.robolectric.util.ReflectionHelpers.ClassParameter.from(Int::class.javaPrimitiveType, id))
    private fun await(condition: () -> Boolean) {
        val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!condition() && System.nanoTime() < until) { scheduler.runCurrent(); Thread.sleep(5) }
        assertTrue("Repository did not reach expected state", condition())
    }

    private fun idleSocket() {
        set("socket", Proxy.newProxyInstance(WebSocket::class.java.classLoader, arrayOf(WebSocket::class.java)) { _, method, _ ->
            when (method.name) { "cancel" -> { canceled++; null }; "toString" -> "idle-socket"; else -> error(method.name) }
        })
        field<MutableStateFlow<AppState>>("mutable").value = repository.state.value.copy(connected = true)
    }
    private fun start() {
        ChatRepository::class.java.getDeclaredMethod("startWorker").apply { isAccessible = true }.invoke(repository)
        scheduler.runCurrent()
    }
    private fun count(path: String) = requests.count { it == path }
    private fun drain() {
        val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        do {
            scheduler.runCurrent()
            if (field<OkHttpClient>("client").dispatcher.runningCallsCount() == 0) {
                scheduler.runCurrent()
                if (field<OkHttpClient>("client").dispatcher.runningCallsCount() == 0) return
            }
            Thread.sleep(5)
        } while (System.nanoTime() < until)
        fail("Intercepted requests did not finish")
    }
    @Suppress("UNCHECKED_CAST") private fun <T> field(name: String): T = ChatRepository::class.java.getDeclaredField(name).apply { isAccessible = true }.get(repository) as T
    private fun set(name: String, value: Any?) { ChatRepository::class.java.getDeclaredField(name).apply { isAccessible = true }.set(repository, value) }
}
