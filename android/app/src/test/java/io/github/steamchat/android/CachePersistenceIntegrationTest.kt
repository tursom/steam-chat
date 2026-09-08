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

    @Test fun aMalformedPageRollsBackBothMessagesAndCursor() {
        cache.ingest(scope, JSONArray(), "before", false, "")
        try {
            cache.ingest(scope, JSONArray().put(item("valid")).put(JSONObject().put("id", "peer1")), "after", false, "")
            fail("Malformed sync item must fail the transaction")
        } catch (_: Exception) { }
        assertEquals("before", cache.checkpoint(scope).first)
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
