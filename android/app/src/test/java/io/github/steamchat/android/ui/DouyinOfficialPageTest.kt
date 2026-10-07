package io.github.steamchat.android.ui

import android.net.Uri
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.github.steamchat.android.data.DouyinBrowserRequired
import io.github.steamchat.android.data.DouyinVideo
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = ComposeTestApplication::class)
class DouyinOfficialPageTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val id = "7687575973616905914"
    private val url = "https://www.douyin.com/video/$id"

    @Test fun officialPageLoadsNormalWebsiteWithRestrictedLocalAndAutoplayAccess() {
        compose.setContent { SteamChatTheme { DouyinOfficialPage(url, {}, {}, Modifier.fillMaxSize()) } }
        compose.onNodeWithTag("douyin-official-page").assertIsDisplayed()
        compose.runOnIdle {
            val view = webView()
            assertEquals(url, shadowOf(view).lastLoadedUrl)
            assertTrue(view.settings.javaScriptEnabled)
            assertFalse(view.settings.allowFileAccess)
            assertFalse(view.settings.allowContentAccess)
            assertFalse(view.settings.javaScriptCanOpenWindowsAutomatically)
            assertTrue(view.settings.mediaPlaybackRequiresUserGesture)
            assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, view.settings.mixedContentMode)
            assertEquals(WebSettings.LOAD_NO_CACHE, view.settings.cacheMode)
            assertNull(shadowOf(view).getJavascriptInterface("Android"))
        }
    }

    @Test fun websiteMetadataReturnsMatchingVideoAndDestroysThePageBeforeNativePlayback() {
        val visible = mutableStateOf(true)
        var received: DouyinVideo? = null
        var failure: String? = null
        compose.setContent { SteamChatTheme {
            if (visible.value) DouyinOfficialPage(url, { received = it; visible.value = false }, { failure = it }, Modifier.fillMaxSize())
        } }
        compose.onNodeWithTag("douyin-official-page").assertIsDisplayed()
        val view = compose.runOnIdle { webView() }
        compose.runOnIdle {
            assertNotNull(shadowOf(view).lastEvaluatedJavascriptCallback)
            shadowOf(view).lastEvaluatedJavascriptCallback.onReceiveValue(metadata())
        }
        compose.waitUntil(5000) { received != null }
        compose.onNodeWithTag("douyin-official-page").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(id, received!!.id)
            assertEquals("https://aweme.snssdk.com/aweme/v1/playwm/?video_id=fixture", received!!.playUrl)
            assertNull(failure)
            assertTrue(shadowOf(view).wasDestroyCalled())
        }
    }

    @Test fun cancelledPageCannotPublishLateMetadata() {
        val visible = mutableStateOf(true)
        var delivered = false
        compose.setContent { SteamChatTheme {
            if (visible.value) DouyinOfficialPage(url, { delivered = true }, { delivered = true }, Modifier.fillMaxSize())
        } }
        compose.onNodeWithTag("douyin-official-page").assertIsDisplayed()
        val view = compose.runOnIdle { webView() }
        val callback = compose.runOnIdle { shadowOf(view).lastEvaluatedJavascriptCallback }
        compose.runOnIdle { visible.value = false }
        compose.onNodeWithTag("douyin-official-page").assertDoesNotExist()
        compose.runOnIdle {
            assertTrue(shadowOf(view).wasDestroyCalled())
            callback.onReceiveValue(metadata())
        }
        compose.runOnIdle { assertFalse(delivered) }
    }

    @Test fun navigationToOtherSitesVideosOrLoginIsRejected() {
        var failure: String? = null
        compose.setContent { SteamChatTheme { DouyinOfficialPage(url, {}, { failure = it }, Modifier.fillMaxSize()) } }
        compose.onNodeWithTag("douyin-official-page").assertIsDisplayed()
        compose.runOnIdle {
            val view = webView()
            val client = shadowOf(view).webViewClient
            assertTrue(client.shouldOverrideUrlLoading(view, request("snssdk1128://aweme/detail/$id")))
            assertNull("A blocked automatic app launch must leave the page available for metadata", failure)
            val target = request("https://evil.test/page")
            assertTrue(client.shouldOverrideUrlLoading(view, target))
            assertTrue(failure!!.contains("非视频页面"))
            assertTrue(client.shouldOverrideUrlLoading(view, request("https://www.douyin.com/video/7687575973616905915")))
            assertTrue(client.shouldOverrideUrlLoading(view, request("https://www.douyin.com/login")))
            assertTrue(client.shouldOverrideUrlLoading(view, request("http://m.douyin.com/share/video/$id")))
        }
    }

    @Test fun pageFollowsLifecyclePauseAndResumeAndReleasesAfterLeaving() {
        val owner = object : LifecycleOwner {
            val registry = LifecycleRegistry(this)
            override val lifecycle: Lifecycle get() = registry
        }
        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.RESUMED }
        val visible = mutableStateOf(true)
        compose.setContent { CompositionLocalProvider(LocalLifecycleOwner provides owner) {
            if (visible.value) SteamChatTheme { DouyinOfficialPage(url, {}, {}, Modifier.fillMaxSize()) }
        } }
        compose.onNodeWithTag("douyin-official-page").assertIsDisplayed()
        val view = compose.runOnIdle { webView() }
        compose.runOnIdle {
            owner.registry.currentState = Lifecycle.State.CREATED
            assertTrue(shadowOf(view).wasOnPauseCalled())
            owner.registry.currentState = Lifecycle.State.RESUMED
            assertTrue(shadowOf(view).wasOnResumeCalled())
            visible.value = false
        }
        compose.onNodeWithTag("douyin-official-page").assertDoesNotExist()
        compose.runOnIdle { assertTrue(shadowOf(view).wasDestroyCalled()) }
    }

    @Test fun nativeResolutionMissingMetadataContinuesInsideTheVideoDialog() {
        val open = mutableStateOf(true)
        compose.setContent { SteamChatTheme {
            if (open.value) DouyinVideoDialog(url, { throw DouyinBrowserRequired() }, { open.value = false })
        } }
        compose.onNodeWithTag("douyin-official-page").assertIsDisplayed()
        compose.onNodeWithTag("douyin-video-error").assertDoesNotExist()
        compose.onNodeWithTag("douyin-video-close").performClick()
        compose.onNodeWithTag("douyin-official-page").assertDoesNotExist()
    }

    @Test fun unresponsiveWebsiteIsBoundedByTimeout() {
        var failure: String? = null
        compose.setContent { SteamChatTheme { DouyinOfficialPage(url, {}, { failure = it }, Modifier.fillMaxSize()) } }
        compose.onNodeWithTag("douyin-official-page").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(21000)
        compose.runOnIdle { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(21)) }
        compose.waitUntil(5000) { failure != null }
        compose.runOnIdle { assertTrue(failure!!.contains("官网仍未提供")) }
    }

    private fun webView(): WebView {
        fun find(view: View): WebView? {
            if (view is WebView) return view
            if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index))?.let { return it }
            return null
        }
        return checkNotNull(find(compose.activity.window.decorView))
    }

    private fun metadata(): String = JSONObject.quote(JSONObject().put("pageUrl", url).put("item", JSONObject()
        .put("aweme_id", id).put("desc", "测试视频").put("author", JSONObject().put("nickname", "作者"))
        .put("video", JSONObject().put("duration", 12345).put("play_addr", JSONObject().put("url_list", JSONArray()
            .put("https://aweme.snssdk.com/aweme/v1/playwm/?video_id=fixture"))))).toString())

    private fun request(value: String) = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(value)
        override fun isForMainFrame() = true
        override fun isRedirect() = false
        override fun hasGesture() = false
        override fun getMethod() = "GET"
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }
}
