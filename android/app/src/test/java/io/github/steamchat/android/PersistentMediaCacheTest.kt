package io.github.steamchat.android

import android.app.Application
import io.github.steamchat.android.data.ChatCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.async
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.Closeable
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, manifest = Config.NONE)
class PersistentMediaCacheTest {
    private lateinit var server: MockWebServer
    private val repositories = mutableListOf<ChatRepository>()
    private val image = byteArrayOf(1, 2, 3, 4)
    private val source = "https://media.example.test/picture.png"

    @Before fun setup() { server = MockWebServer(); server.start() }
    @After fun cleanup() {
        repositories.forEach(::closeRepository)
        server.shutdown()
    }
    private fun repository(scope: String = "server:user:steam"): ChatRepository {
        val repo = ChatRepository(RuntimeEnvironment.getApplication())
        runBlocking { field<CoroutineScope>(repo, "scope").coroutineContext[Job]!!.cancelAndJoin() }
        set(repo, "base", server.url("/")) // Loopback transport injected only in tests; production login requires HTTPS.
        set(repo, "cookie", "steam_chat_session=synthetic")
        set(repo, "expires", Long.MAX_VALUE)
        set(repo, "cacheScope", scope)
        set(repo, "client", OkHttpClient.Builder().callTimeout(2, TimeUnit.SECONDS).build())
        field<MutableStateFlow<AppState>>(repo, "mutable").value = AppState(loggedIn = true, accessAllowed = true)
        repositories += repo
        return repo
    }
    private fun closeRepository(repo: ChatRepository) {
        // Close handles as process termination would, without clearing on-disk application data.
        ChatRepository::class.java.declaredFields.firstOrNull { it.name == "mediaCache" }?.let {
            it.isAccessible = true
            (it.get(repo) as? Closeable)?.close()
        }
        field<ChatCache>(repo, "cache").close()
        field<OkHttpClient>(repo, "client").dispatcher.cancelAll()
        field<OkHttpClient>(repo, "client").connectionPool.evictAll()
    }
    private fun response(cacheControl: String = "public, max-age=86400") = MockResponse()
        .setHeader("Content-Type", "image/png").setHeader("Cache-Control", cacheControl).setBody(Buffer().write(image))
    private fun bytes(repo: ChatRepository) = runBlocking { repo.imageBytes(source) }
    private fun endSession(repo: ChatRepository) {
        ChatRepository::class.java.getDeclaredMethod("endSession", String::class.java).apply { isAccessible = true }.invoke(repo, "")
    }
    private fun assertNoCredentialsOnDisk() {
        val root = java.io.File(RuntimeEnvironment.getApplication().cacheDir, "media-v1")
        root.walkTopDown().filter { it.isFile }.forEach {
            val data = it.readBytes().toString(Charsets.ISO_8859_1)
            assertFalse("Cookie must not be cached", data.contains("synthetic"))
            assertFalse("Set-Cookie must not be cached", data.contains("response-credential"))
        }
    }
    private fun set(repo: ChatRepository, name: String, value: Any) {
        ChatRepository::class.java.getDeclaredField(name).apply { isAccessible = true }.set(repo, value)
    }
    @Suppress("UNCHECKED_CAST")
    private fun <T> field(repo: ChatRepository, name: String): T =
        ChatRepository::class.java.getDeclaredField(name).apply { isAccessible = true }.get(repo) as T

    @Test fun reopeningRepositoryReusesDiskImageWithoutAnotherDownload() {
        server.enqueue(response()); server.enqueue(response())
        val first = repository()
        assertArrayEquals(image, bytes(first))
        closeRepository(first)
        val reopened = repository()
        assertArrayEquals(image, bytes(reopened))
        assertEquals("Process restart must not download the same fresh image again", 1, server.requestCount)
    }

    @Test fun differentAccountCannotReuseAnotherAccountsImage() {
        server.enqueue(response()); server.enqueue(response())
        val first = repository("server:user:steam-a")
        assertArrayEquals(image, bytes(first))
        closeRepository(first)
        val other = repository("server:user:steam-b")
        assertArrayEquals(image, bytes(other))
        assertEquals(2, server.requestCount)
    }

    @Test fun noStoreResponsesAreNotPersisted() {
        server.enqueue(response("no-store")); server.enqueue(response("no-store"))
        val first = repository()
        assertArrayEquals(image, bytes(first))
        closeRepository(first)
        assertArrayEquals(image, bytes(repository()))
        assertEquals(2, server.requestCount)
    }

    @Test fun logoutClearsImagesBeforeTheSameAccountLogsInAgain() {
        server.enqueue(response()); server.enqueue(response())
        val first = repository()
        assertArrayEquals(image, bytes(first))
        endSession(first)
        assertFalse(java.io.File(RuntimeEnvironment.getApplication().cacheDir, "media-v1").exists())
        assertArrayEquals(image, bytes(repository()))
        assertEquals(2, server.requestCount)
    }

    @Test fun accountSwitchRetainsOnlyTheActivePartition() {
        repeat(3) { server.enqueue(response()) }
        val repo = repository("account-a")
        assertArrayEquals(image, bytes(repo))
        set(repo, "cacheScope", "account-b")
        assertArrayEquals(image, bytes(repo))
        val partitions = java.io.File(RuntimeEnvironment.getApplication().cacheDir, "media-v1").listFiles()!!
        assertEquals(1, partitions.size)
        set(repo, "cacheScope", "account-a")
        assertArrayEquals(image, bytes(repo))
        assertEquals(3, server.requestCount)
    }

    @Test fun temporaryAccessLossClosesHandlesWithoutDestroyingTheRestorablePartition() {
        server.enqueue(response())
        val repo = repository()
        assertArrayEquals(image, bytes(repo))
        ChatRepository::class.java.getDeclaredMethod("hideAccount", String::class.java).apply { isAccessible = true }.invoke(repo, "denied")
        assertNull(bytes(repo))
        set(repo, "cacheScope", "server:user:steam")
        field<MutableStateFlow<AppState>>(repo, "mutable").value = AppState(loggedIn = true, accessAllowed = true)
        assertArrayEquals(image, bytes(repo))
        assertEquals(1, server.requestCount)
    }

    @Test fun cacheExpiryUsesHttpRevalidationAndPersistsTheRefreshedImage() {
        server.enqueue(response("max-age=0").setHeader("ETag", "\"image-v1\""))
        server.enqueue(MockResponse().setResponseCode(304).setHeader("Cache-Control", "public, max-age=86400"))
        val first = repository()
        assertArrayEquals(image, bytes(first))
        assertArrayEquals(image, bytes(first))
        server.takeRequest()
        assertEquals("\"image-v1\"", server.takeRequest().getHeader("If-None-Match"))
        closeRepository(first)
        assertArrayEquals(image, bytes(repository()))
        assertEquals(2, server.requestCount)
    }

    @Test fun cookiesAreNotSerializedIntoCachedHeaders() {
        server.enqueue(response().setHeader("Set-Cookie", "steam_chat_session=response-credential"))
        val first = repository()
        assertArrayEquals(image, bytes(first))
        closeRepository(first)
        assertNoCredentialsOnDisk()
        assertArrayEquals(image, bytes(repository()))
        assertEquals(1, server.requestCount)
    }

    @Test fun credentialVaryResponsesDoNotPersistRequestCookies() {
        repeat(2) { server.enqueue(response().setHeader("Vary", "Cookie").setHeader("Set-Cookie", "session=response-credential")) }
        val first = repository()
        assertArrayEquals(image, bytes(first))
        closeRepository(first)
        assertNoCredentialsOnDisk()
        assertArrayEquals(image, bytes(repository()))
        assertEquals(2, server.requestCount)
    }

    @Test fun conditionalResponsesCannotIntroduceCredentialVaryIntoDiskEntries() {
        server.enqueue(response("max-age=0").setHeader("ETag", "\"image-v1\""))
        server.enqueue(MockResponse().setResponseCode(304).setHeader("Vary", "Cookie")
            .setHeader("Set-Cookie", "session=response-credential"))
        server.enqueue(response())
        val first = repository()
        assertArrayEquals(image, bytes(first))
        assertArrayEquals(image, bytes(first))
        closeRepository(first)
        assertNoCredentialsOnDisk()
        assertArrayEquals(image, bytes(repository()))
        assertEquals(3, server.requestCount)
    }

    @Test fun logoutDuringDownloadCannotReturnOrRecreateAnOldImage() = runBlocking {
        server.enqueue(response().setBodyDelay(1, TimeUnit.SECONDS))
        val repo = repository()
        val loading = async(Dispatchers.IO) { repo.imageBytes(source) }
        assertNotNull(server.takeRequest(2, TimeUnit.SECONDS))
        endSession(repo)
        assertNull(loading.await())
        assertFalse(java.io.File(RuntimeEnvironment.getApplication().cacheDir, "media-v1").exists())
    }

    @Test fun normalizedMediaPathsCannotAccessOtherApiRoutes() {
        server.enqueue(response())
        val repo = repository()
        assertNull(runBlocking { repo.imageBytes("/proxy/sticker/../../api/private") })
        assertEquals(0, server.requestCount)
    }

    @Test fun cachedImagesStillRequireCurrentPermissionAndUnexpiredSession() {
        server.enqueue(response())
        val repo = repository()
        assertArrayEquals(image, bytes(repo))
        field<MutableStateFlow<AppState>>(repo, "mutable").value = AppState(loggedIn = true, accessAllowed = false)
        assertNull(bytes(repo))
        field<MutableStateFlow<AppState>>(repo, "mutable").value = AppState(loggedIn = true, accessAllowed = true)
        set(repo, "expires", 1L)
        assertNull(bytes(repo))
        assertEquals(1, server.requestCount)
    }
}
