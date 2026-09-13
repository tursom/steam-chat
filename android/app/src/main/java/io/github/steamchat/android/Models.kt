package io.github.steamchat.android

data class Friend(val id: String, val name: String, val avatar: String = "", val online: Boolean = false, val gameName: String = "")
data class Sticker(val name: String, val title: String = name, val imageUrl: String = "", val aliases: List<String> = emptyList())
data class Conversation(val id: String, val name: String, val avatar: String = "", val preview: String = "", val updatedAt: String = "", val unread: Int = 0)
data class Message(val key: String, val peerId: String, val name: String, val text: String, val echo: Boolean, val time: String, val pending: Boolean = false, val failed: Boolean = false, val error: String = "", val imageUrl: String? = null)
enum class SessionRestoration { NONE, LOADING, RETRY }

enum class RestSyncStatus { IDLE, SYNCING, READY, FAILED }

data class AppState(
    val restoration: SessionRestoration = SessionRestoration.NONE,
    val restSyncText: String = "REST 等待同步",
    val restSyncStatus: RestSyncStatus = RestSyncStatus.IDLE,
    val server: String = "", val loggedIn: Boolean = false, val username: String = "",
    val connected: Boolean = false, val connectionText: String = "未连接", val steamOnline: Boolean = false,
    val activeAccountId: String = "", val accessAllowed: Boolean = false, val loading: Boolean = false,
    val error: String = "", val conversations: List<Conversation> = emptyList(), val friends: List<Friend> = emptyList(),
    val messages: List<Message> = emptyList(), val emoticons: List<String> = emptyList(), val stickers: List<String> = emptyList(),
    val stickerInventory: List<Sticker> = emptyList(),
    val selectedPeer: String = "", val selectedName: String = "", val backgroundEnabled: Boolean = true,
    val notificationPreview: Boolean = false, val notificationsEnabled: Boolean = true
) {
    val canSend: Boolean get() = loggedIn && accessAllowed && steamOnline
}
