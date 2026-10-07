package io.github.steamchat.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import io.github.steamchat.android.ThemeMode

/** Chat-specific roles Material's scheme has no slot for; values mirror the redesign mockups. */
@Immutable
internal data class ChatColors(
    val dark: Boolean,
    val bg: Color, val chatBg: Color, val ground: Color, val card: Color, val rail: Color, val navBg: Color,
    val text: Color, val muted: Color, val line: Color, val input: Color, val chip: Color,
    val accent: Color, val onAccent: Color, val accentSoft: Color, val accentText: Color,
    val online: Color, val game: Color, val gameSoft: Color,
    val danger: Color, val onDanger: Color, val warningBg: Color, val warningText: Color,
    val inBubble: Color, val outBubble: Color, val outText: Color, val outMeta: Color,
    val selected: Color, val placeholder: Color, val tints: List<Color>
)

internal val LightChatColors = ChatColors(
    dark = false,
    bg = Color(0xFFFFFFFF), chatBg = Color(0xFFEEF3F0), ground = Color(0xFFF2F5F3), card = Color(0xFFFFFFFF),
    rail = Color(0xFFF6F9F7), navBg = Color(0xFFFAFCFB),
    text = Color(0xFF17201C), muted = Color(0xFF5C6B64), line = Color(0xFFE3E9E5), input = Color(0xFFF0F4F2), chip = Color(0xFFE1E9E4),
    accent = Color(0xFF1B7F64), onAccent = Color.White, accentSoft = Color(0xFFDDF1E7), accentText = Color(0xFF0F5A46),
    online = Color(0xFF1FA477), game = Color(0xFF2F6FD0), gameSoft = Color(0xFFE3ECFA),
    danger = Color(0xFFC4372E), onDanger = Color.White, warningBg = Color(0xFFFAF2E1), warningText = Color(0xFF7A5A1E),
    inBubble = Color.White, outBubble = Color(0xFFD3EFE1), outText = Color(0xFF10261D), outMeta = Color(0xFF3D6656),
    selected = Color(0xFFE7F3EC), placeholder = Color(0xFFDDE5E0),
    tints = listOf(Color(0xFFDCEFE4), Color(0xFFF3DDE4), Color(0xFFDCE7F3), Color(0xFFE9E0F3), Color(0xFFF4E8D3))
)

internal val DarkChatColors = ChatColors(
    dark = true,
    bg = Color(0xFF121615), chatBg = Color(0xFF0C100F), ground = Color(0xFF0D1110), card = Color(0xFF1A201E),
    rail = Color(0xFF0F1312), navBg = Color(0xFF161B1A),
    text = Color(0xFFE5ECE8), muted = Color(0xFF9AABA3), line = Color(0xFF26302C), input = Color(0xFF1D2422), chip = Color(0xFF1D2422),
    accent = Color(0xFF4FD1A5), onAccent = Color(0xFF06281D), accentSoft = Color(0xFF1E3A31), accentText = Color(0xFF9FE8CC),
    online = Color(0xFF4FD1A5), game = Color(0xFF7DB3FF), gameSoft = Color(0xFF1D2B40),
    danger = Color(0xFFFFB4AB), onDanger = Color(0xFF561E19), warningBg = Color(0xFF2E2717), warningText = Color(0xFFE9C987),
    inBubble = Color(0xFF1E2523), outBubble = Color(0xFF1F5544), outText = Color(0xFFE8F6EF), outMeta = Color(0xFFA9D9C6),
    selected = Color(0xFF1B2A25), placeholder = Color(0xFF2A3330),
    tints = listOf(Color(0xFF2A3B33), Color(0xFF3D2A31), Color(0xFF2A3442), Color(0xFF352E42), Color(0xFF3F3627))
)

internal val LocalChatColors = staticCompositionLocalOf { LightChatColors }

/** Shorthand for the active chat palette inside composables. */
internal val chatColors: ChatColors @Composable get() = LocalChatColors.current

private fun scheme(c: ChatColors) = if (c.dark) darkColorScheme(
    primary = c.accent, onPrimary = c.onAccent, primaryContainer = c.accentSoft, onPrimaryContainer = c.accentText,
    secondary = c.accent, onSecondary = c.onAccent, secondaryContainer = c.accentSoft, onSecondaryContainer = c.accentText,
    background = c.bg, onBackground = c.text, surface = c.bg, onSurface = c.text,
    surfaceVariant = c.input, onSurfaceVariant = c.muted, surfaceContainer = c.navBg, surfaceContainerLow = c.card,
    surfaceContainerHigh = c.card, surfaceContainerHighest = c.input, outline = c.muted, outlineVariant = c.line,
    error = c.danger, onError = c.onDanger
) else lightColorScheme(
    primary = c.accent, onPrimary = c.onAccent, primaryContainer = c.accentSoft, onPrimaryContainer = c.accentText,
    secondary = c.accent, onSecondary = c.onAccent, secondaryContainer = c.accentSoft, onSecondaryContainer = c.accentText,
    background = c.bg, onBackground = c.text, surface = c.bg, onSurface = c.text,
    surfaceVariant = c.input, onSurfaceVariant = c.muted, surfaceContainer = c.navBg, surfaceContainerLow = c.card,
    surfaceContainerHigh = c.card, surfaceContainerHighest = c.input, outline = c.muted, outlineVariant = c.line,
    error = c.danger, onError = c.onDanger
)

@Composable
internal fun SteamChatTheme(mode: ThemeMode = ThemeMode.SYSTEM, content: @Composable () -> Unit) {
    val dark = mode.isDark(isSystemInDarkTheme())
    val colors = if (dark) DarkChatColors else LightChatColors
    val view = LocalView.current
    // A manual theme can differ from the system's, so system bar icons follow the app theme.
    if (!view.isInEditMode) LaunchedEffect(view, dark) {
        view.context.componentActivity()?.applyChatSystemBars(dark)
    }
    CompositionLocalProvider(LocalChatColors provides colors) {
        MaterialTheme(colorScheme = scheme(colors),
            shapes = Shapes(small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(16.dp), large = RoundedCornerShape(20.dp)),
            content = content)
    }
}
