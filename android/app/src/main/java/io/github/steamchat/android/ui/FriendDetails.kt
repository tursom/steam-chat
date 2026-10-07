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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
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
    val chat = chatColors
    val playing = friend?.gameName?.isNotBlank() == true
    Surface(modifier, color = chat.bg) {
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().height(64.dp).padding(start = 20.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("好友资料", Modifier.weight(1f), fontSize = 16.sp, fontWeight = FontWeight.Bold)
                ToolButton(Icons.Default.Close, "关闭好友资料", onClick = close)
            }
            HorizontalDivider(color = chat.line)
            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Avatar(friend?.name ?: name, friend?.avatar?.takeIf { it.isNotBlank() } ?: avatar, loader, friend?.online == true, 96, playing)
                Spacer(Modifier.height(4.dp))
                Text(friend?.name?.ifBlank { name } ?: name, fontSize = 20.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 20.dp))
                val (status, fg, bg) = when {
                    playing -> Triple("正在玩 ${friend?.gameName}", chat.game, chat.gameSoft)
                    friend?.online == true -> Triple("在线", chat.accentText, chat.accentSoft)
                    friend?.online == false -> Triple("离线", chat.muted, chat.input)
                    else -> Triple("状态未知", chat.muted, chat.input)
                }
                Text(status, Modifier.padding(horizontal = 20.dp).clip(RoundedCornerShape(14.dp)).background(bg).padding(horizontal = 12.dp, vertical = 5.dp),
                    color = fg, fontSize = 13.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
                Spacer(Modifier.height(12.dp))
                Column(Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(chat.input).padding(horizontal = 16.dp, vertical = 4.dp)) {
                    Column(Modifier.padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("Steam ID", fontSize = 12.sp, color = chat.muted)
                        SelectionContainer { Text(peer, fontSize = 14.sp, fontFamily = FontFamily.Monospace) }
                    }
                    HorizontalDivider(color = chat.line)
                    TextButton(onClick = { clipboard.setText(AnnotatedString(peer)) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        contentPadding = PaddingValues(0.dp)) {
                        Icon(Icons.Default.ContentCopy, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("复制 Steam ID", Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
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
