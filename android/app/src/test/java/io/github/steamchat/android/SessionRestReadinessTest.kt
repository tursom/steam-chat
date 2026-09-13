package io.github.steamchat.android

import android.app.Application
import io.github.steamchat.android.data.ChatCache
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.security.KeyStore
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.*

/** Real loopback TLS requests; no external server, credentials or Steam side effects. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, manifest = Config.NONE)
class SessionRestReadinessTest {
    private val server = MockWebServer()
    private val release = CountDownLatch(1)
    private val entered = CountDownLatch(1)
    private var repository: ChatRepository? = null
    @Volatile private var authCode = 200
    @Volatile private var delayAuth = false
    @Volatile private var steam = "account1"
    @Volatile private var steamStatus = "online"
    private val posts = java.util.concurrent.CopyOnWriteArrayList<RecordedRequest>()
    private val paths = java.util.concurrent.CopyOnWriteArrayList<String>()

    private fun start(expired: Boolean = false, seedPrivateCache: Boolean = false): ChatRepository {
        val store = KeyStore.getInstance("PKCS12").apply {
            load(SessionRestReadinessTest::class.java.getResourceAsStream("/localhost-test.p12")!!, "test-only".toCharArray())
        }
        val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, "test-only".toCharArray()) }
        val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
        val ssl = SSLContext.getInstance("TLS").apply { init(keys.keyManagers, trust.trustManagers, null) }
        server.useHttps(ssl.socketFactory, false)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                paths += path
                if (request.method == "POST") posts += request
                val body = when (path) {
                    "/api/auth/me" -> {
                        entered.countDown()
                        if (delayAuth) release.await(5, TimeUnit.SECONDS)
                        return MockResponse().setResponseCode(authCode).setBody("""{"user":{"id":1,"username":"test"}}""")
                    }
                    "/api/steam/status" -> """{"accessAllowed":true,"status":"$steamStatus","activeAccount":{"steamId":"$steam"}}"""
                    "/api/messages/sync" -> """{"steamAccountId":"$steam","items":[{"syncId":"event1","eventId":"event1","id":"peer","name":"Friend","message":"REST catchup","sentAt":"2026-09-08T12:00:00Z","ordinal":1,"echo":false}],"nextCursor":"c1","hasMore":false}"""
                    "/api/config" -> """{"wsPath":"/ws"}"""
                    "/ws" -> return MockResponse().setResponseCode(503)
                    "/api/friends" -> "[]"
                    "/api/emoticons" -> "{}"
                    "/message", "/image" -> """{"ok":true}"""
                    "/api/auth/logout" -> "{}"
                    else -> return MockResponse().setResponseCode(404)
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        val client = OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory, trust.trustManagers[0] as X509TrustManager)
            .callTimeout(2, TimeUnit.SECONDS).retryOnConnectionFailure(false).build()
        if (seedPrivateCache) {
            val cache = ChatCache(RuntimeEnvironment.getApplication())
            val scope = org.json.JSONArray(listOf(server.url("/").newBuilder().host("localhost").build().toString(), "1", "account1")).toString()
            cache.ingest(scope, org.json.JSONArray("""[{"syncId":"private","eventId":"private","id":"peer","message":"private cached text","sentAt":"2026-09-08T11:00:00Z","ordinal":1,"echo":false}]"""), "private-cursor", false, "")
            cache.close()
        }
        return ChatRepository(RuntimeEnvironment.getApplication(), sessionLoader = {
            JSONObject().put("server", server.url("/").newBuilder().host("localhost").build().toString()).put("cookie", "steam_chat_session=test")
                .put("expires", if (expired) 1L else Long.MAX_VALUE)
        }, httpClient = client).also { repository = it }
    }

    private fun await(check: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
        while (!check() && System.nanoTime() < deadline) Thread.sleep(10)
        assertTrue("Condition not met; state=${repository?.state?.value}", check())
    }

    @After fun close() {
        release.countDown()
        repository?.let { repo ->
            val field = ChatRepository::class.java.getDeclaredField("scope").apply { isAccessible = true }
            runBlocking { (field.get(repo) as CoroutineScope).coroutineContext[Job]!!.cancelAndJoin() }
            (ChatRepository::class.java.getDeclaredField("cache").apply { isAccessible = true }.get(repo) as ChatCache).close()
        }
        server.shutdown()
    }

    @Test fun delayedSavedAuthUsesRestorationWithoutPrivateCache() {
        delayAuth = true
        val repo = start(seedPrivateCache = true)
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        assertEquals(SessionRestoration.LOADING, repo.state.value.restoration)
        assertFalse(repo.state.value.loggedIn)
        assertTrue(repo.state.value.conversations.isEmpty())
        release.countDown()
        await { repo.state.value.accessAllowed }
    }

    @Test fun offlineRestoreOffersRetryAndRecoversThroughRest() {
        authCode = 503
        val repo = start(seedPrivateCache = true)
        await { repo.state.value.error.isNotEmpty() }
        assertEquals(SessionRestoration.RETRY, repo.state.value.restoration)
        assertFalse(repo.state.value.loggedIn)
        assertTrue(repo.state.value.conversations.isEmpty())
        authCode = 200
        repo.refresh()
        await { repo.state.value.conversations.isNotEmpty() }
        assertFalse(repo.state.value.connected)
    }

    @Test fun rejectedAuthRetainsServerButExposesNoAccount() {
        authCode = 401
        val repo = start(seedPrivateCache = true)
        await { paths.contains("/api/auth/me") && repo.state.value.error.isNotEmpty() }
        assertFalse(repo.state.value.loggedIn)
        assertTrue(repo.state.value.conversations.isEmpty())
        assertEquals(server.url("/").newBuilder().host("localhost").build().toString(), repo.state.value.server)
        assertFalse(paths.contains("/api/messages/sync"))
    }

    @Test fun forbiddenAuthEndsRestorationInsteadOfRetryingCredentials() {
        authCode = 403
        val repo = start()
        await { repo.state.value.error.isNotEmpty() }
        assertEquals(SessionRestoration.NONE, repo.state.value.restoration)
        assertFalse(repo.state.value.loggedIn)
        assertTrue(repo.state.value.activeAccountId.isEmpty())
        assertEquals("", ChatRepository::class.java.getDeclaredField("cookie").apply { isAccessible = true }.get(repo))
    }

    @Test fun expiredSessionRetainsConfiguredServer() {
        val repo = start(expired = true)
        await { repo.state.value.error.isNotEmpty() }
        assertEquals(server.url("/").newBuilder().host("localhost").build().toString(), repo.state.value.server)
        assertFalse(paths.contains("/api/auth/me"))
    }

    @Test fun restCatchupAndRealTextAndStickerPostsWorkWithRejectedWebsocket() {
        val repo = start()
        await { repo.state.value.conversations.isNotEmpty() && paths.contains("/ws") }
        assertFalse(repo.state.value.connected)
        repo.selectConversation("peer", "Friend")
        await { repo.state.value.messages.isNotEmpty() }
        repo.sendText("hello via REST")
        await { posts.any { it.path == "/message" } }
        val message = posts.first { it.path == "/message" }
        assertEquals("steam_chat_session=test", message.getHeader("Cookie"))
        val payload = JSONObject(message.body.readUtf8())
        assertEquals("hello via REST", payload.getString("msg"))
        assertEquals("peer", payload.getString("id"))
        assertEquals("account1", payload.getString("steamAccountId"))
        repo.sendSticker("example")
        await { posts.count { it.path == "/message" } == 2 }
        assertEquals("/sticker example", JSONObject(posts.last().body.readUtf8()).getString("msg"))
    }

    @Test fun stalledAuthTimesOutIntoActionableRetry() {
        delayAuth = true
        val repo = start(seedPrivateCache = true)
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        await { repo.state.value.restoration == SessionRestoration.RETRY && repo.state.value.error.isNotEmpty() }
        assertFalse(repo.state.value.loggedIn)
        assertTrue(repo.state.value.conversations.isEmpty())
    }

    @Test fun validatedDifferentAccountDoesNotExposeCachedPreviousAccount() {
        steam = "account2"
        val repo = start(seedPrivateCache = true)
        await { repo.state.value.conversations.isNotEmpty() }
        repo.selectConversation("peer", "Friend")
        await { repo.state.value.messages.isNotEmpty() }
        assertEquals("account2", repo.state.value.activeAccountId)
        assertTrue(repo.state.value.messages.none { it.text == "private cached text" })
    }

    @Test fun imagePostWorksWithoutWebsocket() {
        val repo = start()
        await { repo.state.value.accessAllowed }
        repo.selectConversation("peer", "Friend")
        await { repo.state.value.selectedPeer == "peer" }
        val uri = android.net.Uri.parse("content://test/rest-image")
        org.robolectric.Shadows.shadowOf(RuntimeEnvironment.getApplication().contentResolver)
            .registerInputStream(uri, java.io.ByteArrayInputStream(byteArrayOf(1, 2, 3)))
        repo.sendImage(uri)
        await { posts.any { it.path == "/image" } }
        val body = JSONObject(posts.first { it.path == "/image" }.body.readUtf8())
        assertEquals("AQID", body.getString("img"))
        assertEquals("account1", body.getString("steamAccountId"))
        assertEquals("peer", body.getString("id"))
        assertFalse(repo.state.value.connected)
    }

    @Test fun steamGoingOfflineBeforePostPreventsSending() {
        val repo = start()
        await { repo.state.value.canSend }
        repo.selectConversation("peer", "Friend")
        await { repo.state.value.selectedPeer == "peer" }
        steamStatus = "offline"
        repo.sendText("must not send offline")
        await { !repo.state.value.steamOnline }
        assertTrue(posts.isEmpty())
        assertFalse(repo.state.value.canSend)
    }

    @Test fun logoutKeepsConfigurationOnNextLaunchWithoutRestoringAccount() {
        val repo = start()
        await { repo.state.value.accessAllowed }
        val configured = repo.state.value.server
        repo.logout()
        await { posts.any { it.path == "/api/auth/logout" } }
        val next = ChatRepository(RuntimeEnvironment.getApplication(), sessionLoader = { null })
        try {
            await { next.state.value.restoration == SessionRestoration.NONE }
            assertEquals(configured, next.state.value.server)
            assertFalse(next.state.value.loggedIn)
            assertTrue(next.state.value.activeAccountId.isEmpty())
            assertTrue(next.state.value.conversations.isEmpty())
        } finally {
            runBlocking { (ChatRepository::class.java.getDeclaredField("scope").apply { isAccessible = true }.get(next) as CoroutineScope).coroutineContext[Job]!!.cancelAndJoin() }
        }
    }

    @Test fun changingServerDuringDelayedAuthCannotRestoreOldSession() {
        delayAuth = true
        val repo = start()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        repo.changeServer()
        release.countDown()
        await { posts.any { it.path == "/api/auth/logout" } }
        assertEquals("", repo.state.value.server)
        assertEquals(SessionRestoration.NONE, repo.state.value.restoration)
        assertFalse(repo.state.value.loggedIn)
        assertTrue(repo.state.value.conversations.isEmpty())
    }

    @Test fun changedAccountCannotReceiveQueuedMessageForOldAccount() {
        val repo = start()
        await { repo.state.value.accessAllowed }
        repo.selectConversation("peer", "Friend")
        await { repo.state.value.selectedPeer == "peer" }
        steam = "account2"
        repo.sendText("must not cross accounts")
        await { repo.state.value.error.isNotEmpty() }
        assertTrue(posts.isEmpty())
        assertTrue(repo.state.value.messages.isEmpty())
        assertTrue(repo.state.value.selectedPeer.isEmpty())
    }
}
