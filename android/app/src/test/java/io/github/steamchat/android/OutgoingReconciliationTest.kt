package io.github.steamchat.android

import android.app.Application
import android.net.Uri
import org.robolectric.Shadows.shadowOf
import java.io.ByteArrayInputStream
import io.github.steamchat.android.data.ChatCache
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
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

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, manifest = Config.NONE)
class OutgoingReconciliationTest {
    private lateinit var repository: ChatRepository
    private lateinit var scope: CoroutineScope
    private lateinit var cache: ChatCache
    private val scheduler = TestCoroutineScheduler()
    private val account = "duplicate-test"
    private val image = "https://images.example.test/image.jpg"
    private var ack = item("ack")
    private fun item(event: String, ordinal: Int = 1, text: String = image) = JSONObject()
        .put("syncId", event).put("eventId", event).put("id", "peer").put("echo", true)
        .put("sentAt", "2026-09-10T08:26:00Z").put("ordinal", ordinal).put("message", text).put("type", "image")
    @Before fun setup() {
        repository = ChatRepository(RuntimeEnvironment.getApplication())
        runBlocking { field<CoroutineScope>("scope").coroutineContext[Job]!!.cancelAndJoin() }
        scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(scheduler))
        set("scope", scope)
        cache = field("cache")
        cache.clearAll()
        set("base", "https://duplicate.invalid/".toHttpUrl())
        set("cookie", "steam_chat_session=synthetic")
        set("expires", Long.MAX_VALUE)
        set("cacheScope", account)
        set("accountSteamId", "steam")
        field<MutableStateFlow<AppState>>("mutable").value = AppState(loggedIn = true, accessAllowed = true,
            selectedPeer = "peer", username = "Me")
        set("client", OkHttpClient.Builder().addInterceptor { chain ->
            val body = when (chain.request().url.encodedPath) {
                "/api/steam/status" -> """{"accessAllowed":true,"activeAccount":{"steamId":"steam"}}"""
                "/image" -> JSONObject().put("ok", true).put("item", ack).toString()
                else -> error("Unexpected request")
            }
            Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1).code(200)
                .message("synthetic").body(body.toResponseBody("application/json".toMediaType())).build()
        }.build())
    }
    @After fun cleanup() { scope.cancel(); cache.close() }
    private fun set(name: String, value: Any) = ChatRepository::class.java.getDeclaredField(name).apply { isAccessible = true }.set(repository, value)
    @Suppress("UNCHECKED_CAST") private fun <T> field(name: String): T = ChatRepository::class.java.getDeclaredField(name).apply { isAccessible = true }.get(repository) as T
    private fun publish() = ChatRepository::class.java.getDeclaredMethod("publishCache").apply { isAccessible = true }.invoke(repository)
    private fun ingest(vararg items: JSONObject) { cache.ingest(account, JSONArray(items.toList()), "cursor", false, "peer"); publish() }
    private fun send() {
        val uri = Uri.parse("content://test/image")
        shadowOf(RuntimeEnvironment.getApplication().contentResolver).registerInputStream(uri, ByteArrayInputStream(byteArrayOf(1, 2, 3)))
        repository.sendImage(uri)
        scheduler.runCurrent()
    }

    @Test fun discardedSemanticReimportStillAcknowledgesLocalSend() {
        send()
        assertEquals(1, repository.state.value.messages.size)
        ingest(item("history"), ack)
        assertEquals(1, cache.messages(account, "peer").size)
        assertEquals("Local acknowledged image must disappear", 1, repository.state.value.messages.size)
        assertTrue(cache.containsEvent(account, "ack"))
    }
    @Test fun acknowledgementAfterCachedSemanticMatchRemovesLocalCopyImmediately() {
        ingest(item("history"))
        send()
        assertEquals(1, repository.state.value.messages.size)
    }
    @Test fun exactEventAcknowledgementAfterSyncRemovesLocalCopy() {
        ingest(ack)
        send()
        assertEquals(1, repository.state.value.messages.size)
    }
    @Test fun independentIdenticalImagesWithDifferentOrdinalsRemainSeparate() {
        ingest(item("first"))
        ack = item("second", ordinal = 2)
        send()
        assertEquals(2, repository.state.value.messages.size)
        ingest(ack)
        assertEquals(2, repository.state.value.messages.size)
        assertTrue(repository.state.value.messages.none { it.key.startsWith("local:") })
    }
    @Test fun partialAcknowledgementDoesNotMergeByImageContent() {
        ingest(item("history"))
        ack = JSONObject().put("eventId", "new-event").put("message", image)
        send()
        assertEquals(2, repository.state.value.messages.size)
    }
    @Test fun independentImagesWithDifferentTimestampsRemainSeparate() {
        ingest(item("first"))
        ack = item("second").put("sentAt", "2026-09-10T08:26:01Z")
        send()
        assertEquals(2, repository.state.value.messages.size)
        ingest(ack)
        assertEquals(2, repository.state.value.messages.size)
    }
    @Test fun legacyMarkupAndUrlWithoutSharedIdentityRemainSeparate() {
        ingest(item("legacy", text = "[img]$image[/img]"))
        send()
        ingest(ack)
        assertEquals(2, repository.state.value.messages.size)
    }
}
