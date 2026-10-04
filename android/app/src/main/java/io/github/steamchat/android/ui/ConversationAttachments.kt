package io.github.steamchat.android.ui

import androidx.lifecycle.ViewModel

/** Temporary content grants survive rotation, but are never put in saved state or on disk. */
internal class ConversationAttachments : ViewModel() {
    private var scope = ""
    private val entries = mutableMapOf<String, ConversationAttachmentState>()

    fun useScope(value: String) {
        if (scope != value) { entries.clear(); scope = value }
    }

    fun forPeer(peer: String): ConversationAttachmentState = entries.getOrPut(peer) { ConversationAttachmentState() }

    override fun onCleared() { entries.clear() }
}
