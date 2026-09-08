package io.github.steamchat.android.ui

import java.net.URI
import java.net.URLEncoder

sealed interface MessagePart {
    data class Text(val text: String) : MessagePart
    data class Image(val source: String, val label: String = "图片", val small: Boolean = false) : MessagePart
    data class Link(val url: String, val title: String, val description: String = "", val image: String = "") : MessagePart
}

/** Only navigable web URLs; never pass credentials, control characters or custom schemes to Android. */
fun safeWebUrl(value: String): String? = runCatching {
    val text = value.trim()
    val uri = URI(text)
    text.takeIf { uri.scheme?.lowercase() in setOf("https", "http") && !uri.host.isNullOrEmpty() &&
        uri.rawUserInfo == null && text.none { it.isISOControl() } }
}.getOrNull()

fun validServer(value: String): Boolean = safeWebUrl(value)?.let {
    val uri = URI(it)
    uri.scheme.equals("https", true) && uri.rawQuery == null && uri.rawFragment == null
} == true

fun safeImageSource(value: String): String? {
    if (value.startsWith("/") && !value.startsWith("//") && !value.contains('\\') &&
        value.none { it.isISOControl() }) {
        return runCatching { URI(value).takeIf { it.rawAuthority == null && it.scheme == null }?.toString() }.getOrNull()
    }
    return safeWebUrl(value)
}

fun inventoryName(value: String): String? = value.trim().trim(':').takeIf {
    it.length in 1..160 && it.matches(Regex("[A-Za-z0-9_+.-]+"))
}
private fun encoded(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
fun emoticonSource(name: String) = "https://community.cloudflare.steamstatic.com/economy/emoticon/${encoded(name)}"
fun stickerSource(name: String) = "/proxy/sticker/${encoded(name)}"
fun stickerMarkup(name: String) = "[sticker type=\"${name.replace("\\", "\\\\").replace("\"", "\\\"")}\" limit=\"0\"][/sticker]"

object SteamMessageParser {
    private val opening = Regex("\\[(og|url|img|emoticon|sticker)(?=[\\s=\\]])", RegexOption.IGNORE_CASE)
    private val inline = Regex("https?://[^\\s<>\\[\\]]+|:([A-Za-z0-9_+.-]{1,160}):")

    fun parse(text: String): List<MessagePart> {
        // Bound parser work independently of transport limits. The remainder remains literal text.
        val input = text.take(65536)
        val result = mutableListOf<MessagePart>()
        var index = 0
        while (index < input.length) {
            val match = opening.find(input, index) ?: break
            appendInline(result, input.substring(index, match.range.first))
            val tag = match.groupValues[1].lowercase()
            val end = tagEnd(input, match.range.last + 1)
            val close = if (end >= 0) input.indexOf("[/$tag]", end + 1, ignoreCase = true) else -1
            if (end < 0 || close < 0) {
                result += MessagePart.Text(input.substring(match.range.first))
                index = input.length
                break
            }
            val attrs = input.substring(match.range.last + 1, end)
            val body = input.substring(end + 1, close)
            val part = block(tag, attrs, body)
            val next = close + tag.length + 3
            if (part == null) result += MessagePart.Text(input.substring(match.range.first, next))
            else {
                result += part
                if (tag == "og" && part is MessagePart.Link && body.trim() != part.url) appendInline(result, body)
            }
            index = next
        }
        appendInline(result, input.substring(index))
        if (text.length > input.length) result += MessagePart.Text(text.substring(input.length))
        return result
    }

    private fun block(tag: String, source: String, body: String): MessagePart? = when (tag) {
        "emoticon" -> inventoryName(body)?.takeIf { source.isBlank() }?.let {
            MessagePart.Image(emoticonSource(it), ":$it:", true)
        }
        "sticker" -> attributes(source, setOf("type", "limit"))?.get("type")?.trim()
            ?.takeIf { it.isNotEmpty() && it.length <= 256 && body.isBlank() }
            ?.let { MessagePart.Image(stickerSource(it), "贴纸") }
        "url" -> urlTarget(source, body)?.let { MessagePart.Link(it, body.ifBlank { it }) }
        "og" -> attributes(source, setOf("url", "img", "title", "desc"), true)?.let { a ->
            safeWebUrl(a["url"].orEmpty())?.let {
                MessagePart.Link(it, a["title"].orEmpty().ifBlank { it }, a["desc"].orEmpty(),
                    safeWebUrl(a["img"].orEmpty()).orEmpty())
            }
        }
        "img" -> attributes(source, setOf("src", "thumbnail_src", "srcset", "width", "height"))?.let { a ->
            val url = safeImageSource(a["src"].orEmpty().ifBlank { body.trim() })
            url?.let { MessagePart.Image(it) }
        }
        else -> null
    }

    private fun urlTarget(attrs: String, body: String): String? = if (attrs.isBlank()) safeWebUrl(body)
        else attributes("href$attrs", setOf("href"))?.get("href")?.let(::safeWebUrl)

    private fun appendInline(parts: MutableList<MessagePart>, text: String) {
        var index = 0
        inline.findAll(text).forEach { m ->
            if (m.range.first > index) parts += MessagePart.Text(text.substring(index, m.range.first))
            val name = m.groupValues[1]
            if (name.isNotEmpty()) parts += MessagePart.Image(emoticonSource(name), ":$name:", true)
            else {
                val url = safeWebUrl(m.value)
                val image = url != null && runCatching { URI(url).path.orEmpty().lowercase().matches(Regex(".*\\.(png|jpe?g|gif|webp|bmp)")) }.getOrDefault(false)
                parts += if (image) MessagePart.Image(url!!) else if (url != null) MessagePart.Link(url, url) else MessagePart.Text(m.value)
            }
            index = m.range.last + 1
        }
        if (index < text.length) parts += MessagePart.Text(text.substring(index))
    }

    private fun tagEnd(text: String, start: Int): Int {
        var quote: Char? = null
        var i = start
        while (i < text.length) {
            val c = text[i]
            if (quote != null) {
                if (c == '\\') i++ else if (c == quote) quote = null
            } else if (c == '\'' || c == '"') quote = c else if (c == ']') return i
            i++
        }
        return -1
    }

    internal fun attributes(source: String, allowed: Set<String>, requireQuoted: Boolean = false): Map<String, String>? {
        val values = mutableMapOf<String, String>()
        var i = 0
        fun whitespace() { while (i < source.length && source[i].isWhitespace()) i++ }
        while (i < source.length) {
            whitespace()
            if (i == source.length) break
            if (!(source[i] in 'a'..'z' || source[i] in 'A'..'Z' || source[i] == '_')) return null
            val start = i++
            while (i < source.length && (source[i].isLetterOrDigit() || source[i] in "_-")) i++
            val name = source.substring(start, i).lowercase()
            if (name !in allowed || name in values) return null
            whitespace()
            if (i >= source.length || source[i++] != '=') return null
            whitespace()
            if (i >= source.length) return null
            val quote = source[i].takeIf { it == '\'' || it == '"' }
            if (requireQuoted && quote == null) return null
            val value = StringBuilder()
            if (quote != null) {
                i++
                var closed = false
                while (i < source.length) {
                    val c = source[i++]
                    if (c == quote) { closed = true; break }
                    if (c == '\\' && i < source.length && (source[i] == quote || source[i] == '\\')) value.append(source[i++])
                    else value.append(c)
                }
                if (!closed) return null
            } else {
                while (i < source.length && !source[i].isWhitespace()) value.append(source[i++])
                if (value.isEmpty()) return null
            }
            values[name] = value.toString()
        }
        return values
    }
}
