package com.campusdesk.mobile

import com.campusdesk.mobile.data.*
import com.campusdesk.mobile.domain.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class ApiClientTest {
    private val server = MockWebServer().apply { start() }
    private val token = "test-only-token-not-a-real-secret"
    private fun client(value: String = token) = ApiClient(Connection(server.url("/").toString(), value))
    private fun respond(body: String, status: Int = 200) { server.enqueue(MockResponse().setResponseCode(status).setBody(body)) }
    @After fun close() { server.shutdown() }
    @Test fun `DTO accepts null fields extra backend keys and camel case plan`() {
        val task = apiJson.decodeFromString<Task>("""{"id":7,"state":"awaiting_approval","state_version":3,"current_plan_id":8,"metadata":{},"plan":{"id":8,"version":2,"digest":"abc","plan":{"identityMode":"student_id_only","identityRow":3,"changes":[{"row":3,"col":1,"field":"name","before":"","value":"示例"}],"notes":null}},"questions":[],"answers":[],"latest_operation":null}""")
        assertEquals("student_id_only", task.plan!!.plan.identityMode)
        assertEquals(3, task.stateVersion)
        val suggestion = apiJson.decodeFromString<Suggestion>("""{"id":1,"title":"测试","summary":null,"confidence":null,"source_count":2,"sources":[{"id":2,"text":null,"sender_id":"demo"}]}""")
        assertEquals(2, suggestion.sourceCount); assertNull(suggestion.sources[0].text)
    }
    @Test fun `health also checks authenticated endpoint`() = runBlocking {
        respond("""{"running":true}"""); respond("""{"items":[]}""")
        client().health()
        assertNull(server.takeRequest().getHeader("Authorization"))
        val authenticated = server.takeRequest()
        assertEquals("Bearer $token", authenticated.getHeader("Authorization"))
        assertEquals("/v1/tasks?limit=1", authenticated.path)
    }
    @Test fun `health cannot succeed with invalid token`() = runBlocking {
        respond("""{"running":true}"""); respond("{}", 401)
        try { client().health(); fail() } catch (error: ApiException) { assertEquals(401, error.status) }
    }
    @Test fun `snapshot maps three real API envelopes`() = runBlocking {
        respond("""{"items":[{"id":1,"title":"候选","status":"pending"}]}""")
        respond("""{"items":[{"id":2,"state":"awaiting_input"}]}""")
        respond("""{"items":[{"id":3,"title":"待办","status":"open","due_at":null}]}""")
        respond("""{"items":[]}""")
        val snapshot = client().snapshot()
        assertEquals(1L, snapshot.suggestions.single().id); assertEquals(2L, snapshot.tasks.single().id); assertEquals(3L, snapshot.todos.single().id)
    }
    @Test fun `approval sends exact reviewed plan version digest and request key`() = runBlocking {
        respond("{}")
        val task = Task(7, "awaiting_approval", currentPlanId = 8,
            plan = Plan(8, 2, "reviewed-digest", plan = PlanBody(changes = listOf(Change(3, 4, "age", "", "19")))))
        client().approve(task, "stable-client-request")
        val req = server.takeRequest(); val body = apiJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("/v1/tasks/7/approvals", req.path)
        assertEquals(8, body["plan_id"]!!.jsonPrimitive.int); assertEquals(2, body["plan_version"]!!.jsonPrimitive.int)
        assertEquals("reviewed-digest", body["plan_digest"]!!.jsonPrimitive.content)
        assertEquals("stable-client-request", body["client_request_id"]!!.jsonPrimitive.content)
        assertFalse(body.containsKey("value"))
    }
    @Test fun `unsafe approval is blocked before sending HTTP`() = runBlocking {
        val task = Task(7, "awaiting_approval")
        try { client().approve(task, "req"); fail() } catch (_: IllegalArgumentException) { }
        assertEquals(0, server.requestCount)
    }
    @Test fun `409 is propagated without automatic retry`() = runBlocking {
        respond("{}", 409)
        try { client().cancel(7); fail() } catch (error: ApiException) { assertEquals(409, error.status) }
        assertEquals(1, server.requestCount)
    }
    @Test fun `redirect is rejected and bearer token is never forwarded`() = runBlocking {
        MockWebServer().use { other ->
            other.start(); server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", other.url("/steal")))
            try { client().cancel(7); fail() } catch (error: ApiException) { assertEquals(302, error.status) }
            assertEquals(0, other.requestCount)
        }
    }
    @Test fun `missing token fails locally`() = runBlocking {
        try { client("").task(1); fail() } catch (error: ApiException) { assertEquals(401, error.status) }
        assertEquals(0, server.requestCount)
    }
    @Test fun `answers and suggestion decisions use expected API shape`() = runBlocking {
        repeat(3) { respond("{}") }
        val client = client()
        client.answer(7, mapOf("phone" to "示例号码"))
        val answer = server.takeRequest()
        assertEquals("/v1/tasks/7/answers", answer.path)
        val body = apiJson.parseToJsonElement(answer.body.readUtf8()).jsonObject
        assertEquals("phone", body["answers"]!!.jsonArray.single().jsonObject["key"]!!.jsonPrimitive.content)
        client.decideSuggestion(9, true); assertEquals("/v1/suggestions/9/accept", server.takeRequest().path)
        client.decideSuggestion(10, false); assertEquals("/v1/suggestions/10/dismiss", server.takeRequest().path)
    }
    @Test fun `oversized response is rejected`() = runBlocking {
        respond("x".repeat(4 * 1024 * 1024 + 1))
        try { client().task(1); fail() } catch (error: ApiException) { assertEquals("response_too_large", error.code) }
    }
    @Test fun `malformed JSON is not silently accepted`() = runBlocking {
        respond("not-json")
        try { client().task(1); fail() } catch (_: kotlinx.serialization.SerializationException) { }
    }
    @Test fun `read reconnects when a reused socket closes unexpectedly`() = runBlocking {
        val client = client()
        val body = """{"id":7,"state":"completed"}"""
        respond(body); client.task(7)
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        respond(body)
        assertEquals(7L, client.task(7).id)
        assertEquals(3, server.requestCount)
    }
    @Test fun `mutation on a broken reused socket is not automatically resent`() = runBlocking {
        val client = client()
        respond("""{"id":7,"state":"completed"}"""); client.task(7)
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        respond("{}")
        try { client.cancel(7); fail() } catch (_: java.io.IOException) { }
        assertEquals(2, server.requestCount)
    }
}
