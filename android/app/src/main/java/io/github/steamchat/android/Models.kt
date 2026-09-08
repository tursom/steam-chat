package io.github.steamchat.android

data class Friend(val id: String, val name: String, val avatar: String = "", val online: Boolean = false, val gameName: String = "")
data class Conversation(val id: String, val name: String, val avatar: String = "", val preview: String = "", val updatedAt: String = "", val unread: Int = 0)
data class Message(val key: String, val peerId: String, val name: String, val text: String, val echo: Boolean, val time: String, val pending: Boolean = false, val failed: Boolean = false, val error: String = "", val imageUrl: String? = null)
data class AppState(
    val server: String = "", val loggedIn: Boolean = false, val username: String = "",
    val connected: Boolean = false, val connectionText: String = "未连接", val steamOnline: Boolean = false,
    val activeAccountId: String = "", val accessAllowed: Boolean = false, val loading: Boolean = false,
    val error: String = "", val conversations: List<Conversation> = emptyList(), val friends: List<Friend> = emptyList(),
    val messages: List<Message> = emptyList(), val emoticons: List<String> = emptyList(), val stickers: List<String> = emptyList(),
    val selectedPeer: String = "", val selectedName: String = "", val backgroundEnabled: Boolean = true,
    val notificationPreview: Boolean = false, val notificationsEnabled: Boolean = true
)
