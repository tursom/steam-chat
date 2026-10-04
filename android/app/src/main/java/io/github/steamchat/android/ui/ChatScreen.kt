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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.*
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.github.steamchat.android.AppState
import io.github.steamchat.android.ChatRepository
import io.github.steamchat.android.Message

@Composable
internal fun ChatScreen(
    state: AppState, repository: ChatRepository, loader: UiImageLoader,
    showBack: Boolean = true,
    onBack: () -> Unit = { repository.leaveConversation() },
    inlineProfile: Boolean = false,
    profileState: MutableState<Boolean> = rememberSaveable { mutableStateOf(false) },
    attachmentState: ConversationAttachmentState = remember(state.selectedPeer) { ConversationAttachmentState() }
) {
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
    val messages = state.messages.filter { it.peerId == selectedPeer }
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
        BoxWithConstraints(Modifier.weight(1f).fillMaxHeight()) {
            val compact = maxHeight < 420.dp
            val inventoryDialog = maxHeight < 480.dp
            val inventoryHeight = minOf(226.dp, maxHeight * .28f)
            val dialogHeight = minOf(340.dp, (maxHeight - 24.dp).coerceAtLeast(128.dp))
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().height(if (compact) 48.dp else 66.dp).padding(horizontal = 8.dp).testTag("chat-header"),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (showBack) ToolButton(Icons.AutoMirrored.Filled.ArrowBack, "返回消息") { focus.clearFocus(); keyboard?.hide(); onBack() }
                    Avatar(name, avatar, loader, friend?.online == true, 36)
                    Column(Modifier.weight(1f)) {
                        Text(name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(if (!state.connected) "${state.restSyncText} · ${state.connectionText}" else friend?.gameName?.takeIf { it.isNotBlank() }?.let { "正在玩 $it" } ?: if (friend?.online == true) "在线" else "离线",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = if (compact) 1 else 2, overflow = TextOverflow.Ellipsis)
                    }
                    ToolButton(Icons.Default.PersonOutline, "好友资料") { focus.clearFocus(); keyboard?.hide(); showInventory = false; profile = !profile }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
                if (!canSend) Text(when {
                    !state.accessAllowed -> "此账号尚无聊天访问权限"
                    else -> "Steam 未在线 · 暂不能发送消息"
                }, Modifier.fillMaxWidth().background(Color(0xFFFAF5E9)).padding(horizontal = 10.dp, vertical = if (compact) 2.dp else 10.dp),
                    color = Color(0xFF9B793E), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                    LazyColumn(Modifier.widthIn(max = 760.dp).fillMaxSize().testTag("chat-messages"), state = scroll,
                        contentPadding = PaddingValues(if (compact) 8.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                        if (messages.isEmpty()) item { EmptyState(if (state.loading) "正在加载消息…" else "暂无消息") }
                        items(messages, key = { it.key }) { message ->
                            MessageRow(message, avatar, loader, { lightbox = it }, {
                                if (message.retryMayDuplicate) retry = message.key else repository.retryMessage(message.key)
                            })
                        }
                        item(key = "chat-end") { Spacer(Modifier.fillMaxWidth().height(1.dp).testTag("chat-end")) }
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
                Column(Modifier.align(Alignment.CenterHorizontally).widthIn(max = 760.dp).fillMaxWidth().testTag("chat-composer")
                    .padding(horizontal = if (compact) 8.dp else 16.dp, vertical = if (compact) 2.dp else 8.dp)) {
                    attachmentState.uri?.let { uri ->
                        Row(Modifier.fillMaxWidth().testTag("pending-attachment"), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            MediaImage(uri.toString(), loader, "待发送图片", Modifier.size(if (compact) 40.dp else 64.dp).clip(RoundedCornerShape(6.dp)))
                            Text("待发送图片", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                            ToolButton(Icons.Default.Close, "移除待发送图片") { attachmentState.uri = null }
                        }
                    }
                    TextField(draft, { draft = it }, modifier = Modifier.fillMaxWidth().heightIn(max = if (compact) 56.dp else 120.dp).testTag("message-input"),
                        placeholder = { Text("发送消息…") }, minLines = 1, maxLines = if (compact) 1 else 4,
                        colors = TextFieldDefaults.colors(focusedContainerColor = Color.White, unfocusedContainerColor = Color.White,
                            focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent))
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        ToolButton(if (showInventory) Icons.Default.Keyboard else Icons.Default.SentimentSatisfiedAlt, "表情与贴纸") {
                            if (!showInventory) { focus.clearFocus(); keyboard?.hide() }
                            showInventory = !showInventory
                        }
                        ToolButton(Icons.Default.Image, "选择图片", canSend && imageRequest == null) {
                            imageRequest = scope + selectedPeer
                            picker.launch("image/*")
                        }
                        Spacer(Modifier.weight(1f))
                        FilledIconButton(onClick = {
                            val image = attachmentState.uri
                            if (image != null) { repository.sendImage(image); attachmentState.uri = null }
                            else if (draft.isNotBlank()) { repository.sendText(draft); draft = "" }
                        }, enabled = canSend && (attachmentState.uri != null || draft.isNotBlank()),
                            modifier = Modifier.size(48.dp).testTag("send-message"), shape = RoundedCornerShape(8.dp)) {
                            Icon(Icons.Default.ArrowUpward, if (attachmentState.uri != null) "发送图片" else "发送消息")
                        }
                    }
                }
                if (showInventory && !inventoryDialog) InventoryPanel(state, loader, { draft += it },
                    { repository.sendSticker(it); showInventory = false }, canSend, { showInventory = false },
                    Modifier.fillMaxWidth().height(inventoryHeight))
            }
            if (showInventory && inventoryDialog) Dialog(onDismissRequest = { showInventory = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
                val dialogFocus = remember { FocusRequester() }
                LaunchedEffect(Unit) { dialogFocus.requestFocus() }
                Surface(Modifier.padding(12.dp).widthIn(max = 480.dp).fillMaxWidth().height(dialogHeight).onPreviewKeyEvent {
                    if (it.key == Key.Escape && it.type == KeyEventType.KeyUp) { showInventory = false; true } else false
                }.focusRequester(dialogFocus).focusable(), shape = RoundedCornerShape(12.dp)) {
                    InventoryPanel(state, loader, { draft += it }, { repository.sendSticker(it); showInventory = false },
                        canSend, { showInventory = false }, Modifier.fillMaxSize())
                }
            }
        }
        if (profile && inlineProfile) {
            VerticalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
            FriendDetails(friend, selectedPeer, name, avatar, loader,
                Modifier.width(270.dp).fillMaxHeight().testTag("friend-details-inline")) { profile = false }
        }
    }
    lightbox?.let { ImageLightbox(it, loader) { lightbox = null } }
    retry?.let { key -> AlertDialog(onDismissRequest = { retry = null }, title = { Text("确认重新发送？") },
        text = { Text("上次发送结果可能未确认，对方可能已经收到。重试可能产生重复消息，请先检查会话。") },
        confirmButton = { TextButton(onClick = { repository.retryMessage(key); retry = null }, enabled = canSend) { Text("仍要重试") } },
        dismissButton = { TextButton(onClick = { retry = null }) { Text("取消") } }) }
    if (profile && !inlineProfile) FriendDetailsDrawer(friend, selectedPeer, name, avatar, loader) { profile = false }
}

@Composable
private fun MessageRow(message: Message, avatar: String, loader: UiImageLoader, viewImage: (String) -> Unit, retry: () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (message.echo) Arrangement.End else Arrangement.Start, verticalAlignment = Alignment.Top) {
        if (!message.echo) { Avatar(message.name, avatar, loader, size = 30); Spacer(Modifier.width(8.dp)) }
        Column(Modifier.fillMaxWidth(if (message.echo) .84f else .9f), horizontalAlignment = if (message.echo) Alignment.End else Alignment.Start) {
            if (!message.echo) Text(message.name, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp))
            val parts = remember(message.text, message.imageUrl) {
                val source = message.imageUrl?.let { if (message.key.startsWith("local:") && it.startsWith("content://")) it else safeImageSource(it) }
                source?.let { listOf(MessagePart.Image(it)) } ?: SteamMessageParser.parse(message.text)
            }
            Column(Modifier.clip(RoundedCornerShape(8.dp)).background(if (message.echo) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant).padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                parts.forEach { part -> MessageContent(part, loader, viewImage) }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(displayTime(message.time), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (message.echo && message.pending) { Icon(Icons.Default.Schedule, "发送中", Modifier.size(14.dp)); Text("发送中", style = MaterialTheme.typography.labelSmall) }
                else if (message.echo && !message.failed) Icon(Icons.Default.Done, "已发送", Modifier.size(14.dp), tint = MaterialTheme.colorScheme.primary)
            }
            if (message.echo && message.failed) {
                Text(message.error.ifBlank { "发送失败或结果未确认" }, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = retry, modifier = Modifier.heightIn(min = 48.dp)) { Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(4.dp)); Text("重试") }
            }
        }
    }
}

@Composable
private fun MessageContent(part: MessagePart, loader: UiImageLoader, viewImage: (String) -> Unit) {
    val context = LocalContext.current
    when (part) {
        is MessagePart.Text -> SelectionContainer { Text(part.text, style = MaterialTheme.typography.bodyMedium) }
        is MessagePart.Image -> MediaImage(part.source, loader, part.label,
            (if (part.small) Modifier.size(48.dp) else Modifier.fillMaxWidth().height(190.dp)).clip(RoundedCornerShape(6.dp)).clickable { viewImage(part.source) })
        is MessagePart.Link -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (part.image.isNotBlank()) MediaImage(part.image, loader, "链接预览", Modifier.fillMaxWidth().height(150.dp).clickable { viewImage(part.image) })
            TextButton(onClick = { openWeb(context, part.url) }, contentPadding = PaddingValues(0.dp), modifier = Modifier.heightIn(min = 48.dp)) {
                Text(part.title, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                Icon(Icons.AutoMirrored.Filled.OpenInNew, "打开链接", Modifier.padding(start = 4.dp).size(18.dp))
            }
            if (part.description.isNotBlank()) Text(part.description, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
internal fun InventoryPanel(state: AppState, loader: UiImageLoader, insert: (String) -> Unit,
                            sendSticker: (String) -> Unit, canSendSticker: Boolean, close: () -> Unit,
                            modifier: Modifier = Modifier.fillMaxWidth().height(226.dp)) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    Column(modifier.background(MaterialTheme.colorScheme.surfaceVariant)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TabRow(tab, Modifier.weight(1f)) { listOf("Steam", "Emoji", "贴纸").forEachIndexed { index, label -> Tab(tab == index, { tab = index }, text = { Text(label) }) } }
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
            Text(if (state.loading) "正在加载库存…" else "暂无可用库存", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        else LazyVerticalGrid(GridCells.Adaptive(64.dp), modifier = Modifier.weight(1f), contentPadding = PaddingValues(8.dp)) {
            items(inventory, key = { it }) { item ->
                val title = if (tab == 2) state.stickerInventory.firstOrNull { it.name == item }?.title ?: item else item
                Column(Modifier.height(76.dp).clip(RoundedCornerShape(6.dp)).clickable(enabled = tab != 2 || canSendSticker) {
                    if (tab == 2) sendSticker(item)
                    else insert(if (tab == 0) ":$item:" else item)
                }.padding(4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    if (tab == 1) Text(item, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.height(48.dp))
                    else {
                        MediaImage(if (tab == 0) emoticonSource(item) else stickerSource(item), loader, title, Modifier.size(44.dp))
                        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
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
