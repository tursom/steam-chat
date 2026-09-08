@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package io.github.steamchat.android.ui

import android.content.Intent
import androidx.core.net.toUri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.steamchat.android.*

private val Green = Color(0xFF278773)
private val Ink = Color(0xFF26372F)
private val Muted = Color(0xFF74897C)
private val Neutral = Color(0xFFF3F7F4)
private val Palette = lightColorScheme(primary = Green, onPrimary = Color.White,
    primaryContainer = Color(0xFFE2F0E7), onPrimaryContainer = Ink,
    background = Color.White, surface = Color.White, onSurface = Ink,
    onBackground = Ink, surfaceVariant = Neutral, onSurfaceVariant = Muted,
    secondary = Color(0xFF697E9C), error = Color(0xFFB44C48), outline = Color(0xFFBACBC0))

@Composable
internal fun SteamChatTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Palette, shapes = Shapes(small = RoundedCornerShape(6.dp), medium = RoundedCornerShape(8.dp), large = RoundedCornerShape(8.dp)), content = content)
}

@Composable
fun ChatApp(repository: ChatRepository, notificationsAllowed: Boolean, requestNotifications: () -> Unit,
            openNotificationSettings: () -> Unit) {
    val state by repository.state.collectAsStateWithLifecycle()
    SteamChatTheme {
        val loader = remember(repository, state.loggedIn, state.server, state.activeAccountId, state.accessAllowed) { UiImageLoader(repository) }
        DisposableEffect(loader) { onDispose { loader.clear() } }
        var tab by rememberSaveable { mutableIntStateOf(0) }
        val snackbar = remember { SnackbarHostState() }
        val drafts = rememberSaveableStateHolder()
        // Track restored draft keys too, so logout cannot retain a previously visited peer's draft.
        var draftKeys by rememberSaveable { mutableStateOf<List<String>>(emptyList()) }
        val sessionScope = "${state.loggedIn}:${state.server}:${state.username}:${state.activeAccountId}:${state.accessAllowed}"
        var previousScope by rememberSaveable { mutableStateOf(sessionScope) }
        LaunchedEffect(sessionScope) {
            if (previousScope != sessionScope) {
                draftKeys.forEach { drafts.removeState(it) }
                draftKeys = emptyList()
                previousScope = sessionScope
            }
        }
        LaunchedEffect(state.error) {
            if (state.error.isNotBlank()) { snackbar.showSnackbar(state.error); repository.clearError() }
        }
        Surface(Modifier.fillMaxSize(), color = Color.White) {
            Scaffold(modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding(),
                contentWindowInsets = WindowInsets(0, 0, 0, 0),
                snackbarHost = { SnackbarHost(snackbar) },
                bottomBar = {
                    if (state.loggedIn && state.selectedPeer.isBlank()) NavigationBar(containerColor = Color.White, windowInsets = WindowInsets(0, 0, 0, 0)) {
                        listOf("消息" to Icons.AutoMirrored.Filled.Chat, "好友" to Icons.Default.People, "设置" to Icons.Default.Settings).forEachIndexed { index, (label, icon) ->
                            NavigationBarItem(selected = tab == index, onClick = { tab = index }, icon = {
                                if (index == 0 && state.conversations.any { it.unread > 0 }) BadgedBox(badge = { Badge { Text(state.conversations.sumOf { it.unread }.coerceAtMost(999).toString()) } }) { Icon(icon, label) }
                                else Icon(icon, label)
                            }, label = { Text(label) })
                        }
                    }
                }) { padding ->
                Box(Modifier.padding(padding).fillMaxSize()) {
                    when {
                        !state.loggedIn -> LoginScreen(state, repository)
                        state.selectedPeer.isNotBlank() -> {
                            val draftKey = "$sessionScope:${state.selectedPeer}"
                            SideEffect { if (draftKey !in draftKeys) draftKeys = draftKeys + draftKey }
                            drafts.SaveableStateProvider(draftKey) { ChatScreen(state, repository, loader) }
                        }
                        tab == 2 -> SettingsScreen(state, repository, loader, notificationsAllowed, requestNotifications, openNotificationSettings)
                        else -> ContactScreen(state, repository, loader, tab == 1, { tab = 1 }, { tab = 2 })
                    }
                    if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
                }
            }
        }
    }
}

@Composable
internal fun ToolButton(icon: ImageVector, label: String, enabled: Boolean = true, onClick: () -> Unit) {
    TooltipBox(positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(), tooltip = { PlainTooltip { Text(label) } }, state = rememberTooltipState()) {
        IconButton(onClick, enabled = enabled, modifier = Modifier.size(48.dp)) { Icon(icon, label) }
    }
}

@Composable
internal fun Avatar(name: String, source: String, loader: UiImageLoader, online: Boolean = false, size: Int = 46) {
    val colors = listOf(Color(0xFFDDEDE1), Color(0xFFF0DFE5), Color(0xFFE0EAF2), Color(0xFFE8E1F2))
    Box(Modifier.size(size.dp)) {
        Box(Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)).background(colors[(name.hashCode() and Int.MAX_VALUE) % colors.size]), contentAlignment = Alignment.Center) {
            if (source.isNotBlank()) MediaImage(source, loader, "$name 的头像", Modifier.fillMaxSize(), androidx.compose.ui.layout.ContentScale.Crop, name.take(1))
            else Text(name.take(1).ifBlank { "?" }, fontWeight = FontWeight.Medium, fontSize = (size / 2.5).sp)
        }
        if (online) Box(Modifier.size(10.dp).align(Alignment.BottomEnd).clip(CircleShape).background(Green))
    }
}

@Composable
private fun LoginScreen(state: AppState, repository: ChatRepository) {
    var server by rememberSaveable(state.server) { mutableStateOf(state.server) }
    var username by rememberSaveable { mutableStateOf(state.username) }
    // Password must not enter saved instance state.
    var password by remember { mutableStateOf("") }
    var configured by rememberSaveable { mutableStateOf(false) }
    var validation by remember { mutableStateOf("") }
    BackHandler(configured) { configured = false; password = "" }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (configured) ToolButton(Icons.AutoMirrored.Filled.ArrowBack, "修改后端地址") { configured = false; password = "" }
            Icon(Icons.Default.SportsEsports, null, tint = Green, modifier = Modifier.size(32.dp))
            Spacer(Modifier.width(10.dp)); Text("Steam Chat", style = MaterialTheme.typography.titleLarge)
        }
        Spacer(Modifier.height(16.dp))
        Text(if (configured) "登录" else "连接服务器", style = MaterialTheme.typography.headlineMedium)
        if (!configured) {
            OutlinedTextField(server, { server = it; validation = "" }, Modifier.fillMaxWidth(), label = { Text("后端 HTTPS 地址") },
                singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), leadingIcon = { Icon(Icons.Default.Lock, null) })
            if (validation.isNotEmpty()) Text(validation, color = MaterialTheme.colorScheme.error)
            Button(onClick = {
                if (validServer(server)) { server = server.trim().trimEnd('/'); configured = true }
                else validation = "请输入不含账户密码、查询参数或片段的 HTTPS 地址"
            }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("继续") }
            Text("HTTPS 安全连接", color = Muted, style = MaterialTheme.typography.bodySmall)
        } else {
            Text(server, color = Muted)
            OutlinedTextField(username, { username = it }, Modifier.fillMaxWidth(), label = { Text("后台账号") }, singleLine = true)
            OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text("密码") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
            Button(onClick = { repository.login(server, username.trim(), password); password = "" },
                enabled = !state.loading && username.isNotBlank() && password.isNotBlank(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (state.loading) "正在登录…" else "登录") }
        }
    }
}

@Composable
private fun ContactScreen(state: AppState, repository: ChatRepository, loader: UiImageLoader, friends: Boolean,
                          newChat: () -> Unit, settings: () -> Unit) {
    var query by rememberSaveable(friends) { mutableStateOf("") }
    var unread by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 20.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.SportsEsports, null, tint = Green); Spacer(Modifier.width(8.dp))
                Text("Steam Chat", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                ToolButton(Icons.Default.Refresh, "刷新", !state.loading) { repository.refresh() }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (friends) "好友" else "消息", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
                ToolButton(Icons.Default.Edit, "新建会话", onClick = newChat)
            }
            OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().padding(top = 8.dp), placeholder = { Text("搜索好友") }, singleLine = true,
                leadingIcon = { Icon(Icons.Default.Search, null) }, trailingIcon = { if (query.isNotEmpty()) ToolButton(Icons.Default.Close, "清除搜索") { query = "" } })
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClick = settings), verticalAlignment = Alignment.CenterVertically) {
                Icon(if (state.connected) Icons.Default.CloudDone else Icons.Default.CloudOff, null, tint = if (state.connected) Green else Color(0xFF9B793E), modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp)); Text("${state.username} · ${state.connectionText}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                Icon(Icons.Default.ChevronRight, null)
            }
            if (!state.accessAllowed) Text("此账号尚无聊天访问权限", color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp))
            if (!friends) TabRow(selectedTabIndex = if (unread) 1 else 0) {
                Tab(!unread, { unread = false }, text = { Text("全部消息") })
                Tab(unread, { unread = true }, text = { Text("未读") })
            } else Text("${state.friends.count { it.online }} 位在线 · ${state.friends.size} 位好友", color = Muted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 12.dp))
        }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(vertical = 8.dp)) {
            if (friends) {
                val contacts = state.friends.filter { it.name.contains(query, true) || it.id.contains(query) }.sortedByDescending { it.online }
                if (contacts.isEmpty()) item { EmptyState(if (state.loading) "正在加载好友…" else "没有匹配的好友") }
                items(contacts, key = { it.id }) { friend -> ContactRow(friend.name, friend.avatar, if (friend.gameName.isNotBlank()) "正在玩 ${friend.gameName}" else if (friend.online) "在线" else "离线", "", 0, friend.online, loader) { repository.selectConversation(friend.id, friend.name) } }
            } else {
                val conversations = state.conversations.filter { (!unread || it.unread > 0) && (it.name.contains(query, true) || it.id.contains(query)) }
                if (conversations.isEmpty()) item { EmptyState(if (state.loading) "正在加载会话…" else if (unread) "暂无未读消息" else "暂无会话") }
                items(conversations, key = { it.id }) { c -> ContactRow(c.name, c.avatar, c.preview, c.updatedAt, c.unread, state.friends.any { it.id == c.id && it.online }, loader) { repository.selectConversation(c.id, c.name) } }
            }
        }
    }
}

@Composable
private fun ContactRow(name: String, avatar: String, preview: String, time: String, unread: Int, online: Boolean, loader: UiImageLoader, select: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = select).padding(horizontal = 22.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Avatar(name, avatar, loader, online)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                if (time.isNotBlank()) Text(displayTime(time), style = MaterialTheme.typography.labelSmall, color = Muted, modifier = Modifier.padding(start = 6.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(preview, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = Muted)
                if (unread > 0) Badge(containerColor = Green) { Text(if (unread > 99) "99+" else unread.toString()) }
            }
        }
    }
}

@Composable
internal fun EmptyState(text: String) { Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { Text(text, color = Muted) } }

@Composable
private fun SettingsScreen(state: AppState, repository: ChatRepository, loader: UiImageLoader, notificationsAllowed: Boolean,
                           requestNotifications: () -> Unit, openNotificationSettings: () -> Unit) {
    val context = LocalContext.current
    var logout by remember { mutableStateOf(false) }
    var battery by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).background(Color(0xFFF8FAF9))) {
        Text("设置", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.fillMaxWidth().background(Color.White).padding(22.dp))
        Row(Modifier.fillMaxWidth().background(Color.White).padding(22.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Avatar(state.username, "", loader)
            Column(Modifier.weight(1f)) { Text(state.username, style = MaterialTheme.typography.titleMedium); Text("Steam 账户 · ${state.activeAccountId.ifBlank { "未选择" }}", style = MaterialTheme.typography.bodySmall, color = Muted) }
        }
        SectionLabel("消息通知")
        SettingToggle("后台接收消息", "保持前台服务连接；仍受系统休眠与后台限制影响", state.backgroundEnabled, repository::setBackgroundEnabled)
        SettingToggle("通知显示消息内容", "仅影响此设备的通知预览", state.notificationPreview, repository::setNotificationPreview)
        SettingToggle("消息提醒", "此设备的新消息通知", state.notificationsEnabled, repository::setNotificationsEnabled)
        SettingAction("系统通知权限", if (notificationsAllowed) "已允许；各通知类别仍由系统控制" else "未允许，点击申请或前往系统设置", if (notificationsAllowed) openNotificationSettings else requestNotifications)
        SectionLabel("连接与设备")
        SettingAction("后端地址", state.server) { logout = true }
        SettingAction("连接状态", "${state.connectionText} · Steam ${if (state.steamOnline) "在线" else "离线"} · ${if (state.accessAllowed) "有访问权限" else "无访问权限"}") { repository.refresh() }
        SettingAction("后台运行设置", "电池优化与后台活动") { battery = true }
        SettingAction("系统通知设置", "通知类别、锁屏显示与提示音", openNotificationSettings)
        Text("${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}", style = MaterialTheme.typography.bodySmall, color = Muted, modifier = Modifier.padding(22.dp))
        TextButton(onClick = { logout = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("退出登录", color = MaterialTheme.colorScheme.error) }
    }
    if (logout) AlertDialog(onDismissRequest = { logout = false }, title = { Text("退出并重新配置？") }, text = { Text("将退出当前后台账号，清除本地会话缓存、图片缓存和草稿。之后可修改后端地址。") },
        confirmButton = { TextButton(onClick = { loader.clear(); repository.logout(); logout = false }) { Text("退出登录") } }, dismissButton = { TextButton(onClick = { logout = false }) { Text("取消") } })
    if (battery) AlertDialog(onDismissRequest = { battery = false }, title = { Text("后台运行设置") },
        text = { Text("可在系统电池设置中检查 Steam Chat 的优化限制，厂商系统可能还需允许后台活动或自启动。前台服务不能保证在休眠、断网或强行停止后继续接收消息。") },
        confirmButton = { TextButton(onClick = { battery = false; launchSystem(context, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }) { Text("打开电池设置") } }, dismissButton = { TextButton(onClick = { battery = false }) { Text("取消") } })
}

@Composable private fun SectionLabel(text: String) { Text(text, style = MaterialTheme.typography.labelMedium, color = Muted, modifier = Modifier.padding(start = 22.dp, top = 22.dp, bottom = 8.dp)) }
@Composable private fun SettingToggle(title: String, subtitle: String, checked: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().background(Color.White).padding(horizontal = 22.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) { Text(title); Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Muted) }
        Switch(checked, change)
    }
}
@Composable private fun SettingAction(title: String, subtitle: String, click: () -> Unit) {
    Row(Modifier.fillMaxWidth().background(Color.White).clickable(onClick = click).padding(horizontal = 22.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) { Text(title); Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Muted) }
        Icon(Icons.Default.ChevronRight, null)
    }
}
internal fun launchSystem(context: android.content.Context, intent: Intent) {
    try { context.startActivity(intent) } catch (_: Exception) { Toast.makeText(context, "无法打开此系统页面", Toast.LENGTH_SHORT).show() }
}
internal fun openWeb(context: android.content.Context, url: String) {
    safeWebUrl(url)?.let { launchSystem(context, Intent(Intent.ACTION_VIEW, it.toUri())) }
}
internal fun displayTime(value: String): String = runCatching {
    java.time.Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm"))
}.getOrElse { value.take(32) }
