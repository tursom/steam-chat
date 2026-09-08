package io.github.steamchat.android.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.core.net.toUri
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import io.github.steamchat.android.ChatRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/** Account-scoped, decoded-byte bounded cache. No bitmap recycling while Compose may still draw it. */
class UiImageLoader(private val repository: ChatRepository) {
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
    }
    private val permits = Semaphore(3)
    private var generation = 0
    @Synchronized fun clear() { generation++; cache.evictAll() }
    suspend fun load(source: String, context: Context): Bitmap? = withContext(Dispatchers.IO) {
        cache.get(source)?.let { return@withContext it }
        val version = synchronized(this@UiImageLoader) { generation }
        permits.withPermit {
            cache.get(source)?.let { return@withPermit it }
            val bytes = if (source.startsWith("content://")) readLocal(context, source.toUri())
                else safeImageSource(source)?.let { repository.imageBytes(it) }
            val bitmap = bytes?.takeIf { it.size <= MAX_BYTES }?.let(::decodeBounded)
            synchronized(this@UiImageLoader) {
                if (generation != version) null else bitmap?.also { cache.put(source, it) }
            }
        }
    }
    private fun readLocal(context: Context, uri: Uri): ByteArray? = runCatching {
        context.contentResolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (out.size() + count > MAX_BYTES) return@use null
                out.write(buffer, 0, count)
            }
            out.toByteArray()
        }
    }.getOrNull()
    private fun decodeBounded(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth > 100000 || bounds.outHeight > 100000) return null
        var sample = 1
        while (bounds.outWidth / sample > 1600 || bounds.outHeight / sample > 1600) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }
    companion object { private const val MAX_BYTES = 20 * 1024 * 1024 }
}

@Composable
fun MediaImage(source: String, loader: UiImageLoader, description: String, modifier: Modifier = Modifier,
               contentScale: ContentScale = ContentScale.Fit, fallback: String = "图片不可用") {
    val context = LocalContext.current
    var bitmap by remember(source, loader) { mutableStateOf<Bitmap?>(null) }
    var loading by remember(source, loader) { mutableStateOf(true) }
    LaunchedEffect(source, loader) {
        try { bitmap = loader.load(source, context) }
        catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { bitmap = null }
        finally { loading = false }
    }
    Box(modifier.background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
        val image = bitmap
        if (image != null) Image(image.asImageBitmap(), description, Modifier.fillMaxSize(), contentScale = contentScale)
        else if (loading) CircularProgressIndicator()
        else Text(fallback, style = MaterialTheme.typography.labelSmall)
    }
}
