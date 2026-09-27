package io.github.steamchat.android.ui

import android.app.Application
import android.content.pm.ActivityInfo
import androidx.activity.ComponentActivity
import org.robolectric.Shadows.shadowOf

/** Register the Compose host only in Robolectric, for both build variants. */
class ComposeTestApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        shadowOf(packageManager).addOrUpdateActivity(ActivityInfo().apply {
            name = ComponentActivity::class.java.name
            packageName = this@ComposeTestApplication.packageName
            applicationInfo = this@ComposeTestApplication.applicationInfo
            exported = true
            theme = android.R.style.Theme_Material_Light_NoActionBar
        })
    }
}
