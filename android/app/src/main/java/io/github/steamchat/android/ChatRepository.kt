package io.github.steamchat.android

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.util.Base64
import androidx.core.content.ContextCompat
import io.github.steamchat.android.data.ChatCache
import io.github.steamchat.android.data.Protocol
import io.github.steamchat.android.data.SessionVault
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.random.Random

class ChatRepository(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val gate = Mutex()
    private val vault = SessionVault(context)
    private val cache = ChatCache(context)
    private val settings = context.getSharedPreferences("chat-settings", Context.MODE_PRIVATE)
    private val mutable = MutableStateFlow(AppState(backgroundEnabled = settings.getBoolean("background", true), notificationPreview = settings.getBoolean("preview", false), notificationsEnabled = settings.getBoolean("notifications", true)))
    val state: StateFlow<AppState> = mutable.asStateFlow()
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(45, TimeUnit.SECONDS).pingInterval(30, TimeUnit.SECONDS).build()
    @Volatile private var base: HttpUrl? = null
    @Volatile private var cookie = ""
    @Volatile private var expires = 0L
    @Volatile private var generation = 0L
    @Volatile private var sessionEnding = false
    @Volatile private var foreground = false
    private var userId = ""
    private var accountSteamId = ""
    @Volatile private var cacheScope = ""
    private var socket: WebSocket? = null
    private var wsPath = "/ws"
    private var reconnectAt = 0L
    private var attempts = 0
    private var httpRetryAt = 0L
    private var worker: Job? = null
    private val hints = Channel<Unit>(Channel.CONFLATED)
    private val outgoing = linkedMapOf<String, Outgoing>()
    private data class Outgoing(val message: Message, val scope: String, val uri: Uri? = null, val confirmedEventId: String = "")
    private class HttpFailure(val status: Int) : IOException("HTTP $status")

    init {
        scope.launch {
            gate.withLock {
                val saved = vault.load() ?: return@withLock
                runCatching {
                    base = Protocol.base(saved.getString("server")); cookie = saved.getString("cookie"); expires = saved.getLong("expires")
                    if (expires <= System.currentTimeMillis()) { endSession("登录已过期，请重新登录"); return@withLock }
                    mutable.update { it.copy(server = base.toString()) }
                    validateSession()
                    startWorker()
                }.onFailure { handleFailure(it) }
                startWorker()
            }
        }
        runCatching {
            (context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { hints.trySend(Unit) }
                override fun onLost(network: Network) { hints.trySend(Unit) }
            })
        }
    }

    private fun launchAction(block: suspend () -> Unit) {
        val version = generation
        scope.launch { gate.withLock {
            if (version != generation) return@withLock
            try { block() } catch (e: CancellationException) { throw e } catch (e: Exception) { handleFailure(e) }
        } }
    }
    private fun request(path: String, body: JSONObject? = null): String {
        val root = base ?: error("请先登录")
        return execute(Protocol.endpoint(root, path), body)
    }
    private fun execute(url: HttpUrl, body: JSONObject? = null): String {
        if (sessionEnding) throw CancellationException()
        val version = generation
        val root = base ?: error("请先登录")
        require(url.host == root.host && url.port == root.port && url.isHttps && url.encodedPath.startsWith(root.encodedPath))
        if (cookie.isNotEmpty() && expires <= System.currentTimeMillis()) throw HttpFailure(401)
        val builder = Request.Builder().url(url)
        if (cookie.isNotEmpty()) builder.header("Cookie", cookie)
        if (body != null) builder.post(body.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
        client.newCall(builder.build()).execute().use { response ->
            if (version != generation) throw CancellationException()
            if (!response.isSuccessful) throw HttpFailure(response.code)
            response.headers.values("Set-Cookie").mapNotNull { Cookie.parse(url, it) }.firstOrNull { it.name == "steam_chat_session" }?.let {
                cookie = "${it.name}=${it.value}"; expires = minOf(it.expiresAt, System.currentTimeMillis() + 7 * 86400_000L)
                vault.save(JSONObject().put("server", root.toString()).put("cookie", cookie).put("expires", expires))
            }
            return response.body?.byteStream()?.use { String(bounded(it, 4 * 1024 * 1024), Charsets.UTF_8) } ?: "{}"
        }
    }
    private fun json(path: String, body: JSONObject? = null) = JSONObject(request(path, body))

    fun login(server: String, username: String, password: String) = launchAction {
        val validated = Protocol.base(server)
        endSession("")
        sessionEnding = false
        base = validated
        mutable.update { it.copy(server = validated.toString(), loading = true, error = "") }
        try {
            json("/api/auth/login", JSONObject().put("username", username).put("password", password))
            require(cookie.isNotEmpty()) { "服务器未返回会话 Cookie" }
            validateSession()
            startWorker(); hints.trySend(Unit)
        } finally { mutable.update { it.copy(loading = false) } }
    }
    private fun validateSession() {
        val me = json("/api/auth/me")
        val user = me.optJSONObject("user") ?: throw HttpFailure(401)
        if (user.optBoolean("forcePasswordChange")) { endSession("请在网页版修改密码后重新登录"); return }
        userId = user.getLong("id").toString()
        mutable.update { it.copy(loggedIn = true, username = user.optString("username")) }
    }
    fun logout() {
        val oldBase = base
        val oldCookie = cookie
        sessionEnding = true
        generation++
        client.dispatcher.cancelAll()
        mutable.update { AppState(server = it.server, backgroundEnabled = it.backgroundEnabled, notificationPreview = it.notificationPreview, notificationsEnabled = it.notificationsEnabled) }
        scope.launch {
            gate.withLock { endSession("") }
            if (oldBase != null && oldCookie.isNotEmpty()) runCatching {
                client.newCall(Request.Builder().url(Protocol.endpoint(oldBase, "/api/auth/logout")).header("Cookie", oldCookie)
                    .post("{}".toRequestBody("application/json".toMediaType())).build()).execute().close()
            }
        }
    }
    private fun endSession(error: String) {
        sessionEnding = true
        generation++
        cookie = ""; expires = 0; vault.clear()
        worker?.cancel(); worker = null
        socket?.cancel(); socket = null
        client.dispatcher.cancelAll()
        cache.clearAll()
        cacheScope = ""; accountSteamId = ""; userId = ""; outgoing.clear()
        mutable.update { AppState(server = it.server, error = error, backgroundEnabled = it.backgroundEnabled, notificationPreview = it.notificationPreview, notificationsEnabled = it.notificationsEnabled) }
        context.stopService(Intent(context, ConnectionService::class.java))
        ChatNotifications.clearMessages(context)
    }
    private fun allowed() = !sessionEnding && (state.value.loggedIn || cookie.isNotEmpty()) && (foreground || state.value.backgroundEnabled)
    private fun startWorker() {
        if (!allowed() || worker?.isActive == true) return
        worker = scope.launch {
            while (isActive && allowed()) {
                gate.withLock {
                    try {
                        if (cookie.isNotEmpty()) {
                            if (!state.value.loggedIn) validateSession()
                            if (state.value.loggedIn) catchUp()
                            if (state.value.accessAllowed && socket == null && System.currentTimeMillis() >= reconnectAt) connectSocket()
                        }
                    } catch (e: CancellationException) { throw e } catch (e: Exception) { handleFailure(e) }
                }
                withTimeoutOrNull(30_000) { hints.receive() }
                delay((httpRetryAt - System.currentTimeMillis()).coerceAtLeast(1000))
            }
        }
        updateService()
    }
    private fun catchUp() {
        val status = json("/api/steam/status")
        val account = status.optJSONObject("activeAccount")
        val permitted = status.optBoolean("accessAllowed") && account != null
        val steam = if (permitted) account!!.optString("steamId") else ""
        val online = status.optString("status") == "online"
        if (!permitted || steam.isEmpty()) { hideAccount(if (!online) "Steam 未连接，等待管理员登录" else "无 Steam 账户访问权限"); return }
        val nextScope = JSONArray(listOf(base.toString(), userId, steam)).toString()
        if (nextScope != cacheScope) {
            val selectedPeer = state.value.selectedPeer
            val selectedName = state.value.selectedName
            val firstAccount = cacheScope.isEmpty()
            hideAccount()
            cacheScope = nextScope; accountSteamId = steam
            if (firstAccount) mutable.update { it.copy(selectedPeer = selectedPeer, selectedName = selectedName) }
        }
        mutable.update { it.copy(activeAccountId = steam, accessAllowed = true, steamOnline = online, connectionText = connectionText(it.connected, online)) }
        var reset = false
        for (pageNumber in 0 until 50) {
            if (!allowed()) break
            val checkpoint = cache.checkpoint(cacheScope)
            val url = Protocol.endpoint(base!!, "/api/messages/sync").newBuilder().addQueryParameter("limit", "100").addQueryParameter("steamAccountId", accountSteamId).apply {
                if (checkpoint.first.isNotEmpty()) addQueryParameter("cursor", checkpoint.first)
            }.build()
            val page = try { JSONObject(execute(url)) } catch (e: HttpFailure) {
                if (e.status == 409 && !reset) { cache.reset(cacheScope); reset = true; continue }
                throw e
            }
            if (page.getString("steamAccountId") != accountSteamId) { hideAccount(); hints.trySend(Unit); return }
            val more = page.getBoolean("hasMore")
            val cursor = page.getString("nextCursor")
            require(!more || cursor != checkpoint.first) { "同步游标未推进" }
            val notices = cache.ingest(cacheScope, page.getJSONArray("items"), cursor, more, if (foreground) state.value.selectedPeer else "")
            publishCache()
            for (message in notices) {
                if (state.value.loggedIn && !(foreground && state.value.selectedPeer == message.peerId)) ChatNotifications.message(context, state.value, message)
            }
            if (!more) break
            if (pageNumber == 49) hints.trySend(Unit)
        }
        if (online) {
            val friends = JSONArray(request("/api/friends"))
            mutable.update { it.copy(friends = (0 until friends.length()).map { index -> friends.getJSONObject(index).let { f -> Friend(f.getString("id"), f.optString("name"), f.optString("avatar"), f.optBoolean("online"), f.optString("gameName")) } }) }
            if (state.value.emoticons.isEmpty() && state.value.stickers.isEmpty()) {
                val media = json("/api/emoticons")
                mutable.update { it.copy(emoticons = mediaNames(media.optJSONArray("emoticons")), stickers = mediaNames(media.optJSONArray("stickers"))) }
            }
        }
        publishCache()
    }
    private fun mediaNames(items: JSONArray?): List<String> = if (items == null) emptyList() else (0 until items.length()).mapNotNull {
        when (val item = items.opt(it)) { is String -> item; is JSONObject -> item.optString("name", item.optString("type")).takeIf(String::isNotEmpty); else -> null }
    }
    private fun hideAccount(reason: String = "无 Steam 账户访问权限") {
        socket?.cancel(); socket = null
        cacheScope = ""; accountSteamId = ""; outgoing.clear()
        mutable.update { it.copy(activeAccountId = "", accessAllowed = false, steamOnline = false, connected = false, connectionText = reason, conversations = emptyList(), friends = emptyList(), messages = emptyList(), emoticons = emptyList(), stickers = emptyList(), selectedPeer = "", selectedName = "") }
        ChatNotifications.clearMessages(context)
    }
    private fun connectSocket() {
        wsPath = json("/api/config").getString("wsPath")
        val url = Protocol.endpoint(base!!, wsPath)
        val version = generation
        val account = cacheScope
        socket = client.newWebSocket(Request.Builder().url(url).header("Cookie", cookie).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                launchAction {
                    if (version != generation || account != cacheScope || !allowed() || socket !== webSocket) { webSocket.cancel(); return@launchAction }
                    attempts = 0
                    mutable.update { it.copy(connected = true, connectionText = connectionText(true, it.steamOnline)) }
                    hints.trySend(Unit)
                }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (version != generation || account != cacheScope) return
                val type = runCatching { JSONObject(text).optString("type") }.getOrNull()
                if (type in listOf("sync_available", "message", "ready", "steam_status", "status")) hints.trySend(Unit)
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = failed(webSocket, null)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = failed(webSocket, response?.code)
            private fun failed(webSocket: WebSocket, status: Int?) {
                launchAction {
                    if (version != generation || socket !== webSocket) return@launchAction
                    socket = null
                    if (status == 401) { endSession("登录已过期，请重新登录"); return@launchAction }
                    if (status == 403) { hideAccount(); return@launchAction }
                    attempts = (attempts + 1).coerceAtMost(6)
                    reconnectAt = System.currentTimeMillis() + Random.nextLong(1000, (1000L shl attempts).coerceAtMost(60_000))
                    mutable.update { it.copy(connected = false, connectionText = "连接已断开，等待重连") }
                }
            }
        })
    }
    private fun connectionText(connected: Boolean, steam: Boolean) = when { !connected -> "未连接（HTTP 同步）"; !steam -> "服务器已连接，Steam 离线"; else -> "已连接" }
    private fun handleFailure(error: Throwable) {
        if (error is CancellationException) return
        when ((error as? HttpFailure)?.status) {
            401 -> endSession("登录已过期，请重新登录")
            403 -> { hideAccount(); mutable.update { it.copy(error = "访问被拒绝；如需修改密码，请前往网页版") } }
            else -> {
                httpRetryAt = System.currentTimeMillis() + 30_000
                mutable.update { it.copy(loading = false, error = if (error is HttpFailure) "服务器请求失败 (${error.status})" else "网络或数据处理失败，请检查服务器后重试") }
                if (cookie.isNotEmpty() && !state.value.loggedIn) {
                    // Restore remains retryable after an offline process start, but no cache is exposed.
                    mutable.update { it.copy(error = "无法验证已保存的会话，请联网后刷新") }
                }
            }
        }
    }
    fun refresh() = launchAction {
        if (!state.value.loggedIn && cookie.isNotEmpty()) validateSession()
        if (state.value.loggedIn) { catchUp(); startWorker(); hints.trySend(Unit) }
    }
    fun selectConversation(id: String, name: String) = launchAction {
        if (!state.value.loggedIn) return@launchAction
        mutable.update { it.copy(selectedPeer = id, selectedName = name) }
        if (cacheScope.isNotEmpty() && state.value.accessAllowed) {
            cache.read(cacheScope, id); ChatNotifications.clearPeer(context, id); publishCache()
        }
    }
    fun leaveConversation() { mutable.update { it.copy(selectedPeer = "", selectedName = "", messages = emptyList()) } }
    private fun publishCache() {
        if (cacheScope.isEmpty() || !state.value.accessAllowed) return
        outgoing.entries.removeAll { (_, item) -> item.scope == cacheScope && item.confirmedEventId.isNotEmpty() && cache.containsEvent(cacheScope, item.confirmedEventId) }
        mutable.update { current ->
            val conversations = cache.conversations(cacheScope).map { c -> current.friends.find { it.id == c.id }?.let { c.copy(name = it.name, avatar = it.avatar) } ?: c }
            current.copy(conversations = conversations, messages = if (current.selectedPeer.isEmpty()) emptyList() else cache.messages(cacheScope, current.selectedPeer) + outgoing.values.filter { it.scope == cacheScope && it.message.peerId == current.selectedPeer }.map { it.message })
        }
    }
    fun sendText(text: String) { if (text.isNotBlank()) queueSend(text, null) }
    fun sendImage(uri: Uri) = queueSend("[图片]", uri)
    private fun queueSend(text: String, uri: Uri?) {
        val peer = state.value.selectedPeer
        val account = cacheScope
        launchAction {
            if (!state.value.accessAllowed || peer.isEmpty() || account != cacheScope) return@launchAction
            val message = Message("local:${UUID.randomUUID()}", peer, state.value.username, text, true, Instant.now().toString(), pending = true, imageUrl = uri?.toString())
            val item = Outgoing(message, cacheScope, uri)
            outgoing[message.key] = item; publishCache(); transmit(item)
        }
    }
    fun retryMessage(key: String) = launchAction {
        val item = outgoing[key] ?: return@launchAction
        if (!item.message.failed || item.scope != cacheScope) return@launchAction
        transmit(item.copy(message = item.message.copy(pending = true, failed = false, error = "")))
    }
    private fun transmit(item: Outgoing) {
        outgoing[item.message.key] = item; publishCache()
        try {
            val status = json("/api/steam/status")
            if (!status.optBoolean("accessAllowed") || status.optJSONObject("activeAccount")?.optString("steamId") != accountSteamId) {
                hideAccount()
                mutable.update { it.copy(error = "Steam 帐号已变化，请刷新后重新发送") }
                return
            }
            val body = JSONObject().put("id", item.message.peerId).put("steamAccountId", accountSteamId)
            val path = if (item.uri != null) {
                require(item.uri.scheme == "content") { "Only content URIs are supported" }
                val bytes = context.contentResolver.openInputStream(item.uri)?.use { bounded(it, 6 * 1024 * 1024) } ?: error("Cannot read image")
                require(bytes.isNotEmpty())
                body.put("img", Base64.encodeToString(bytes, Base64.NO_WRAP)); "/image"
            } else { body.put("msg", item.message.text); "/message" }
            val response = json(path, body)
            check(response.optBoolean("ok"))
            val committed = response.optJSONObject("item")
            outgoing[item.message.key] = item.copy(
                message = item.message.copy(pending = false, failed = false, error = ""),
                confirmedEventId = committed?.optString("eventId").orEmpty()
            )
            hints.trySend(Unit)
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            outgoing[item.message.key] = item.copy(message = item.message.copy(pending = false, failed = true, error = "发送结果不确定，可能已送达。手动重试可能重复发送。"))
            handleFailure(e)
        }
        publishCache()
    }
    suspend fun imageBytes(source: String): ByteArray? = withContext(Dispatchers.IO) {
        val version = generation
        val account = cacheScope
        if (!state.value.accessAllowed) return@withContext null
        try {
            val root = base ?: return@withContext null
            val url = if (source.startsWith("https://") || source.startsWith("http://")) {
                val public = source.toHttpUrl()
                require(public.username.isEmpty() && public.password.isEmpty() && public.fragment == null)
                Protocol.endpoint(root, "/proxy/image").newBuilder().addQueryParameter("url", public.toString()).build()
            } else {
                val relative = if (source.startsWith(root.encodedPath + "proxy/")) source.removePrefix(root.encodedPath) else source.removePrefix("/")
                require(relative.startsWith("proxy/image?") || relative.startsWith("proxy/sticker/"))
                Protocol.endpoint(root, relative)
            }
            if (expires <= System.currentTimeMillis()) throw HttpFailure(401)
            client.newCall(Request.Builder().url(url).header("Cookie", cookie).build()).execute().use {
                if (!it.isSuccessful) throw HttpFailure(it.code)
                val bytes = it.body?.byteStream()?.use { stream -> bounded(stream, 10 * 1024 * 1024) }
                if (version == generation && account == cacheScope && state.value.accessAllowed) bytes else null
            }
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            if (version == generation && account == cacheScope && e is HttpFailure && e.status in listOf(401, 403)) launchAction { handleFailure(e) }
            null
        }
    }
    fun setBackgroundEnabled(enabled: Boolean) {
        settings.edit().putBoolean("background", enabled).apply()
        mutable.update { it.copy(backgroundEnabled = enabled) }; reconcile()
    }
    fun setNotificationPreview(enabled: Boolean) {
        settings.edit().putBoolean("preview", enabled).apply(); mutable.update { it.copy(notificationPreview = enabled) }
        ChatNotifications.clearMessages(context)
    }
    fun setNotificationsEnabled(enabled: Boolean) {
        settings.edit().putBoolean("notifications", enabled).apply(); mutable.update { it.copy(notificationsEnabled = enabled) }
        if (!enabled) ChatNotifications.clearMessages(context)
    }
    fun onForegroundChanged(value: Boolean) { foreground = value; reconcile() }
    fun clearError() { mutable.update { it.copy(error = "") } }
    private fun reconcile() = launchAction {
        if (allowed()) { startWorker(); hints.trySend(Unit) } else {
            worker?.cancel(); worker = null; socket?.cancel(); socket = null
            mutable.update { it.copy(connected = false, connectionText = "后台连接已暂停") }
        }
        if (foreground && cacheScope.isNotEmpty() && state.value.selectedPeer.isNotEmpty()) { cache.read(cacheScope, state.value.selectedPeer); publishCache() }
        updateService()
    }
    private fun updateService() {
        if (state.value.loggedIn && state.value.backgroundEnabled) {
            // Android may disallow a background FGS start; next visible activity retries.
            runCatching { ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java)) }
                .onFailure { mutable.update { it.copy(error = "系统未允许后台服务，请打开应用以恢复后台连接") } }
        } else context.stopService(Intent(context, ConnectionService::class.java))
    }
    fun onServiceStarted() = launchAction {
        if (allowed()) startWorker()
        else if (cookie.isEmpty()) context.stopService(Intent(context, ConnectionService::class.java))
    }
    private fun bounded(input: java.io.InputStream, max: Int): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            require(output.size() + count <= max) { "Payload exceeds size limit" }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }
}
