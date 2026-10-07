@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package io.github.steamchat.android.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.SentimentSatisfiedAlt
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.github.steamchat.android.AppState
import io.github.steamchat.android.ChatRepository
import io.github.steamchat.android.Message
import io.github.steamchat.android.data.DouyinVideoResolver
import java.time.Duration
import java.time.Instant

@Composable
internal fun ChatScreen(
    state: AppState, repository: ChatRepository, loader: UiImageLoader,
    showBack: Boolean = true,
    onBack: () -> Unit = { repository.leaveConversation() },
    inlineProfile: Boolean = false,
    profileState: MutableState<Boolean> = rememberSaveable { mutableStateOf(false) },
    attachmentState: ConversationAttachmentState = remember(state.selectedPeer) { ConversationAttachmentState() }
) {
    val chat = chatColors
    val scope = listOf(state.server, state.activeAccountId, state.username)
    val selectedPeer = state.selectedPeer
    var draft by rememberSaveable(scope, selectedPeer) { mutableStateOf("") }
    var showInventory by rememberSaveable(scope, selectedPeer) { mutableStateOf(false) }
    var lightbox by remember(scope, selectedPeer) { mutableStateOf<String?>(null) }
    var retry by remember(scope, selectedPeer) { mutableStateOf<String?>(null) }
    var profile by profileState
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val overlayFocus = remember { FocusRequester() }
    // Save only request identity, never the content URI. The callback is updated on recomposition,
    // so comparing just a captured selectedPeer in the callback would target the wrong conversation.
    var imageRequest by rememberSaveable { mutableStateOf<List<String>?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        val request = imageRequest
        imageRequest = null
        val current = repository.state.value
        val currentIdentity = listOf(current.server, current.activeAccountId, current.username, current.selectedPeer)
        if (uri?.scheme == "content" && current.loggedIn && request == currentIdentity && request == scope + selectedPeer) {
            attachmentState.uri = uri
        }
    }
    fun dismissOverlay(): Boolean = when {
        lightbox != null -> { lightbox = null; true }
        retry != null -> { retry = null; true }
        profile -> { profile = false; true }
        showInventory -> { showInventory = false; true }
        else -> false
    }
    BackHandler { if (!dismissOverlay()) onBack() }
    LaunchedEffect(profile, showInventory, inlineProfile) {
        if (profile || showInventory) {
            focus.clearFocus()
            keyboard?.hide()
            // Give hardware Escape a target after removing focus from the text editor.
            overlayFocus.requestFocus()
        }
    }
    val friend = state.friends.firstOrNull { it.id == selectedPeer }
    val conversation = state.conversations.firstOrNull { it.id == selectedPeer }
    val name = state.selectedName.ifBlank { friend?.name ?: selectedPeer }
    val avatar = friend?.avatar?.ifBlank { conversation?.avatar.orEmpty() } ?: conversation?.avatar.orEmpty()
    val playing = friend?.gameName?.isNotBlank() == true
    val messages = state.messages.filter { it.peerId == selectedPeer }
    val shapes = remember(messages) { bubbleShapes(messages) }
    val scroll = key(scope, selectedPeer) {
        rememberLazyListState(initialFirstVisibleItemIndex = messages.size)
    }
    var positioned by rememberSaveable(scope, selectedPeer) { mutableStateOf(false) }
    var previousCount by rememberSaveable(scope, selectedPeer) { mutableIntStateOf(0) }
    var previousLastKey by rememberSaveable(scope, selectedPeer) { mutableStateOf<String?>(null) }
    val canSend = state.canSend
    LaunchedEffect(scope, selectedPeer, messages.lastOrNull()?.key, messages.size) {
        if (messages.isEmpty()) return@LaunchedEffect
        // Re-entering a SaveableStateProvider with unchanged data must preserve its scroll offset.
        if (positioned && previousCount == messages.size && previousLastKey == messages.last().key) return@LaunchedEffect
        val nearBottom = scroll.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= previousCount - 2 }
            ?: (scroll.firstVisibleItemIndex >= previousCount - 2)
        val tailChanged = previousLastKey != messages.last().key
        val localSend = messages.last().let { it.key != previousLastKey && it.echo && it.key.startsWith("local:") }
        val initial = !positioned
        positioned = true
        previousCount = messages.size
        previousLastKey = messages.last().key
        // The end anchor also exposes the bottom of a message taller than the viewport.
        if (initial) scroll.scrollToItem(messages.size)
        else if ((tailChanged && nearBottom) || localSend) scroll.animateScrollToItem(messages.size)
    }
    Row(Modifier.fillMaxSize().onPreviewKeyEvent {
        if (it.key == Key.Escape && it.type == KeyEventType.KeyUp) dismissOverlay() else false
    }.focusRequester(overlayFocus).focusable()) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxHeight().background(chat.chatBg)) {
            val compact = maxHeight < 420.dp
            val inventoryDialog = maxHeight < 480.dp
            val inventoryHeight = minOf(226.dp, maxHeight * .28f)
            val dialogHeight = minOf(340.dp, (maxHeight - 24.dp).coerceAtLeast(128.dp))
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().background(chat.bg).height(if (compact) 48.dp else 64.dp).padding(start = if (showBack) 4.dp else 16.dp, end = 8.dp).testTag("chat-header"),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (showBack) ToolButton(Icons.AutoMirrored.Filled.ArrowBack, "返回消息") { focus.clearFocus(); keyboard?.hide(); onBack() }
                    Avatar(name, avatar, loader, friend?.online == true, if (compact) 32 else 40, playing)
                    Column(Modifier.weight(1f).padding(start = 4.dp)) {
                        Text(name, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val (status, color) = when {
                            !state.connected -> "${state.restSyncText} · ${state.connectionText}" to chat.warningText
                            playing -> "正在玩 ${friend?.gameName}" to chat.game
                            friend?.online == true -> "在线" to chat.accentText
                            else -> "离线" to chat.muted
                        }
                        Text(status, fontSize = 12.sp, color = color, maxLines = if (compact) 1 else 2, overflow = TextOverflow.Ellipsis)
                    }
                    Box(Modifier.clip(CircleShape).background(if (profile && inlineProfile) chat.accentSoft else Color.Transparent)) {
                        CompositionLocalProvider(LocalContentColor provides if (profile && inlineProfile) chat.accentText else chat.text) {
                            ToolButton(Icons.Default.PersonOutline, "好友资料") { focus.clearFocus(); keyboard?.hide(); showInventory = false; profile = !profile }
                        }
                    }
                }
                HorizontalDivider(color = chat.line)
                if (!canSend) Row(Modifier.fillMaxWidth().background(chat.warningBg).padding(horizontal = 14.dp, vertical = if (compact) 2.dp else 8.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Outlined.Info, null, Modifier.size(16.dp), tint = chat.warningText)
                    Text(when {
                        !state.accessAllowed -> "此账号尚无聊天访问权限"
                        else -> "Steam 未在线 · 暂不能发送消息"
                    }, color = chat.warningText, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                    LazyColumn(Modifier.widthIn(max = 760.dp).fillMaxSize().testTag("chat-messages"), state = scroll,
                        contentPadding = PaddingValues(horizontal = if (compact) 8.dp else 12.dp, vertical = if (compact) 6.dp else 10.dp)) {
                        if (messages.isEmpty()) item { EmptyState(if (state.loading) "正在加载消息…" else "暂无消息") }
                        itemsIndexed(messages, key = { _, message -> message.key }) { index, message ->
                            MessageRow(message, shapes.getOrElse(index) { BubbleShape(null, first = true, last = true) }, name, avatar, loader, { lightbox = it }, {
                                if (message.retryMayDuplicate) retry = message.key else repository.retryMessage(message.key)
                            })
                        }
                        item(key = "chat-end") { Spacer(Modifier.fillMaxWidth().height(1.dp).testTag("chat-end")) }
                    }
                }
                Column(Modifier.fillMaxWidth().background(chat.bg)) {
                    HorizontalDivider(color = chat.line)
                    Column(Modifier.align(Alignment.CenterHorizontally).widthIn(max = 760.dp).fillMaxWidth().testTag("chat-composer")
                        .padding(horizontal = if (compact) 4.dp else 8.dp, vertical = if (compact) 2.dp else 8.dp)) {
                        attachmentState.uri?.let { uri ->
                            Row(Modifier.padding(start = 8.dp, end = 4.dp, bottom = 8.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(chat.input)
                                .padding(6.dp).testTag("pending-attachment"), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                MediaImage(uri.toString(), loader, "待发送图片", Modifier.size(if (compact) 40.dp else 56.dp).clip(RoundedCornerShape(10.dp)))
                                Text("待发送图片", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                ToolButton(Icons.Default.Close, "移除待发送图片") { attachmentState.uri = null }
                            }
                        }
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            CompositionLocalProvider(LocalContentColor provides chat.muted) {
                                ToolButton(if (showInventory) Icons.Default.Keyboard else Icons.Outlined.SentimentSatisfiedAlt, "表情与贴纸") {
                                    if (!showInventory) { focus.clearFocus(); keyboard?.hide() }
                                    showInventory = !showInventory
                                }
                            }
                            BasicTextField(draft, { draft = it }, Modifier.weight(1f).testTag("message-input"),
                                textStyle = TextStyle(color = chat.text, fontSize = 15.sp, lineHeight = 21.sp), cursorBrush = SolidColor(chat.accent),
                                maxLines = if (compact) 1 else 5,
                                decorationBox = { inner ->
                                    Box(Modifier.clip(RoundedCornerShape(24.dp)).background(chat.input).heightIn(min = 48.dp)
                                        .padding(horizontal = 16.dp, vertical = 13.dp), contentAlignment = Alignment.CenterStart) {
                                        if (draft.isEmpty()) Text("发送消息…", color = chat.muted, fontSize = 15.sp, maxLines = 1)
                                        inner()
                                    }
                                })
                            CompositionLocalProvider(LocalContentColor provides chat.muted) {
                                ToolButton(Icons.Outlined.Image, "选择图片", canSend && imageRequest == null) {
                                    imageRequest = scope + selectedPeer
                                    picker.launch("image/*")
                                }
                            }
                            val sendEnabled = canSend && (attachmentState.uri != null || draft.isNotBlank())
                            FilledIconButton(onClick = {
                                val image = attachmentState.uri
                                if (image != null) { repository.sendImage(image); attachmentState.uri = null }
                                else if (draft.isNotBlank()) { repository.sendText(draft); draft = "" }
                            }, enabled = sendEnabled, modifier = Modifier.size(48.dp).testTag("send-message"), shape = CircleShape,
                                colors = IconButtonDefaults.filledIconButtonColors(containerColor = chat.accent, contentColor = chat.onAccent,
                                    disabledContainerColor = chat.input, disabledContentColor = chat.muted.copy(alpha = .6f))) {
                                Icon(Icons.Default.ArrowUpward, if (attachmentState.uri != null) "发送图片" else "发送消息")
                            }
                        }
                    }
                    if (showInventory && !inventoryDialog) InventoryPanel(state, loader, { draft += it },
                        { repository.sendSticker(it); showInventory = false }, canSend, { showInventory = false },
                        Modifier.fillMaxWidth().height(inventoryHeight))
                }
            }
            if (showInventory && inventoryDialog) Dialog(onDismissRequest = { showInventory = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
                val dialogFocus = remember { FocusRequester() }
                LaunchedEffect(Unit) { dialogFocus.requestFocus() }
                Surface(Modifier.padding(12.dp).widthIn(max = 480.dp).fillMaxWidth().height(dialogHeight).onPreviewKeyEvent {
                    if (it.key == Key.Escape && it.type == KeyEventType.KeyUp) { showInventory = false; true } else false
                }.focusRequester(dialogFocus).focusable(), shape = RoundedCornerShape(20.dp)) {
                    InventoryPanel(state, loader, { draft += it }, { repository.sendSticker(it); showInventory = false },
                        canSend, { showInventory = false }, Modifier.fillMaxSize())
                }
            }
        }
        if (profile && inlineProfile) {
            VerticalDivider(color = chat.line)
            FriendDetails(friend, selectedPeer, name, avatar, loader,
                Modifier.width(300.dp).fillMaxHeight().testTag("friend-details-inline")) { profile = false }
        }
    }
    lightbox?.let { ImageLightbox(it, loader) { lightbox = null } }
    retry?.let { key -> AlertDialog(onDismissRequest = { retry = null }, title = { Text("确认重新发送？") },
        text = { Text("上次发送结果可能未确认，对方可能已经收到。重试可能产生重复消息，请先检查会话。") },
        confirmButton = { TextButton(onClick = { repository.retryMessage(key); retry = null }, enabled = canSend) { Text("仍要重试") } },
        dismissButton = { TextButton(onClick = { retry = null }) { Text("取消") } }) }
    if (profile && !inlineProfile) FriendDetailsDrawer(friend, selectedPeer, name, avatar, loader) { profile = false }
}

/** Placement of one message within its run of consecutive same-sender messages. */
internal data class BubbleShape(val date: String?, val first: Boolean, val last: Boolean)

/**
 * Consecutive messages from the same side, on the same day and within five minutes, share one
 * avatar and a tail on the last bubble; a date chip opens each day. Failed sends stand alone
 * because their retry row sits below them.
 */
internal fun bubbleShapes(messages: List<Message>): List<BubbleShape> {
    val instants = messages.map { runCatching { Instant.parse(it.time) }.getOrNull() }
    val days = messages.map { dayLabel(it.time) }
    fun joined(a: Int, b: Int): Boolean {
        val x = messages[a]; val y = messages[b]
        if (x.echo != y.echo || days[a] != days[b] || (x.echo && x.failed) || (y.echo && y.failed)) return false
        val start = instants[a] ?: return false
        val end = instants[b] ?: return false
        return Duration.between(start, end).abs() < Duration.ofMinutes(5)
    }
    return messages.indices.map { index ->
        BubbleShape(
            date = days[index]?.takeIf { index == 0 || days[index - 1] != it },
            first = index == 0 || !joined(index - 1, index),
            last = index == messages.lastIndex || !joined(index, index + 1))
    }
}

@Composable
private fun DateChip(label: String) {
    Box(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 4.dp), contentAlignment = Alignment.Center) {
        Text(label, Modifier.clip(RoundedCornerShape(12.dp)).background(chatColors.chip).padding(horizontal = 12.dp, vertical = 3.dp),
            fontSize = 12.sp, fontWeight = FontWeight.Medium, color = chatColors.muted)
    }
}

@Composable
private fun MessageRow(message: Message, shape: BubbleShape, name: String, avatar: String, loader: UiImageLoader,
                       viewImage: (String) -> Unit, retry: () -> Unit) {
    val chat = chatColors
    val out = message.echo
    Column(Modifier.fillMaxWidth()) {
        shape.date?.let { DateChip(it) }
        Row(Modifier.fillMaxWidth().padding(top = if (shape.first) 10.dp else 3.dp),
            horizontalArrangement = if (out) Arrangement.End else Arrangement.Start, verticalAlignment = Alignment.Bottom) {
            if (!out) {
                if (shape.last) Avatar(message.name.ifBlank { name }, avatar, loader, size = 30) else Spacer(Modifier.width(30.dp))
                Spacer(Modifier.width(8.dp))
            }
            Box(Modifier.fillMaxWidth(if (out) .82f else .9f), contentAlignment = if (out) Alignment.CenterEnd else Alignment.CenterStart) {
                Bubble(message, shape, loader, viewImage)
            }
        }
        if (out && message.failed) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            Text(message.error.ifBlank { "发送失败或结果未确认" }, Modifier.weight(1f, fill = false), color = chat.danger,
                style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            TextButton(onClick = retry, modifier = Modifier.heightIn(min = 48.dp)) {
                Icon(Icons.Default.Refresh, null, Modifier.size(16.dp), tint = chat.danger); Spacer(Modifier.width(4.dp))
                Text("重试", color = chat.danger, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun Bubble(message: Message, shape: BubbleShape, loader: UiImageLoader, viewImage: (String) -> Unit) {
    val chat = chatColors
    val out = message.echo
    val parts = remember(message.text, message.imageUrl) {
        val source = message.imageUrl?.let { if (message.key.startsWith("local:") && it.startsWith("content://")) it else safeImageSource(it) }
        source?.let { listOf(MessagePart.Image(it)) } ?: SteamMessageParser.parse(message.text)
    }
    val mediaOnly = parts.isNotEmpty() && parts.all { it is MessagePart.Image && !it.small || it is MessagePart.Link }
    val large = 18.dp
    val tail = 6.dp
    val corners = if (out) RoundedCornerShape(topStart = large, topEnd = if (shape.first) large else tail, bottomEnd = tail, bottomStart = large)
        else RoundedCornerShape(topStart = if (shape.first) large else tail, topEnd = large, bottomEnd = large, bottomStart = tail)
    val meta = if (out) chat.outMeta else chat.muted
    CompositionLocalProvider(LocalContentColor provides if (out) chat.outText else chat.text) {
        Column(Modifier.alpha(if (message.pending) .75f else 1f).clip(corners).background(if (out) chat.outBubble else chat.inBubble)
            .padding(if (mediaOnly) PaddingValues(4.dp, 4.dp, 4.dp, 6.dp) else PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 6.dp)),
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            parts.forEach { part -> MessageContent(part, loader, viewImage) }
            Row(Modifier.align(Alignment.End).padding(horizontal = if (mediaOnly) 8.dp else 0.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(bubbleTime(message.time), fontSize = 11.sp, lineHeight = 14.sp, color = meta)
                when {
                    out && message.pending -> Icon(Icons.Default.Schedule, "发送中", Modifier.size(13.dp), tint = meta)
                    out && message.failed -> Icon(Icons.Default.ErrorOutline, "发送失败", Modifier.size(14.dp), tint = chat.danger)
                    out -> Icon(Icons.Default.Done, "已发送", Modifier.size(14.dp), tint = meta)
                }
            }
        }
    }
}

@Composable
private fun MessageContent(part: MessagePart, loader: UiImageLoader, viewImage: (String) -> Unit) {
    val context = LocalContext.current
    val chat = chatColors
    when (part) {
        is MessagePart.Text -> SelectionContainer { Text(part.text, fontSize = 15.sp, lineHeight = 21.sp) }
        is MessagePart.Image -> MediaImage(part.source, loader, part.label,
            (if (part.small) Modifier.size(48.dp) else Modifier.widthIn(max = 280.dp).fillMaxWidth().height(180.dp))
                .clip(RoundedCornerShape(if (part.small) 6.dp else 14.dp)).clickable { viewImage(part.source) })
        is MessagePart.Link -> if (DouyinVideoResolver.supports(part.url)) DouyinVideoCard(part, loader)
        else Column(Modifier.widthIn(max = 300.dp).clip(RoundedCornerShape(12.dp)).background(LocalContentColor.current.copy(alpha = .06f))) {
            if (part.image.isNotBlank()) MediaImage(part.image, loader, "链接预览", Modifier.fillMaxWidth().height(140.dp).clickable { viewImage(part.image) })
            Column(Modifier.fillMaxWidth().clickable { openWeb(context, part.url) }.heightIn(min = 48.dp).padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(part.title, Modifier.weight(1f, fill = false), fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    Icon(Icons.AutoMirrored.Filled.OpenInNew, "打开链接", Modifier.padding(start = 4.dp).size(16.dp), tint = chat.muted)
                }
                if (part.description.isNotBlank()) Text(part.description, fontSize = 12.sp, color = chat.muted, maxLines = 3, overflow = TextOverflow.Ellipsis)
                runCatching { java.net.URI(part.url).host }.getOrNull()?.removePrefix("www.")?.let { Text(it, fontSize = 12.sp, color = chat.muted) }
            }
        }
    }
}

@Composable
internal fun InventoryPanel(state: AppState, loader: UiImageLoader, insert: (String) -> Unit,
                            sendSticker: (String) -> Unit, canSendSticker: Boolean, close: () -> Unit,
                            modifier: Modifier = Modifier.fillMaxWidth().height(226.dp)) {
    val chat = chatColors
    var tab by rememberSaveable { mutableIntStateOf(0) }
    Column(modifier.background(chat.card)) {
        HorizontalDivider(color = chat.line)
        Row(verticalAlignment = Alignment.CenterVertically) {
            TabRow(tab, Modifier.weight(1f), containerColor = Color.Transparent, contentColor = chat.accentText) {
                listOf("Steam", "Emoji", "贴纸").forEachIndexed { index, label ->
                    Tab(tab == index, { tab = index }, text = { Text(label, fontWeight = if (tab == index) FontWeight.Bold else FontWeight.Medium) },
                        unselectedContentColor = chat.muted)
                }
            }
            ToolButton(Icons.Default.Close, "关闭表情面板", onClick = close)
        }
        val inventory = remember(tab, state.emoticons, state.stickers) {
            when (tab) {
                0 -> state.emoticons.mapNotNull(::inventoryName).distinct()
                1 -> listOf("😀", "😊", "😂", "🥰", "😎", "🤔", "😮", "😭", "👍", "👏", "❤️", "🎉", "🔥", "✨", "🎮", "☕")
                else -> state.stickers.mapNotNull(io.github.steamchat.android.data.Protocol::stickerName).distinct()
            }
        }
        if (inventory.isEmpty()) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            Text(if (state.loading) "正在加载库存…" else "暂无可用库存", color = chat.muted)
        }
        else LazyVerticalGrid(GridCells.Adaptive(64.dp), modifier = Modifier.weight(1f), contentPadding = PaddingValues(8.dp)) {
            items(inventory, key = { it }) { item ->
                val title = if (tab == 2) state.stickerInventory.firstOrNull { it.name == item }?.title ?: item else item
                Column(Modifier.height(76.dp).clip(RoundedCornerShape(12.dp)).clickable(enabled = tab != 2 || canSendSticker) {
                    if (tab == 2) sendSticker(item)
                    else insert(if (tab == 0) ":$item:" else item)
                }.padding(4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    if (tab == 1) Text(item, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.height(48.dp))
                    else {
                        MediaImage(if (tab == 0) emoticonSource(item) else stickerSource(item), loader, title, Modifier.size(44.dp))
                        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall, color = chat.muted)
                    }
                }
            }
        }
    }
}

@Composable
private fun ImageLightbox(source: String, loader: UiImageLoader, close: () -> Unit) {
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize(), color = Color.Black) {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    CompositionLocalProvider(LocalContentColor provides Color.White) {
                        ToolButton(Icons.Default.Close, "关闭图片", onClick = close)
                        Text("图片", color = Color.White)
                    }
                }
                MediaImage(source, loader, "聊天图片", Modifier.fillMaxWidth().weight(1f))
            }
        }
    }
}
