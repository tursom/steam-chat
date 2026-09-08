package io.github.steamchat.android.data

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class ProtocolTest {
    @Test fun requiresHttpsAndUnambiguousAuthority() {
        listOf("http://example.com", "https://user:pass@example.com", "https://@example.com", "https://example.com/?x=1", "https://example.com/#x", "https://example.com\\@evil.test").forEach {
            assertTrue(it, runCatching { Protocol.base(it) }.isFailure)
        }
    }
    @Test fun preservesReverseProxyPrefixForEveryEndpoint() {
        val base = Protocol.base("https://example.com:8443/chat")
        assertEquals("https://example.com:8443/chat/", base.toString())
        for (path in listOf("/api/auth/login", "/api/messages/sync?limit=100", "/ws", "/message", "/image", "/proxy/sticker/123")) {
            assertEquals("https://example.com:8443/chat$path", Protocol.endpoint(base, path).toString())
        }
    }
    @Test fun rejectsOriginAndPrefixEscape() {
        val base = Protocol.base("https://example.com/chat/")
        listOf("//evil.test/a", "https://evil.test/a", "../outside", "%2e%2e/outside", "/ws#fragment", "\\evil.test").forEach {
            assertTrue(it, runCatching { Protocol.endpoint(base, it) }.isFailure)
        }
    }
    @Test fun bootstrapEchoStaleAndInvalidTimesNeverNotify() {
        val now = Instant.parse("2026-01-01T12:00:00Z").toEpochMilli()
        assertFalse(Protocol.freshIncoming(true, false, "2026-01-01T12:00:00Z", now))
        assertFalse(Protocol.freshIncoming(false, true, "2026-01-01T12:00:00Z", now))
        assertFalse(Protocol.freshIncoming(false, false, "2025-01-01T12:00:00Z", now))
        assertFalse(Protocol.freshIncoming(false, false, "2026-01-02T12:00:00Z", now))
        assertFalse(Protocol.freshIncoming(false, false, "invalid", now))
        assertTrue(Protocol.freshIncoming(false, false, "2026-01-01T11:59:00Z", now))
    }
    @Test fun bootstrapPersistsAcrossAllPagesAndDuplicatesNeverNotify() {
        var bootstrap = true
        repeat(10) { bootstrap = Protocol.bootstrapAfterPage(bootstrap, true); assertTrue(bootstrap) }
        bootstrap = Protocol.bootstrapAfterPage(bootstrap, false)
        assertFalse(bootstrap)
        assertFalse(Protocol.bootstrapAfterPage(bootstrap, true))
        assertFalse(Protocol.shouldNotify(false, true, "peer", ""))
        assertFalse(Protocol.shouldNotify(true, true, "peer", "peer"))
        assertFalse(Protocol.shouldNotify(true, false, "peer", ""))
        assertTrue(Protocol.shouldNotify(true, true, "peer", ""))
    }
    @Test fun reimportsDeduplicateByEitherDurableIdentityNotTimestamp() {
        assertTrue(Protocol.duplicate("s1", "new", setOf("s1"), setOf("e1")))
        assertTrue(Protocol.duplicate("s2", "e1", setOf("s1"), setOf("e1")))
        assertFalse(Protocol.duplicate("s2", "e2", setOf("s1"), setOf("e1")))
        assertFalse(Protocol.duplicate("s2", "", setOf("s1"), emptySet()))
    }
}
