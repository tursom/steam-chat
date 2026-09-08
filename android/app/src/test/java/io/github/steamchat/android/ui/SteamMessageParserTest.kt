package io.github.steamchat.android.ui

import org.junit.Assert.*
import org.junit.Test

class SteamMessageParserTest {
    @Test fun rejectsDangerousLinksAndCredentialUrls() {
        listOf("javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "intent://host", "//evil.test/a", "https://user:pass@example.com/a", "https://example.com/\nattack", "https://example.com\\@evil.test").forEach { assertNull(it, safeWebUrl(it)) }
        assertEquals("https://example.com/a?q=1", safeWebUrl("https://example.com/a?q=1"))
        assertEquals("http://example.com/", safeWebUrl("http://example.com/"))
    }
    @Test fun serverRequiresHttpsWithoutSecretsQueryOrFragment() {
        assertTrue(validServer("https://example.com/chat"))
        listOf("http://example.com", "https://user@example.com", "https://example.com/?token=x", "https://example.com/#x").forEach { assertFalse(validServer(it)) }
    }
    @Test fun htmlRemainsLiteral() {
        val input = "<script>alert(1)</script><img src=x onerror=alert(2)>"
        assertEquals(listOf(MessagePart.Text(input)), SteamMessageParser.parse(input))
        val malicious = "[url=javascript:alert(1)]打开[/url]"
        assertEquals(listOf(MessagePart.Text(malicious)), SteamMessageParser.parse(malicious))
    }
    @Test fun parsesQuotedSteamImageAttributesIncludingBrackets() {
        val input = "[img src=\"https://example.com/a.png\" thumbnail_src=\"https://example.com/t.png\" srcset=\"https://example.com/a.png 2x\" width=\"100\" height=\"50\"][url=https://example.com/a.png]https://example.com/a.png[/url][/img]"
        assertEquals(listOf(MessagePart.Image("https://example.com/a.png")), SteamMessageParser.parse(input))
        assertEquals(listOf(MessagePart.Image("https://example.com/a.png")), SteamMessageParser.parse("[img src='https://example.com/a.png'][/img]"))
    }
    @Test fun openGraphHonorsEscapingAndQuotedClosingBracket() {
        val input = "[og url=\"https://example.com\" img=\"https://example.com/a.png\" title=\"a ] \\\"title\\\"\" desc='plain <b>text</b>']https://example.com[/og]"
        assertEquals(listOf(MessagePart.Link("https://example.com", "a ] \"title\"", "plain <b>text</b>", "https://example.com/a.png")), SteamMessageParser.parse(input))
    }
    @Test fun duplicateUnknownAndUnquotedOgAttributesFallBack() {
        listOf("[og url='https://example.com' url='https://evil.test'][/og]", "[og url=https://example.com][/og]", "[img src='https://example.com/a.png' onclick='x'][/img]", "[img src='unfinished][/img]").forEach {
            assertEquals(it, listOf(MessagePart.Text(it)), SteamMessageParser.parse(it))
        }
    }
    @Test fun parsesInventoryMarkupAndPlainImages() {
        assertEquals(listOf(MessagePart.Image(emoticonSource("steamhappy"), ":steamhappy:", true)), SteamMessageParser.parse("[emoticon]steamhappy[/emoticon]"))
        assertEquals(listOf(MessagePart.Image(emoticonSource("steamthumbsup"), ":steamthumbsup:", true)), SteamMessageParser.parse(":steamthumbsup:"))
        assertEquals(listOf(MessagePart.Image(stickerSource("sticker_name"), "贴纸")), SteamMessageParser.parse(stickerMarkup("sticker_name")))
        assertEquals(listOf(MessagePart.Image("https://example.com/a.jpg?q=1")), SteamMessageParser.parse("https://example.com/a.jpg?q=1"))
    }
    @Test fun relativeImagesCannotBecomeExternalAuthorities() {
        assertEquals("/proxy/sticker/name", safeImageSource("/proxy/sticker/name"))
        assertNull(safeImageSource("//evil.test/a"))
        assertNull(safeImageSource("/\\evil.test/a"))
        assertNull(safeImageSource("content://private/a"))
    }
    @Test fun unsupportedMarkupIsPreservedAndParserBoundsWork() {
        assertEquals(listOf(MessagePart.Text("[unknown]hello[/unknown]")), SteamMessageParser.parse("[unknown]hello[/unknown]"))
        val text = "x".repeat(70000)
        assertEquals(text, SteamMessageParser.parse(text).filterIsInstance<MessagePart.Text>().joinToString("") { it.text })
    }
}
