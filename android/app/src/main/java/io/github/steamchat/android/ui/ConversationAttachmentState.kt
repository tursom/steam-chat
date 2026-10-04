package io.github.steamchat.android.ui

import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Owned by the account/conversation holder; content grants must never enter saved state. */
internal class ConversationAttachmentState {
    var uri by mutableStateOf<Uri?>(null)
}
