package io.github.steamchat.android.data

import io.github.steamchat.android.Sticker
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class StickerInventoryTest {
    @Test fun retainsCanonicalNameTitlePreviewAndAliasesAlongsideLegacyStrings() {
        val result = Protocol.stickerInventory(JSONArray().put("legacy").put(JSONObject()
            .put("name", "Cat Cam talking").put("title", "Cat sticker")
            .put("imageUrl", "https://media.example.test/image.png")
            .put("aliases", JSONArray().put("old-name"))))
        assertEquals(Sticker("legacy"), result.first())
        assertEquals(Sticker("Cat Cam talking", "Cat sticker", "https://media.example.test/image.png", listOf("old-name")), result.last())
        assertEquals(result.last(), Protocol.stickerForName("old-name", result))
    }

    @Test fun invalidPreviewCredentialsAndInvalidNamesAreNotUsed() {
        for (url in listOf("https://user:secret@example.test/image", "https://@example.test/image", "file:///private", "https://example.test/image#secret")) {
            val sticker = Protocol.stickerInventory(JSONArray().put(JSONObject().put("name", "valid").put("imageUrl", url))).single()
            assertEquals("", sticker.imageUrl)
        }
        assertTrue(Protocol.stickerInventory(JSONArray().put("bad\nname").put(JSONObject().put("name", "bad\"name"))).isEmpty())
    }

    @Test fun ambiguousAliasesAreNotGuessedAndCanonicalNamesHavePriority() {
        val first = Sticker("one", aliases = listOf("ambiguous", "two"))
        val second = Sticker("two", aliases = listOf("ambiguous"))
        assertNull(Protocol.stickerForName("ambiguous", listOf(first, second)))
        assertEquals(second, Protocol.stickerForName("two", listOf(first, second)))
        assertEquals("/proxy/sticker/Rumi%20%3A%20Why...%3F", Protocol.stickerPath("Rumi : Why...?"))
    }
}
