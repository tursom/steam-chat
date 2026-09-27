package io.github.steamchat.android.data

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Public-link requests use their own client: never the authenticated chat client. */
class BilibiliShare(private val client: OkHttpClient = OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
    .connectTimeout(5, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS)
    .callTimeout(10, TimeUnit.SECONDS).build()) {

    suspend fun resolve(input: HttpUrl): String = withTimeout(10_000) {
        var url = input
        repeat(5) { step ->
            require(allowed(url)) { "Unsupported share destination" }
            // Upgrade copied HTTP links without ever making a cleartext request.
            url = url.newBuilder().scheme("https").port(443).build()
            videoUrl(url)?.let { return@withTimeout it }
            require(url.host == "b23.tv" && SHORT_PATH.matches(url.encodedPath) && step < 4) { "Not a video share" }
            url = redirect(url)
        }
        error("Too many share redirects")
    }

    fun cancel() = client.dispatcher.cancelAll()

    private suspend fun redirect(url: HttpUrl): HttpUrl = suspendCancellableCoroutine { continuation ->
        val call = client.newCall(Request.Builder().url(url).header("User-Agent", "Mozilla/5.0").get().build())
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { continuation.resumeWith(Result.failure(e)) }
            override fun onResponse(call: Call, response: Response) {
                val result = runCatching {
                    response.use {
                        require(it.code in listOf(301, 302, 303, 307, 308)) { "Share link did not redirect" }
                        val location = it.header("Location") ?: error("Missing share destination")
                        require('\\' !in location && location.none(Char::isISOControl) && !hasUserInfo(location))
                        url.resolve(location) ?: error("Invalid share destination")
                    }
                }
                continuation.resumeWith(result)
            }
        })
    }

    companion object {
        private val SHORT_PATH = Regex("/[A-Za-z0-9]+/?")
        private val VIDEO_PATH = Regex("/video/(BV1[1-9A-HJ-NP-Za-km-z]{9}|av[0-9]+)/?")
        private const val ALPHABET = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf"
        private const val MAX_AID = 2251799813685248L
        private const val XOR_CODE = 23442827791579L

        /** Match a complete share or a standalone Bilibili video URL, not surrounding prose. */
        fun extract(text: String): HttpUrl? {
            val trimmed = text.trim()
            val raw = if (trimmed.startsWith('【')) {
                // Locate the outer wrapper, allowing nested brackets and line breaks
                // in a video title without swallowing a separate prefixed note.
                var depth = 0
                var end = -1
                for ((index, character) in trimmed.withIndex()) {
                    if (character == '【') depth++
                    if (character == '】') depth--
                    if (depth == 0) { end = index; break }
                }
                if (end < 0) return null
                val title = trimmed.substring(1, end)
                if (!title.endsWith("-哔哩哔哩") || title.removeSuffix("-哔哩哔哩").isBlank()) return null
                trimmed.substring(end + 1).trim()
            } else trimmed
            if ('\\' in raw || raw.any { it.isWhitespace() || it.isISOControl() } || hasUserInfo(raw)) return null
            val url = raw.toHttpUrlOrNull() ?: return null
            if (!allowed(url)) return null
            return url.takeIf { (it.host == "b23.tv" && SHORT_PATH.matches(it.encodedPath)) ||
                (it.host != "b23.tv" && VIDEO_PATH.matches(it.encodedPath)) }
        }

        private fun allowed(url: HttpUrl) = url.host in setOf("b23.tv", "bilibili.com", "www.bilibili.com", "m.bilibili.com") &&
            url.username.isEmpty() && url.password.isEmpty() && url.port == (if (url.isHttps) 443 else 80)

        // HttpUrl normalizes explicit empty user-info away, so inspect it first.
        private fun hasUserInfo(raw: String) = '@' in raw.substringAfter("://", raw.removePrefix("//"))
            .substringBefore('/').substringBefore('?').substringBefore('#')

        private fun videoUrl(url: HttpUrl): String? {
            if (url.host == "b23.tv") return null
            val id = VIDEO_PATH.matchEntire(url.encodedPath)?.groupValues?.get(1) ?: return null
            val aid = if (id.startsWith("av")) id.substring(2).toLongOrNull() else bvToAv(id)
            require(aid != null && aid in 1 until MAX_AID) { "Invalid video ID" }
            val page = url.queryParameter("p")?.toIntOrNull()?.takeIf { it > 1 }
            return "https://www.bilibili.com/video/av$aid" + (page?.let { "?p=$it" } ?: "")
        }

        // Bilibili's 51-bit BV encoding (also covers older, smaller av IDs).
        private fun bvToAv(bv: String): Long {
            val digits = bv.toCharArray()
            val third = digits[3]; digits[3] = digits[9]; digits[9] = third
            val fourth = digits[4]; digits[4] = digits[7]; digits[7] = fourth
            var value = 0L
            for (index in 3 until digits.size) {
                val digit = ALPHABET.indexOf(digits[index])
                require(digit >= 0) { "Invalid BV digit" }
                value = value * 58 + digit
            }
            require(value in MAX_AID until (MAX_AID * 2)) { "Invalid BV range" }
            return (value and (MAX_AID - 1)) xor XOR_CODE
        }
    }
}
