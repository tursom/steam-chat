package io.github.steamchat.android.data

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

object Protocol {
    fun base(raw: String): HttpUrl {
        require(!raw.contains('\\')) { "Invalid server URL" }
        val url = raw.trim().toHttpUrl()
        require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null) { "Use an HTTPS server URL without credentials, query or fragment" }
        // An empty user-info component is also forbidden.
        require(!raw.substringAfter("://").substringBefore('/').contains('@')) { "Credentials are forbidden" }
        return url.newBuilder().encodedPath(url.encodedPath.trimEnd('/') + "/").build()
    }

    fun endpoint(base: HttpUrl, path: String): HttpUrl {
        require(!path.contains('\\') && !path.startsWith("//") && !path.contains("://"))
        val result = base.resolve(path.removePrefix("/")) ?: error("Invalid endpoint")
        require(result.scheme == base.scheme && result.host == base.host && result.port == base.port && result.encodedPath.startsWith(base.encodedPath))
        require(result.fragment == null && result.username.isEmpty() && result.password.isEmpty())
        return result
    }

    fun timestampMillis(timestamp: String): Long? = runCatching { Instant.parse(timestamp).toEpochMilli() }.getOrElse {
        runCatching { LocalDateTime.parse(timestamp.replace(' ', 'T')).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli() }.getOrNull()
    }

    fun semanticIdentity(item: JSONObject): String {
        val timestamp = item.optString("sentAt").ifEmpty { item.optString("date") }
        val identity = JSONArray().put(item.optString("id")).put(item.optBoolean("echo"))
            .put(timestampMillis(timestamp)?.toString() ?: timestamp).put(item.optString("ordinal", "0"))
            .put(item.optString("message")).toString()
        return MessageDigest.getInstance("SHA-256").digest(identity.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    fun freshIncoming(bootstrap: Boolean, echo: Boolean, timestamp: String, now: Long, notificationFloor: Long = now - 5 * 60_000): Boolean {
        if (bootstrap || echo) return false
        val at = timestampMillis(timestamp) ?: return false
        return at in notificationFloor..(now + 60_000)
    }

    fun bootstrapAfterPage(bootstrap: Boolean, hasMore: Boolean) = bootstrap && hasMore

    fun shouldNotify(inserted: Boolean, freshIncoming: Boolean, peer: String, foregroundPeer: String) =
        inserted && freshIncoming && peer != foregroundPeer

    fun duplicate(syncId: String, eventId: String, syncIds: Set<String>, eventIds: Set<String>) =
        syncId in syncIds || (eventId.isNotEmpty() && eventId in eventIds)
}
