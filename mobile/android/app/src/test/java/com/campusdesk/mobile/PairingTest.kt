package com.campusdesk.mobile

import com.campusdesk.mobile.data.*
import com.campusdesk.mobile.domain.ApiException
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class PairingTest {
    private val code = "a".repeat(43)
    private val now = Instant.parse("2026-11-03T00:00:00Z")
    private fun invitation(base: String = "https://desk.example.ts.net", expires: String = "2026-11-03T00:05:00Z") =
        """{"version":1,"base":"$base","code":"$code","expires_at":"$expires"}"""
    @Test fun `valid invitation is normalized without exposing code in log output`() {
        val value = parsePairingInvitation(invitation("https://desk.example.ts.net/"), now)
        assertEquals("https://desk.example.ts.net", value.base); assertEquals(code, value.code)
        assertFalse(value.toString().contains(code))
    }
    @Test fun `pairing rejects unsafe origins expired invitations and malformed data`() {
        for (base in listOf("http://desk.example.ts.net", "https://example.com", "https://desk.ts.net.evil.invalid", "https://a@desk.ts.net", "https://desk.ts.net:8443", "https://desk.ts.net/path", "https://desk.ts.net?code=secret")) {
            try { parsePairingInvitation(invitation(base), now); fail(base) } catch (_: IllegalArgumentException) { }
        }
        for (raw in listOf("$code broken", invitation(expires = "2026-11-03T00:00:00Z"), invitation().replace(code, "short"), "x".repeat(4097))) {
            try { parsePairingInvitation(raw, now); fail() } catch (error: IllegalArgumentException) { assertFalse(error.message!!.contains(code)) }
        }
    }
    @Test fun `exchange uses a single unauthenticated POST and parses device credential`() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setResponseCode(201).setBody("""{"device_id":"device-test","token":"${"b".repeat(43)}","expires_at":"2027-02-01T00:00:00Z","scopes":"mobile:read,mobile:act"}"""))
            val result = ApiClient(Connection(server.url("/").toString(), "old-owner-token")).pair(code, "测试手机")
            val request = server.takeRequest()
            assertEquals("POST", request.method); assertEquals("/v1/device-pairings", request.path)
            assertNull(request.getHeader("Authorization")); assertTrue(request.body.readUtf8().contains(code))
            assertEquals("device-test", result.deviceId); assertFalse(result.toString().contains(result.token))
        }
    }
    @Test fun `pairing failures and redirects are never retried`() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setResponseCode(401))
            val api = ApiClient(Connection(server.url("/").toString()))
            try { api.pair(code, "手机"); fail() } catch (error: ApiException) { assertEquals(401, error.status) }
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", server.url("/other")))
            try { api.pair(code, "手机"); fail() } catch (error: ApiException) { assertEquals(302, error.status) }
            assertEquals(2, server.requestCount)
        }
    }
}
