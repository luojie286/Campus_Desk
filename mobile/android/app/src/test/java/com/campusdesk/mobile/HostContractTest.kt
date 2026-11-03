package com.campusdesk.mobile

import com.campusdesk.mobile.data.*
import com.campusdesk.mobile.domain.ApiException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class HostContractTest {
    @Test fun `Android client interoperates with real v2 handler over loopback without workers`() = runBlocking {
        val root = File(requireNotNull(System.getProperty("desk.projectRoot")))
        val process = ProcessBuilder("node", "tools/mobile-fixture-server.cjs").directory(root)
            .redirectError(File(if (System.getProperty("os.name", "").startsWith("Windows")) "NUL" else "/dev/null")).start()
        val executor = Executors.newSingleThreadExecutor()
        try {
            val line = executor.submit<String> { process.inputStream.bufferedReader().readLine() }.get(15, TimeUnit.SECONDS)
            val base = apiJson.parseToJsonElement(line).jsonObject["base"]!!.jsonPrimitive.content
            val client = ApiClient(Connection(base, "synthetic-mobile-contract-token-00000000"))
            client.health()
            val snapshot = client.snapshot()
            assertEquals(2, snapshot.suggestions.size); assertEquals(2, snapshot.tasks.size)
            client.decideSuggestion(snapshot.suggestions[0].id, true)
            client.decideSuggestion(snapshot.suggestions[1].id, false)
            assertTrue(client.snapshot().suggestions.isEmpty())
            assertEquals(1, client.snapshot().todos.size)
            val input = client.task(2)
            assertEquals("phone", input.questions.single().key)
            client.answer(2, mapOf("phone" to "合成号码"))
            assertEquals("preparing", client.task(2).state)
            val task = client.task(1)
            try { client.approve(task.copy(plan = task.plan!!.copy(digest = "stale")), "stale-req"); fail() }
            catch (error: ApiException) { assertEquals(409, error.status) }
            client.approve(task, "contract-request")
            client.approve(task, "contract-request") // 同一审批重复返回相同操作，不再入队。
            assertEquals("approved", client.task(1).state)
            client.cancel(1)
            assertEquals("cancelled", client.task(1).state)
            assertFalse(client.briefingSettings().enabled)
            client.saveBriefingSettings(BriefingSettings(true, "08:30", "UTC"))
            assertEquals("08:30", client.briefingSettings().time)
            val brief = client.generateToday()
            assertEquals(brief.id, client.generateToday().id)
            assertEquals("queued", client.briefing(brief.id).state)
            assertEquals(1, client.snapshot().briefings.size)
            try { ApiClient(Connection(base, "invalid")).snapshot(); fail() }
            catch (error: ApiException) { assertEquals(401, error.status) }
        } finally {
            process.destroy(); if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly()
            executor.shutdownNow()
        }
    }
}
