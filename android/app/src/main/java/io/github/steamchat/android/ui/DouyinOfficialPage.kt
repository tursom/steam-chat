package io.github.steamchat.android.ui

import android.annotation.SuppressLint
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.*
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.github.steamchat.android.data.DouyinVideo
import io.github.steamchat.android.data.DouyinVideoResolver
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.resume

/** A user-triggered, bounded normal website visit; the resulting stream still uses Media3. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun DouyinOfficialPage(input: String, onVideo: (DouyinVideo) -> Unit, onFailure: (String) -> Unit,
                                modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val latestVideo by rememberUpdatedState(onVideo)
    val latestFailure by rememberUpdatedState(onFailure)
    var finished by remember(input) { mutableStateOf(false) }
    fun fail(message: String) {
        if (!finished) { finished = true; latestFailure(message) }
    }
    val webView = remember(context, input) {
        try { WebView(context).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                cacheMode = WebSettings.LOAD_NO_CACHE
                userAgentString = DouyinVideoResolver.USER_AGENT
                allowFileAccess = false
                allowContentAccess = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                mediaPlaybackRequiresUserGesture = true
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
            }
            // Do not install an Android JavaScript interface or share the chat HTTP client's cookies.
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (!request.isForMainFrame) return false
                    // The site's automatic "open Douyin" attempt must not abort metadata
                    // collection or launch another app while this normal page is loading.
                    if (request.url.scheme !in setOf("https", "http")) return true
                    val allowed = DouyinVideoResolver.browserPageAllowed(input, request.url.toString()) && request.url.scheme == "https"
                    if (!allowed) fail("官网跳转到了非视频页面，请尝试打开原链接")
                    return !allowed
                }

                override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                    if (url != "about:blank" && !DouyinVideoResolver.browserPageAllowed(input, url)) {
                        view.stopLoading()
                        fail("官网跳转到了非视频页面，请尝试打开原链接")
                    }
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) fail("官网页面加载失败，请检查网络或打开原链接")
                }

                override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                    handler.cancel()
                    fail("官网连接校验失败，请检查网络或打开原链接")
                }
            }
        } } catch (_: Exception) { null }
    }
    if (webView == null) {
        LaunchedEffect(input) { fail("此设备的网页组件不可用，请更新 Android System WebView 或打开原链接") }
        return
    }
    DisposableEffect(webView, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> webView.onResume()
                Lifecycle.Event.ON_PAUSE, Lifecycle.Event.ON_STOP -> webView.onPause()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            finished = true
            lifecycle.removeObserver(observer)
        }
    }
    LaunchedEffect(webView, input) {
        try {
            val start = DouyinVideoResolver.officialBrowserUrl(input) ?: error("不支持的抖音视频链接")
            webView.loadUrl(start)
            withTimeout(20_000) {
                while (!finished) {
                    val page = webView.url.orEmpty()
                    val id = DouyinVideoResolver.browserVideoId(input, page)
                    if (id != null) {
                        val value = evaluateMetadata(webView, DouyinVideoResolver.browserMetadataScript(id))
                        val video = withContext(Dispatchers.Default) { DouyinVideoResolver.parseBrowserMetadata(value, input, page) }
                        if (video != null && !finished) {
                            finished = true
                            latestVideo(video)
                            break
                        }
                    }
                    delay(250)
                }
            }
        } catch (_: TimeoutCancellationException) {
            fail("官网仍未提供可播放信息，可能需要在抖音内观看，请尝试打开原链接")
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { fail("官网视频信息获取失败，请重试或打开原链接") }
    }
    Box(modifier.testTag("douyin-official-page")) {
        AndroidView(factory = { webView }, onRelease = {
            it.stopLoading()
            it.onPause()
            it.removeAllViews()
            it.destroy()
        }, modifier = Modifier.fillMaxSize())
        Surface(Modifier.align(Alignment.BottomCenter).padding(12.dp), color = Color(0xDD202624), contentColor = Color.White) {
            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
                Text("正在获取视频信息…")
            }
        }
    }
}

private suspend fun evaluateMetadata(view: WebView, script: String): String = suspendCancellableCoroutine { continuation ->
    view.evaluateJavascript(script) { value ->
        if (continuation.isActive) continuation.resume(value.orEmpty())
    }
}
