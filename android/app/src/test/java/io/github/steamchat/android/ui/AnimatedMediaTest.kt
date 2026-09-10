package io.github.steamchat.android.ui

import android.app.Application
import android.graphics.Color
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import com.github.penfeizhou.animation.FrameAnimationDrawable
import io.github.steamchat.android.ChatRepository
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AnimatedMediaTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val context get() = RuntimeEnvironment.getApplication()
    private fun fixture(name: String) = javaClass.getResourceAsStream("/animation/$name")!!.use { it.readBytes() }
    private fun local(name: String): String {
        val uri = Uri.parse("content://animation.test/$name")
        shadowOf(context.contentResolver).registerInputStream(uri, ByteArrayInputStream(fixture(name)))
        return uri.toString()
    }

    @Test fun apngAndWebpDecodeDifferentCanvasPixels() {
        for ((name, format) in listOf("png" to AnimationFormat.APNG, "webp" to AnimationFormat.WEBP)) {
            val media = decodeMedia(fixture("two-frames.$name")) as UiMedia.Animated
            assertEquals(format, media.format)
            val drawable = prepareAnimation(media)!!
            val decoder = drawable.frameSeqDecoder
            assertEquals(2, decoder.frameCount)
            assertEquals(8, decoder.bounds.width())
            assertEquals(6, decoder.bounds.height())
            assertFalse(drawable.isRunning)
            val first = decoder.getFrameBitmap(0)!!
            val second = decoder.getFrameBitmap(1)!!
            assertEquals("$name first canvas", Color.RED, first.getPixel(4, 3))
            assertEquals("$name second canvas", Color.BLUE, second.getPixel(4, 3))
            first.recycle()
            second.recycle()
            releaseAnimation(drawable)
        }
    }

    @Test fun staticFormatsAndLimits() {
        assertEquals(AnimationFormat.GIF, (decodeMedia(fixture("two-frames.gif")) as UiMedia.Animated).format)
        assertTrue(decodeMedia(fixture("static.png")) is UiMedia.Still)
        assertTrue(decodeMedia(fixture("static.jpg")) is UiMedia.Still)
        assertNull(decodeMedia(fixture("oversized.png")))
        assertNull(decodeMedia(ByteArray(MAX_MEDIA_BYTES + 1)))
        assertNull(decodeMedia(byteArrayOf(1, 2, 3)))
        assertNull(decodeMedia(byteArrayOf()))
    }

    @Test fun encodedCacheNeverSharesDrawableOrDecoder() = runBlocking {
        val loader = UiImageLoader(ChatRepository(context))
        val source = local("two-frames.png")
        val first = loader.load(source, context) as UiMedia.Animated
        val second = loader.load(source, context) as UiMedia.Animated
        assertSame(first, second)
        assertEquals(fixture("two-frames.png").size, first.cacheBytes)
        val a = prepareAnimation(first)!!
        val b = prepareAnimation(second)!!
        assertNotSame(a, b)
        assertNotSame(a.frameSeqDecoder, b.frameSeqDecoder)
        releaseAnimation(a)
        releaseAnimation(b)
        val oldGeneration = loader.generation.value
        loader.clear()
        assertNull(loader.load(source, context, oldGeneration))
    }

    @Test fun clearRejectsInFlightLocalRead() = runBlocking {
        val loader = UiImageLoader(ChatRepository(context))
        val entered = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val uri = Uri.parse("content://animation.test/blocked")
        shadowOf(context.contentResolver).registerInputStream(uri, object : ByteArrayInputStream(fixture("two-frames.png")) {
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                entered.countDown()
                check(resume.await(10, TimeUnit.SECONDS))
                return super.read(b, off, len)
            }
        })
        val loading = async(kotlinx.coroutines.Dispatchers.Default) { loader.load(uri.toString(), context) }
        try {
            assertTrue(entered.await(10, TimeUnit.SECONDS))
            loader.clear()
        } finally { resume.countDown() }
        assertNull(loading.await())
    }

    @Test fun compositionLifecycleAndAccountClearReleasePlayback() {
        val loader = UiImageLoader(ChatRepository(context))
        val source = local("two-frames.png")
        val shown = mutableStateOf(true)
        val owner = object : LifecycleOwner {
            val registry = LifecycleRegistry.createUnsafe(this)
            override val lifecycle: Lifecycle get() = registry
        }
        owner.registry.currentState = Lifecycle.State.CREATED
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides owner) {
                if (shown.value) MediaImage(source, loader, "animation", Modifier.size(80.dp))
            }
        }
        compose.waitForIdle()
        assertNull(currentAnimation())
        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.STARTED }
        compose.waitUntil(10000) { currentAnimation()?.isRunning == true }
        val first = currentAnimation()!!
        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.CREATED }
        compose.waitUntil(10000) { first.callback == null && !first.isRunning && currentAnimation() == null }
        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.STARTED }
        compose.waitUntil(10000) { currentAnimation()?.isRunning == true }
        val second = currentAnimation()!!
        assertNotSame(first, second)
        compose.runOnIdle { shown.value = false }
        compose.waitForIdle()
        compose.waitUntil(10000) { second.callback == null && !second.isRunning }
        compose.runOnIdle { shown.value = true }
        compose.waitUntil(10000) { currentAnimation()?.isRunning == true }
        val third = currentAnimation()!!
        compose.runOnIdle { loader.clear() }
        compose.waitUntil(10000) { third.callback == null && !third.isRunning && currentAnimation() == null }
    }

    @Test fun cancellationDoesNotPopulateCache() = runBlocking {
        val loader = UiImageLoader(ChatRepository(context))
        val entered = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val uri = Uri.parse("content://animation.test/cancelled")
        shadowOf(context.contentResolver).registerInputStream(uri, object : ByteArrayInputStream(fixture("two-frames.png")) {
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                entered.countDown()
                check(resume.await(10, TimeUnit.SECONDS))
                return super.read(b, off, len)
            }
        })
        val loading = async(kotlinx.coroutines.Dispatchers.Default) { loader.load(uri.toString(), context) }
        try {
            assertTrue(entered.await(10, TimeUnit.SECONDS))
            loading.cancel()
        } finally { resume.countDown() }
        loading.join()
        assertTrue(loading.isCancelled)
        shadowOf(context.contentResolver).registerInputStream(uri, ByteArrayInputStream(byteArrayOf()))
        assertNull(loader.load(uri.toString(), context))
    }

    @Test fun clippedCompositionStopsAndFitCropArePreserved() {
        val loader = UiImageLoader(ChatRepository(context))
        val source = local("two-frames.png")
        val outside = mutableStateOf(false)
        val crop = mutableStateOf(false)
        compose.setContent {
            Box(Modifier.size(100.dp).clipToBounds()) {
                MediaImage(source, loader, "animation", Modifier.offset(y = if (outside.value) 200.dp else 0.dp).size(80.dp),
                    contentScale = if (crop.value) ContentScale.Crop else ContentScale.Fit)
            }
        }
        compose.waitUntil(10000) { currentAnimation()?.isRunning == true }
        val first = currentAnimation()!!
        assertEquals(ImageView.ScaleType.FIT_CENTER, (first.callback as ImageView).scaleType)
        compose.runOnIdle { crop.value = true }
        compose.waitForIdle()
        assertEquals(ImageView.ScaleType.CENTER_CROP, (first.callback as ImageView).scaleType)
        compose.runOnIdle { outside.value = true }
        compose.waitForIdle()
        compose.waitUntil(10000) { !first.isRunning && first.callback == null && currentAnimation() == null }
        compose.runOnIdle { outside.value = false }
        compose.waitUntil(10000) { currentAnimation()?.isRunning == true }
        assertNotSame(first, currentAnimation())
    }

    private fun currentAnimation(): FrameAnimationDrawable<*>? {
        fun find(view: View): FrameAnimationDrawable<*>? {
            if (view is ImageView) (view.drawable as? FrameAnimationDrawable<*>)?.let { return it }
            if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index))?.let { return it }
            return null
        }
        return find(compose.activity.window.decorView)
    }
}
