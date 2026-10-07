package io.github.steamchat.android.ui

import io.github.steamchat.android.Message
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

class ChatGroupingTest {
    private val today = LocalDate.of(2026, 10, 4)
    private fun at(day: LocalDate, hour: Int, minute: Int) =
        LocalDateTime.of(day, java.time.LocalTime.of(hour, minute)).atZone(ZoneId.systemDefault()).toInstant().toString()
    private fun message(key: String, echo: Boolean, time: String, failed: Boolean = false) =
        Message(key, "peer", if (echo) "Me" else "Friend", key, echo, time, failed = failed)

    @Test fun consecutiveSameSideMessagesShareAGroupUntilSideTimeOrDayChanges() {
        val now = LocalDate.now()
        val messages = listOf(
            message("a", false, at(now, 10, 0)),
            message("b", false, at(now, 10, 3)),
            message("c", false, at(now, 10, 9)), // six minutes later: new group
            message("d", true, at(now, 10, 9)),
            message("e", true, at(now, 10, 10), failed = true), // stands alone for its retry row
            message("f", true, at(now, 10, 10))
        )
        val shapes = bubbleShapes(messages)
        assertEquals(listOf(true, false, true, true, true, true), shapes.map { it.first })
        assertEquals(listOf(false, true, true, true, true, true), shapes.map { it.last })
        assertEquals(listOf("今天", null, null, null, null, null), shapes.map { it.date })
    }

    @Test fun eachDayOpensWithOneDateChipAndUnparsableTimesNeverJoin() {
        val now = LocalDate.now()
        val shapes = bubbleShapes(listOf(
            message("old", false, at(now.minusDays(1), 23, 58)),
            message("new", false, at(now, 0, 1)),
            message("bad", false, "not-a-time")
        ))
        assertEquals(listOf("昨天", "今天", null), shapes.map { it.date })
        assertEquals(listOf(true, true, true), shapes.map { it.first })
    }

    @Test fun listTimeNarrowsFromClockToFullDate() {
        assertEquals("09:30", listTime(at(today, 9, 30), today))
        assertEquals("昨天", listTime(at(today.minusDays(1), 22, 0), today))
        assertEquals("周三", listTime(at(LocalDate.of(2026, 9, 30), 8, 0), today))
        assertEquals("9月20日", listTime(at(LocalDate.of(2026, 9, 20), 8, 0), today))
        assertEquals("2025/12/31", listTime(at(LocalDate.of(2025, 12, 31), 8, 0), today))
    }

    @Test fun dayLabelsAreRelativeThenAbsolute() {
        assertEquals("今天", dayLabel(at(today, 1, 0), today))
        assertEquals("昨天", dayLabel(at(today.minusDays(1), 1, 0), today))
        assertEquals("9月28日 周一", dayLabel(at(LocalDate.of(2026, 9, 28), 1, 0), today))
        assertEquals("2025年1月2日", dayLabel(at(LocalDate.of(2025, 1, 2), 1, 0), today))
        assertNull(dayLabel("garbage", today))
    }
}
