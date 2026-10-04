package io.github.steamchat.android

import android.app.Application
import io.github.steamchat.android.data.ChatCache
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, manifest = Config.NONE)
class CachePersistenceIntegrationTest {
    private lateinit var cache: ChatCache
    private val scope = "https://chat.example.com/|user1|steam1"
    @Before fun setup() {
        File(RuntimeEnvironment.getApplication().noBackupFilesDir, "chat.sqlite").delete()
        cache = ChatCache(RuntimeEnvironment.getApplication())
    }
    @After fun cleanup() { cache.close() }
    private fun item(id: String, time: String = Instant.now().toString(), peer: String = "peer1", echo: Boolean = false) =
        JSONObject().put("syncId", id).put("eventId", id).put("id", peer).put("name", "Friend")
            .put("message", "message-$id").put("sentAt", time).put("ordinal", 1).put("echo", echo)

    @Test fun initialPagesStaySilentThenNewMessagesNotifyOnce() {
        assertTrue(cache.ingest(scope, JSONArray().put(item("old")), "c1", true, "").isEmpty())
        assertTrue(cache.checkpoint(scope).second)
        assertTrue(cache.ingest(scope, JSONArray().put(item("old2")), "c2", false, "").isEmpty())
        assertFalse(cache.checkpoint(scope).second)
        assertEquals(1, cache.ingest(scope, JSONArray().put(item("new")), "c3", false, "").size)
        assertTrue(cache.ingest(scope, JSONArray().put(item("new")), "c4", false, "").isEmpty())
        assertEquals(3, cache.messages(scope, "peer1").size)
        assertEquals(1, cache.conversations(scope).single().unread)
        cache.read(scope, "peer1")
        assertEquals(0, cache.conversations(scope).single().unread)
    }

    @Test fun incomingOutsideVisibleConversationCreatesSystemNotification() {
        val context = RuntimeEnvironment.getApplication()
        ChatNotifications.channels(context)
        val state = AppState(loggedIn = true, accessAllowed = true)
        val manager = context.getSystemService(android.app.NotificationManager::class.java)
        cache.ingest(scope, JSONArray(), "initial", false, "")
        for ((index, visible) in listOf("", "other-peer").withIndex()) {
            val notices = cache.ingest(scope, JSONArray().put(item("notice-$index")), "cursor-$index", false, visible)
            assertEquals(1, notices.size)
            notices.forEach { ChatNotifications.message(context, state, it) }
            assertEquals("peer:peer1", manager.activeNotifications.single().tag)
            ChatNotifications.clearMessages(context)
        }
        val visibleNotices = cache.ingest(scope, JSONArray().put(item("visible")), "last", false, "peer1")
        assertTrue(visibleNotices.isEmpty())
        assertTrue(manager.activeNotifications.isEmpty())
    }

    @Test fun aMalformedPageRollsBackBothMessagesAndCursor() {
        cache.ingest(scope, JSONArray(), "before", false, "")
        try {
            cache.ingest(scope, JSONArray().put(item("valid")).put(JSONObject().put("id", "peer1")), "after", false, "")
            fail("Malformed sync item must fail the transaction")
        } catch (_: Exception) { }
        assertEquals("before", cache.checkpoint(scope).first)
        assertFalse(cache.containsEvent(scope, "valid"))
        assertTrue(cache.messages(scope, "peer1").isEmpty())
    }

    @Test fun accountScopesAndForegroundReadStateAreIsolated() {
        cache.ingest(scope, JSONArray(), "start", false, "")
        cache.ingest(scope, JSONArray().put(item("one")), "next", false, "peer1")
        assertEquals(0, cache.conversations(scope).single().unread)
        assertTrue(cache.messages("another-account", "peer1").isEmpty())
        assertEquals("", cache.checkpoint("another-account").first)
    }

    @Test fun delayedCatchupStaysUnreadAndHistoryImportsRemainChronological() {
        cache.ingest(scope, JSONArray(), "initial", false, "")
        val now = System.currentTimeMillis()
        cache.writableDatabase.execSQL("UPDATE checkpoints SET notification_floor=? WHERE scope=?", arrayOf<Any>(now - 30 * 60_000, scope))
        val delayed = item("delayed", Instant.ofEpochMilli(now - 10 * 60_000).toString())
        assertEquals(1, cache.ingest(scope, JSONArray().put(delayed), "after-outage", false, "").size)
        cache.ingest(scope, JSONArray().put(item("older", Instant.ofEpochMilli(now - 60 * 60_000).toString())), "import", false, "")
        assertEquals(listOf("older", "delayed"), cache.messages(scope, "peer1").map { it.key })
        assertEquals("message-delayed", cache.conversations(scope).single().preview)
        assertEquals(1, cache.conversations(scope).single().unread)
    }

    @Test fun semanticReimportsDoNotDuplicateAndLogoutClearDeletesAllScopes() {
        val original = item("one")
        cache.ingest(scope, JSONArray().put(original), "first", false, "")
        val reimport = JSONObject(original.toString()).put("eventId", "reimport").put("syncId", "reimport").put("name", "Renamed friend")
        assertTrue(cache.ingest(scope, JSONArray().put(reimport), "second", false, "").isEmpty())
        assertEquals(1, cache.messages(scope, "peer1").size)
        cache.ingest("other", JSONArray().put(original), "other-cursor", false, "")
        cache.clearAll()
        assertTrue(cache.messages(scope, "peer1").isEmpty())
        assertTrue(cache.messages("other", "peer1").isEmpty())
        assertEquals("", cache.checkpoint(scope).first)
    }

    @Test fun versionOneUpgradePreservesMessagesCheckpointAndEventIdentity() {
        cache.ingest(scope, JSONArray().put(item("existing")), "saved", false, "")
        // Reconstruct the shipped v1 schema, which has no alias table.
        cache.writableDatabase.execSQL("DROP TABLE event_aliases")
        restoreOldCheckpoints()
        cache.writableDatabase.version = 1
        cache.close()
        cache = ChatCache(RuntimeEnvironment.getApplication())
        assertTrue(cache.containsEvent(scope, "existing"))
        assertEquals("saved", cache.checkpoint(scope).first)
        assertEquals(1, cache.messages(scope, "peer1").size)
    }

    private fun restoreOldCheckpoints() {
        cache.writableDatabase.execSQL("DROP TABLE history_pending")
        cache.writableDatabase.execSQL("ALTER TABLE checkpoints RENAME TO new_checkpoints")
        cache.writableDatabase.execSQL("CREATE TABLE checkpoints (scope TEXT PRIMARY KEY, cursor TEXT NOT NULL, bootstrap INTEGER NOT NULL, notification_floor INTEGER NOT NULL)")
        cache.writableDatabase.execSQL("INSERT INTO checkpoints SELECT scope,cursor,bootstrap,notification_floor FROM new_checkpoints")
        cache.writableDatabase.execSQL("DROP TABLE new_checkpoints")
    }

    @Test fun versionTwoUpgradeRestartsOnlyUnfinishedBootstrapAndKeepsMessages() {
        cache.ingest(scope, JSONArray().put(item("partial")), "old-first-page", true, "")
        cache.ingest("complete", JSONArray().put(item("complete")), "live-saved", false, "")
        restoreOldCheckpoints()
        cache.writableDatabase.version = 2
        cache.close()
        cache = ChatCache(RuntimeEnvironment.getApplication())
        assertEquals("" to true, cache.checkpoint(scope))
        assertEquals("live-saved" to false, cache.checkpoint("complete"))
        assertTrue(cache.containsEvent(scope, "partial"))
        assertNull(cache.historyCursor(scope))
        assertNull(cache.historyCursor("complete"))
    }

    @Test fun recentPageAndTwoCursorsSurviveRestartWhileNewMessagesNotifyDuringBackfill() {
        val recent = item("recent")
        cache.ingestHistory(scope, JSONArray().put(recent), "history-1", true, "live-start")
        assertEquals("live-start" to false, cache.checkpoint(scope))
        assertEquals("history-1", cache.historyCursor(scope))
        assertEquals(0, cache.conversations(scope).single().unread)
        cache.close()
        cache = ChatCache(RuntimeEnvironment.getApplication())
        assertEquals("history-1", cache.historyCursor(scope))
        assertEquals("live-start" to false, cache.checkpoint(scope))
        assertEquals(1, cache.ingest(scope, JSONArray().put(item("new")), "live-next", false, "").size)
        assertEquals("history-1", cache.historyCursor(scope))
        // Even a recent timestamp in a backfill page is historical and remains silent.
        cache.ingestHistory(scope, JSONArray().put(item("earlier")).put(recent), "history-2", true)
        assertEquals("live-next", cache.checkpoint(scope).first)
        assertEquals("history-2", cache.historyCursor(scope))
        assertEquals(1, cache.conversations(scope).single().unread)
        assertEquals(3, cache.messages(scope, "peer1").size)
        cache.ingestHistory(scope, JSONArray(), "history-end", false)
        assertNull(cache.historyCursor(scope))
        assertEquals("live-next", cache.checkpoint(scope).first)
        assertTrue(cache.ingest(scope, JSONArray().put(recent), "live-end", false, "").isEmpty())
        assertNull(cache.historyCursor("other-account"))
    }

    @Test fun malformedRecentAndOlderPagesRollBackMessagesAndBothCursors() {
        val malformed = JSONArray().put(item("valid")).put(JSONObject().put("id", "peer1"))
        assertThrows(Exception::class.java) { cache.ingestHistory(scope, malformed, "history-1", true, "live-start") }
        assertEquals("" to true, cache.checkpoint(scope))
        assertNull(cache.historyCursor(scope))
        assertFalse(cache.containsEvent(scope, "valid"))
        cache.ingestHistory(scope, JSONArray().put(item("recent")), "history-1", true, "live-start")
        assertThrows(Exception::class.java) { cache.ingestHistory(scope, malformed, "history-2", false) }
        assertEquals("live-start" to false, cache.checkpoint(scope))
        assertEquals("history-1", cache.historyCursor(scope))
        assertFalse(cache.containsEvent(scope, "valid"))
        cache.reset(scope)
        assertEquals("" to true, cache.checkpoint(scope))
        assertNull(cache.historyCursor(scope))
        assertTrue(cache.containsEvent(scope, "recent"))
    }

    @Test fun liveNoticesSurviveHistoryWinningTheRaceAndDoNotResurrectReadMessages() {
        cache.ingestHistory(scope, JSONArray(), "h1", true, "live-start")
        val late = item("late")
        cache.ingestHistory(scope, JSONArray().put(late), "h2", true)
        assertEquals(0, cache.conversations(scope).single().unread)
        cache.close()
        cache = ChatCache(RuntimeEnvironment.getApplication())
        assertEquals(1, cache.ingest(scope, JSONArray().put(late), "live-next", false, "").size)
        assertEquals(1, cache.conversations(scope).single().unread)
        assertTrue(cache.ingest(scope, JSONArray().put(late), "replay", false, "").isEmpty())
        val read = item("already-read")
        cache.ingestHistory(scope, JSONArray().put(read), "h3", true)
        cache.read(scope, "peer1")
        assertTrue(cache.ingest(scope, JSONArray().put(read), "live-read", false, "").isEmpty())
        assertEquals(0, cache.conversations(scope).single().unread)
        val visible = item("visible")
        cache.ingestHistory(scope, JSONArray().put(visible), "h4", true, foregroundPeer = "peer1")
        assertTrue(cache.ingest(scope, JSONArray().put(visible), "live-visible", false, "").isEmpty())
    }

    @Test fun historyOnlyRestartKeepsLiveProgressAndPendingNotices() {
        cache.ingestHistory(scope, JSONArray(), "history", true, "live-start")
        val late = item("late")
        cache.ingestHistory(scope, JSONArray().put(late), "history-next", true)
        cache.restartHistory(scope)
        cache.close()
        cache = ChatCache(RuntimeEnvironment.getApplication())
        assertEquals("live-start" to false, cache.checkpoint(scope))
        assertEquals("", cache.historyCursor(scope))
        assertEquals(1, cache.ingest(scope, JSONArray().put(late), "live-next", false, "").size)
        cache.ingestHistory(scope, JSONArray().put(late), "history-new", false)
        assertEquals("live-next", cache.checkpoint(scope).first)
        assertNull(cache.historyCursor(scope))
    }

    @Test fun semanticAliasesSurviveReopenAndStayScoped() {
        val original = item("original")
        cache.ingest(scope, JSONArray().put(original), "first", false, "")
        val alias = JSONObject(original.toString()).put("eventId", "alias").put("syncId", "alias-sync")
        cache.ingest(scope, JSONArray().put(alias), "second", false, "")
        cache.close()
        cache = ChatCache(RuntimeEnvironment.getApplication())
        assertTrue(cache.containsEvent(scope, "original"))
        assertTrue(cache.containsEvent(scope, "alias"))
        assertFalse(cache.containsEvent("other", "alias"))
        // A replay with the alias event ID must not insert another row even if its payload differs.
        cache.ingest(scope, JSONArray().put(JSONObject(alias.toString()).put("syncId", "replay").put("message", "changed")), "third", false, "")
        assertEquals(1, cache.messages(scope, "peer1").size)
        cache.reset(scope)
        assertTrue(cache.containsEvent(scope, "alias"))
        cache.clearAll()
        assertFalse(cache.containsEvent(scope, "alias"))
    }

    @Test fun semanticAliasPointsAtTheOriginalRowThroughUniqueIndexes() {
        val original = item("original")
        cache.ingest(scope, JSONArray().put(item("first", peer = "peer2")).put(original), "first", false, "")
        val alias = JSONObject(original.toString()).put("eventId", "alias").put("syncId", "alias-sync")
        cache.ingest(scope, JSONArray().put(alias), "second", false, "")
        fun seq(sql: String, vararg args: String) = cache.readableDatabase.rawQuery(sql, arrayOf(*args)).use { it.moveToFirst(); it.getLong(0) }
        assertEquals(2L, seq("SELECT COUNT(*) FROM messages WHERE scope=?", scope))
        assertEquals(seq("SELECT seq FROM messages WHERE scope=? AND sync_id=?", scope, "original"),
            seq("SELECT message_seq FROM event_aliases WHERE scope=? AND event_id=?", scope, "alias"))
        // Alias lookup must probe the unique indexes, never scan and sort the account's rows per message.
        val plan = cache.readableDatabase.rawQuery("EXPLAIN QUERY PLAN SELECT ?1,?2,seq FROM (" +
            "SELECT seq FROM messages WHERE scope=?1 AND sync_id=?3 UNION ALL SELECT seq FROM messages WHERE scope=?1 AND event_id=?2 UNION ALL " +
            "SELECT seq FROM messages WHERE scope=?1 AND semantic_id=?4) ORDER BY seq LIMIT 1", arrayOf(scope, "e", "s", "x")).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(3)) } }
        assertEquals(3, plan.count { it.contains("sqlite_autoindex_messages") })
        assertFalse(plan.joinToString().contains("messages_peer"))
    }

    @Test fun conversationsOrderByLatestMessageAndCountOnlyUnreadRows() {
        cache.ingest(scope, JSONArray(), "initial", false, "")
        val now = System.currentTimeMillis()
        cache.ingest(scope, JSONArray().put(item("a1", Instant.ofEpochMilli(now - 3_000).toString(), "peerA"))
            .put(item("b1", Instant.ofEpochMilli(now - 2_000).toString(), "peerB"))
            .put(item("a2", Instant.ofEpochMilli(now - 1_000).toString(), "peerA"))
            .put(item("c1", Instant.ofEpochMilli(now - 500).toString(), "peerC", echo = true)), "next", false, "peerB")
        val conversations = cache.conversations(scope)
        assertEquals(listOf("peerC", "peerA", "peerB"), conversations.map { it.id })
        assertEquals(listOf("message-c1", "message-a2", "message-b1"), conversations.map { it.preview })
        assertEquals(listOf(0, 2, 0), conversations.map { it.unread })
        cache.read(scope, "peerA")
        assertEquals(0, cache.conversations(scope).sumOf { it.unread })
    }

    @Test fun versionThreeUpgradeAddsUnreadIndexAndKeepsData() {
        cache.ingest(scope, JSONArray(), "initial", false, "")
        cache.ingest(scope, JSONArray().put(item("unread")), "saved", false, "")
        cache.writableDatabase.execSQL("DROP INDEX messages_unread")
        cache.writableDatabase.version = 3
        cache.close()
        cache = ChatCache(RuntimeEnvironment.getApplication())
        assertTrue(cache.readableDatabase.rawQuery("SELECT 1 FROM sqlite_master WHERE type='index' AND name='messages_unread'", null).use { it.moveToFirst() })
        assertEquals("saved", cache.checkpoint(scope).first)
        assertEquals(1, cache.conversations(scope).single().unread)
    }

    @Test fun cursorSurvivesReopeningAndResetDoesNotDuplicateRows() {
        cache.ingest(scope, JSONArray().put(item("one")), "saved", false, "")
        cache.close()
        cache = ChatCache(RuntimeEnvironment.getApplication())
        assertEquals("saved", cache.checkpoint(scope).first)
        assertEquals(1, cache.messages(scope, "peer1").size)
        cache.reset(scope)
        assertTrue(cache.ingest(scope, JSONArray().put(item("one")), "rebuilt", false, "").isEmpty())
        assertEquals(1, cache.messages(scope, "peer1").size)
    }
}
