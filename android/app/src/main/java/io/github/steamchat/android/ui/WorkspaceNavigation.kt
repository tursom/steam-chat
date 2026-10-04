package io.github.steamchat.android.ui

import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver

/** Saveable inputs alone do not validate the account that originally wrote a Bundle. */
internal class WorkspaceNavigation(val scope: String, peer: String = "", name: String = "") {
    val tab = mutableIntStateOf(0)
    val lastPeer = mutableStateOf(peer)
    val lastName = mutableStateOf(name)
    val profile = mutableStateOf(false)

    companion object {
        fun saver(expectedScope: String) = listSaver<WorkspaceNavigation, Any>(
            save = { listOf(it.scope, it.tab.intValue, it.lastPeer.value, it.lastName.value, it.profile.value) },
            restore = { saved ->
                if (saved[0] != expectedScope) null else WorkspaceNavigation(expectedScope, saved[2] as String, saved[3] as String).apply {
                    tab.intValue = saved[1] as Int
                    profile.value = saved[4] as Boolean
                }
            }
        )
    }
}
