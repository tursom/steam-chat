package io.github.steamchat.android.data

import okhttp3.Cache
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import java.io.Closeable
import java.io.File
import java.security.MessageDigest

/** One account partition, bounded by OkHttp's journaled HTTP disk cache. */
class MediaDiskCache(private val directory: File, private val maxBytes: Long = 128L * 1024 * 1024) : Closeable {
    private var activeScope: String? = null
    private var activeClient: OkHttpClient? = null
    private var cache: Cache? = null

    @Synchronized fun client(scope: String, base: OkHttpClient, authorized: () -> Boolean): OkHttpClient? {
        if (scope.isEmpty() || !authorized()) return null
        if (scope == activeScope) activeClient?.let { return it }
        close()
        val key = MessageDigest.getInstance("SHA-256").digest(scope.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        directory.mkdirs()
        directory.listFiles()?.filter { it.name != key }?.forEach { it.deleteRecursively() }
        val disk = Cache(File(directory, key), maxBytes)
        val client = base.newBuilder().dispatcher(Dispatcher()).cache(disk).addNetworkInterceptor { chain ->
            val response = chain.proceed(chain.request())
            val sensitiveVary = response.headers.values("Vary").flatMap { it.split(',') }
                .any { it.trim().equals("Cookie", true) || it.trim().equals("Authorization", true) }
            val clean = response.newBuilder().removeHeader("Set-Cookie").removeHeader("Set-Cookie2")
            // Vary credentials would otherwise be serialized in OkHttp's cache entry.
            // Replacing Vary also protects conditional 304 cache metadata updates.
            if (sensitiveVary) clean.header("Vary", "*").header("Cache-Control", "no-store")
            if (response.code != 304 && (response.code != 200 || !response.header("Content-Type").orEmpty().startsWith("image/", true))) {
                clean.header("Cache-Control", "no-store")
            }
            clean.build()
        }.build()
        cache = disk
        activeClient = client
        activeScope = scope
        return client
    }

    @Synchronized override fun close() {
        activeClient?.dispatcher?.cancelAll()
        activeClient = null
        activeScope = null
        runCatching { cache?.close() }
        cache = null
    }

    @Synchronized fun clear() {
        close()
        directory.deleteRecursively()
    }
}
