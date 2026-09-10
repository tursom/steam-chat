package io.github.steamchat.android

import android.app.Application
import io.github.steamchat.android.data.ChatCache
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import okhttp3.OkHttpClient
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Response
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

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, manifest = Config.NONE)
class StickerSendTest {
    private lateinit var repository: ChatRepository
    private lateinit var scope: CoroutineScope
    private val scheduler = TestCoroutineScheduler()
    private val sent = mutableListOf<JSONObject>()
    private var failSend = false
    @Before fun setup() {
        repository = ChatRepository(RuntimeEnvironment.getApplication())
        runBlocking { field<CoroutineScope>("scope").coroutineContext[Job]!!.cancelAndJoin() }
        scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(scheduler))
        set("scope", scope)
        set("base", "https://sticker.invalid/".toHttpUrl())
        set("cookie", "steam_chat_session=synthetic")
        set("expires", Long.MAX_VALUE)
        set("cacheScope", "test-sticker-scope")
        set("accountSteamId", "steam")
        field<MutableStateFlow<AppState>>("mutable").value = AppState(loggedIn = true, accessAllowed = true,
            connected = true, steamOnline = true, selectedPeer = "peer", username = "Me")
        set("client", OkHttpClient.Builder().addInterceptor { chain ->
            val path = chain.request().url.encodedPath
            val body = when (path) {
                "/api/steam/status" -> """{"accessAllowed":true,"activeAccount":{"steamId":"steam"}}"""
                "/message" -> {
                    val buffer = okio.Buffer()
                    chain.request().body!!.writeTo(buffer)
                    val request = JSONObject(buffer.readUtf8())
                    sent += request
                    val text = request.getString("msg")
                    val canonical = if (text.startsWith("/sticker ")) "[sticker type=\"${text.removePrefix("/sticker ")}\" limit=\"0\"][/sticker]" else text
                    JSONObject().put("ok", true).put("item", JSONObject().put("eventId", "event-${sent.size}").put("message", canonical)).toString()
                }
                else -> error("Unexpected request $path")
            }
            Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1)
                .code(if (path == "/message" && failSend) 503 else 200).message("synthetic")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }.build())
    }
    @After fun cleanup() { scope.cancel(); field<ChatCache>("cache").close(); field<OkHttpClient>("client").dispatcher.cancelAll() }
    private fun set(name: String, value: Any) = ChatRepository::class.java.getDeclaredField(name).apply { isAccessible = true }.set(repository, value)
    @Suppress("UNCHECKED_CAST") private fun <T> field(name: String): T = ChatRepository::class.java.getDeclaredField(name).apply { isAccessible = true }.get(repository) as T
    private fun sendSticker(name: String) {
        repository.sendSticker(name)
        scheduler.runCurrent()
    }

    @Test fun stickerNamesWithSpacesAndPunctuationUseCommandsAndCanonicalReplies() {
        for (name in listOf("Cat Cam talking", "Rumi : Why...?")) {
            sendSticker(name)
            assertEquals("/sticker $name", sent.last().getString("msg"))
            assertEquals("steam", sent.last().getString("steamAccountId"))
            assertEquals("[sticker type=\"$name\" limit=\"0\"][/sticker]", repository.state.value.messages.last().text)
        }
    }

    @Test fun retryPreservesWireCommandRatherThanSendingPreviewMarkup() {
        failSend = true
        sendSticker("Cat Cam talking")
        val pending = repository.state.value.messages.single()
        assertTrue(pending.failed)
        failSend = false
        repository.retryMessage(pending.key)
        scheduler.runCurrent()
        assertEquals(listOf("/sticker Cat Cam talking", "/sticker Cat Cam talking"), sent.map { it.getString("msg") })
    }

    @Test fun ordinaryTextIsNotReinterpretedAsStickerCommands() {
        val text = "😀 [sticker type=\"Cat Cam talking\" limit=\"0\"][/sticker]"
        repository.sendText(text)
        scheduler.runCurrent()
        assertEquals(text, sent.single().getString("msg"))
    }

    @Test fun invalidNamesDoNotIssueNetworkRequests() {
        for (name in listOf("", "bad\n/sticker other", "bad\"name", "bad[name]", "bad\\name")) sendSticker(name)
        assertTrue(sent.isEmpty())
    }
}
