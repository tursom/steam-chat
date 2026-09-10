package io.github.steamchat.android.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import io.github.steamchat.android.Conversation
import io.github.steamchat.android.Message
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class ChatCache(context: Context) : SQLiteOpenHelper(context, File(context.noBackupFilesDir, "chat.sqlite").absolutePath, null, 2) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE checkpoints (scope TEXT PRIMARY KEY, cursor TEXT NOT NULL, bootstrap INTEGER NOT NULL, notification_floor INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, sync_id TEXT NOT NULL, event_id TEXT, semantic_id TEXT NOT NULL, peer TEXT NOT NULL, payload TEXT NOT NULL, sent_at INTEGER NOT NULL, ordinal INTEGER NOT NULL, unread INTEGER NOT NULL DEFAULT 0, UNIQUE(scope,sync_id), UNIQUE(scope,event_id), UNIQUE(scope,semantic_id))")
        db.execSQL("CREATE INDEX messages_peer ON messages(scope,peer,sent_at DESC,ordinal DESC,seq DESC)")
        createEventAliases(db)
    }
    private fun createEventAliases(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE event_aliases (scope TEXT NOT NULL, event_id TEXT NOT NULL, message_seq INTEGER NOT NULL, PRIMARY KEY(scope,event_id))")
        db.execSQL("INSERT INTO event_aliases SELECT scope,event_id,seq FROM messages WHERE event_id IS NOT NULL AND event_id<>''")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) createEventAliases(db)
    }
    fun checkpoint(scope: String): Pair<String, Boolean> = readableDatabase.rawQuery("SELECT cursor,bootstrap FROM checkpoints WHERE scope=?", arrayOf(scope)).use {
        if (it.moveToFirst()) it.getString(0) to (it.getInt(1) != 0) else "" to true
    }
    private fun notificationFloor(scope: String): Long = readableDatabase.rawQuery("SELECT notification_floor FROM checkpoints WHERE scope=?", arrayOf(scope)).use {
        if (it.moveToFirst()) it.getLong(0) else System.currentTimeMillis() - 60_000
    }
    fun reset(scope: String) {
        writableDatabase.execSQL("INSERT OR REPLACE INTO checkpoints VALUES (?, '', 1, ?)", arrayOf<Any>(scope, notificationFloor(scope)))
    }
    fun clearAll() {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("event_aliases", null, null)
            db.delete("messages", null, null)
            db.delete("checkpoints", null, null)
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    fun ingest(scope: String, items: JSONArray, cursor: String, hasMore: Boolean, foregroundPeer: String): List<Message> {
        val db = writableDatabase
        val notifications = mutableListOf<Message>()
        db.beginTransaction()
        try {
            val bootstrap = checkpoint(scope).second
            // Keep the initial notification floor, not a rolling five-minute cutoff: long outages still produce unread messages.
            val floor = notificationFloor(scope)
            for (i in 0 until items.length()) {
                val item = items.getJSONObject(i)
                val syncId = item.getString("syncId")
                require(syncId.isNotEmpty()) { "Missing sync ID" }
                val message = decode(item, syncId)
                val eligible = Protocol.freshIncoming(bootstrap, message.echo, message.time, System.currentTimeMillis(), floor)
                val eventId = item.optString("eventId")
                val semanticId = Protocol.semanticIdentity(item)
                val values = ContentValues().apply {
                    put("scope", scope); put("sync_id", syncId)
                    item.optString("eventId").takeIf { it.isNotEmpty() }?.let { put("event_id", it) }
                    put("semantic_id", semanticId)
                    put("peer", message.peerId); put("payload", item.toString())
                    put("sent_at", Protocol.timestampMillis(message.time) ?: 0)
                    put("ordinal", item.optLong("ordinal", 0))
                    put("unread", if (eligible && message.peerId != foregroundPeer) 1 else 0)
                }
                // A semantic reimport may have another event ID. Retain that exact alias
                // so acknowledgements and later replays can still find the original row.
                val knownEvent = eventId.isNotEmpty() && containsEvent(scope, eventId)
                val inserted = !knownEvent && db.insertWithOnConflict("messages", null, values, SQLiteDatabase.CONFLICT_IGNORE) != -1L
                if (!knownEvent && eventId.isNotEmpty()) {
                    db.execSQL("INSERT OR IGNORE INTO event_aliases(scope,event_id,message_seq) SELECT scope,?,seq FROM messages WHERE scope=? AND (sync_id=? OR event_id=? OR semantic_id=?) ORDER BY seq LIMIT 1",
                        arrayOf(eventId, scope, syncId, eventId, semanticId))
                }
                if (Protocol.shouldNotify(inserted, eligible, message.peerId, foregroundPeer)) notifications.add(message)
            }
            db.execSQL("INSERT OR REPLACE INTO checkpoints VALUES (?, ?, ?, ?)", arrayOf<Any>(scope, cursor, if (Protocol.bootstrapAfterPage(bootstrap, hasMore)) 1 else 0, floor))
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        return notifications
    }
    fun read(scope: String, peer: String) { writableDatabase.execSQL("UPDATE messages SET unread=0 WHERE scope=? AND peer=?", arrayOf(scope, peer)) }
    fun containsEvent(scope: String, eventId: String): Boolean = readableDatabase.rawQuery("SELECT 1 FROM event_aliases WHERE scope=? AND event_id=? LIMIT 1", arrayOf(scope, eventId)).use { it.moveToFirst() }
    fun containsConfirmed(scope: String, item: JSONObject): Boolean {
        val eventId = item.optString("eventId")
        if (eventId.isNotEmpty() && containsEvent(scope, eventId)) return true
        // Partial/legacy acknowledgements must not match a hash made from default fields.
        if (!item.has("id") || !item.has("echo") || !item.has("message") || !item.has("ordinal") ||
            item.optString("sentAt").ifEmpty { item.optString("date") }.isEmpty()) return false
        return readableDatabase.rawQuery("SELECT 1 FROM messages WHERE scope=? AND semantic_id=? LIMIT 1",
            arrayOf(scope, Protocol.semanticIdentity(item))).use { it.moveToFirst() }
    }
    fun messages(scope: String, peer: String): List<Message> = readableDatabase.rawQuery(
        "SELECT sync_id,payload FROM messages WHERE scope=? AND peer=? ORDER BY sent_at DESC,ordinal DESC,seq DESC LIMIT 500", arrayOf(scope, peer)
    ).use { c -> buildList { while (c.moveToNext()) add(decode(JSONObject(c.getString(1)), c.getString(0))) }.reversed() }
    fun conversations(scope: String): List<Conversation> = readableDatabase.rawQuery(
        "SELECT m.peer,m.payload,(SELECT SUM(unread) FROM messages u WHERE u.scope=m.scope AND u.peer=m.peer) FROM messages m WHERE m.scope=? AND m.seq=(SELECT seq FROM messages n WHERE n.scope=m.scope AND n.peer=m.peer ORDER BY sent_at DESC,ordinal DESC,seq DESC LIMIT 1) ORDER BY m.sent_at DESC,m.ordinal DESC,m.seq DESC LIMIT 1000", arrayOf(scope)
    ).use { c -> buildList {
        while (c.moveToNext()) {
            val item = JSONObject(c.getString(1))
            val peer = c.getString(0)
            val name = if (item.optBoolean("echo")) peer else item.optString("name").ifBlank { peer }
            add(Conversation(peer, name, preview = item.optString("message"), updatedAt = item.optString("sentAt").ifEmpty { item.optString("date") }, unread = c.getInt(2)))
        }
    } }
    private fun decode(item: JSONObject, key: String) = Message(key, item.getString("id"), item.optString("name"), item.optString("message"), item.optBoolean("echo"), item.optString("sentAt").ifEmpty { item.optString("date") }, imageUrl = if (item.optString("type") == "image") item.optString("message").takeIf { it.startsWith("https://") || it.startsWith("/proxy/") } else null)
}
