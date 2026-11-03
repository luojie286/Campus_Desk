package com.campusdesk.mobile

import com.campusdesk.mobile.data.*
import com.campusdesk.mobile.domain.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class BriefingTest {
    private val now = Instant.parse("2026-11-03T23:00:00Z")
    private fun brief(date: String = "2026-11-04", state: String = "ready") = Briefing(5, date, "Asia/Yakutsk", state, "ai")
    @Test fun `today briefing notifies once even on silent first poll`() {
        val snapshot = Snapshot(briefings = listOf(brief()))
        val first = planNotifications(SeenState(), snapshot, false, now)
        assertEquals(listOf(Notice("briefing", 5)), first.notices)
        assertTrue(planNotifications(first.next, snapshot, false, now).notices.isEmpty())
    }
    @Test fun `yesterday and unfinished reports never generate a new morning notice`() {
        val snapshot = Snapshot(briefings = listOf(brief("2026-11-03"), brief(state = "generating")))
        assertTrue(planNotifications(SeenState(), snapshot, false, now).notices.isEmpty())
    }
    @Test fun `completion after generating produces one notice`() {
        val first = planNotifications(SeenState(), Snapshot(briefings = listOf(brief(state = "generating"))), false, now)
        val done = planNotifications(first.next, Snapshot(briefings = listOf(brief())), false, now)
        assertEquals(1, done.notices.size)
    }
    @Test fun `old persisted state is compatible and invalid report zone is ignored`() {
        val old = apiJson.decodeFromString<SeenState>("""{"initialized":true,"suggestions":[1],"activeApprovals":[]}""")
        assertTrue(old.briefings.isEmpty())
        assertTrue(planNotifications(old, Snapshot(briefings = listOf(brief().copy(timeZone = "invalid"))), false, now).notices.isEmpty())
    }
    @Test fun `ready report parses sections null fields and source references`() {
        val report = apiJson.decodeFromString<Briefing>("""{"id":5,"local_date":"2026-11-04","time_zone":"Asia/Yakutsk","state":"ready","mode":"rules","generated_at":null,"content":{"intro":"早上好","sections":[{"title":"待办","items":[{"text":"示例事项","ref":"todo:1"}]}]}}""")
        assertEquals("todo:1", report.content!!.sections.single().items.single().ref)
        assertEquals("rules", report.mode)
    }
    @Test fun `old backend without early briefing still loads existing lists`() = runBlocking {
        MockWebServer().use { server ->
            server.start(); repeat(3) { server.enqueue(MockResponse().setBody("""{"items":[]}""")) }
            server.enqueue(MockResponse().setResponseCode(404).setBody("{}"))
            val snapshot = ApiClient(Connection(server.url("/").toString(), "fake")).snapshot()
            assertFalse(snapshot.briefingSupported); assertTrue(snapshot.tasks.isEmpty())
        }
    }
    @Test fun `schedule uses PUT and manual generation uses POST with no field values`() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setBody("""{"enabled":true,"time":"08:30","time_zone":"UTC"}"""))
            server.enqueue(MockResponse().setBody("""{"id":1,"local_date":"2026-11-04","time_zone":"UTC","state":"queued"}"""))
            val client = ApiClient(Connection(server.url("/").toString(), "fake"))
            assertEquals("08:30", client.saveBriefingSettings(BriefingSettings(true, "08:30", "UTC")).time)
            assertEquals("PUT", server.takeRequest().method)
            assertEquals("queued", client.generateToday().state)
            val request = server.takeRequest(); assertEquals("POST", request.method); assertEquals("{}", request.body.readUtf8())
        }
    }
}
