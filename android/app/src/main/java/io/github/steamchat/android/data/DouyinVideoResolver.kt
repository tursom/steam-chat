package io.github.steamchat.android.data

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit

data class DouyinVideo(
    val id: String, val pageUrl: String, val title: String, val author: String,
    val playUrl: String, val durationMs: Long
)

/** A normal website visit may provide metadata after its anonymous browser setup. */
class DouyinBrowserRequired : IllegalStateException("公开分享页需要按官网方式访问后获取视频信息")

/** Reads public share-page JSON, without executing scripts or using the chat transport. */
class DouyinVideoResolver(client: OkHttpClient = OkHttpClient()) {
    private val pages = client.newBuilder().followRedirects(false).followSslRedirects(false)
        .cookieJar(CookieJar.NO_COOKIES).retryOnConnectionFailure(false)
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(8, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS).build()

    suspend fun resolve(input: String): DouyinVideo = withTimeout(20_000) {
        var url = requireNotNull(link(input)) { "不支持的抖音视频链接" }
        var id = videoId(url)
        if (id == null) {
            repeat(4) {
                if (id == null) {
                    require(url.host == "v.douyin.com" && SHORT_PATH.matches(url.encodedPath)) { "短链接未指向抖音视频" }
                    val response = fetch(url)
                    require(response.code in REDIRECTS) { "抖音短链接未提供视频地址" }
                    url = destination(url, response.location)
                    id = videoId(url)
                }
            }
        }
        val itemId = requireNotNull(id) { "抖音短链接跳转过多" }
        url = "https://www.iesdouyin.com/share/video/$itemId".toHttpUrl()
        repeat(5) { step ->
            val response = fetch(url)
            if (response.code in REDIRECTS) {
                require(step < 4) { "分享页跳转过多" }
                url = destination(url, response.location)
                require(videoId(url) == itemId) { "分享页跳转到了其他内容" }
            } else {
                require(response.code == 200) { "抖音分享页暂时不可用 (${response.code})" }
                return@withTimeout withContext(Dispatchers.Default) { parsePage(response.body, itemId) }
                    ?: throw DouyinBrowserRequired()
            }
        }
        error("分享页跳转过多")
    }

    /** The player has its own public transport; every redirected CDN request is checked. */
    fun mediaClient(): OkHttpClient = OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(8, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            var request = chain.request().newBuilder().removeHeader("Cookie").removeHeader("Authorization")
                .removeHeader("Proxy-Authorization").build()
            // Validate before opening a socket, including each redirected Range request.
            // Keep Range and Referer; never retain a page's Set-Cookie or change video parameters.
            var result: Response? = null
            for (step in 0..4) {
                if (mediaUrl(request.url.toString()) == null) throw IOException("不支持的视频来源")
                val response = chain.proceed(request)
                if (response.code !in REDIRECTS) { result = response; break }
                response.use {
                    if (step == 4) throw IOException("视频地址跳转过多")
                    val location = it.header("Location") ?: throw IOException("视频跳转地址为空")
                    if (!clean(location)) throw IOException("无效的视频跳转地址")
                    val destination = request.url.resolve(location) ?: throw IOException("无效的视频跳转地址")
                    if (mediaUrl(destination.toString()) == null) throw IOException("视频跳转到了不支持的来源")
                    request = request.newBuilder().url(destination).build()
                }
            }
            result ?: throw IOException("视频地址跳转过多")
        }.build()

    private data class Page(val code: Int, val location: String?, val body: String)

    private suspend fun fetch(url: HttpUrl): Page = suspendCancellableCoroutine { continuation ->
        require(pageHost(url) && url.isHttps && url.port == 443) { "不支持的分享地址" }
        val call = pages.newCall(Request.Builder().url(url).header("User-Agent", USER_AGENT)
            .header("Accept", "text/html").get().build())
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { continuation.resumeWith(Result.failure(e)) }
            override fun onResponse(call: Call, response: Response) {
                val result = runCatching {
                    response.use {
                        val body = if (it.code == 200) {
                            val content = it.body ?: error("分享页为空")
                            require(content.contentLength() <= MAX_PAGE_BYTES) { "分享页过大" }
                            val out = ByteArrayOutputStream()
                            content.byteStream().use { stream ->
                                val buffer = ByteArray(8192)
                                while (true) {
                                    val count = stream.read(buffer)
                                    if (count < 0) break
                                    require(out.size() + count <= MAX_PAGE_BYTES) { "分享页过大" }
                                    out.write(buffer, 0, count)
                                }
                            }
                            out.toByteArray().toString(content.contentType()?.charset(Charsets.UTF_8) ?: Charsets.UTF_8)
                        } else ""
                        Page(it.code, it.header("Location"), body)
                    }
                }
                continuation.resumeWith(result)
            }
        })
    }

    private fun destination(current: HttpUrl, location: String?): HttpUrl {
        val raw = requireNotNull(location) { "分享页缺少跳转地址" }
        require(clean(raw)) { "无效的跳转地址" }
        val url = requireNotNull(current.resolve(raw)) { "无效的跳转地址" }
        return requireNotNull(link(url.toString())) { "跳转地址不是抖音视频" }
    }

    companion object {
        const val USER_AGENT = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36"
        internal const val MAX_PAGE_BYTES = 2 * 1024 * 1024
        private val REDIRECTS = setOf(301, 302, 303, 307, 308)
        private val VIDEO_PATH = Regex("/(?:share/)?video/([0-9]{15,22})/?")
        private val ID = Regex("[0-9]{15,22}")
        private val SHORT_PATH = Regex("/[A-Za-z0-9_-]{1,128}/?")
        private val PAGE_HOSTS = setOf("douyin.com", "www.douyin.com", "m.douyin.com", "v.douyin.com", "www.iesdouyin.com", "iesdouyin.com")
        private val MEDIA_DOMAINS = setOf("douyinvod.com", "amemv.com", "douyin.com", "iesdouyin.com", "snssdk.com")

        fun supports(input: String): Boolean = link(input) != null

        internal fun officialBrowserUrl(input: String): String? = link(input)?.let { url ->
            videoId(url)?.let { "https://www.douyin.com/video/$it" } ?: url.toString()
        }

        internal fun browserPageAllowed(input: String, target: String): Boolean {
            val original = link(input) ?: return false
            if (target.toHttpUrlOrNull()?.isHttps != true) return false
            val next = link(target) ?: return false
            val expected = videoId(original)
            return next.isHttps && (expected == null || videoId(next) == expected)
        }

        internal fun browserVideoId(input: String, currentPage: String): String? {
            if (!browserPageAllowed(input, currentPage)) return null
            return link(currentPage)?.let(::videoId)
        }

        private fun clean(raw: String): Boolean = '\\' !in raw && raw.none { it.isWhitespace() || it.isISOControl() } &&
            '@' !in raw.substringAfter("://", raw.removePrefix("//")).substringBefore('/').substringBefore('?').substringBefore('#')

        private fun pageHost(url: HttpUrl) = url.host in PAGE_HOSTS && url.username.isEmpty() && url.password.isEmpty()

        private fun link(input: String): HttpUrl? {
            if (!clean(input)) return null
            val url = input.toHttpUrlOrNull() ?: return null
            if (!pageHost(url) || url.port != if (url.isHttps) 443 else 80) return null
            if (videoId(url) == null && !(url.host == "v.douyin.com" && SHORT_PATH.matches(url.encodedPath))) return null
            return url.newBuilder().scheme("https").port(443).fragment(null).build()
        }

        private fun videoId(url: HttpUrl): String? {
            if (url.host == "v.douyin.com") return null
            return VIDEO_PATH.matchEntire(url.encodedPath)?.groupValues?.get(1)
                ?: url.queryParameter("modal_id")?.takeIf { url.encodedPath == "/" && ID.matches(it) }
        }

        internal fun mediaUrl(raw: String): String? {
            if (!clean(raw)) return null
            val url = raw.toHttpUrlOrNull() ?: return null
            return url.toString().takeIf {
                url.isHttps && url.port == 443 && url.username.isEmpty() && url.password.isEmpty() &&
                    MEDIA_DOMAINS.any { domain -> url.host == domain || url.host.endsWith(".$domain") }
            }
        }

        internal fun parsePage(html: String, id: String): DouyinVideo? {
            if (html.length > MAX_PAGE_BYTES || !ID.matches(id)) return null
            val marker = Regex("window\\._ROUTER_DATA\\s*=\\s*").find(html) ?: return null
            val json = jsonObject(html, marker.range.last + 1) ?: return null
            val loaders = runCatching { JSONObject(json).optJSONObject("loaderData") }.getOrNull() ?: return null
            val keys = loaders.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                if (!key.startsWith("video_")) continue
                val route = loaders.optJSONObject(key) ?: continue
                val items = route.optJSONObject("videoInfoRes")?.optJSONArray("item_list") ?: continue
                for (index in 0 until items.length()) {
                    val item = items.optJSONObject(index) ?: continue
                    parseItem(item, id)?.let { return it }
                }
            }
            return null
        }

        private fun parseItem(item: JSONObject, id: String): DouyinVideo? {
            if (!ID.matches(id) || item.optString("aweme_id") != id) return null
            val video = item.optJSONObject("video") ?: return null
            val urls = video.optJSONObject("play_addr")?.optJSONArray("url_list") ?: return null
            val play = (0 until minOf(urls.length(), 8)).firstNotNullOfOrNull { mediaUrl(urls.optString(it)) } ?: return null
            return DouyinVideo(id, "https://www.douyin.com/video/$id", item.optString("desc").take(2000).ifBlank { "抖音视频" },
                item.optJSONObject("author")?.optString("nickname").orEmpty().take(160), play,
                video.optLong("duration", 0).coerceAtLeast(0))
        }

        // This script reads only metadata already published by the official page. It has no
        // Android bridge, cookie extraction, token signing, login or CAPTCHA handling.
        internal fun browserMetadataScript(id: String): String {
            require(ID.matches(id))
            return """(function() {
                var loaders = window._ROUTER_DATA && window._ROUTER_DATA.loaderData;
                if (!loaders) return '';
                var keys = Object.keys(loaders).slice(0, 30);
                for (var k = 0; k < keys.length; k++) {
                    if (keys[k].indexOf('video_') !== 0) continue;
                    var route = loaders[keys[k]];
                    var items = route && route.videoInfoRes && route.videoInfoRes.item_list;
                    if (!Array.isArray(items)) continue;
                    for (var i = 0; i < Math.min(items.length, 30); i++) {
                        var item = items[i];
                        if (!item || String(item.aweme_id) !== '$id') continue;
                        var video = item.video;
                        var urls = video && video.play_addr && video.play_addr.url_list;
                        if (!Array.isArray(urls)) continue;
                        var data = {pageUrl: location.href, item: {
                            aweme_id: String(item.aweme_id), desc: String(item.desc || '').slice(0, 2000),
                            author: {nickname: String(item.author && item.author.nickname || '').slice(0, 160)},
                            video: {duration: video.duration || 0, play_addr: {url_list: urls.slice(0, 8).filter(function(u) {
                                return typeof u === 'string' && u.length <= 8192;
                            })}}
                        }};
                        var result = JSON.stringify(data);
                        return result.length <= 65536 ? result : '';
                    }
                }
                return '';
            })()""".trimIndent()
        }

        /** WebView returns a JSON-encoded string; validate both page identity and video identity. */
        internal fun parseBrowserMetadata(raw: String, input: String, currentPage: String): DouyinVideo? = runCatching {
            if (raw.length > 128 * 1024) return null
            val decoded = JSONTokener(raw).nextValue() as? String ?: return null
            if (decoded.isEmpty() || decoded.length > 65536) return null
            val data = JSONObject(decoded)
            val page = data.optString("pageUrl")
            if (!browserPageAllowed(input, page) || !browserPageAllowed(input, currentPage) || link(page) != link(currentPage)) return null
            val id = browserVideoId(input, currentPage) ?: return null
            parseItem(data.optJSONObject("item") ?: return null, id)
        }.getOrNull()

        // Isolate the assigned JSON object; braces in quoted descriptions do not end it.
        // Do not evaluate script contents (a share page is external data).
        private fun jsonObject(text: String, start: Int): String? {
            if (text.getOrNull(start) != '{') return null
            var depth = 0
            var quoted = false
            var escaped = false
            for (index in start until text.length) {
                val c = text[index]
                if (quoted) {
                    if (escaped) escaped = false else if (c == '\\') escaped = true else if (c == '"') quoted = false
                } else when (c) {
                    '"' -> quoted = true
                    '{', '[' -> { depth++; if (depth > 64) return null }
                    '}', ']' -> { depth--; if (depth == 0) return text.substring(start, index + 1) }
                }
            }
            return null
        }
    }
}
