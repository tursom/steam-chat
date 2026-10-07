@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package io.github.steamchat.android.ui

import android.content.Intent
import androidx.core.net.toUri
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.steamchat.android.*
import kotlinx.coroutines.delay
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

@Composable
fun ChatApp(repository: ChatRepository, notificationsAllowed: Boolean, requestNotifications: () -> Unit,
            openNotificationSettings: () -> Unit) {
    val state by repository.state.collectAsStateWithLifecycle()
    SteamChatTheme(state.themeMode) {
        val chat = chatColors
        val loader = remember(repository, state.loggedIn, state.server, state.activeAccountId, state.accessAllowed, state.stickerInventory) { UiImageLoader(repository) }
        DisposableEffect(loader) { onDispose { loader.clear() } }
        val keyboard = LocalSoftwareKeyboardController.current
        val focus = LocalFocusManager.current
        val snackbar = remember { SnackbarHostState() }
        val drafts = rememberSaveableStateHolder()
        // Track restored draft keys too, so logout cannot retain a previously visited peer's draft.
        var draftKeys by rememberSaveable { mutableStateOf<List<String>>(emptyList()) }
        val sessionScope = "${state.loggedIn}:${state.server}:${state.username}:${state.activeAccountId}:${state.accessAllowed}"
        val navigation = rememberSaveable(sessionScope, saver = WorkspaceNavigation.saver(sessionScope)) {
            WorkspaceNavigation(sessionScope, state.selectedPeer, state.selectedName)
        }
        var tab by navigation.tab
        var lastPeer by navigation.lastPeer
        var lastName by navigation.lastName
        val profile = navigation.profile
        val attachments: ConversationAttachments = viewModel()
        attachments.useScope(sessionScope)
        var previousScope by rememberSaveable { mutableStateOf(sessionScope) }
        LaunchedEffect(sessionScope) {
            if (previousScope != sessionScope) {
                draftKeys.filterNot { it.startsWith("$sessionScope:") }.forEach { drafts.removeState(it) }
                draftKeys = draftKeys.filter { it.startsWith("$sessionScope:") }
                previousScope = sessionScope
            }
        }
        LaunchedEffect(state.error) {
            if (state.error.isNotBlank()) { snackbar.showSnackbar(state.error); repository.clearError() }
        }
        LaunchedEffect(state.selectedPeer, state.selectionRequest, sessionScope) {
            val latest = repository.state.value
            if (latest.selectionRequest != state.selectionRequest || latest.selectedPeer != state.selectedPeer) return@LaunchedEffect
            if (state.selectedPeer.isNotBlank()) {
                lastPeer = state.selectedPeer; lastName = state.selectedName
                // Notification navigation may select a chat while settings are open.
                if (tab == 2) tab = 0
            }
        }
        Surface(Modifier.fillMaxSize(), color = chat.bg) {
            BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding()) {
                val wide = maxWidth >= 840.dp
                val rail = maxWidth >= 600.dp
                val inlineProfile = maxWidth >= 1200.dp
                val ready = state.loggedIn && state.restoration == SessionRestoration.NONE
                fun leaveChat() {
                    if (state.selectedPeer.isNotBlank()) { lastPeer = state.selectedPeer; lastName = state.selectedName }
                    profile.value = false
                    keyboard?.hide(); focus.clearFocus()
                    repository.leaveConversation()
                }
                fun selectTab(index: Int) {
                    profile.value = false
                    keyboard?.hide(); focus.clearFocus()
                    if (index == 2 || !wide) leaveChat()
                    tab = index
                }
                // selectedPeer continues to mean a visible conversation in the
                // repository: hidden chats retain their unread/notification behavior.
                LaunchedEffect(wide, tab, sessionScope) {
                    if (wide && ready && state.accessAllowed && tab != 2 && state.selectedPeer.isBlank() && lastPeer.isNotBlank())
                        repository.selectConversation(lastPeer, lastName)
                }
                BackHandler(ready && state.selectedPeer.isBlank() && tab != 0) { selectTab(0) }
                Scaffold(modifier = Modifier.fillMaxSize(), contentWindowInsets = WindowInsets(0, 0, 0, 0), containerColor = chat.bg,
                    snackbarHost = { SnackbarHost(snackbar) }, bottomBar = {
                        if (ready && !rail && state.selectedPeer.isBlank()) Column {
                            HorizontalDivider(color = chat.line)
                            NavigationBar(Modifier.testTag("bottom-navigation"), containerColor = chat.navBg, tonalElevation = 0.dp, windowInsets = WindowInsets(0, 0, 0, 0)) {
                                navigationItems.forEachIndexed { index, item ->
                                    NavigationBarItem(selected = tab == index, onClick = { selectTab(index) },
                                        modifier = Modifier.testTag("nav-${item.tag}"),
                                        icon = { NavigationIcon(state, index, item, tab == index) },
                                        label = { Text(item.label, fontWeight = if (tab == index) FontWeight.Bold else FontWeight.Medium) },
                                        colors = navigationColors())
                                }
                            }
                        }
                    }) { padding ->
                    Box(Modifier.padding(padding).fillMaxSize()) {
                        when {
                            !ready -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                                Box(Modifier.widthIn(max = 520.dp).fillMaxSize()) {
                                    if (state.restoration != SessionRestoration.NONE) RestorationScreen(state, repository)
                                    else LoginScreen(state, repository)
                                }
                            }
                            else -> Row(Modifier.fillMaxSize().testTag("adaptive-workspace")) {
                                if (rail) {
                                    TabletNavigation(state, tab, if (inlineProfile) 80.dp else 72.dp, ::selectTab)
                                    VerticalDivider(color = chat.line)
                                }
                                if (tab == 2) {
                                    Box(Modifier.weight(1f).fillMaxHeight().background(chat.ground).testTag("settings-pane"), contentAlignment = Alignment.TopCenter) {
                                        Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) {
                                            SettingsScreen(state, repository, loader, notificationsAllowed, requestNotifications, openNotificationSettings)
                                        }
                                    }
                                } else {
                                    if (wide || state.selectedPeer.isBlank()) {
                                        Box((if (wide) Modifier.width(if (inlineProfile) 340.dp else 300.dp) else Modifier.weight(1f))
                                            .fillMaxHeight().background(chat.bg).testTag("conversation-pane")) {
                                            ContactScreen(state, repository, loader, tab == 1, { selectTab(1) }, { selectTab(2) },
                                                selectedPeer = if (wide) state.selectedPeer else lastPeer, compact = wide)
                                        }
                                        if (wide) VerticalDivider(color = chat.line)
                                    }
                                    if (state.selectedPeer.isNotBlank()) {
                                        val draftKey = "$sessionScope:${state.selectedPeer}"
                                        SideEffect { if (draftKey !in draftKeys) draftKeys = draftKeys + draftKey }
                                        Box(Modifier.weight(1f).fillMaxHeight().testTag("chat-pane")) {
                                            drafts.SaveableStateProvider(draftKey) {
                                                ChatScreen(state, repository, loader, showBack = !wide, onBack = ::leaveChat,
                                                    inlineProfile = inlineProfile, profileState = profile,
                                                    attachmentState = attachments.forPeer(state.selectedPeer))
                                            }
                                        }
                                    } else if (wide) {
                                        Column(Modifier.weight(1f).fillMaxHeight().background(chat.chatBg).testTag("chat-empty"),
                                            verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                                            Box(Modifier.size(88.dp).clip(CircleShape).background(chat.accentSoft), contentAlignment = Alignment.Center) {
                                                Icon(Icons.AutoMirrored.Outlined.Chat, null, Modifier.size(40.dp), tint = chat.accentText)
                                            }
                                            Spacer(Modifier.height(20.dp))
                                            Text("选择一个会话", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                                            Text("从左侧选择好友，开始聊天", style = MaterialTheme.typography.bodyMedium, color = chat.muted, modifier = Modifier.padding(12.dp))
                                        }
                                    }
                                }
                            }
                        }
                        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
                    }
                }
            }
        }
    }
}

internal class NavigationItem(val label: String, val tag: String, val selectedIcon: ImageVector, val icon: ImageVector)
internal val navigationItems = listOf(
    NavigationItem("消息", "messages", Icons.AutoMirrored.Filled.Chat, Icons.AutoMirrored.Outlined.Chat),
    NavigationItem("好友", "friends", Icons.Default.People, Icons.Outlined.People),
    NavigationItem("设置", "settings", Icons.Default.Settings, Icons.Outlined.Settings)
)

@Composable
internal fun NavigationIcon(state: AppState, index: Int, item: NavigationItem, selected: Boolean) {
    val unread = state.conversations.sumOf { it.unread }
    val icon = if (selected) item.selectedIcon else item.icon
    if (index == 0 && unread > 0) BadgedBox(badge = {
        Badge(containerColor = chatColors.danger, contentColor = chatColors.onDanger) { Text(unread.coerceAtMost(999).toString()) }
    }) { Icon(icon, item.label) }
    else Icon(icon, item.label)
}

@Composable
internal fun navigationColors() = NavigationBarItemDefaults.colors(
    selectedIconColor = chatColors.accentText, selectedTextColor = chatColors.text, indicatorColor = chatColors.accentSoft,
    unselectedIconColor = chatColors.muted, unselectedTextColor = chatColors.muted)

@Composable
internal fun ToolButton(icon: ImageVector, label: String, enabled: Boolean = true, onClick: () -> Unit) {
    TooltipBox(positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(), tooltip = { PlainTooltip { Text(label) } }, state = rememberTooltipState()) {
        IconButton(onClick, enabled = enabled, modifier = Modifier.size(48.dp)) { Icon(icon, label) }
    }
}

/** Circular avatar; the presence dot is green online, blue in game, absent offline. */
@Composable
internal fun Avatar(name: String, source: String, loader: UiImageLoader, online: Boolean = false, size: Int = 46,
                    playing: Boolean = false, ring: Color = chatColors.bg) {
    val chat = chatColors
    Box(Modifier.size(size.dp)) {
        Box(Modifier.fillMaxSize().clip(CircleShape).background(chat.tints[(name.hashCode() and Int.MAX_VALUE) % chat.tints.size]), contentAlignment = Alignment.Center) {
            if (source.isNotBlank()) MediaImage(source, loader, "$name 的头像", Modifier.fillMaxSize(), androidx.compose.ui.layout.ContentScale.Crop, name.take(1))
            else Text(name.take(1).ifBlank { "?" }, color = chat.text, fontWeight = FontWeight.Medium, fontSize = (size / 2.6).sp)
        }
        if (online || playing) {
            val dot = (size * .27f).coerceIn(10f, 20f).dp
            Box(Modifier.size(dot).align(Alignment.BottomEnd).clip(CircleShape).background(ring).padding(dot * .17f)
                .clip(CircleShape).background(if (playing) chat.game else chat.online))
        }
    }
}

@Composable
private fun BrandMark(size: Dp = 44.dp) {
    Box(Modifier.size(size).clip(RoundedCornerShape(size * .32f)).background(chatColors.accent), contentAlignment = Alignment.Center) {
        Icon(Icons.Default.SportsEsports, null, Modifier.size(size * .56f), tint = chatColors.onAccent)
    }
}

@Composable
internal fun RestorationScreen(state: AppState, repository: ChatRepository) {
    val chat = chatColors
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
        BrandMark(56.dp)
        Text("Steam Chat", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text(state.server, color = chat.muted)
        if (state.restoration == SessionRestoration.LOADING) {
            CircularProgressIndicator()
            Text("正在验证已保存的会话…")
        } else {
            Text("暂时无法验证已保存的会话，请检查网络后重试。验证完成前不显示聊天记录。", color = chat.muted)
            Button(onClick = { repository.refresh() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("重试") }
        }
        TextButton(onClick = { repository.logout() }) { Text("退出会话并重新登录") }
        TextButton(onClick = { repository.changeServer() }) { Text("更换服务器") }
    }
}

@Composable
private fun LoginScreen(state: AppState, repository: ChatRepository) {
    val chat = chatColors
    var server by rememberSaveable(state.server) { mutableStateOf(state.server) }
    var username by rememberSaveable { mutableStateOf(state.username) }
    // Password must not enter saved instance state.
    var password by remember { mutableStateOf("") }
    var configured by rememberSaveable(state.server) { mutableStateOf(state.server.isNotBlank()) }
    var validation by remember { mutableStateOf("") }
    val fieldShape = RoundedCornerShape(14.dp)
    BackHandler(configured) { configured = false; password = "" }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (configured) ToolButton(Icons.AutoMirrored.Filled.ArrowBack, "修改后端地址") { configured = false; password = "" }
            BrandMark(40.dp)
            Spacer(Modifier.width(12.dp)); Text("Steam Chat", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(20.dp))
        Text(if (configured) "登录" else "连接服务器", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        if (!configured) {
            OutlinedTextField(server, { server = it; validation = "" }, Modifier.fillMaxWidth(), label = { Text("后端 HTTPS 地址") }, shape = fieldShape,
                singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), leadingIcon = { Icon(Icons.Default.Lock, null) })
            if (validation.isNotEmpty()) Text(validation, color = MaterialTheme.colorScheme.error)
            Button(onClick = {
                if (validServer(server)) { repository.configureServer(server); configured = true }
                else validation = "请输入不含账户密码、查询参数或片段的 HTTPS 地址"
            }, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), shape = fieldShape) { Text("继续") }
            Text("HTTPS 安全连接", color = chat.muted, style = MaterialTheme.typography.bodySmall)
        } else {
            Text(server, color = chat.muted)
            OutlinedTextField(username, { username = it }, Modifier.fillMaxWidth(), label = { Text("后台账号") }, singleLine = true, shape = fieldShape)
            OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text("密码") }, singleLine = true, shape = fieldShape,
                visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
            Button(onClick = { repository.login(server, username.trim(), password); password = "" },
                enabled = !state.loading && username.isNotBlank() && password.isNotBlank(), modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), shape = fieldShape) { Text(if (state.loading) "正在登录…" else "登录") }
        }
    }
}

/** One status pill replaces the old icon and refresh button; details and manual refresh live in its dialog. */
@Composable
internal fun SyncStatusIndicator(state: AppState, settings: () -> Unit, refresh: () -> Unit = {}) {
    val chat = chatColors
    var details by remember { mutableStateOf(false) }
    val healthy = state.accessAllowed && state.restSyncStatus != RestSyncStatus.FAILED && state.steamOnline
    val (label, description) = when {
        !state.accessAllowed -> "无权限" to "同步状态：无访问权限"
        state.restSyncStatus == RestSyncStatus.SYNCING -> "同步中" to "同步状态：正在同步"
        state.restSyncStatus == RestSyncStatus.FAILED -> "同步失败" to "同步状态：同步失败"
        !state.steamOnline -> "Steam 离线" to "同步状态：Steam 离线"
        state.restSyncStatus == RestSyncStatus.READY && state.connected -> "已连接" to "同步状态：已同步，实时连接正常"
        state.restSyncStatus == RestSyncStatus.READY -> "REST 接收" to "同步状态：已同步，使用 REST 接收消息"
        else -> "等待同步" to "同步状态：等待同步"
    }
    val container = if (healthy) chat.accentSoft else chat.warningBg
    val content = if (healthy) chat.accentText else chat.warningText
    Surface(onClick = { details = true }, shape = RoundedCornerShape(16.dp), color = container, contentColor = content,
        modifier = Modifier.heightIn(min = 32.dp).testTag("sync-status").semantics { contentDescription = description }) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (state.accessAllowed && state.restSyncStatus == RestSyncStatus.SYNCING)
                CircularProgressIndicator(Modifier.size(10.dp), color = content, strokeWidth = 1.5.dp)
            else Box(Modifier.size(8.dp).clip(CircleShape).background(if (healthy && state.connected) chat.online else content))
            Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium, maxLines = 1)
        }
    }
    if (details) AlertDialog(onDismissRequest = { details = false }, title = { Text("同步状态") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (state.username.isNotBlank()) Text(state.username, fontWeight = FontWeight.Medium)
            StatusLine(state.restSyncStatus == RestSyncStatus.READY, state.restSyncText)
            StatusLine(state.connected, state.connectionText)
            StatusLine(state.steamOnline, if (state.steamOnline) "Steam 在线" else "Steam 离线")
            if (!state.accessAllowed) Text("此账号尚无聊天访问权限", color = chat.danger)
        }
    }, confirmButton = { TextButton(onClick = { details = false }) { Text("关闭") } },
        dismissButton = {
            Row {
                TextButton(onClick = { details = false; settings() }) { Text("打开设置") }
                TextButton(onClick = { details = false; refresh() }, enabled = !state.loading) { Text("刷新") }
            }
        })
}

@Composable
private fun StatusLine(ok: Boolean, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(if (ok) chatColors.online else chatColors.warningText))
        Text(text)
    }
}

@Composable
internal fun SearchField(query: String, onChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier) {
    val chat = chatColors
    BasicTextField(query, onChange, modifier.fillMaxWidth().heightIn(min = 44.dp), singleLine = true,
        textStyle = TextStyle(color = chat.text, fontSize = 15.sp), cursorBrush = SolidColor(chat.accent),
        decorationBox = { inner ->
            Row(Modifier.clip(RoundedCornerShape(22.dp)).background(chat.input).padding(start = 14.dp, end = 2.dp).heightIn(min = 44.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Search, null, Modifier.size(20.dp), tint = chat.muted)
                Spacer(Modifier.width(10.dp))
                Box(Modifier.weight(1f)) {
                    if (query.isEmpty()) Text(placeholder, color = chat.muted, fontSize = 15.sp, maxLines = 1)
                    inner()
                }
                if (query.isNotEmpty()) ToolButton(Icons.Default.Close, "清除搜索") { onChange("") }
            }
        })
}

@Composable
internal fun ContactScreen(state: AppState, repository: ChatRepository, loader: UiImageLoader, friends: Boolean,
                          newChat: () -> Unit, settings: () -> Unit, selectedPeer: String = "", compact: Boolean = false) {
    val chat = chatColors
    var query by rememberSaveable(friends) { mutableStateOf("") }
    var unread by rememberSaveable { mutableStateOf(false) }
    var expandedSearch by rememberSaveable(friends) { mutableStateOf(false) }
    var requestSearchFocus by remember { mutableStateOf(false) }
    val searchFocus = remember { FocusRequester() }
    LaunchedEffect(requestSearchFocus) {
        if (requestSearchFocus) { searchFocus.requestFocus(); requestSearchFocus = false }
    }
    // The pull indicator stays until the sync it started settles (or briefly, if none starts).
    var pulled by remember { mutableStateOf(false) }
    LaunchedEffect(pulled, state.restSyncStatus) {
        if (pulled && state.restSyncStatus != RestSyncStatus.SYNCING) { delay(800); pulled = false }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
    val short = maxHeight < 400.dp
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 16.dp)) {
            Row(Modifier.fillMaxWidth().padding(start = 4.dp, top = if (short) 2.dp else 10.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(if (friends) "好友" else "消息", style = if (short || compact) MaterialTheme.typography.headlineSmall else MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold, maxLines = 1, modifier = Modifier.semantics { heading() })
                    if (friends && !short) Text("${state.friends.count { it.online }} 人在线", color = chat.muted, style = MaterialTheme.typography.bodySmall)
                }
                SyncStatusIndicator(state, settings, repository::refresh)
                if (short && !expandedSearch && query.isEmpty()) ToolButton(Icons.Default.Search, if (friends) "搜索好友" else "搜索会话") { expandedSearch = true; requestSearchFocus = true }
                if (!friends) ToolButton(Icons.Default.Edit, "新建会话", onClick = newChat)
            }
            if (!short || expandedSearch || query.isNotEmpty()) SearchField(query, { query = it }, if (friends) "搜索好友" else "搜索会话或好友",
                Modifier.padding(top = 8.dp).focusRequester(searchFocus).onFocusChanged { if (it.isFocused) expandedSearch = true })
            if (!state.accessAllowed) Text("此账号尚无聊天访问权限", color = chat.danger, modifier = Modifier.padding(vertical = 8.dp))
            if (!short && !friends) Row(Modifier.padding(top = 10.dp, bottom = 4.dp).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val unreadCount = state.conversations.count { it.unread > 0 }
                ListFilter("全部", null, !unread) { unread = false }
                ListFilter("未读", unreadCount.takeIf { it > 0 }, unread) { unread = true }
            }
            if (short && !friends && unread) AssistChip(onClick = { unread = false }, label = { Text("仅未读") },
                trailingIcon = { Icon(Icons.Default.Close, "显示全部消息", Modifier.size(16.dp)) }, modifier = Modifier.testTag("clear-unread-filter"))
        }
        PullToRefreshBox(isRefreshing = pulled, onRefresh = { pulled = true; repository.refresh() }, modifier = Modifier.weight(1f)) {
            LazyColumn(Modifier.fillMaxSize().testTag("contact-list"), contentPadding = PaddingValues(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 12.dp)) {
                if (friends) {
                    val contacts = state.friends.filter { it.name.contains(query, true) || it.id.contains(query) }
                    if (contacts.isEmpty()) item { EmptyState(if (state.loading) "正在加载好友…" else "没有匹配的好友") }
                    val groups = listOf(
                        "游戏中" to contacts.filter { it.gameName.isNotBlank() },
                        "在线" to contacts.filter { it.online && it.gameName.isBlank() },
                        "离线" to contacts.filter { !it.online && it.gameName.isBlank() })
                    groups.filter { it.second.isNotEmpty() }.forEach { (title, members) ->
                        item(key = "group-$title") { GroupHeader("$title · ${members.size}") }
                        items(members, key = { it.id }) { friend ->
                            ContactRow(friend.id, friend.name, friend.avatar,
                                if (friend.gameName.isNotBlank()) "正在玩 ${friend.gameName}" else if (friend.online) "在线" else "离线", "", 0,
                                friend.online, loader, friend.id == selectedPeer, compact, playing = friend.gameName.isNotBlank(),
                                previewColor = when { friend.gameName.isNotBlank() -> chat.game; friend.online -> chat.accentText; else -> chat.muted },
                                dimmed = !friend.online && friend.gameName.isBlank()) { repository.selectConversation(friend.id, friend.name) }
                        }
                    }
                } else {
                    val conversations = state.conversations.filter { (!unread || it.unread > 0) && (it.name.contains(query, true) || it.id.contains(query)) }
                    if (conversations.isEmpty()) item { EmptyState(if (state.loading) "正在加载会话…" else if (unread) "暂无未读消息" else "暂无会话") }
                    items(conversations, key = { it.id }) { c ->
                        val friend = state.friends.firstOrNull { it.id == c.id }
                        ContactRow(c.id, c.name, c.avatar, c.preview, c.updatedAt, c.unread, friend?.online == true, loader, c.id == selectedPeer, compact,
                            playing = friend?.gameName?.isNotBlank() == true) { repository.selectConversation(c.id, c.name) }
                    }
                }
            }
        }
    }
    }
}

@Composable
private fun ListFilter(label: String, count: Int?, selected: Boolean, onClick: () -> Unit) {
    val chat = chatColors
    Surface(selected = selected, onClick = onClick, shape = RoundedCornerShape(16.dp),
        color = if (selected) chat.accent else Color.Transparent, contentColor = if (selected) chat.onAccent else chat.text,
        border = if (selected) null else androidx.compose.foundation.BorderStroke(1.dp, chat.line),
        modifier = Modifier.heightIn(min = 32.dp)) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium)
            if (count != null) Text(count.coerceAtMost(99).toString(), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun GroupHeader(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, color = chatColors.muted,
        modifier = Modifier.padding(start = 12.dp, top = 14.dp, bottom = 6.dp).semantics { heading() })
}

@Composable
private fun ContactRow(id: String, name: String, avatar: String, preview: String, time: String, unread: Int, online: Boolean, loader: UiImageLoader,
                       isSelected: Boolean, compact: Boolean, playing: Boolean = false, previewColor: Color? = null, dimmed: Boolean = false,
                       select: () -> Unit) {
    val chat = chatColors
    val highlight = unread > 0
    Row(Modifier.fillMaxWidth().padding(vertical = 1.dp).clip(RoundedCornerShape(14.dp))
        .background(if (isSelected) chat.selected else Color.Transparent).testTag("contact-$id").semantics { selected = isSelected }
        .clickable(onClick = select).padding(horizontal = 10.dp, vertical = if (compact) 9.dp else 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(if (compact) 12.dp else 14.dp)) {
        Box(Modifier.alpha(if (dimmed) .6f else 1f)) {
            Avatar(name, avatar, loader, online, if (compact) 46 else 52, playing, ring = if (isSelected) chat.selected else chat.bg)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium,
                    fontSize = if (compact) 15.sp else 16.sp, color = if (dimmed) chat.muted else chat.text)
                if (time.isNotBlank()) Text(listTime(time), style = MaterialTheme.typography.labelMedium,
                    color = if (highlight) chat.accentText else chat.muted, modifier = Modifier.padding(start = 8.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(preview, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = if (compact) 13.sp else 14.sp,
                    color = previewColor ?: if (highlight) chat.text else chat.muted)
                if (highlight) Badge(Modifier.padding(start = 8.dp), containerColor = chat.accent, contentColor = chat.onAccent) {
                    Text(if (unread > 99) "99+" else unread.toString(), fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
internal fun EmptyState(text: String) { Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { Text(text, color = chatColors.muted) } }

@Composable
internal fun SettingsScreen(state: AppState, repository: ChatRepository, loader: UiImageLoader, notificationsAllowed: Boolean,
                           requestNotifications: () -> Unit, openNotificationSettings: () -> Unit) {
    val context = LocalContext.current
    val chat = chatColors
    var logout by remember { mutableStateOf(false) }
    var battery by remember { mutableStateOf(false) }
    var channelSummary by remember { mutableStateOf(ChatNotifications.settingsSummary(context)) }
    var batteryExempt by remember { mutableStateOf(BackgroundWork.batteryExempt(context)) }
    androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
        channelSummary = ChatNotifications.settingsSummary(context)
        batteryExempt = BackgroundWork.batteryExempt(context)
    }
    val version = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull().orEmpty() }
    Column(Modifier.fillMaxSize().background(chat.ground).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("设置", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 4.dp, bottom = 6.dp).semantics { heading() })
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(chat.card).padding(16.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Avatar(state.username, "", loader, size = 56)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(state.username, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text("Steam 账户 ${state.activeAccountId.ifBlank { "未选择" }}", style = MaterialTheme.typography.bodySmall, color = chat.muted)
                Text(state.server.toUri().host ?: state.server, style = MaterialTheme.typography.bodySmall, color = chat.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        SettingsGroup("通知",
            { SettingToggle("后台接收消息", "保持连接以接收新消息；仍受系统休眠与后台限制影响", state.backgroundEnabled, repository::setBackgroundEnabled) },
            { SettingToggle("消息提醒", "此设备的新消息通知", state.notificationsEnabled, repository::setNotificationsEnabled) },
            { SettingToggle("通知显示消息内容", "锁屏和横幅中显示正文", state.notificationPreview, repository::setNotificationPreview) },
            { SettingAction("系统通知权限", if (notificationsAllowed) "已允许；各通知类别仍由系统控制" else "未允许，点击申请或前往系统设置",
                onClick = if (notificationsAllowed) openNotificationSettings else requestNotifications) },
            { SettingAction("消息通知类别", channelSummary, onClick = openNotificationSettings) },
            { SettingAction("发送测试通知", "此设备") {
                val posted = ChatNotifications.test(context)
                Toast.makeText(context, if (posted) "已发送测试通知" else "系统未允许消息通知", Toast.LENGTH_SHORT).show()
                channelSummary = ChatNotifications.settingsSummary(context)
            } })
        SettingsGroup("后台运行",
            { SettingAction("电池优化", "系统休眠时对后台连接的限制", trailing = {
                StatusChip(if (batteryExempt) "已忽略" else "受限制", batteryExempt)
            }) { battery = true } },
            { SettingAction("后台活动与自启动", "在应用详情中由系统管理") { launchSystem(context, BackgroundWork.appDetails(context)) } })
        SettingsGroup("外观", {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("主题", fontSize = 16.sp)
                ThemeSelector(state.themeMode, repository::setThemeMode)
            }
        })
        SettingsGroup("连接",
            { SettingAction("连接状态", null, content = {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    StatusChip(if (state.connected) "实时通道" else "实时通道未连接", state.connected)
                    StatusChip(state.restSyncText.removePrefix("REST ").let { "REST $it" }, state.restSyncStatus == RestSyncStatus.READY)
                    StatusChip(if (state.steamOnline) "Steam 在线" else "Steam 离线", state.steamOnline)
                    if (!state.accessAllowed) StatusChip("无访问权限", false)
                }
            }) { repository.refresh() } },
            { SettingAction("后端地址", state.server) { logout = true } })
        Surface(onClick = { logout = true }, shape = RoundedCornerShape(20.dp), color = chat.card, contentColor = chat.danger,
            modifier = Modifier.fillMaxWidth().padding(top = 14.dp).heightIn(min = 56.dp)) {
            Box(contentAlignment = Alignment.Center) { Text("退出登录", fontSize = 16.sp, fontWeight = FontWeight.Medium) }
        }
        Text("Steam Chat $version · ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}", style = MaterialTheme.typography.bodySmall,
            color = chat.muted, modifier = Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 8.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
    if (logout) AlertDialog(onDismissRequest = { logout = false }, title = { Text("退出并重新配置？") }, text = { Text("将退出当前后台账号，清除本地会话缓存、图片缓存和草稿。之后可修改后端地址。") },
        confirmButton = { TextButton(onClick = { loader.clear(); repository.logout(); logout = false }) { Text("退出登录", color = chat.danger) } }, dismissButton = { TextButton(onClick = { logout = false }) { Text("取消") } })
    if (battery) AlertDialog(onDismissRequest = { battery = false }, title = { Text("后台运行设置") },
        text = { Text((if (batteryExempt) "Steam Chat 已忽略电池优化，可在后台恢复连接服务。" else "允许忽略电池优化后，系统休眠时对后台连接的限制更少，App 也能在后台自行恢复连接服务。") +
            "\n\n荣耀等厂商系统还需在应用详情的耗电或启动管理中允许后台活动和自启动。前台服务不能保证在强行停止、断网或重启后未恢复时继续接收消息。") },
        confirmButton = { TextButton(onClick = {
            battery = false
            if (batteryExempt) launchSystem(context, BackgroundWork.batterySettings())
            // Some vendor builds hide the one-tap request; fall back to the full list.
            else runCatching { context.startActivity(BackgroundWork.exemptionRequest(context)) }.onFailure { launchSystem(context, BackgroundWork.batterySettings()) }
        }) { Text(if (batteryExempt) "电池优化设置" else "申请忽略电池优化") } },
        dismissButton = { TextButton(onClick = { battery = false; launchSystem(context, BackgroundWork.appDetails(context)) }) { Text("应用详情") } })
}

@Composable
private fun SettingsGroup(title: String, vararg rows: @Composable () -> Unit) {
    Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, color = chatColors.muted,
        modifier = Modifier.padding(start = 4.dp, top = 14.dp).semantics { heading() })
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(chatColors.card)) {
        rows.forEachIndexed { index, row ->
            if (index > 0) HorizontalDivider(Modifier.padding(start = 16.dp), color = chatColors.line)
            row()
        }
    }
}

@Composable
private fun StatusChip(text: String, ok: Boolean) {
    val chat = chatColors
    Row(Modifier.clip(RoundedCornerShape(13.dp)).background(if (ok) chat.accentSoft else chat.warningBg).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(if (ok) chat.online else chat.warningText))
        Text(text, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium, color = if (ok) chat.accentText else chat.warningText)
    }
}

@Composable
private fun ThemeSelector(mode: ThemeMode, change: (ThemeMode) -> Unit) {
    val chat = chatColors
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(chat.input).padding(4.dp).selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        listOf(ThemeMode.SYSTEM to "跟随系统", ThemeMode.LIGHT to "浅色", ThemeMode.DARK to "深色").forEach { (value, label) ->
            val selected = mode == value
            Box(Modifier.weight(1f).heightIn(min = 40.dp).clip(RoundedCornerShape(10.dp))
                .background(if (selected) chat.card else Color.Transparent)
                .then(if (selected) Modifier.border(1.dp, chat.line, RoundedCornerShape(10.dp)) else Modifier)
                .selectable(selected, role = Role.RadioButton, onClick = { change(value) }).testTag("theme-${value.name.lowercase()}"),
                contentAlignment = Alignment.Center) {
                Text(label, fontSize = 14.sp, fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium, color = if (selected) chat.text else chat.muted)
            }
        }
    }
}

@Composable private fun SettingToggle(title: String, subtitle: String, checked: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, fontSize = 16.sp); Text(subtitle, style = MaterialTheme.typography.bodySmall, color = chatColors.muted)
        }
        Switch(checked, change)
    }
}

@Composable private fun SettingAction(title: String, subtitle: String?, trailing: (@Composable () -> Unit)? = null,
                                      content: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(if (content != null) 6.dp else 2.dp)) {
            Text(title, fontSize = 16.sp)
            if (!subtitle.isNullOrBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = chatColors.muted)
            content?.invoke()
        }
        if (trailing != null) trailing() else Icon(Icons.Default.ChevronRight, null, tint = chatColors.muted)
    }
}

internal fun launchSystem(context: android.content.Context, intent: Intent) {
    try { context.startActivity(intent) } catch (_: Exception) { Toast.makeText(context, "无法打开此系统页面", Toast.LENGTH_SHORT).show() }
}
internal fun openWeb(context: android.content.Context, url: String) {
    safeWebUrl(url)?.let { launchSystem(context, Intent(Intent.ACTION_VIEW, it.toUri())) }
}
internal fun displayTime(value: String): String = runCatching {
    Instant.parse(value).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("MM-dd HH:mm"))
}.getOrElse { value.take(32) }

private fun zoned(value: String): ZonedDateTime? = runCatching { Instant.parse(value).atZone(ZoneId.systemDefault()) }.getOrNull()
private val weekdays = mapOf(DayOfWeek.MONDAY to "周一", DayOfWeek.TUESDAY to "周二", DayOfWeek.WEDNESDAY to "周三", DayOfWeek.THURSDAY to "周四",
    DayOfWeek.FRIDAY to "周五", DayOfWeek.SATURDAY to "周六", DayOfWeek.SUNDAY to "周日")

/** Conversation-list time: today's clock, then 昨天, weekday, month/day, full date. */
internal fun listTime(value: String, today: LocalDate = LocalDate.now()): String {
    val time = zoned(value) ?: return value.take(16)
    val day = time.toLocalDate()
    return when {
        day == today -> time.format(DateTimeFormatter.ofPattern("HH:mm"))
        day == today.minusDays(1) -> "昨天"
        day.isAfter(today.minusDays(7)) && day.isBefore(today) -> weekdays.getValue(day.dayOfWeek)
        day.year == today.year -> "${day.monthValue}月${day.dayOfMonth}日"
        else -> "${day.year}/${day.monthValue}/${day.dayOfMonth}"
    }
}

/** Date separator label inside a chat; null when the timestamp cannot be parsed. */
internal fun dayLabel(value: String, today: LocalDate = LocalDate.now()): String? {
    val day = zoned(value)?.toLocalDate() ?: return null
    return when {
        day == today -> "今天"
        day == today.minusDays(1) -> "昨天"
        day.year == today.year -> "${day.monthValue}月${day.dayOfMonth}日 ${weekdays.getValue(day.dayOfWeek)}"
        else -> "${day.year}年${day.monthValue}月${day.dayOfMonth}日"
    }
}

/** Clock time shown inside a bubble. */
internal fun bubbleTime(value: String): String = zoned(value)?.format(DateTimeFormatter.ofPattern("HH:mm")) ?: value.take(16)
