package io.github.steamchat.android.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import android.widget.ImageView
import androidx.core.net.toUri
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
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import com.github.penfeizhou.animation.FrameAnimationDrawable
import com.github.penfeizhou.animation.apng.APNGDrawable
import com.github.penfeizhou.animation.apng.decode.APNGParser
import com.github.penfeizhou.animation.gif.GifDrawable
import com.github.penfeizhou.animation.gif.decode.GifParser
import com.github.penfeizhou.animation.io.StreamReader
import com.github.penfeizhou.animation.loader.Loader
import com.github.penfeizhou.animation.webp.WebPDrawable
import com.github.penfeizhou.animation.webp.decode.WebPParser
import io.github.steamchat.android.ChatRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

internal sealed interface UiMedia {
    val cacheBytes: Int
    class Still(val bitmap: Bitmap) : UiMedia {
        override val cacheBytes get() = bitmap.allocationByteCount
    }
    // Cache only immutable source data, never playback state or a Drawable callback.
    class Animated(private val bytes: ByteArray, val format: AnimationFormat) : UiMedia {
        override val cacheBytes get() = bytes.size
        fun newDrawable(): FrameAnimationDrawable<*> = format.drawable(bytes).apply { setAutoPlay(false) }
    }
}

internal enum class AnimationFormat {
    APNG, GIF, WEBP;
    fun drawable(bytes: ByteArray): FrameAnimationDrawable<*> {
        val loader = Loader { StreamReader(ByteArrayInputStream(bytes)) }
        return when (this) {
            APNG -> APNGDrawable(loader)
            GIF -> GifDrawable(loader)
            WEBP -> WebPDrawable(loader)
        }
    }
}

/** Account-scoped cache: bitmap allocation bytes and animated encoded bytes share the 24 MiB budget. */
class UiImageLoader(private val repository: ChatRepository) {
    private val cache = object : LruCache<String, UiMedia>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: UiMedia) = value.cacheBytes
    }
    private val permits = Semaphore(3)
    private val epoch = MutableStateFlow(0L)
    internal val generation = epoch.asStateFlow()
    @Synchronized fun clear() { epoch.value++; cache.evictAll() }

    internal suspend fun load(source: String, context: Context, version: Long = generation.value): UiMedia? =
        withContext(Dispatchers.IO) {
            permits.withPermit {
                currentCoroutineContext().ensureActive()
                synchronized(this@UiImageLoader) {
                    if (epoch.value != version) return@withPermit null
                    cache.get(source)?.let { return@withPermit it }
                }
                val bytes = if (source.startsWith("content://")) readLocal(context, source.toUri())
                    else safeImageSource(source)?.let { repository.imageBytes(it) }
                currentCoroutineContext().ensureActive()
                val media = bytes?.let(::decodeMedia)
                currentCoroutineContext().ensureActive()
                synchronized(this@UiImageLoader) {
                    if (epoch.value != version) null else media?.also { cache.put(source, it) }
                }
            }
        }

    private suspend fun readLocal(context: Context, uri: Uri): ByteArray? = runCatching {
        context.contentResolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                currentCoroutineContext().ensureActive()
                val count = input.read(buffer)
                if (count < 0) break
                if (out.size() + count > MAX_MEDIA_BYTES) return@use null
                out.write(buffer, 0, count)
            }
            out.toByteArray()
        }
    }.getOrNull()
}

internal const val MAX_MEDIA_BYTES = 20 * 1024 * 1024
internal const val MAX_MEDIA_DIMENSION = 1600

internal fun decodeMedia(bytes: ByteArray): UiMedia? {
    if (bytes.isEmpty() || bytes.size > MAX_MEDIA_BYTES) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth !in 1..100000 || bounds.outHeight !in 1..100000) return null
    fun reader() = StreamReader(ByteArrayInputStream(bytes))
    val format = when {
        bounds.outMimeType == "image/png" && APNGParser.isAPNG(reader()) -> AnimationFormat.APNG
        bounds.outMimeType == "image/gif" && GifParser.isGif(reader()) -> AnimationFormat.GIF
        bounds.outMimeType == "image/webp" && WebPParser.isAWebP(reader()) -> AnimationFormat.WEBP
        else -> null
    }
    if (format != null) {
        // This decoder allocates its original canvas before sampling. Reject oversized animations
        // rather than letting a small ImageView disguise an unbounded initial allocation.
        if (bounds.outWidth > MAX_MEDIA_DIMENSION || bounds.outHeight > MAX_MEDIA_DIMENSION) return null
        return UiMedia.Animated(bytes, format)
    }
    var sample = 1
    while (bounds.outWidth / sample > MAX_MEDIA_DIMENSION || bounds.outHeight / sample > MAX_MEDIA_DIMENSION) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size,
        BitmapFactory.Options().apply { inSampleSize = sample })?.let(UiMedia::Still)
}

/** Called off the UI thread, before a library decoder can render any subframes. */
internal fun prepareAnimation(media: UiMedia.Animated): FrameAnimationDrawable<*>? {
    val drawable = media.newDrawable()
    return try {
        val decoder = drawable.frameSeqDecoder
        val bounds = decoder.bounds
        val valid = bounds.width() in 1..MAX_MEDIA_DIMENSION && bounds.height() in 1..MAX_MEDIA_DIMENSION &&
            decoder.frameCount in 1..1000 && (0 until decoder.frameCount).all { index ->
                val frame = decoder.getFrame(index)
                frame != null && frame.frameWidth in 1..bounds.width() && frame.frameHeight in 1..bounds.height() &&
                    frame.frameX >= 0 && frame.frameY >= 0 &&
                    frame.frameX.toLong() + frame.frameWidth <= bounds.width() &&
                    frame.frameY.toLong() + frame.frameHeight <= bounds.height()
            }
        if (valid) drawable else { releaseAnimation(drawable); null }
    } catch (_: Exception) {
        releaseAnimation(drawable)
        null
    }
}

internal fun releaseAnimation(drawable: FrameAnimationDrawable<*>) {
    drawable.setAutoPlay(false)
    drawable.stop()
    drawable.frameSeqDecoder.stop()
    drawable.clearAnimationCallbacks()
    drawable.callback = null
}

@Composable
fun MediaImage(source: String, loader: UiImageLoader, description: String, modifier: Modifier = Modifier,
               contentScale: ContentScale = ContentScale.Fit, fallback: String = "图片不可用") {
    val context = LocalContext.current
    val generation by loader.generation.collectAsState()
    val requestGeneration = remember(source, loader) { generation }
    var media by remember(source, loader) { mutableStateOf<UiMedia?>(null) }
    var loading by remember(source, loader) { mutableStateOf(true) }
    var visible by remember(source, loader) { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle.currentStateAsState().value
    LaunchedEffect(source, loader, generation) {
        media = null
        try {
            if (requestGeneration == generation) media = loader.load(source, context, requestGeneration)
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { media = null }
        finally { loading = false }
    }
    Box(modifier.background(MaterialTheme.colorScheme.surfaceVariant).onGloballyPositioned {
        val bounds = it.boundsInWindow()
        visible = it.isAttached && bounds.width > 0 && bounds.height > 0
    }, contentAlignment = Alignment.Center) {
        val image = media.takeIf { generation == requestGeneration }
        when (image) {
            is UiMedia.Still -> Image(image.bitmap.asImageBitmap(), description, Modifier.fillMaxSize(), contentScale = contentScale)
            is UiMedia.Animated -> if (visible && lifecycle.isAtLeast(Lifecycle.State.STARTED)) {
                AnimatedMedia(image, description, contentScale, fallback)
            }
            null -> if (loading) CircularProgressIndicator() else Text(fallback, style = MaterialTheme.typography.labelSmall)
        }
    }
}

private class AnimationImageView(context: Context) : ImageView(context) {
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        (drawable as? FrameAnimationDrawable<*>)?.let {
            it.callback = this
            if (!it.isRunning) it.start()
        }
    }

    override fun onDetachedFromWindow() {
        (drawable as? FrameAnimationDrawable<*>)?.let(::releaseAnimation)
        super.onDetachedFromWindow()
    }
}

@Composable
private fun AnimatedMedia(media: UiMedia.Animated, description: String, contentScale: ContentScale, fallback: String) {
    var drawable by remember(media) { mutableStateOf<FrameAnimationDrawable<*>?>(null) }
    var failed by remember(media) { mutableStateOf(false) }
    LaunchedEffect(media) {
        // Keep ownership inside the try/finally, including cancellation during the IO -> main handoff.
        var owned: FrameAnimationDrawable<*>? = null
        try {
            withContext(Dispatchers.IO) { owned = prepareAnimation(media) }
            drawable = owned
            failed = owned == null
            kotlinx.coroutines.awaitCancellation()
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { failed = true }
        finally { drawable = null; owned?.let(::releaseAnimation) }
    }
    val image = drawable
    if (image != null) {
        AndroidView(factory = { context -> AnimationImageView(context) }, modifier = Modifier.fillMaxSize(),
            onRelease = { view -> view.setImageDrawable(null); releaseAnimation(image) },
            update = { view ->
                view.contentDescription = description
                view.scaleType = when (contentScale) {
                    ContentScale.Crop -> ImageView.ScaleType.CENTER_CROP
                    ContentScale.FillBounds -> ImageView.ScaleType.FIT_XY
                    ContentScale.Inside -> ImageView.ScaleType.CENTER_INSIDE
                    ContentScale.None -> ImageView.ScaleType.CENTER
                    else -> ImageView.ScaleType.FIT_CENTER
                }
                if (view.drawable !== image) {
                    view.setImageDrawable(image)
                    if (view.isAttachedToWindow) image.start()
                }
            })
    } else if (failed) Text(fallback, style = MaterialTheme.typography.labelSmall)
    else CircularProgressIndicator()
}
