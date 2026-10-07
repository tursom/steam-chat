package io.github.steamchat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SportsEsports
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.steamchat.android.AppState

@Composable
internal fun TabletNavigation(state: AppState, tab: Int, width: Dp, select: (Int) -> Unit) {
    val chat = chatColors
    BoxWithConstraints(Modifier.width(width).fillMaxHeight().background(chat.rail).testTag("navigation-rail")) {
        val short = maxHeight < 360.dp
        val labels = maxHeight >= 240.dp
        Column(Modifier.fillMaxSize().padding(vertical = if (short) 4.dp else 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (!short) {
                Box(Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(chat.accent), contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.SportsEsports, "Steam Chat", Modifier.size(24.dp), tint = chat.onAccent)
                }
                Spacer(Modifier.height(24.dp))
            }
            navigationItems.forEachIndexed { index, item ->
                if (index == 2) Spacer(Modifier.weight(1f))
                NavigationRailItem(selected = tab == index, onClick = { select(index) },
                    modifier = Modifier.testTag("nav-${item.tag}"),
                    icon = { NavigationIcon(state, index, item, tab == index) },
                    label = if (labels) ({ Text(item.label, style = MaterialTheme.typography.labelSmall, fontWeight = if (tab == index) FontWeight.Bold else FontWeight.Medium) }) else null,
                    colors = NavigationRailItemDefaults.colors(selectedIconColor = chat.accentText, selectedTextColor = chat.text,
                        indicatorColor = chat.accentSoft, unselectedIconColor = chat.muted, unselectedTextColor = chat.muted))
                if (index == 0) Spacer(Modifier.height(if (short) 4.dp else 8.dp))
            }
            if (!short) {
                Spacer(Modifier.height(14.dp))
                FilledTonalIconButton(onClick = { select(2) }, modifier = Modifier.size(40.dp), shape = CircleShape,
                    colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = chat.tints[2], contentColor = chat.text)) {
                    Text(state.username.take(1).ifBlank { "我" }, fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}
