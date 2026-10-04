package io.github.steamchat.android

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import androidx.core.content.ContextCompat
import io.github.steamchat.android.data.ChatCache
import io.github.steamchat.android.data.BilibiliShare
import io.github.steamchat.android.data.MediaDiskCache
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
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

class ChatRepository(private val context: Context, private val socketFactory: WebSocket.Factory? = null,
                     private val sessionLoader: (() -> JSONObject?)? = null, httpClient: OkHttpClient? = null,
                     private val bilibiliShare: BilibiliShare = BilibiliShare()) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val gate = Mutex()
    private val vault = SessionVault(context)
    private val cache = ChatCache(context)
    private val mediaCache = MediaDiskCache(java.io.File(context.cacheDir, "media-v1"))
    private val settings = context.getSharedPreferences("chat-settings", Context.MODE_PRIVATE)
    private val mutable = MutableStateFlow(AppState(restoration = SessionRestoration.LOADING, server = settings.getString("server", "").orEmpty(), backgroundEnabled = settings.getBoolean("background", true), notificationPreview = settings.getBoolean("preview", false), notificationsEnabled = settings.getBoolean("notifications", true)))
    val state: StateFlow<AppState> = mutable.asStateFlow()
    private val client = httpClient ?: OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(45, TimeUnit.SECONDS).pingInterval(30, TimeUnit.SECONDS).build()
    @Volatile private var base: HttpUrl? = null
    @Volatile private var cookie = ""
    @Volatile private var expires = 0L
    @Volatile private var generation = 0L
    private val navigationVersion = AtomicLong()
    @Volatile private var sessionEnding = false
    @Volatile private var foreground = false
    private var userId = ""
    private var accountSteamId = ""
    @Volatile private var cacheScope = ""
    private val connectionLock = Any()
    @Volatile private var socket: WebSocket? = null
    private var socketVersion = 0L
    private var socketDeadline = Long.MAX_VALUE
    private var socketWorker: Job? = null
    private var socketConnect: Job? = null
    private val connectionHints = Channel<Unit>(Channel.CONFLATED)
    private var defaultNetwork: Network? = null
    private var lastRecovery = Long.MIN_VALUE
    @Volatile private var recoveryVersion = 0L
    @Volatile private var activeRead: Call? = null
    private class RecoveryInterrupted : IOException()
    private var reconnectAt = 0L
    private var attempts = 0
    @Volatile private var httpRetryAt = 0L
    @Volatile private var syncAt = 0L
    private var now: () -> Long = SystemClock::elapsedRealtime
    private class MetadataRefresh(var job: Job? = null, var nextAt: Long = 0)
    private val friendsRefresh = MetadataRefresh()
    private val mediaRefresh = MetadataRefresh()
    private var metadataVersion = 0L
    private var worker: Job? = null
    private val hints = Channel<Unit>(Channel.CONFLATED)
    // A socket frame or network change only wakes the CPU briefly; hold these while the follow-up
    // HTTP round trips run in the background so the notification is not deferred to the next wake.
    private val syncWake = wakeLock("SteamChat:sync")
    private val connectWake = wakeLock("SteamChat:connect")
    private val outgoing = linkedMapOf<String, Outgoing>()
    private data class Outgoing(val message: Message, val scope: String, val uri: Uri? = null, val confirmedItem: JSONObject? = null,
                                val wireText: String = message.text, val shareUrl: HttpUrl? = null)
    private class HttpFailure(val status: Int) : IOException("HTTP $status")

    init {
        scope.launch {
            gate.withLock {
                if (sessionEnding) return@withLock
                try {
                    val saved = if (sessionLoader == null) vault.load() else sessionLoader.invoke()
                    if (sessionEnding) return@withLock
                    if (saved == null) {
                        mutable.update { it.copy(restoration = SessionRestoration.NONE) }
                        return@withLock
                    }
                    base = Protocol.base(saved.getString("server"))
                    configureServer(base.toString())
                    cookie = saved.getString("cookie"); expires = saved.getLong("expires")
                    if (expires <= System.currentTimeMillis()) { endSession("登录已过期，请重新登录"); return@withLock }
                    validateSession()
                } catch (e: CancellationException) { throw e } catch (e: Exception) {
                    handleFailure(e)
                } finally {
                    mutable.update { if (it.restoration == SessionRestoration.LOADING) it.copy(restoration = SessionRestoration.RETRY) else it }
                }
                startWorker()
            }
        }
        runCatching {
            (context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    synchronized(connectionLock) {
                        if (defaultNetwork == network) return
                        defaultNetwork = network
                        recoverConnection()
                    }
                }
                override fun onLost(network: Network) {
                    synchronized(connectionLock) {
                        if (defaultNetwork != network) return
                        defaultNetwork = null
                        invalidateSocket()
                        mutable.update { if (it.accessAllowed) it.copy(connected = false, connectionText = "网络已断开，等待恢复") else it }
                        connectionHints.trySend(Unit)
                    }
                }
            })
        }
    }

    private fun wakeLock(tag: String) = runCatching {
        context.getSystemService(PowerManager::class.java)?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, tag)?.apply { setReferenceCounted(false) }
    }.getOrNull()
    // Re-acquiring extends the timeout; the timeout bounds battery cost if a release path is missed.
    private fun PowerManager.WakeLock?.hold(timeout: Long) { if (!foreground) runCatching { this?.acquire(timeout) } }
    private fun PowerManager.WakeLock?.drop() { runCatching { if (this?.isHeld == true) release() } }

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
        val call = client.newCall(builder.build())
        val readVersion = synchronized(connectionLock) {
            if (body == null) activeRead = call
            recoveryVersion
        }
        try {
            call.execute().use { response ->
                if (version != generation) throw CancellationException()
                if (body == null && readVersion != recoveryVersion) throw RecoveryInterrupted()
                if (!response.isSuccessful) throw HttpFailure(response.code)
                response.headers.values("Set-Cookie").mapNotNull { Cookie.parse(url, it) }.firstOrNull { it.name == "steam_chat_session" }?.let {
                    cookie = "${it.name}=${it.value}"; expires = minOf(it.expiresAt, System.currentTimeMillis() + 7 * 86400_000L)
                    vault.save(JSONObject().put("server", root.toString()).put("cookie", cookie).put("expires", expires))
                }
                val result = response.body?.byteStream()?.use { String(bounded(it, 4 * 1024 * 1024), Charsets.UTF_8) } ?: "{}"
                if (version != generation) throw CancellationException()
                if (body == null && readVersion != recoveryVersion) throw RecoveryInterrupted()
                return result
            }
        } catch (e: IOException) {
            if (body == null && readVersion != recoveryVersion) throw RecoveryInterrupted()
            throw e
        } finally { if (activeRead === call) activeRead = null }
    }
    private fun json(path: String, body: JSONObject? = null) = JSONObject(request(path, body))

    fun configureServer(server: String) {
        val validated = Protocol.base(server).toString()
        settings.edit().putString("server", validated).apply()
        mutable.update { it.copy(server = validated) }
    }

    fun login(server: String, username: String, password: String) = launchAction {
        val validated = Protocol.base(server)
        endSession("")
        sessionEnding = false
        base = validated
        configureServer(validated.toString())
        mutable.update { it.copy(server = validated.toString(), loading = true, error = "") }
        try {
            json("/api/auth/login", JSONObject().put("username", username).put("password", password))
            require(cookie.isNotEmpty()) { "服务器未返回会话 Cookie" }
            validateSession()
            startWorker(); hints.trySend(Unit)
        } finally { mutable.update { it.copy(loading = false) } }
    }
    private fun validateSession() {
        mutable.update { it.copy(restoration = SessionRestoration.LOADING) }
        try {
            val me = json("/api/auth/me")
            val user = me.optJSONObject("user") ?: throw HttpFailure(401)
            if (user.optBoolean("forcePasswordChange")) { endSession("请在网页版修改密码后重新登录"); return }
            userId = user.getLong("id").toString()
            mutable.update { it.copy(loggedIn = true, username = user.optString("username"), restoration = SessionRestoration.NONE, error = "") }
        } catch (e: HttpFailure) {
            if (e.status == 403) endSession("会话访问被拒绝，请重新登录或在网页版检查账户")
            else throw e
        } finally {
            mutable.update { if (it.restoration == SessionRestoration.LOADING) it.copy(restoration = SessionRestoration.RETRY) else it }
        }
    }
    fun changeServer() {
        logout()
        settings.edit().remove("server").apply()
        mutable.update { it.copy(server = "") }
    }
    fun logout() {
        navigationVersion.incrementAndGet()
        val oldBase = base
        val oldCookie = cookie
        sessionEnding = true
        generation++
        client.dispatcher.cancelAll()
        bilibiliShare.cancel()
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
        navigationVersion.incrementAndGet()
        sessionEnding = true
        generation++
        cancelMetadata()
        httpRetryAt = 0; syncAt = 0; reconnectAt = 0; attempts = 0
        cookie = ""; expires = 0; vault.clear()
        bilibiliShare.cancel()
        worker?.cancel(); worker = null
        synchronized(connectionLock) {
            invalidateSocket()
            socketWorker?.cancel(); socketWorker = null
        }
        client.dispatcher.cancelAll()
        mediaCache.clear()
        cache.clearAll()
        cacheScope = ""; accountSteamId = ""; userId = ""; outgoing.clear()
        mutable.update { AppState(server = it.server, error = error, backgroundEnabled = it.backgroundEnabled, notificationPreview = it.notificationPreview, notificationsEnabled = it.notificationsEnabled) }
        context.stopService(Intent(context, ConnectionService::class.java))
        BackgroundWork.cancel(context)
        syncWake.drop(); connectWake.drop()
        ChatNotifications.clearMessages(context)
    }
    private fun allowed() = !sessionEnding && (state.value.loggedIn || cookie.isNotEmpty()) && (foreground || state.value.backgroundEnabled)
    private fun startWorker() {
        if (!allowed()) return
        startSocketWorker()
        if (worker?.isActive == true) return
        worker = scope.launch {
            var syncRequested = true
            try { while (isActive && allowed()) {
                val wait = gate.withLock {
                    try {
                        if (cookie.isNotEmpty()) {
                            if ((syncRequested || now() >= syncAt || (httpRetryAt > 0 && now() >= httpRetryAt)) && now() >= httpRetryAt) {
                                syncWake.hold(SYNC_WAKE_MS)
                                if (!state.value.loggedIn) validateSession()
                                val pending = state.value.loggedIn && catchUp()
                                httpRetryAt = 0
                                syncAt = now() + when {
                                    pending -> 250
                                    foreground && !state.value.connected -> 3_000
                                    // A live socket delivers sync hints and the server heartbeat prunes dead ones;
                                    // background polling is only a safety net, so spare the radio.
                                    !foreground && state.value.connected -> BACKGROUND_POLL_MS
                                    else -> 30_000
                                }
                                syncRequested = false
                            }
                            connectionHints.trySend(Unit)
                        }
                    } catch (e: CancellationException) { throw e } catch (e: Exception) {
                        handleFailure(e)
                    }
                    connectionHints.trySend(Unit)
                    val next = if (httpRetryAt > 0) httpRetryAt else if (syncRequested) now() else syncAt
                    // Keep the CPU only across back-to-back batches; idle waits may sleep until the next wake.
                    // Re-check at least every 30s so deadlines shortened outside the gate (socket loss) apply;
                    // a re-check that is not due issues no request.
                    (next - now()).coerceIn(1, 30_000).also { if (it > 1_000) syncWake.drop() }
                }
                syncRequested = withTimeoutOrNull(wait) { hints.receive(); true } ?: false
            } } finally { syncWake.drop() }
        }
        updateService()
    }
    private fun catchUp(): Boolean {
        mutable.update { it.copy(restSyncText = "REST 正在同步…", restSyncStatus = RestSyncStatus.SYNCING) }
        try {
            val pending = syncMessages()
            httpRetryAt = 0
            mutable.update { it.copy(restSyncText = when {
                !it.accessAllowed -> "REST 无账户访问权限"
                pending -> "REST 正在分批同步历史…"
                else -> "REST 同步完成"
            }, restSyncStatus = if (pending) RestSyncStatus.SYNCING else RestSyncStatus.READY) }
            return pending
        } catch (e: Exception) {
            mutable.update { it.copy(restSyncText = "REST 同步未完成，等待重试", restSyncStatus = RestSyncStatus.FAILED) }
            throw e
        }
    }
    private fun syncMessages(): Boolean {
        val status = json("/api/steam/status")
        val account = status.optJSONObject("activeAccount")
        val permitted = status.optBoolean("accessAllowed") && account != null
        val steam = if (permitted) account!!.optString("steamId") else ""
        val online = status.optString("status") == "online"
        if (!permitted || steam.isEmpty()) { hideAccount(if (!online) "Steam 未连接，等待管理员登录" else "无 Steam 账户访问权限"); return false }
        val nextScope = JSONArray(listOf(base.toString(), userId, steam)).toString()
        val scopeChanged = nextScope != cacheScope
        if (scopeChanged) {
            val selectedPeer = state.value.selectedPeer
            val selectedName = state.value.selectedName
            val firstAccount = cacheScope.isEmpty()
            hideAccount()
            cacheScope = nextScope; accountSteamId = steam
            if (firstAccount) mutable.update { it.copy(selectedPeer = selectedPeer, selectedName = selectedName) }
        }
        mutable.update { it.copy(activeAccountId = steam, accessAllowed = true, steamOnline = online, connectionText = connectionText(it.connected, online)) }
        // Republishing re-queries conversations and decodes the open chat; the cache only changes when pages ingest rows.
        if (scopeChanged) publishCache()
        // Friends/emoticons only feed the UI; returning to the foreground triggers a sync that refreshes them.
        if (online && foreground) refreshMetadata()
        if (!allowed()) return false
        val checkpoint = cache.checkpoint(cacheScope)
        var fetchingHistory = false
        fun fetchPage(cursor: String?, history: Boolean): JSONObject {
            fetchingHistory = history
            val url = Protocol.endpoint(base!!, "/api/messages/sync").newBuilder().addQueryParameter("limit", "100").addQueryParameter("steamAccountId", accountSteamId).apply {
                if (cursor != null) addQueryParameter("cursor", cursor)
                if (history) addQueryParameter("mode", "history")
            }.build()
            val page = JSONObject(execute(url))
            if (page.getString("steamAccountId") != accountSteamId) {
                hideAccount(); hints.trySend(Unit)
                throw RecoveryInterrupted()
            }
            val next = page.getString("nextCursor")
            require(next.isNotEmpty() && (!page.getBoolean("hasMore") || next != cursor)) { "同步游标未推进" }
            return page
        }
        try {
            if (checkpoint.second || checkpoint.first.isEmpty()) {
                val page = fetchPage(null, history = true)
                val liveCursor = page.getString("liveCursor")
                require(liveCursor.isNotEmpty()) { "缺少增量同步游标" }
                cache.ingestHistory(cacheScope, page.getJSONArray("items"), page.getString("nextCursor"), page.getBoolean("hasMore"), liveCursor)
                if (page.getJSONArray("items").length() > 0) publishCache()
                return page.getBoolean("hasMore")
            }
            // Bounded batches release gate between rounds so user actions can run.
            // Always catch up live messages before spending a request on older history.
            val page = fetchPage(checkpoint.first, history = false)
            val more = page.getBoolean("hasMore")
            val notices = cache.ingest(cacheScope, page.getJSONArray("items"), page.getString("nextCursor"), more, if (foreground) state.value.selectedPeer else "")
            if (page.getJSONArray("items").length() > 0) publishCache()
            for (message in notices) {
                if (state.value.loggedIn && !(foreground && state.value.selectedPeer == message.peerId)) ChatNotifications.message(context, state.value, message)
            }
            if (more) return true
            val historyCursor = cache.historyCursor(cacheScope)
            if (historyCursor != null && allowed()) {
                val history = fetchPage(historyCursor.takeIf { it.isNotEmpty() }, history = true)
                cache.ingestHistory(cacheScope, history.getJSONArray("items"), history.getString("nextCursor"), history.getBoolean("hasMore"),
                    foregroundPeer = if (foreground) state.value.selectedPeer else "")
                if (history.getJSONArray("items").length() > 0) publishCache()
            }
            return cache.historyCursor(cacheScope) != null
        } catch (e: HttpFailure) {
            if (e.status != 409) throw e
            if (fetchingHistory && !checkpoint.second && checkpoint.first.isNotEmpty()) cache.restartHistory(cacheScope)
            else cache.reset(cacheScope)
            return true
        }
    }
    private fun cancelMetadata() {
        metadataVersion++
        for (refresh in listOf(friendsRefresh, mediaRefresh)) {
            refresh.job?.cancel(); refresh.job = null; refresh.nextAt = 0
        }
    }
    private fun refreshMetadata() {
        val root = base ?: return
        val capturedCookie = cookie
        val version = generation
        val account = cacheScope
        val metadata = metadataVersion
        fun current() = version == generation && metadata == metadataVersion && account == cacheScope &&
            cookie == capturedCookie && !sessionEnding && state.value.accessAllowed
        fun launchRefresh(refresh: MetadataRefresh, path: String, interval: Long, publish: (String) -> Unit) {
            if (refresh.job?.isActive == true || now() < refresh.nextAt) return
            refresh.job = scope.launch {
                try {
                    val body = metadataRequest(root, capturedCookie, path)
                    gate.withLock {
                        if (!current()) return@withLock
                        publish(body)
                        refresh.nextAt = now() + interval
                    }
                } catch (e: CancellationException) { throw e } catch (e: Exception) {
                    gate.withLock {
                        if (!current()) return@withLock
                        refresh.nextAt = now() + 30_000
                        if (e is HttpFailure && e.status in listOf(401, 403)) handleFailure(e)
                    }
                }
            }
        }
        launchRefresh(friendsRefresh, "/api/friends", 60_000) { body ->
            val friends = JSONArray(body)
            val parsed = (0 until friends.length()).map { index -> friends.getJSONObject(index).let { f ->
                Friend(f.getString("id"), f.optString("name"), f.optString("avatar"), f.optBoolean("online"), f.optString("gameName"))
            } }
            mutable.update { state ->
                if (!current()) state else state.copy(friends = parsed, conversations = state.conversations.map { conversation ->
                    parsed.find { it.id == conversation.id }?.let { conversation.copy(name = it.name, avatar = it.avatar) } ?: conversation
                })
            }
        }
        launchRefresh(mediaRefresh, "/api/emoticons", 30 * 60_000) { body ->
            val media = JSONObject(body)
            val emoticons = mediaNames(media.optJSONArray("emoticons"))
            val stickers = Protocol.stickerInventory(media.optJSONArray("stickers"))
            mutable.update { if (current()) it.copy(emoticons = emoticons, stickers = stickers.map { sticker -> sticker.name }, stickerInventory = stickers) else it }
        }
    }
    // Metadata never rotates credentials; only serialized authoritative requests may do that.
    private suspend fun metadataRequest(root: HttpUrl, capturedCookie: String, path: String): String = suspendCancellableCoroutine { continuation ->
        val url = Protocol.endpoint(root, path)
        require(url.isHttps && url.host == root.host && url.port == root.port && url.encodedPath.startsWith(root.encodedPath))
        val call = client.newCall(Request.Builder().url(url).header("Cookie", capturedCookie).build())
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { continuation.resumeWith(Result.failure(e)) }
            override fun onResponse(call: Call, response: Response) {
                val result = runCatching {
                    response.use {
                        if (!it.isSuccessful) throw HttpFailure(it.code)
                        it.body?.byteStream()?.use { stream -> String(bounded(stream, 4 * 1024 * 1024), Charsets.UTF_8) } ?: "{}"
                    }
                }
                continuation.resumeWith(result)
            }
        })
    }
    private fun mediaNames(items: JSONArray?): List<String> = if (items == null) emptyList() else (0 until items.length()).mapNotNull {
        when (val item = items.opt(it)) { is String -> item; is JSONObject -> item.optString("name", item.optString("type")).takeIf(String::isNotEmpty); else -> null }
    }
    private fun hideAccount(reason: String = "无 Steam 账户访问权限") {
        navigationVersion.incrementAndGet()
        cancelMetadata()
        synchronized(connectionLock) { invalidateSocket(); reconnectAt = 0; attempts = 0 }
        cacheScope = ""; accountSteamId = ""; outgoing.clear()
        mediaCache.close()
        mutable.update { it.copy(activeAccountId = "", accessAllowed = false, steamOnline = false, connected = false, connectionText = reason, conversations = emptyList(), friends = emptyList(), messages = emptyList(), emoticons = emptyList(), stickers = emptyList(), stickerInventory = emptyList(), selectedPeer = "", selectedName = "") }
        ChatNotifications.clearMessages(context)
    }
    // Never take gate while holding connectionLock: gate may be occupied by a blocking HTTP call.
    private fun invalidateSocket() {
        socketVersion++
        socketConnect?.cancel(); socketConnect = null
        val obsolete = socket
        socket = null
        socketDeadline = Long.MAX_VALUE
        obsolete?.cancel()
    }
    private fun recoverConnection() = synchronized(connectionLock) {
        if (!allowed()) return@synchronized
        connectWake.hold(CONNECT_WAKE_MS)
        invalidateSocket()
        // Coalesce flapping network/lifecycle signals into at most one attempt per second.
        val timestamp = now()
        val deadline = if (lastRecovery == Long.MIN_VALUE) timestamp else maxOf(timestamp, lastRecovery + 1_000)
        if (deadline == timestamp) lastRecovery = timestamp
        attempts = 0
        reconnectAt = deadline
        recoveryVersion++
        activeRead?.cancel() // GET only; never replay or cancel a message POST to reconnect.
        httpRetryAt = deadline
        syncAt = deadline
        mutable.update { if (it.accessAllowed) it.copy(connected = false, connectionText = "正在恢复连接…") else it }
        hints.trySend(Unit)
        startSocketWorker()
        connectionHints.trySend(Unit)
    }
    private fun startSocketWorker() = synchronized(connectionLock) {
        if (!allowed() || socketWorker?.isActive == true) return@synchronized
        socketWorker = scope.launch {
            while (isActive && allowed()) {
                val wait = synchronized(connectionLock) {
                    if (state.value.accessAllowed) {
                        if (socket != null && now() >= socketDeadline) {
                            invalidateSocket()
                            scheduleSocketRetry()
                        }
                        if (socket == null && socketConnect?.isActive != true && now() >= reconnectAt) {
                            socketConnect = scope.launch { connectSocket() }
                        }
                    }
                    val next = when {
                        !state.value.accessAllowed -> Long.MAX_VALUE
                        socket != null -> socketDeadline
                        socketConnect?.isActive == true -> Long.MAX_VALUE
                        else -> reconnectAt
                    }
                    (next - now()).coerceAtLeast(1)
                }
                withTimeoutOrNull(wait) { connectionHints.receive() }
            }
        }
    }
    private fun scheduleSocketRetry() {
        // Backoff timers do not run while the CPU sleeps; the next network event or watchdog run retries instead.
        connectWake.drop()
        attempts = (attempts + 1).coerceAtMost(6)
        reconnectAt = now() + Random.nextLong(1000, (1000L shl attempts).coerceAtMost(60_000))
        mutable.update { if (it.accessAllowed) it.copy(connected = false, connectionText = "实时通道断开，正在重试") else it }
        if (foreground) {
            syncAt = minOf(syncAt, now())
            hints.trySend(Unit)
        } else syncAt = minOf(syncAt, now() + 30_000) // Without hints, fall back to the normal poll interval.
        connectionHints.trySend(Unit)
    }
    private suspend fun connectSocket() {
        val root: HttpUrl
        val version: Long
        val account: String
        val token: Long
        val capturedCookie: String
        synchronized(connectionLock) {
            root = base ?: return
            version = generation
            account = cacheScope
            token = socketVersion
            capturedCookie = cookie
        }
        fun current() = version == generation && account == cacheScope && token == socketVersion &&
            allowed() && state.value.accessAllowed
        try {
            if (expires <= System.currentTimeMillis()) throw HttpFailure(401)
            // Config has its own cancellable deadline/backoff; optional metadata and sync cannot block it.
            val config = withTimeout(15_000) { metadataRequest(root, capturedCookie, "/api/config") }
            val url = Protocol.endpoint(root, JSONObject(config).getString("wsPath"))
            synchronized(connectionLock) {
                if (!current()) return
                if (cookie != capturedCookie) { scheduleSocketRetry(); return }
                mutable.update { it.copy(connected = false, connectionText = "正在连接实时通道…") }
                socketDeadline = now() + 20_000
                socket = (socketFactory ?: client).newWebSocket(Request.Builder().url(url).header("Cookie", capturedCookie).build(), object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) = synchronized(connectionLock) {
                        if (!current() || socket !== webSocket) { webSocket.cancel(); return@synchronized }
                        // OkHttp's 30s ping + next-ping timeout detects an idle half-open socket.
                        socketDeadline = Long.MAX_VALUE
                        attempts = 0
                        mutable.update { it.copy(connected = true, connectionText = connectionText(true, it.steamOnline)) }
                        // Hand the wake over to the catch-up sync that the open triggers.
                        syncWake.hold(SYNC_WAKE_MS)
                        connectWake.drop()
                        hints.trySend(Unit)
                        connectionHints.trySend(Unit)
                        Unit
                    }
                    override fun onMessage(webSocket: WebSocket, text: String) = synchronized(connectionLock) {
                        if (!current() || socket !== webSocket) return@synchronized
                        val type = runCatching { JSONObject(text).optString("type") }.getOrNull()
                        if (type in listOf("sync_available", "message", "ready", "steam_status", "status")) {
                            syncWake.hold(SYNC_WAKE_MS)
                            hints.trySend(Unit)
                        }
                        Unit
                    }
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(code, null)
                        failed(webSocket, null)
                    }
                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = failed(webSocket, null)
                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = failed(webSocket, response?.code)
                    private fun failed(webSocket: WebSocket, status: Int?) = synchronized(connectionLock) {
                        if (!current() || socket !== webSocket) return@synchronized
                        invalidateSocket()
                        scheduleSocketRetry()
                        if (status == 401 || status == 403) rejectSocketAuthorization(status, version, account, capturedCookie)
                    }
                })
            }
        } catch (e: CancellationException) {
            if (e !is TimeoutCancellationException) throw e
            synchronized(connectionLock) { if (current()) scheduleSocketRetry() }
        } catch (e: Exception) {
            synchronized(connectionLock) {
                if (current()) {
                    scheduleSocketRetry()
                    if (e is HttpFailure && e.status in listOf(401, 403)) rejectSocketAuthorization(e.status, version, account, capturedCookie)
                }
            }
        } finally {
            synchronized(connectionLock) {
                if (token == socketVersion) socketConnect = null
                connectionHints.trySend(Unit)
            }
        }
    }
    private fun rejectSocketAuthorization(status: Int, version: Long, account: String, capturedCookie: String) {
        // Stop retries immediately, then let authoritative account cleanup serialize with HTTP.
        reconnectAt = Long.MAX_VALUE
        val token = socketVersion
        launchAction {
            synchronized(connectionLock) {
                if (version == generation && account == cacheScope && token == socketVersion) {
                    if (cookie == capturedCookie) handleFailure(HttpFailure(status))
                    else { reconnectAt = now(); connectionHints.trySend(Unit) }
                }
            }
        }
    }
    private fun connectionText(connected: Boolean, steam: Boolean) = when { !connected -> "实时通道未连接"; !steam -> "实时通道已连接，Steam 离线"; else -> "实时通道已连接" }
    private fun handleFailure(error: Throwable) {
        if (error is CancellationException || error is RecoveryInterrupted) return
        when ((error as? HttpFailure)?.status) {
            401 -> endSession("登录已过期，请重新登录")
            403 -> {
                hideAccount()
                httpRetryAt = now() + 30_000
                mutable.update { it.copy(error = "访问被拒绝；如需修改密码，请前往网页版") }
            }
            else -> {
                httpRetryAt = now() + 30_000
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
    fun selectConversation(id: String, name: String) {
        val navigation = navigationVersion.incrementAndGet()
        val account = cacheScope
        val session = generation
        fun current() = navigation == navigationVersion.get() && session == generation &&
            account == cacheScope && !sessionEnding && state.value.loggedIn
        launchAction {
            if (!current()) return@launchAction
            if (account.isNotEmpty() && state.value.accessAllowed) {
                cache.read(account, id)
                if (!current()) return@launchAction
                ChatNotifications.clearPeer(context, id)
                // Publish peer and its cached messages together; an intermediate empty
                // list would clamp the peer's restored LazyListState to the first row.
                publishCache(id, name, navigation, ::current)
            } else {
                mutable.update { if (current()) it.copy(selectedPeer = id, selectedName = name, selectionRequest = navigation, messages = emptyList()) else it }
            }
        }
    }
    fun leaveConversation() {
        val navigation = navigationVersion.incrementAndGet()
        mutable.update { it.copy(selectedPeer = "", selectedName = "", selectionRequest = navigation, messages = emptyList()) }
    }
    private fun publishCache() = publishCache(null, null, null) { true }
    private fun publishCache(selectedPeer: String?, selectedName: String?, selectionRequest: Long?, valid: () -> Boolean) {
        val account = cacheScope
        if (account.isEmpty() || !state.value.accessAllowed || !valid()) return
        outgoing.entries.removeAll { (_, item) -> item.scope == account && item.confirmedItem?.let { cache.containsConfirmed(account, it) } == true }
        val cachedConversations = cache.conversations(account)
        mutable.update { current ->
            if (!valid() || account != cacheScope || sessionEnding || !current.accessAllowed) return@update current
            val peer = selectedPeer ?: current.selectedPeer
            val conversations = cachedConversations.map { c -> current.friends.find { it.id == c.id }?.let { c.copy(name = it.name, avatar = it.avatar) } ?: c }
            val messages = if (peer.isEmpty()) emptyList() else cache.messages(account, peer) + outgoing.values.filter { it.scope == account && it.message.peerId == peer }.map { it.message }
            if (!valid() || account != cacheScope || sessionEnding) current
            else current.copy(selectedPeer = peer, selectedName = selectedName ?: current.selectedName,
                selectionRequest = selectionRequest ?: current.selectionRequest, conversations = conversations, messages = messages)
        }
    }
    fun sendText(text: String) { if (text.isNotBlank()) queueSend(text, null, shareUrl = BilibiliShare.extract(text)) }
    fun sendImage(uri: Uri) = queueSend("[图片]", uri)
    fun sendSticker(raw: String) {
        val name = Protocol.stickerName(raw) ?: return
        queueSend("[sticker type=\"$name\" limit=\"0\"][/sticker]", null, "/sticker $name")
    }
    private fun queueSend(text: String, uri: Uri?, wireText: String = text, shareUrl: HttpUrl? = null) {
        val peer = state.value.selectedPeer
        val account = cacheScope
        launchAction {
            if (!state.value.canSend || peer.isEmpty() || account != cacheScope) return@launchAction
            val message = Message("local:${UUID.randomUUID()}", peer, state.value.username, text, true, Instant.now().toString(), pending = true, imageUrl = uri?.toString())
            val item = Outgoing(message, cacheScope, uri, wireText = wireText, shareUrl = shareUrl)
            prepareAndTransmit(item)
        }
    }
    fun retryMessage(key: String) = launchAction {
        val item = outgoing[key] ?: return@launchAction
        if (!state.value.canSend || !item.message.failed || item.scope != cacheScope) return@launchAction
        prepareAndTransmit(item.copy(message = item.message.copy(pending = true, failed = false, error = "")))
    }
    private fun prepareAndTransmit(item: Outgoing) {
        val url = item.shareUrl ?: return transmit(item)
        outgoing[item.message.key] = item; publishCache()
        val version = generation
        // Public short-link resolution never occupies the message sync/action gate.
        scope.launch {
            if (version != generation || sessionEnding) return@launch
            val result = try { Result.success(bilibiliShare.resolve(url)) }
                catch (e: TimeoutCancellationException) { Result.failure(e) }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { Result.failure(e) }
            gate.withLock {
                if (version != generation || sessionEnding || item.scope != cacheScope || outgoing[item.message.key] !== item) return@withLock
                val text = result.getOrNull()
                if (text != null && state.value.canSend) {
                    transmit(item.copy(message = item.message.copy(text = text), wireText = text, shareUrl = null))
                } else {
                    outgoing[item.message.key] = item.copy(message = item.message.copy(pending = false, failed = true,
                        retryMayDuplicate = false, error = if (text == null) "哔哩哔哩链接解析失败，消息尚未发送。请重试。" else "当前无法发送消息，请恢复连接后重试。"))
                    publishCache()
                }
            }
        }
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
            if (status.optString("status") != "online") {
                mutable.update { it.copy(steamOnline = false) }
                error("Steam 未在线")
            }
            val body = JSONObject().put("id", item.message.peerId).put("steamAccountId", accountSteamId)
            val path = if (item.uri != null) {
                require(item.uri.scheme == "content") { "Only content URIs are supported" }
                val bytes = context.contentResolver.openInputStream(item.uri)?.use { bounded(it, 6 * 1024 * 1024) } ?: error("Cannot read image")
                require(bytes.isNotEmpty())
                body.put("img", Base64.encodeToString(bytes, Base64.NO_WRAP)); "/image"
            } else { body.put("msg", item.wireText); "/message" }
            val response = json(path, body)
            check(response.optBoolean("ok"))
            val committed = response.optJSONObject("item")
            outgoing[item.message.key] = item.copy(
                message = item.message.copy(text = committed?.opt("message") as? String ?: item.message.text,
                    pending = false, failed = false, error = ""),
                confirmedItem = committed
            )
            hints.trySend(Unit)
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            outgoing[item.message.key] = item.copy(message = item.message.copy(pending = false, failed = true, retryMayDuplicate = true, error = "发送结果不确定，可能已送达。手动重试可能重复发送。"))
            handleFailure(e)
        }
        publishCache()
    }
    suspend fun imageBytes(source: String): ByteArray? = withContext(Dispatchers.IO) {
        val version = generation
        val account = cacheScope
        if (!state.value.loggedIn || !state.value.accessAllowed || account.isEmpty() || sessionEnding || cookie.isEmpty()) return@withContext null
        fun authorized() = version == generation && account == cacheScope && !sessionEnding &&
            state.value.loggedIn && state.value.accessAllowed && cookie.isNotEmpty() && expires > System.currentTimeMillis()
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
            val imagePath = Protocol.endpoint(root, "/proxy/image").encodedPath
            val stickerPath = Protocol.endpoint(root, "/proxy/sticker/").encodedPath
            require(url.encodedPath == imagePath || url.encodedPath.startsWith(stickerPath))
            if (expires <= System.currentTimeMillis()) throw HttpFailure(401)
            val stickerRoot = Protocol.endpoint(root, "/proxy/sticker/")
            val sticker = if (url.encodedPath.startsWith(stickerRoot.encodedPath) && url.pathSegments.size == stickerRoot.pathSegments.size)
                Protocol.stickerForName(url.pathSegments.last(), state.value.stickerInventory) else null
            val candidates = if (sticker == null) listOf(url) else buildList {
                // Prefer the canonical animated sticker; inventory artwork is a fallback for missing endpoints.
                add(Protocol.endpoint(root, Protocol.stickerPath(sticker.name)))
                if (sticker.imageUrl.isNotEmpty()) add(Protocol.endpoint(root, "/proxy/image").newBuilder().addQueryParameter("url", sticker.imageUrl).build())
                add(url)
            }.distinct()
            val mediaClient = mediaCache.client(account, client, ::authorized) ?: return@withContext null
            for ((index, candidate) in candidates.withIndex()) {
                if (!authorized()) return@withContext null
                val bytes = mediaClient.newCall(Request.Builder().url(candidate).header("Cookie", cookie).build()).execute().use {
                    if (!it.isSuccessful) {
                        if (it.code in listOf(401, 403, 429) || index == candidates.lastIndex) throw HttpFailure(it.code)
                        null
                    } else it.body?.byteStream()?.use { stream -> bounded(stream, 10 * 1024 * 1024) }
                }
                if (bytes != null) return@withContext if (authorized()) bytes else null
            }
            null
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
    fun onForegroundChanged(value: Boolean) {
        val returning = value && !foreground
        foreground = value
        if (returning) recoverConnection()
        reconcile()
    }
    fun clearError() { mutable.update { it.copy(error = "") } }
    private fun reconcile() = launchAction {
        if (allowed()) { startWorker(); hints.trySend(Unit) } else {
            worker?.cancel(); worker = null
            synchronized(connectionLock) {
                invalidateSocket()
                socketWorker?.cancel(); socketWorker = null
            }
            syncWake.drop(); connectWake.drop()
            mutable.update { it.copy(connected = false, connectionText = "后台连接已暂停") }
        }
        if (foreground && cacheScope.isNotEmpty() && state.value.selectedPeer.isNotEmpty()) { cache.read(cacheScope, state.value.selectedPeer); publishCache() }
        updateService()
    }
    private fun updateService() {
        // A saved session that is still being validated (e.g. no network yet after boot) keeps the service.
        if (!sessionEnding && (state.value.loggedIn || cookie.isNotEmpty()) && state.value.backgroundEnabled) {
            BackgroundWork.schedule(context)
            if (ConnectionService.running) return
            // Android may disallow a background FGS start unless battery-exempt; next visible activity retries.
            runCatching { ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java)) }
                .onFailure { mutable.update { it.copy(error = "系统未允许后台服务，可在设置中允许忽略电池优化，或打开应用以恢复后台连接") } }
        } else {
            context.stopService(Intent(context, ConnectionService::class.java))
            BackgroundWork.cancel(context)
        }
    }
    fun onServiceStarted() = launchAction {
        if (allowed()) startWorker()
        else if (cookie.isEmpty()) context.stopService(Intent(context, ConnectionService::class.java))
    }
    /** Boot/package-replaced broadcast: start the service synchronously while the broadcast still permits it. */
    fun onSystemStart() {
        if (!state.value.backgroundEnabled || !vault.exists()) return
        // The service's start command reconciles once session restore finishes and stops itself if it fails.
        runCatching { ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java)) }
    }
    /** WorkManager fallback: revive the service and socket, then hold the worker's wake for one bounded catch-up. */
    suspend fun backgroundCheck() {
        val version = generation
        withTimeoutOrNull(SYNC_WAKE_MS) {
            gate.withLock {
                if (version != generation || !allowed() || cookie.isEmpty()) return@withLock
                updateService()
                synchronized(connectionLock) {
                    if (socket == null && socketConnect?.isActive != true) {
                        connectWake.hold(CONNECT_WAKE_MS)
                        reconnectAt = now()
                        connectionHints.trySend(Unit)
                    }
                }
                try {
                    if (!state.value.loggedIn) validateSession()
                    if (state.value.loggedIn) {
                        val pending = catchUp()
                        syncAt = now() + if (pending) 250 else 30_000
                    }
                    httpRetryAt = 0
                } catch (e: CancellationException) { throw e } catch (e: Exception) {
                    handleFailure(e)
                }
                startWorker()
            }
        }
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
    private companion object {
        const val SYNC_WAKE_MS = 60_000L // Covers status + sync round trips within the 45s call timeout.
        const val CONNECT_WAKE_MS = 30_000L // Config request plus the 20s handshake deadline.
        const val BACKGROUND_POLL_MS = 60_000L
    }
}
