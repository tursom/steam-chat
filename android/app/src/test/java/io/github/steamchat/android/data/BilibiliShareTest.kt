package io.github.steamchat.android.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import okhttp3.Call
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class BilibiliShareTest {
    @Test fun extractsCompleteShareAndStandaloneVideoLinks() {
        val cases = listOf(
            SHARE to SHORT_URL,
            " \n$SHARE\n " to SHORT_URL,
            "【标题-哔哩哔哩】\n$SHORT_URL" to SHORT_URL,
            "【多行标题\n作者-哔哩哔哩】\n$SHORT_URL" to SHORT_URL,
            "【【联动MV】标题-哔哩哔哩】 $SHORT_URL" to SHORT_URL,
            SHORT_URL to SHORT_URL,
            "https://b23.tv/iULlJGW/" to "https://b23.tv/iULlJGW/",
            "https://www.bilibili.com/video/BV17x411w7KC" to "https://www.bilibili.com/video/BV17x411w7KC",
            "https://bilibili.com/video/av170001/" to "https://bilibili.com/video/av170001/",
            "http://m.bilibili.com/video/av170001?p=2" to "http://m.bilibili.com/video/av170001?p=2",
            "https://WWW.BILIBILI.COM:443/video/av170001" to "https://www.bilibili.com/video/av170001",
            "http://www.bilibili.com:80/video/av170001" to "http://www.bilibili.com/video/av170001",
        )
        for ((input, expected) in cases) assertEquals(input, expected, BilibiliShare.extract(input)?.toString())
    }

    @Test fun doesNotExtractLinksFromOrdinaryMixedText() {
        for (input in listOf(
            "看看这个 $SHORT_URL", "$SHORT_URL 很好听", "$SHORT_URL\n$SHORT_URL",
            "前言 $SHARE", "$SHARE 后记", "$SHARE $SHARE", "$SHARE\n$SHARE", "【普通标题】 $SHORT_URL", "【备注】 请勿转发。$SHARE",
            "【标题-哔哩哔哩】", "<https://www.bilibili.com/video/av170001>",
            "https://www.bilibili.com/video/av170001\u0000", "", "   ",
        )) assertNull(input, BilibiliShare.extract(input))
    }

    @Test fun rejectsLookalikeHostsNonDefaultPortsAndCredentials() {
        for (authority in listOf(
            "www.bilibili.com.evil.test", "b23.tv.evil.test", "evilbilibili.com",
            "api.bilibili.com", "www.bilibili.com.", "127.0.0.1", "[::1]",
            "www.bilibili.com:444", "www.bilibili.com:80", "b23.tv:8443",
            "user@www.bilibili.com", "user:secret@www.bilibili.com",
            ":secret@www.bilibili.com", "www.bilibili.com@evil.test",
        )) assertNull(authority, BilibiliShare.extract("https://$authority/video/av170001"))
        assertNull(BilibiliShare.extract("http://www.bilibili.com:443/video/av170001"))
        assertNull(BilibiliShare.extract("https://www.bilibili.com\\@evil.test/video/av170001"))
    }

    @Test fun rejectsExplicitEmptyCredentialsBeforeUrlNormalization() {
        for (authority in listOf("@www.bilibili.com", ":@www.bilibili.com")) {
            assertNull(authority, BilibiliShare.extract("https://$authority/video/av170001"))
        }
    }

    @Test fun rejectsNonVideoPathsAndMalformedVideoIds() {
        for (input in listOf(
            "ftp://www.bilibili.com/video/av170001", "https://www.bilibili.com/",
            "https://www.bilibili.com/bangumi/play/ep123", "https://live.bilibili.com/123",
            "https://www.bilibili.com/video/av170001/extra", "https://www.bilibili.com/video/AV170001",
            "https://www.bilibili.com/video/BV17x411w7K0", "https://www.bilibili.com/video/BV17x411w7K",
            "https://www.bilibili.com/video/av-1", "https://www.bilibili.com/video%2Fav170001",
            "https://b23.tv/", "https://b23.tv/one/two", "https://b23.tv/a-b",
        )) assertNull(input, BilibiliShare.extract(input))
    }

    @Test fun resolvesUserShareViaMock302AndDropsTracking() = runBlocking<Unit> {
        OfflineNetwork { chain ->
            response(chain, 302, "https://www.bilibili.com/video/BV1hx4y1M7c5?spm_id_from=333.337.search-card.all.click&vd_source=tracking&share_source=copy_link")
        }.use { network ->
            val input = requireNotNull(BilibiliShare.extract(SHARE))
            assertEquals("https://www.bilibili.com/video/av990800235", network.resolver.resolve(input))
            assertEquals(listOf(SHORT_URL), network.requests.map { it.url.toString() })
            assertEquals("GET", network.requests.single().method)
        }
    }

    @Test fun convertsKnownBvIdsIncludingLargeAidWithoutNetwork() = runBlocking<Unit> {
        OfflineNetwork().use { network ->
            for ((bv, aid) in listOf(
                "BV1hx4y1M7c5" to 990800235L,
                "BV17x411w7KC" to 170001L,
                "BV1Q541167Qg" to 455017605L,
                "BV1YTu6zVEXA" to 114851720595698L,
            )) {
                assertEquals(bv, "https://www.bilibili.com/video/av$aid",
                    network.resolver.resolve("https://www.bilibili.com/video/$bv".toHttpUrl()))
            }
            assertTrue(network.requests.isEmpty())
        }
    }

    @Test fun canonicalizesAvHostsSchemeAndPageWithoutNetwork() = runBlocking<Unit> {
        OfflineNetwork().use { network ->
            for (host in listOf("bilibili.com", "www.bilibili.com", "m.bilibili.com")) {
                assertEquals("https://www.bilibili.com/video/av170001?p=3",
                    network.resolver.resolve("http://$host/video/av000170001/?p=3&spm_id_from=tracking#reply".toHttpUrl()))
            }
            for ((query, suffix) in listOf(
                "" to "", "?p=1" to "", "?p=0" to "", "?p=-2" to "",
                "?p=oops" to "", "?p=" to "", "?p=2147483648" to "",
                "?p=2&vd_source=tracking#fragment" to "?p=2", "?p=003&share_source=copy" to "?p=3",
            )) assertEquals(query, "https://www.bilibili.com/video/av170001$suffix",
                network.resolver.resolve("https://www.bilibili.com/video/BV17x411w7KC$query".toHttpUrl()))
            assertTrue(network.requests.isEmpty())
        }
    }

    @Test fun rejectsOutOfRangeVideoIdsWithoutNetwork() = runBlocking<Unit> {
        OfflineNetwork().use { network ->
            for (id in listOf("av0", "av2251799813685248", "av9223372036854775808", "BV1111111111")) {
                expectFailure<IllegalArgumentException> {
                    network.resolver.resolve("https://www.bilibili.com/video/$id".toHttpUrl())
                }
            }
            assertTrue(network.requests.isEmpty())
        }
    }

    @Test fun upgradesEveryHttpHopBeforeMakingARequest() = runBlocking<Unit> {
        OfflineNetwork { chain ->
            response(chain, 302, if (chain.request().url.encodedPath == "/first")
                "http://b23.tv/second" else "http://m.bilibili.com/video/BV17x411w7KC?p=2&tracking=yes")
        }.use { network ->
            assertEquals("https://www.bilibili.com/video/av170001?p=2",
                network.resolver.resolve("http://b23.tv/first".toHttpUrl()))
            assertEquals(listOf("https://b23.tv/first", "https://b23.tv/second"), network.requests.map { it.url.toString() })
            assertTrue(network.requests.all { it.url.isHttps && it.url.port == 443 })
        }
    }

    @Test fun supportsAllRedirectStatusesAndRelativeLocations() = runBlocking<Unit> {
        for (code in listOf(301, 302, 303, 307, 308)) {
            OfflineNetwork { chain -> response(chain, code,
                if (chain.request().url.encodedPath == "/first") "/second" else "//www.bilibili.com/video/av170001")
            }.use { network ->
                assertEquals("https://www.bilibili.com/video/av170001",
                    network.resolver.resolve("https://b23.tv/first".toHttpUrl()))
                assertEquals(2, network.requests.size)
            }
        }
    }

    @Test fun allowsFourRedirectsEndingInVideo() = runBlocking<Unit> {
        OfflineNetwork { chain ->
            val hop = chain.request().url.encodedPath.removePrefix("/").toInt()
            response(chain, 302, if (hop == 4) "https://www.bilibili.com/video/av170001" else "/${hop + 1}")
        }.use { network ->
            assertEquals("https://www.bilibili.com/video/av170001", network.resolver.resolve("https://b23.tv/1".toHttpUrl()))
            assertEquals(4, network.requests.size)
        }
    }

    @Test fun rejectsFifthRedirectAndLoopsWithoutAnotherRequest() = runBlocking<Unit> {
        for (loop in listOf(false, true)) {
            OfflineNetwork { chain ->
                val hop = chain.request().url.encodedPath.removePrefix("/").toInt()
                response(chain, 302, if (loop) "/1" else "/${hop + 1}")
            }.use { network ->
                expectFailure<IllegalArgumentException> { network.resolver.resolve("https://b23.tv/1".toHttpUrl()) }
                assertEquals(4, network.requests.size)
            }
        }
    }

    @Test fun validatesDirectInputsEvenWhenExtractIsBypassed() = runBlocking<Unit> {
        OfflineNetwork().use { network ->
            for (input in UNSAFE_DESTINATIONS) {
                expectFailure<IllegalArgumentException> { network.resolver.resolve(input.toHttpUrl()) }
            }
            assertTrue(network.requests.isEmpty())
        }
    }

    @Test fun rejectsUnsafeAndNonVideoRedirectsBeforeRequestingDestination() = runBlocking<Unit> {
        for (destination in UNSAFE_DESTINATIONS + listOf(
            "https://www.bilibili.com/", "https://www.bilibili.com/bangumi/play/ep123",
            "https://@www.bilibili.com/video/av170001", "//:@www.bilibili.com/video/av170001",
            "https://b23.tv/a/b", "https://www.bilibili.com\\@evil.test/video/av170001",
            "https://www.bili\tbili.com/video/av170001",
        )) {
            OfflineNetwork { chain -> response(chain, 302, destination) }.use { network ->
                expectFailure<IllegalArgumentException> { network.resolver.resolve(SHORT_URL.toHttpUrl()) }
                assertEquals(destination, 1, network.requests.size)
            }
        }
    }

    @Test fun rejectsSuccessNonRedirectAndHttpErrorResponses() = runBlocking<Unit> {
        for (code in listOf(200, 204, 300, 304, 400, 401, 403, 404, 429, 500, 503)) {
            OfflineNetwork { chain -> response(chain, code, "https://www.bilibili.com/video/av170001") }.use { network ->
                expectFailure<IllegalArgumentException> { network.resolver.resolve(SHORT_URL.toHttpUrl()) }
                assertEquals(1, network.requests.size)
            }
        }
    }

    @Test fun rejectsMissingLocationAndPropagatesNetworkFailure() = runBlocking<Unit> {
        OfflineNetwork { chain -> response(chain, 302) }.use { network ->
            expectFailure<IllegalStateException> { network.resolver.resolve(SHORT_URL.toHttpUrl()) }
        }
        OfflineNetwork { chain -> response(chain, 302, "ftp://www.bilibili.com/video/av170001") }.use { network ->
            expectFailure<IllegalStateException> { network.resolver.resolve(SHORT_URL.toHttpUrl()) }
            assertEquals(1, network.requests.size)
        }
        val failure = IOException("offline failure")
        OfflineNetwork { throw failure }.use { network ->
            // Coroutine stack-trace recovery may copy the exception in debug tests.
            assertEquals(failure.message, expectFailure<IOException> { network.resolver.resolve(SHORT_URL.toHttpUrl()) }.message)
            assertEquals(1, network.requests.size)
        }
    }

    @Test fun sendsNoCookieOrAuthorizationAcrossRedirects() = runBlocking<Unit> {
        OfflineNetwork { chain ->
            response(chain, 302, if (chain.request().url.encodedPath == "/first") "/second"
                else "https://www.bilibili.com/video/av170001")
                .newBuilder().header("Set-Cookie", "session=private; Secure; Path=/").build()
        }.use { network ->
            network.resolver.resolve("https://b23.tv/first".toHttpUrl())
            assertEquals(2, network.requests.size)
            for (request in network.requests) {
                assertNull(request.header("Cookie"))
                assertNull(request.header("Authorization"))
                assertNull(request.header("Proxy-Authorization"))
                assertEquals("Mozilla/5.0", request.header("User-Agent"))
            }
        }
    }

    @Test(timeout = 5_000) fun coroutineCancellationCancelsTheInFlightCall() = runBlocking<Unit> {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        OfflineNetwork { chain ->
            entered.countDown()
            check(release.await(4, TimeUnit.SECONDS))
            response(chain, 302, "https://www.bilibili.com/video/av170001")
        }.use { network ->
            val pending = async(start = CoroutineStart.UNDISPATCHED) { network.resolver.resolve(SHORT_URL.toHttpUrl()) }
            try {
                assertTrue(entered.await(2, TimeUnit.SECONDS))
                pending.cancelAndJoin()
                assertTrue(network.calls.single().isCanceled())
                expectFailure<CancellationException> { pending.await() }
                assertEquals(1, network.requests.size)
            } finally {
                release.countDown()
                pending.cancelAndJoin()
            }
        }
    }

    @Test(timeout = 5_000) fun explicitCancelCancelsTheInFlightCall() = runBlocking<Unit> {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        OfflineNetwork { chain ->
            entered.countDown()
            check(release.await(4, TimeUnit.SECONDS))
            response(chain, 302, "https://www.bilibili.com/video/av170001")
        }.use { network ->
            // Catch inside async so an expected IOException does not cancel its parent.
            val pending = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { network.resolver.resolve(SHORT_URL.toHttpUrl()) }
            }
            try {
                assertTrue(entered.await(2, TimeUnit.SECONDS))
                network.resolver.cancel()
                assertTrue(network.calls.single().isCanceled())
                release.countDown()
                assertTrue(pending.await().exceptionOrNull() is IOException)
                assertEquals(1, network.requests.size)
            } finally {
                release.countDown()
                pending.cancelAndJoin()
            }
        }
    }

    @Test(timeout = 20_000) fun totalTimeoutIsSharedAcrossRedirectsAndCancelsTheActiveCall() = runBlocking<Unit> {
        val release = CountDownLatch(1)
        OfflineNetwork { chain ->
            if (chain.request().url.encodedPath == "/first") {
                // Spend part of the single ten-second budget on the first hop.
                Thread.sleep(6_000)
                response(chain, 302, "/second")
            } else {
                check(release.await(15, TimeUnit.SECONDS))
                response(chain, 302, "https://www.bilibili.com/video/av170001")
            }
        }.use { network ->
            val started = System.nanoTime()
            try {
                expectFailure<TimeoutCancellationException> {
                    network.resolver.resolve("https://b23.tv/first".toHttpUrl())
                }
                val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
                assertTrue("Expected the total 10s budget, elapsed ${elapsedMs}ms", elapsedMs in 9_000..14_000)
                assertEquals(listOf("/first", "/second"), network.requests.map { it.url.encodedPath })
                assertTrue(network.calls.last().isCanceled())
            } finally {
                release.countDown()
            }
        }
    }

    /** Never calls proceed(): every request is answered locally, including unexpected hosts. */
    private class OfflineNetwork(
        handler: (Interceptor.Chain) -> Response = { throw AssertionError("Unexpected network request: ${it.request().url}") },
    ) : Closeable {
        val requests = CopyOnWriteArrayList<Request>()
        val calls = CopyOnWriteArrayList<Call>()
        private val client = OkHttpClient.Builder()
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .addInterceptor { chain ->
                requests.add(chain.request())
                calls.add(chain.call())
                handler(chain)
            }.build()
        val resolver = BilibiliShare(client)

        override fun close() {
            client.dispatcher.cancelAll()
            client.dispatcher.executorService.shutdown()
            check(client.dispatcher.executorService.awaitTermination(2, TimeUnit.SECONDS)) { "Offline request did not finish" }
            client.connectionPool.evictAll()
        }
    }

    private suspend inline fun <reified T : Throwable> expectFailure(noinline block: suspend () -> Unit): T {
        try {
            block()
        } catch (failure: Throwable) {
            if (failure is T) return failure
            throw AssertionError("Expected ${T::class.java.simpleName}, got $failure", failure)
        }
        throw AssertionError("Expected ${T::class.java.simpleName}")
    }

    companion object {
        private const val SHORT_URL = "https://b23.tv/iULlJGW"
        private const val SHARE = "【恋愛脳(恋爱脑) / 七音阿卡莉-TV动画「契约之吻」ED-哔哩哔哩】 $SHORT_URL"
        private val UNSAFE_DESTINATIONS = listOf(
            "https://evil.test/video/av170001", "https://www.bilibili.com.evil.test/video/av170001",
            "https://www.bilibili.com:8443/video/av170001", "http://www.bilibili.com:443/video/av170001",
            "https://user:secret@www.bilibili.com/video/av170001", "https://user@b23.tv/next",
        )

        private fun response(chain: Interceptor.Chain, code: Int, location: String? = null): Response =
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(code).message("Offline response").body("".toResponseBody())
                .apply { if (location != null) header("Location", location) }.build()
    }
}
