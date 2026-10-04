package io.github.steamchat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.*
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.github.steamchat.android.Friend

@Composable
internal fun FriendDetails(
    friend: Friend?, peer: String, name: String, avatar: String, loader: UiImageLoader,
    modifier: Modifier = Modifier, close: () -> Unit
) {
    val clipboard = LocalClipboardManager.current
    Surface(modifier) {
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("好友资料", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                ToolButton(Icons.Default.Close, "关闭好友资料", onClick = close)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Avatar(friend?.name ?: name, friend?.avatar?.takeIf { it.isNotBlank() } ?: avatar, loader, friend?.online == true, 64)
                Text(friend?.name?.ifBlank { name } ?: name, style = MaterialTheme.typography.titleLarge)
                Text(when (friend?.online) { true -> "在线"; false -> "离线"; null -> "状态未知" },
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                friend?.gameName?.takeIf { it.isNotBlank() }?.let { game ->
                    Text("正在玩", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(game, style = MaterialTheme.typography.bodyLarge)
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
                Text("Steam ID", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SelectionContainer { Text(peer, style = MaterialTheme.typography.bodyMedium) }
                TextButton(onClick = { clipboard.setText(AnnotatedString(peer)) }) {
                    Icon(Icons.Default.ContentCopy, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("复制 Steam ID", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
internal fun FriendDetailsDrawer(
    friend: Friend?, peer: String, name: String, avatar: String, loader: UiImageLoader, close: () -> Unit
) {
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val drawerFocus = remember { FocusRequester() }
        LaunchedEffect(Unit) { drawerFocus.requestFocus() }
        BoxWithConstraints(Modifier.fillMaxSize().onPreviewKeyEvent {
            if (it.key == Key.Escape && it.type == KeyEventType.KeyUp) { close(); true } else false
        }.focusRequester(drawerFocus).focusable()) {
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .32f)).clickable(
                interactionSource = remember { MutableInteractionSource() }, indication = null,
                onClickLabel = "关闭好友资料", onClick = close
            ))
            // Leave a usable strip of scrim even in a narrow split-screen window.
            FriendDetails(friend, peer, name, avatar, loader,
                Modifier.align(Alignment.CenterEnd).width(minOf(320.dp, maxWidth * .88f))
                    .fillMaxHeight().windowInsetsPadding(WindowInsets.safeDrawing).testTag("friend-details-drawer"), close)
        }
    }
}
