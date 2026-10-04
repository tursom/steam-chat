package io.github.steamchat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SportsEsports
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.steamchat.android.AppState

@Composable
internal fun TabletNavigation(state: AppState, tab: Int, width: Dp, select: (Int) -> Unit) {
    BoxWithConstraints(Modifier.width(width).fillMaxHeight().background(Color(0xFFF0F5EF)).testTag("navigation-rail")) {
        val short = maxHeight < 360.dp
        val labels = maxHeight >= 240.dp
        Column(Modifier.fillMaxSize().padding(vertical = if (short) 4.dp else 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (!short) {
                Icon(Icons.Default.SportsEsports, "Steam Chat", Modifier.padding(vertical = 12.dp).size(30.dp), tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.height(22.dp))
            }
            listOf("消息" to Icons.AutoMirrored.Filled.Chat, "好友" to Icons.Default.People, "设置" to Icons.Default.Settings).forEachIndexed { index, (label, icon) ->
                if (index == 2) Spacer(Modifier.weight(1f))
                NavigationRailItem(selected = tab == index, onClick = { select(index) },
                    modifier = Modifier.testTag("nav-${listOf("messages", "friends", "settings")[index]}"),
                    icon = {
                        if (index == 0 && state.conversations.any { it.unread > 0 })
                            BadgedBox(badge = { Badge { Text(state.conversations.sumOf { it.unread }.coerceAtMost(999).toString()) } }) { Icon(icon, label) }
                        else Icon(icon, label)
                    }, label = if (labels) ({ Text(label, style = MaterialTheme.typography.labelSmall) }) else null)
                if (index == 0) Spacer(Modifier.height(if (short) 4.dp else 12.dp))
            }
            if (!short) {
                Spacer(Modifier.height(14.dp))
                FilledTonalIconButton(onClick = { select(2) }, modifier = Modifier.size(44.dp)) {
                    Text(state.username.take(1).ifBlank { "我" })
                }
            }
        }
    }
}
