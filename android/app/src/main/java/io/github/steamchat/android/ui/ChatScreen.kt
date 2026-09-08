@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package io.github.steamchat.android.ui

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.github.steamchat.android.AppState
import io.github.steamchat.android.ChatRepository
import io.github.steamchat.android.Message

@Composable
internal fun ChatScreen(state: AppState, repository: ChatRepository, loader: UiImageLoader) {
    var draft by rememberSaveable(state.selectedPeer) { mutableStateOf("") }
    // Content grants and previews intentionally live only in this composition, never persisted or queued.
    var attachment by remember(state.selectedPeer) { mutableStateOf<Uri?>(null) }
    var showInventory by rememberSaveable { mutableStateOf(false) }
    var lightbox by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableStateOf<String?>(null) }
    var profile by remember { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    val selectedPeer = state.selectedPeer
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (repository.state.value.selectedPeer == selectedPeer) attachment = uri
    }
    BackHandler {
        when { lightbox != null -> lightbox = null; showInventory -> showInventory = false; else -> repository.leaveConversation() }
    }
    val friend = state.friends.firstOrNull { it.id == selectedPeer }
    val conversation = state.conversations.firstOrNull { it.id == selectedPeer }
    val name = state.selectedName.ifBlank { friend?.name ?: selectedPeer }
    val avatar = friend?.avatar?.ifBlank { conversation?.avatar.orEmpty() } ?: conversation?.avatar.orEmpty()
    val messages = state.messages.filter { it.peerId == selectedPeer }
    val scroll = rememberLazyListState()
    val canSend = state.loggedIn && state.accessAllowed && state.connected && state.steamOnline
    LaunchedEffect(selectedPeer, messages.lastOrNull()?.key, messages.size) {
        if (messages.isNotEmpty()) {
            val nearBottom = scroll.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= messages.size - 3 } ?: true
            if (nearBottom || messages.last().echo) scroll.animateScrollToItem(messages.lastIndex)
        }
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 66.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ToolButton(Icons.AutoMirrored.Filled.ArrowBack, "返回消息") { repository.leaveConversation() }
            Avatar(name, avatar, loader, friend?.online == true, 36)
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (!state.connected) state.connectionText else friend?.gameName?.takeIf { it.isNotBlank() }?.let { "正在玩 $it" } ?: if (friend?.online == true) "在线" else "离线", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            ToolButton(Icons.Default.PersonOutline, "好友资料") { profile = true }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
        if (!canSend) Text(when {
            !state.accessAllowed -> "此账号尚无聊天访问权限"
            !state.connected -> "${state.connectionText} · 暂不能发送消息"
            else -> "Steam 未在线 · 暂不能发送消息"
        }, Modifier.fillMaxWidth().background(Color(0xFFFAF5E9)).padding(10.dp), color = Color(0xFF9B793E), style = MaterialTheme.typography.bodySmall)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = scroll, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            if (messages.isEmpty()) item { EmptyState(if (state.loading) "正在加载消息…" else "暂无消息") }
            items(messages, key = { it.key }) { message ->
                MessageRow(message, avatar, loader, { lightbox = it }, { retry = message.key })
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            attachment?.let { uri ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    MediaImage(uri.toString(), loader, "待发送图片", Modifier.size(72.dp).clip(RoundedCornerShape(6.dp)))
                    Text("待发送图片", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    ToolButton(Icons.Default.Close, "移除待发送图片") { attachment = null }
                }
            }
            TextField(draft, { draft = it }, modifier = Modifier.fillMaxWidth().heightIn(max = 150.dp), placeholder = { Text("发送消息…") },
                minLines = 1, maxLines = 5, colors = TextFieldDefaults.colors(focusedContainerColor = Color.White, unfocusedContainerColor = Color.White,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                ToolButton(if (showInventory) Icons.Default.Keyboard else Icons.Default.SentimentSatisfiedAlt, "表情与贴纸") { if (!showInventory) keyboard?.hide(); showInventory = !showInventory }
                ToolButton(Icons.Default.Image, "选择图片", canSend) { picker.launch("image/*") }
                Spacer(Modifier.weight(1f))
                FilledIconButton(onClick = {
                    val image = attachment
                    if (image != null) { repository.sendImage(image); attachment = null }
                    else if (draft.isNotBlank()) { repository.sendText(draft); draft = "" }
                }, enabled = canSend && (attachment != null || draft.isNotBlank()), modifier = Modifier.size(48.dp), shape = RoundedCornerShape(8.dp)) {
                    Icon(Icons.Default.ArrowUpward, if (attachment != null) "发送图片" else "发送消息")
                }
            }
        }
        if (showInventory) InventoryPanel(state, loader, { draft += it }, { showInventory = false })
    }
    lightbox?.let { ImageLightbox(it, loader) { lightbox = null } }
    retry?.let { key -> AlertDialog(onDismissRequest = { retry = null }, title = { Text("确认重新发送？") },
        text = { Text("上次发送结果可能未确认，对方可能已经收到。重试可能产生重复消息，请先检查会话。") },
        confirmButton = { TextButton(onClick = { repository.retryMessage(key); retry = null }, enabled = canSend) { Text("仍要重试") } },
        dismissButton = { TextButton(onClick = { retry = null }) { Text("取消") } }) }
    if (profile) AlertDialog(onDismissRequest = { profile = false }, title = { Text(name) }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Avatar(name, avatar, loader, friend?.online == true, 56)
            SelectionContainer { Text("Steam ID：$selectedPeer") }
            Text(friend?.gameName?.takeIf { it.isNotBlank() }?.let { "正在玩 $it" } ?: if (friend?.online == true) "在线" else "离线")
        }
    }, confirmButton = { TextButton(onClick = { profile = false }) { Text("关闭") } })
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
private fun InventoryPanel(state: AppState, loader: UiImageLoader, insert: (String) -> Unit, close: () -> Unit) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    Column(Modifier.fillMaxWidth().height(226.dp).background(MaterialTheme.colorScheme.surfaceVariant)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TabRow(tab, Modifier.weight(1f)) { listOf("Steam", "Emoji", "贴纸").forEachIndexed { index, label -> Tab(tab == index, { tab = index }, text = { Text(label) }) } }
            ToolButton(Icons.Default.Close, "关闭表情面板", onClick = close)
        }
        val inventory = remember(tab, state.emoticons, state.stickers) {
            when (tab) {
                0 -> state.emoticons.mapNotNull(::inventoryName).distinct()
                1 -> listOf("😀", "😊", "😂", "🥰", "😎", "🤔", "😮", "😭", "👍", "👏", "❤️", "🎉", "🔥", "✨", "🎮", "☕")
                else -> state.stickers.map { it.trim() }.filter { it.isNotEmpty() && it.length <= 256 && it.none(Char::isISOControl) }.distinct()
            }
        }
        if (inventory.isEmpty()) EmptyState(if (state.loading) "正在加载库存…" else "暂无可用库存")
        LazyVerticalGrid(GridCells.Adaptive(64.dp), contentPadding = PaddingValues(8.dp)) {
            items(inventory, key = { it }) { item ->
                Column(Modifier.height(76.dp).clip(RoundedCornerShape(6.dp)).clickable {
                    insert(when (tab) { 0 -> ":$item:"; 1 -> item; else -> stickerMarkup(item) })
                }.padding(4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    if (tab == 1) Text(item, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.height(48.dp))
                    else {
                        MediaImage(if (tab == 0) emoticonSource(item) else stickerSource(item), loader, item, Modifier.size(44.dp))
                        Text(item, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
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
