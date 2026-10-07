package io.github.steamchat.android.data

import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class DouyinVideoResolverTest {
    private val id = "7687575973616905914"
    private val canonical = "https://www.douyin.com/video/$id"
    private val share = "https://www.iesdouyin.com/share/video/$id"
    private val media = "https://v3-web.douyinvod.com/video.mp4?signature=public"

    @Test fun recognizesOnlyVideoAndShortShareLinks() {
        listOf(canonical, "$canonical/?from=share", "http://www.douyin.com/video/$id", share,
            "https://m.douyin.com/share/video/$id/", "https://v.douyin.com/abcDEF/", "https://www.douyin.com/?modal_id=$id")
            .forEach { assertTrue(it, DouyinVideoResolver.supports(it)) }
        listOf("https://www.douyin.com/", "https://www.douyin.com/user/abc", "https://www.douyin.com/note/$id",
            "https://v.douyin.com/", "https://v.douyin.com/a/b", "https://www.douyin.com/video/12",
            "https://evil.test/video/$id", "https://www.douyin.com.evil.test/video/$id", "https://evil-douyin.com/video/$id",
            "https://user@www.douyin.com/video/$id", "https://@www.douyin.com/video/$id", "https://www.douyin.com:444/video/$id",
            "https://www.douyin.com\\@evil.test/video/$id", "$canonical\n", "看看 $canonical")
            .forEach { assertFalse(it, DouyinVideoResolver.supports(it)) }
    }

    @Test fun publicJsonSuppliesExactVideoAndPreservesEscapedTitle() {
        val title = "视频标题 {包含括号} 和 \"引号\" 🎮"
        val result = DouyinVideoResolver.parsePage(fixture(title = title), id)!!
        assertEquals(id, result.id)
        assertEquals(canonical, result.pageUrl)
        assertEquals(media, result.playUrl)
        assertEquals(title, result.title)
        assertEquals("作者", result.author)
        assertEquals(12345, result.durationMs)
    }

    @Test fun browserVisitStartsAtOriginalWebsiteAndKeepsVideoIdentityAcrossItsMobileRedirect() {
        assertEquals(canonical, DouyinVideoResolver.officialBrowserUrl(share))
        assertEquals(canonical, DouyinVideoResolver.officialBrowserUrl("$canonical?tracking=yes"))
        assertEquals("https://v.douyin.com/abc/", DouyinVideoResolver.officialBrowserUrl("http://v.douyin.com/abc/"))
        assertTrue(DouyinVideoResolver.browserPageAllowed(canonical, "https://m.douyin.com/share/video/$id"))
        for (url in listOf("http://m.douyin.com/share/video/$id", "https://www.douyin.com/login",
            "https://www.douyin.com/video/7687575973616905915", "https://www.douyin.com.evil.test/video/$id",
            "https://user@www.douyin.com/video/$id", "https://www.douyin.com:444/video/$id", "file:///sdcard/page.html")) {
            assertFalse(url, DouyinVideoResolver.browserPageAllowed(canonical, url))
        }
    }

    @Test fun browserMetadataIsAcceptedOnlyForTheCurrentOfficialPageAndRequestedVideo() {
        val current = "https://m.douyin.com/share/video/$id"
        val payload = JSONObject().put("pageUrl", current).put("item", item()).toString()
        val value = JSONObject.quote(payload) // evaluateJavascript's JSON-encoded string.
        val video = DouyinVideoResolver.parseBrowserMetadata(value, canonical, current)!!
        assertEquals(id, video.id)
        assertEquals(media, video.playUrl)
        assertEquals("测试视频", video.title)
        assertEquals(id, DouyinVideoResolver.parseBrowserMetadata(value, "https://v.douyin.com/abc/", current)!!.id)
        assertNull(DouyinVideoResolver.parseBrowserMetadata(value, canonical, canonical)) // stale callback from previous document
        assertNull(DouyinVideoResolver.parseBrowserMetadata(value, "https://www.douyin.com/video/7687575973616905915", current))
        assertNull(DouyinVideoResolver.parseBrowserMetadata(JSONObject.quote(JSONObject().put("pageUrl", "https://evil.test/video/$id").put("item", item()).toString()), canonical, current))
        assertNull(DouyinVideoResolver.parseBrowserMetadata(JSONObject.quote(JSONObject().put("pageUrl", current).put("item", item(play = "https://evil.test/video.mp4")).toString()), canonical, current))
        for (raw in listOf("null", "undefined", "\"\"", "[]", "\"broken\"", "x".repeat(128 * 1024 + 1))) {
            assertNull(raw.take(80), DouyinVideoResolver.parseBrowserMetadata(raw, canonical, current))
        }
    }

    @Test fun emptyPublicPageSignalsWebsiteVisitRatherThanDeclaringTheVideoUnavailable() = runBlocking<Unit> {
        OfflineNetwork { response(it, 200, "<html>抱歉出错了，请尝试在抖音内观看</html>") }.use { network ->
            try { network.resolver.resolve(canonical); fail("Expected browser continuation") }
            catch (_: DouyinBrowserRequired) { /* normal website visit can still supply metadata */ }
        }
    }

    @Test fun unavailableWrongVideoAndScriptExpressionsDoNotProducePlaybackUrls() {
        for (page in listOf("抱歉出错了，请尝试在抖音内观看", "window._ROUTER_DATA = {\"loaderData\":{}};",
            fixture(itemId = "7687575973616905915"), fixture(play = ""),
            "window._ROUTER_DATA = JSON.parse('something');", "window._ROUTER_DATA = {", "window._ROUTER_DATA = {invalid};")) {
            assertNull(page, DouyinVideoResolver.parsePage(page, id))
        }
    }

    @Test fun arbitraryMediaHostsAndCredentialsCannotBecomePlayerSources() {
        for (url in listOf("http://v3-web.douyinvod.com/video.mp4", "https://v3-web.douyinvod.com.evil.test/video.mp4",
            "https://evildouyinvod.com/video.mp4", "https://localhost/video.mp4", "https://127.0.0.1/video.mp4",
            "https://user@v3-web.douyinvod.com/video.mp4", "https://@v3-web.douyinvod.com/video.mp4",
            "https://v3-web.douyinvod.com:444/video.mp4", "file:///sdcard/video.mp4", "javascript:alert(1)")) {
            assertNull(url, DouyinVideoResolver.mediaUrl(url))
            assertNull(url, DouyinVideoResolver.parsePage(fixture(play = url), id))
        }
        assertEquals(media, DouyinVideoResolver.mediaUrl(media))
    }

    @Test fun parserBoundsPageSizeAndJsonNesting() {
        assertNull(DouyinVideoResolver.parsePage("x".repeat(DouyinVideoResolver.MAX_PAGE_BYTES + 1), id))
        assertNull(DouyinVideoResolver.parsePage("window._ROUTER_DATA = {\"x\":" + "[".repeat(100) + "0" + "]".repeat(100) + "};", id))
    }

    @Test fun canonicalLinksFetchMobileSharePageWithoutChangingMessageUrl() = runBlocking<Unit> {
        OfflineNetwork { response(it, 200, fixture()) }.use { network ->
            val result = network.resolver.resolve("$canonical?from=share#fragment")
            assertEquals(canonical, result.pageUrl)
            assertEquals(media, result.playUrl)
            assertEquals(listOf(share), network.requests.map { it.url.toString() })
        }
    }

    @Test fun shortLinkRedirectsResolveTheVideoAndNeverCarryCookies() = runBlocking<Unit> {
        OfflineNetwork { chain ->
            if (chain.request().url.host == "v.douyin.com") response(chain, 302, location = "$canonical?tracking=yes")
            else response(chain, 200, fixture())
        }.use { network ->
            assertEquals(id, network.resolver.resolve("http://v.douyin.com/abc/").id)
            assertEquals(listOf("https://v.douyin.com/abc/", share), network.requests.map { it.url.toString() })
            network.requests.forEach {
                assertNull(it.header("Authorization")); assertNull(it.header("Cookie")); assertNull(it.header("Proxy-Authorization"))
                assertEquals(DouyinVideoResolver.USER_AGENT, it.header("User-Agent"))
            }
        }
    }

    @Test fun unsafeRedirectIsRejectedBeforeRequestingItsDestination() = runBlocking<Unit> {
        for (url in listOf("http://127.0.0.1/private", "https://www.douyin.com.evil.test/video/$id",
            "https://@www.douyin.com/video/$id", "https://www.douyin.com/login", "https://www.douyin.com/user/abc")) {
            OfflineNetwork { response(it, 302, location = url) }.use { network ->
                assertFails { network.resolver.resolve("https://v.douyin.com/abc/") }
                assertEquals(1, network.requests.size)
            }
        }
    }

    @Test fun redirectLoopIsBoundedAndSharePageCannotSwitchVideoIdentity() = runBlocking<Unit> {
        OfflineNetwork { response(it, 302, location = "/abc/") }.use { network ->
            assertFails { network.resolver.resolve("https://v.douyin.com/abc/") }
            assertEquals(4, network.requests.size)
        }
        OfflineNetwork { response(it, 302, location = "https://www.iesdouyin.com/share/video/7687575973616905915") }.use { network ->
            assertFails { network.resolver.resolve(canonical) }
            assertEquals(1, network.requests.size)
        }
    }

    @Test fun emptyOversizeAndHttpFailuresSurfaceAsFailure() = runBlocking<Unit> {
        for ((status, body) in listOf(200 to "", 403 to "denied", 429 to "busy", 404 to "missing",
            200 to "x".repeat(DouyinVideoResolver.MAX_PAGE_BYTES + 1))) {
            OfflineNetwork { response(it, status, body) }.use { network -> assertFails { network.resolver.resolve(canonical) } }
        }
    }

    @Test fun cancellingResolutionCancelsTheRunningHttpCall() = runBlocking<Unit> {
        val entered = CountDownLatch(1)
        val unblock = CountDownLatch(1)
        OfflineNetwork { chain ->
            entered.countDown()
            assertTrue(unblock.await(5, TimeUnit.SECONDS))
            response(chain, 200, fixture())
        }.use { network ->
            val job = async { network.resolver.resolve(canonical) }
            // Let async enqueue its request before waiting on the worker's signal.
            kotlinx.coroutines.yield()
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            try {
                job.cancelAndJoin()
                assertTrue(network.client.dispatcher.runningCalls().single().isCanceled())
            } finally { unblock.countDown() }
        }
    }

    @Test fun mediaRedirectsPreserveRangeButNeverCredentialsOrCookies() {
        val requests = mutableListOf<Request>()
        val client = DouyinVideoResolver().mediaClient().newBuilder().addInterceptor { chain ->
            requests += chain.request()
            if (requests.size == 1) response(chain, 302, location = "https://v9-web.douyinvod.com/video.mp4")
            else response(chain, 206, "media range")
        }.build()
        val request = Request.Builder().url(media).header("Range", "bytes=100-200")
            .header("Referer", canonical).header("Authorization", "test-only-secret").header("Cookie", "test=secret").build()
        client.newCall(request).execute().use { assertEquals(206, it.code) }
        assertEquals(2, requests.size)
        requests.forEach {
            assertEquals("bytes=100-200", it.header("Range"))
            assertEquals(canonical, it.header("Referer"))
            assertNull(it.header("Authorization")); assertNull(it.header("Cookie"))
        }
    }

    @Test fun mediaRedirectsRejectExternalHostsAndLoopsBeforeAnotherConnection() {
        for (location in listOf("https://127.0.0.1/private", "http://v9-web.douyinvod.com/video.mp4", media)) {
            var requests = 0
            val client = DouyinVideoResolver().mediaClient().newBuilder().addInterceptor { chain ->
                requests++
                response(chain, 302, location = location)
            }.build()
            try { client.newCall(Request.Builder().url(media).build()).execute().close(); fail("Unsafe redirect must fail") }
            catch (_: IOException) { /* no connection to rejected destination */ }
            assertEquals(if (location == media) 5 else 1, requests)
        }
    }

    private fun fixture(itemId: String = id, play: String = media, title: String = "测试视频"): String {
        val item = item(itemId, play, title)
        val router = JSONObject().put("loaderData", JSONObject().put("video_(id)/page",
            JSONObject().put("videoInfoRes", JSONObject().put("item_list", JSONArray().put(item)))))
        return "<html><script>window._ROUTER_DATA = $router;</script></html>"
    }

    private fun item(itemId: String = id, play: String = media, title: String = "测试视频") = JSONObject()
        .put("aweme_id", itemId).put("desc", title).put("author", JSONObject().put("nickname", "作者"))
        .put("video", JSONObject().put("duration", 12345).put("play_addr", JSONObject().put("url_list", JSONArray().put(play))))

    private suspend fun assertFails(block: suspend () -> Unit) {
        try { block(); fail("Expected resolution failure") }
        catch (e: IllegalArgumentException) { /* rejected input or HTTP response */ }
        catch (e: IllegalStateException) { /* public page unavailable */ }
    }

    private fun response(chain: Interceptor.Chain, code: Int, body: String = "", location: String? = null) =
        Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("offline fixture")
            .body(body.toResponseBody()).apply {
                if (location != null) header("Location", location)
                header("Set-Cookie", "test-cookie=must-not-be-forwarded")
            }.build()

    private class OfflineNetwork(handler: (Interceptor.Chain) -> Response) : Closeable {
        val requests = CopyOnWriteArrayList<Request>()
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            requests += chain.request()
            handler(chain)
        }.build()
        val resolver = DouyinVideoResolver(client)
        override fun close() { client.dispatcher.cancelAll(); client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll() }
    }
}
