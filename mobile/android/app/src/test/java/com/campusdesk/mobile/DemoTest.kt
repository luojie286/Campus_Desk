package com.campusdesk.mobile
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class DemoTest {
    @Test fun `demo decisions change only the demo instance`() = runBlocking {
        val gateway = DemoGateway()
        val before = gateway.snapshot()
        gateway.decideSuggestion(before.suggestions.first().id, true)
        assertTrue(gateway.snapshot().suggestions.isEmpty())
        assertEquals(before.todos.size + 1, gateway.snapshot().todos.size)
        assertFalse(DemoGateway().snapshot().suggestions.isEmpty())
    }
    @Test fun `demo answer prepares approval and approval completes task`() = runBlocking {
        val gateway = DemoGateway()
        gateway.answer(202, mapOf("phone" to "示例号码"))
        val task = gateway.task(202)
        assertEquals("awaiting_approval", task.state)
        assertEquals("示例号码", task.plan!!.plan.changes.single().value)
        gateway.approve(task, "req")
        assertEquals("completed", gateway.task(202).state)
    }
    @Test fun `demo cancellation is visible in task history`() = runBlocking {
        val gateway = DemoGateway(); gateway.cancel(201)
        assertEquals("cancelled", gateway.task(201).state)
    }
}
