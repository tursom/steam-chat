package io.github.steamchat.android.ui

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import io.github.steamchat.android.data.DouyinVideo
import io.github.steamchat.android.data.DouyinBrowserRequired
import io.github.steamchat.android.data.DouyinVideoResolver
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import java.io.IOException

private object PublicDouyin {
    val resolver by lazy { DouyinVideoResolver() }
    val mediaClient by lazy { resolver.mediaClient() }
}

@Composable
internal fun DouyinVideoCard(part: MessagePart.Link, loader: UiImageLoader,
                            browserFallback: Boolean = true,
                            resolve: suspend (String) -> DouyinVideo = PublicDouyin.resolver::resolve) {
    val context = LocalContext.current
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    var open by rememberSaveable(part.url) { mutableStateOf(false) }
    val chat = chatColors
    Column(Modifier.widthIn(max = 300.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp))
        .background(LocalContentColor.current.copy(alpha = .06f)).testTag("douyin-video-card")) {
        if (part.image.isNotBlank()) MediaImage(part.image, loader, "抖音视频封面", Modifier.fillMaxWidth().height(150.dp))
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(part.title.takeUnless { it == part.url }.orEmpty().ifBlank { "抖音视频" }, fontWeight = FontWeight.Medium,
                maxLines = 3, overflow = TextOverflow.Ellipsis)
            if (part.description.isNotBlank()) Text(part.description, style = MaterialTheme.typography.bodySmall,
                color = chat.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(part.url, style = MaterialTheme.typography.bodySmall, color = chat.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically) {
                FilledTonalButton(onClick = { focus.clearFocus(); keyboard?.hide(); open = true }, Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Icon(Icons.Default.PlayCircle, null, Modifier.size(20.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("播放抖音视频")
                }
                ToolButton(Icons.AutoMirrored.Filled.OpenInNew, "打开抖音原链接") { openWeb(context, part.url) }
            }
        }
    }
    if (open) DouyinVideoDialog(part.url, resolve, { open = false }, browserFallback)
}

private sealed interface VideoResolution {
    data object Loading : VideoResolution
    data class Ready(val video: DouyinVideo) : VideoResolution
    data object OfficialPage : VideoResolution
    data class Failed(val message: String) : VideoResolution
}

/** Resolve only while the user-opened dialog exists; its producer is cancelled on dismissal. */
@Composable
internal fun DouyinVideoDialog(url: String, resolve: suspend (String) -> DouyinVideo, close: () -> Unit,
                               browserFallback: Boolean = true) {
    val context = LocalContext.current
    var attempt by remember(url) { mutableIntStateOf(0) }
    var playbackError by remember(url, attempt) { mutableStateOf<String?>(null) }
    var browserResult by remember(url, attempt) { mutableStateOf<VideoResolution?>(null) }
    val resolution by key(url, attempt) {
        produceState<VideoResolution>(VideoResolution.Loading) {
            value = try { VideoResolution.Ready(resolve(url)) }
            catch (e: DouyinBrowserRequired) { if (browserFallback) VideoResolution.OfficialPage else VideoResolution.Failed(e.message.orEmpty()) }
            catch (_: TimeoutCancellationException) { VideoResolution.Failed("解析超时，请重试") }
            catch (e: CancellationException) { throw e }
            catch (_: IOException) { VideoResolution.Failed("网络连接失败，请检查网络后重试") }
            catch (e: Exception) { VideoResolution.Failed(e.message?.take(240) ?: "公开分享页未提供可播放视频") }
        }
    }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = LocalView.current
        val dialogFocus = remember { FocusRequester() }
        val latestClose by rememberUpdatedState(close)
        LaunchedEffect(Unit) { dialogFocus.requestFocus() }
        DisposableEffect(view) {
            // The player draws black even when the rest of the app uses its light palette.
            val window = (view.parent as? DialogWindowProvider)?.window
            window?.let { WindowCompat.getInsetsController(it, view).apply {
                isAppearanceLightStatusBars = false
                isAppearanceLightNavigationBars = false
            } }
            onDispose { }
        }
        Surface(Modifier.fillMaxSize(), color = Color.Black, contentColor = Color.White) {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)
                .onPreviewKeyEvent { if (it.key == Key.Escape && it.type == KeyEventType.KeyUp) { latestClose(); true } else false }
                .focusRequester(dialogFocus).focusable()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("抖音视频", Modifier.weight(1f).padding(start = 12.dp), fontWeight = FontWeight.Bold)
                    IconButton(onClick = { openWeb(context, url) }, Modifier.size(48.dp)) { Icon(Icons.AutoMirrored.Filled.OpenInNew, "打开抖音原链接") }
                    IconButton(onClick = close, Modifier.size(48.dp).testTag("douyin-video-close")) { Icon(Icons.Default.Close, "关闭视频") }
                }
                val current = browserResult ?: resolution
                when {
                    current == VideoResolution.Loading -> Box(Modifier.weight(1f).fillMaxWidth().testTag("douyin-video-loading"), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            CircularProgressIndicator(color = Color.White)
                            Text("正在解析公开分享页…")
                        }
                    }
                    current == VideoResolution.OfficialPage -> DouyinOfficialPage(url,
                        onVideo = { browserResult = VideoResolution.Ready(it) },
                        onFailure = { browserResult = VideoResolution.Failed(it) },
                        modifier = Modifier.weight(1f).fillMaxWidth())
                    current is VideoResolution.Failed || playbackError != null -> Column(
                        Modifier.weight(1f).fillMaxWidth().testTag("douyin-video-error").verticalScroll(rememberScrollState()).padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(if (playbackError == null) "无法解析视频" else "视频播放失败", style = MaterialTheme.typography.titleLarge)
                        Text(playbackError ?: (current as VideoResolution.Failed).message, color = Color(0xFFCCCCCC))
                        Button(onClick = { attempt++ }) { Text("重新解析") }
                        OutlinedButton(onClick = { openWeb(context, url) }) { Text("打开原链接") }
                    }
                    current is VideoResolution.Ready -> {
                        key(url, attempt) {
                            NativeDouyinPlayer(current.video, Modifier.weight(1f).fillMaxWidth()) {
                                playbackError = "视频可能暂不可用或播放地址已过期，请重新解析或打开原链接"
                            }
                        }
                        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(current.video.title, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            if (current.video.author.isNotBlank()) Text(current.video.author, style = MaterialTheme.typography.bodySmall, color = Color(0xFFCCCCCC))
                        }
                    }
                }
            }
        }
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun NativeDouyinPlayer(video: DouyinVideo, modifier: Modifier, onFailure: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val latestFailure by rememberUpdatedState(onFailure)
    var position by rememberSaveable(video.id) { mutableLongStateOf(0L) }
    var paused by rememberSaveable(video.id) { mutableStateOf(false) }
    val player = remember(context, video.playUrl) {
        val source = OkHttpDataSource.Factory(PublicDouyin.mediaClient).setDefaultRequestProperties(mapOf(
            "User-Agent" to DouyinVideoResolver.USER_AGENT, "Referer" to video.pageUrl))
        ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(source)).build().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
            setHandleAudioBecomingNoisy(true)
            setMediaItem(MediaItem.fromUri(video.playUrl))
            seekTo(position)
            playWhenReady = !paused && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
            prepare()
        }
    }
    DisposableEffect(player, lifecycle) {
        val release = bindVideoLifecycle(player, lifecycle, { latestFailure() }, { paused = !it })
        onDispose {
            position = player.currentPosition.coerceAtLeast(0)
            paused = !player.playWhenReady
            release()
        }
    }
    LaunchedEffect(player) {
        while (true) { delay(500); position = player.currentPosition.coerceAtLeast(0) }
    }
    AndroidView(factory = { PlayerView(it).apply {
        useController = true
        controllerShowTimeoutMs = 3000
        resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
        setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
        contentDescription = "抖音视频播放器"
        this.player = player
    } }, update = { it.player = player }, onRelease = { it.player = null }, modifier = modifier.testTag("douyin-video-player"))
}

/** Own both listener registrations and player release as one lifetime. Resume stays user-driven. */
internal fun bindVideoLifecycle(player: Player, lifecycle: Lifecycle, onFailure: () -> Unit,
                                onPlayChanged: (Boolean) -> Unit): () -> Unit {
    val listener = object : Player.Listener {
        override fun onPlayerError(error: PlaybackException) { onFailure() }
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) { onPlayChanged(playWhenReady) }
    }
    val observer = LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) {
            onPlayChanged(false)
            player.pause()
        }
    }
    player.addListener(listener)
    lifecycle.addObserver(observer)
    return {
        lifecycle.removeObserver(observer)
        player.removeListener(listener)
        player.release()
    }
}
