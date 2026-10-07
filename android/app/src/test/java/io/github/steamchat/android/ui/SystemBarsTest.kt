package io.github.steamchat.android.ui

import android.content.ContextWrapper
import android.content.res.Configuration
import android.view.ContextThemeWrapper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.WindowCompat
import io.github.steamchat.android.ThemeMode
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = ComposeTestApplication::class)
class SystemBarsTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test @Config(qualifiers = "night")
    fun lightAppOverridesDarkSystemEvenWithWrappedViewContextAndAfterThemeChanges() {
        compose.runOnIdle { compose.activity.enableEdgeToEdge() }
        assertLightIcons(false)
        val mode = mutableStateOf(ThemeMode.LIGHT)
        val wrappedView = View(ContextThemeWrapper(ContextWrapper(compose.activity), android.R.style.Theme_Material_Light_NoActionBar))
        compose.setContent {
            CompositionLocalProvider(LocalView provides wrappedView) {
                SteamChatTheme(mode.value) { Surface(color = chatColors.bg) { Text("状态栏") } }
            }
        }
        assertLightIcons(true)
        compose.runOnIdle { mode.value = ThemeMode.DARK }
        assertLightIcons(false)
        compose.runOnIdle { mode.value = ThemeMode.LIGHT }
        assertLightIcons(true)
    }

    @Test @Config(qualifiers = "notnight")
    fun darkAppOverridesLightSystemAndReturningToSystemRestoresDarkIcons() {
        val mode = mutableStateOf(ThemeMode.DARK)
        compose.setContent { SteamChatTheme(mode.value) { Surface(color = chatColors.bg) { Text("状态栏") } } }
        assertLightIcons(false)
        compose.runOnIdle { mode.value = ThemeMode.SYSTEM }
        assertLightIcons(true)
    }

    @Test @Config(qualifiers = "night")
    fun startupUsesPersistedAppChoiceBeforeComposition() {
        compose.runOnIdle {
            val systemDark = compose.activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
            compose.activity.applyChatSystemBars(ThemeMode.LIGHT.isDark(systemDark))
        }
        assertLightIcons(true)
        compose.runOnIdle { compose.activity.applyChatSystemBars(ThemeMode.SYSTEM.isDark(true)) }
        assertLightIcons(false)
    }

    // Android's "light bars" appearance means dark foreground icons on a light background.
    private fun assertLightIcons(lightBackground: Boolean) {
        compose.runOnIdle {
            val window = compose.activity.window
            val controller = WindowCompat.getInsetsController(window, window.decorView)
            assertEquals("Status bar foreground must contrast with the app", lightBackground, controller.isAppearanceLightStatusBars)
            assertEquals("Navigation foreground must follow the same theme", lightBackground, controller.isAppearanceLightNavigationBars)
        }
    }
}
