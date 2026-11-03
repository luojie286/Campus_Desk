package com.campusdesk.mobile

import com.campusdesk.mobile.data.*
import com.campusdesk.mobile.domain.*
import org.junit.Assert.*
import org.junit.Test

class RulesTest {
    private fun task() = Task(7, "awaiting_approval", currentPlanId = 8,
        plan = Plan(8, 2, "digest", plan = PlanBody("full", 2, listOf(Change(2, 3, "sex", "", "男")))))
    @Test fun `normalize base and reject credentials paths queries and non-http schemes`() {
        assertEquals("http://127.0.0.1:9087", connectionBase(" http://127.0.0.1:9087/ "))
        listOf("file:///etc", "https://name:secret@example.com", "https://example.com/api", "https://example.com?token=x", "https://example.com#x", "http://example.com:0").forEach { raw ->
            assertThrows(IllegalArgumentException::class.java) { connectionBase(raw) }
        }
    }
    @Test fun `fingerprints isolate servers tokens and demo and connection string hides token`() {
        val c = Connection(token = "secret")
        assertNotEquals(c.fingerprint(), c.copy(token = "other").fingerprint())
        assertNotEquals(c.fingerprint(), c.copy(base = "https://example.com").fingerprint())
        assertNotEquals(c.fingerprint(), c.copy(demo = true).fingerprint())
        assertFalse(c.toString().contains("secret"))
    }
    @Test fun `only current complete warning free plan may be approved`() {
        val t = task(); assertNull(approvalBlock(t))
        assertNotNull(approvalBlock(t.copy(state = "completed")))
        assertNotNull(approvalBlock(t.copy(plan = null)))
        assertNotNull(approvalBlock(t.copy(currentPlanId = 99)))
        assertNotNull(approvalBlock(t.copy(plan = t.plan!!.copy(status = "superseded"))))
        val b = t.plan!!.plan
        listOf(b.copy(warnings = listOf(Warning(reason = "warning"))),
            b.copy(missing = listOf(Missing("phone"))), b.copy(changes = emptyList()),
            b.copy(changes = listOf(Change(2, 3, "x", value = "=1+1"))),
            b.copy(changes = listOf(Change(2, 3, "x", value = null))),
            b.copy(changes = listOf(Change(0, 3, "x", value = "ok")))).forEach { body ->
            assertNotNull(approvalBlock(t.copy(plan = t.plan!!.copy(plan = body))))
        }
    }
    @Test fun `first poll creates silent baseline unless opted in`() {
        val snapshot = Snapshot(listOf(Suggestion(1, "test")), listOf(task()))
        val silent = planNotifications(SeenState(), snapshot, false)
        assertTrue(silent.notices.isEmpty()); assertTrue(silent.next.initialized)
        assertEquals(2, planNotifications(SeenState(), snapshot, true).notices.size)
    }
    @Test fun `repeat polls and plan versions do not repeat notifications`() {
        val snapshot = Snapshot(listOf(Suggestion(1, "test")), listOf(task()))
        val first = planNotifications(SeenState(), snapshot, false)
        val updated = snapshot.copy(tasks = listOf(task().copy(stateVersion = 20)))
        assertTrue(planNotifications(first.next, updated, true).notices.isEmpty())
    }
    @Test fun `new candidates notify once and input tasks do not notify`() {
        val previous = SeenState(true, setOf(1), emptySet())
        val snapshot = Snapshot(listOf(Suggestion(1, "old"), Suggestion(2, "new")), listOf(task().copy(state = "awaiting_input")))
        val batch = planNotifications(previous, snapshot, false)
        assertEquals(listOf(Notice("suggestion", 2)), batch.notices)
        assertTrue(planNotifications(batch.next, snapshot, false).notices.isEmpty())
    }
    @Test fun `approval re-entry is notified but waiting version change is not`() {
        val previous = SeenState(true, emptySet(), setOf(7))
        val away = planNotifications(previous, Snapshot(tasks = listOf(task().copy(state = "preparing"))), false)
        val back = planNotifications(away.next, Snapshot(tasks = listOf(task())), false)
        assertEquals(listOf(Notice("task", 7)), back.notices)
    }
    @Test fun `notification memory is bounded`() {
        val previous = SeenState(true, (1L..3000L).toSet())
        val next = planNotifications(previous, Snapshot(), false).next
        assertEquals(2000, next.suggestions.size); assertTrue(next.suggestions.contains(3000))
    }
    @Test fun `backoff is bounded and cell addresses handle columns beyond Z`() {
        assertEquals(25_000L, retryDelayMillis(0)); assertEquals(50_000L, retryDelayMillis(1))
        assertEquals(600_000L, retryDelayMillis(99)); assertEquals("AA12", cellAddress(27, 12))
    }
    @Test fun `errors are actionable without exposing server response or token`() {
        assertTrue(errorText(ApiException(401)).contains("令牌"))
        assertTrue(errorText(ApiException(409)).contains("刷新"))
        assertFalse(errorText(java.io.IOException("SECRET")).contains("SECRET"))
    }
}
