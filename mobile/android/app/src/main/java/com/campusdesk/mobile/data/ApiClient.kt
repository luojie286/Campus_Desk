package com.campusdesk.mobile.data

import com.campusdesk.mobile.domain.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import kotlinx.serialization.decodeFromString
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

val apiJson = Json { ignoreUnknownKeys = true; coerceInputValues = true }

class ApiClient(connection: Connection, private val client: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(8, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).callTimeout(25, TimeUnit.SECONDS)
    .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()) : Gateway {
    private val base = connectionBase(connection.base)
    private val token = connection.token
    // USB 转发下空闲连接可能已被主机关闭；只读请求允许重新建连。
    // 修改请求沿用 retryOnConnectionFailure=false，不能因网络结果未知而重发审批。
    private val readClient = client.newBuilder().retryOnConnectionFailure(true).build()
    private suspend fun request(path: String, body: JsonObject? = null, authenticated: Boolean = true, method: String = "POST"): String = withContext(Dispatchers.IO) {
        if (authenticated && token.isBlank()) throw ApiException(401, "token_missing")
        val builder = Request.Builder().url(base + path)
        if (authenticated) builder.header("Authorization", "Bearer $token")
        if (body != null) builder.method(method, body.toString().toRequestBody("application/json".toMediaType()))
        (if (body == null) readClient else client).newCall(builder.build()).execute().use { response ->
            if (!response.isSuccessful) throw ApiException(response.code)
            val source = response.body ?: throw ApiException(502)
            // 响应尺寸设上限，避免异常后端响应耗尽手机内存。
            val output = java.io.ByteArrayOutputStream()
            val input = source.byteStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size() + count > 4 * 1024 * 1024) throw ApiException(502, "response_too_large")
                output.write(buffer, 0, count)
            }
            val bytes = output.toByteArray()
            bytes.toString(Charsets.UTF_8)
        }
    }
    override suspend fun health() {
        val health = apiJson.parseToJsonElement(request("/health", authenticated = false)).jsonObject
        if (health["running"]?.jsonPrimitive?.booleanOrNull != true) throw ApiException(503)
        request("/v1/tasks?limit=1") // 额外验证令牌，不能把 health 成功当成认证成功。
    }
    suspend fun pair(code: String, name: String): PairingResult {
        require(Regex("^[A-Za-z0-9_-]{43}$").matches(code) && name.isNotBlank() && name.length <= 80) { "请检查配对邀请与设备名称" }
        // 兑换是一次性操作，使用不自动重发的修改请求客户端。这里不发送现有主令牌。
        val result = apiJson.decodeFromString<PairingResult>(request("/v1/device-pairings",
            buildJsonObject { put("code", code); put("name", name) }, authenticated = false))
        require(Regex("^[A-Za-z0-9_-]{43}$").matches(result.token) && result.deviceId.isNotBlank()) { "配对响应无效，请在主机重新生成邀请" }
        return result
    }
    override suspend fun snapshot(): Snapshot {
        val suggestions = apiJson.decodeFromString<Items<Suggestion>>(request("/v1/suggestions?status=pending&limit=100")).items
        val tasks = apiJson.decodeFromString<Items<Task>>(request("/v1/tasks?limit=200")).items
        val todos = apiJson.decodeFromString<Items<Todo>>(request("/v1/todos")).items
        var supported = true
        val briefings = try { apiJson.decodeFromString<Items<Briefing>>(request("/v1/briefings")).items }
        catch (error: ApiException) { if (error.status in listOf(404, 503)) { supported = false; emptyList() } else throw error }
        return Snapshot(suggestions, tasks, todos, briefings, supported)
    }
    override suspend fun task(id: Long): Task = apiJson.decodeFromString(request("/v1/tasks/$id"))
    override suspend fun decideSuggestion(id: Long, accept: Boolean) { request("/v1/suggestions/$id/${if (accept) "accept" else "dismiss"}", buildJsonObject {}) }
    override suspend fun answer(id: Long, answers: Map<String, String>) {
        request("/v1/tasks/$id/answers", buildJsonObject {
            put("answers", buildJsonArray { answers.forEach { (key, value) -> add(buildJsonObject { put("key", key); put("value", value) }) } })
        })
    }
    override suspend fun approve(task: Task, requestId: String) {
        require(approvalBlock(task) == null) { approvalBlock(task) ?: "无法批准" }
        val plan = requireNotNull(task.plan)
        request("/v1/tasks/${task.id}/approvals", buildJsonObject {
            put("plan_id", plan.id); put("plan_version", plan.version); put("plan_digest", plan.digest); put("client_request_id", requestId)
        })
    }
    override suspend fun cancel(id: Long) { request("/v1/tasks/$id/cancel", buildJsonObject {}) }
    override suspend fun briefing(id: Long): Briefing = apiJson.decodeFromString(request("/v1/briefings/$id"))
    override suspend fun briefingSettings(): BriefingSettings = apiJson.decodeFromString(request("/v1/briefing-settings"))
    override suspend fun saveBriefingSettings(value: BriefingSettings): BriefingSettings = apiJson.decodeFromString(
        request("/v1/briefing-settings", buildJsonObject { put("enabled", value.enabled); put("time", value.time); put("time_zone", value.timeZone) }, method = "PUT"))
    override suspend fun generateToday(): Briefing = apiJson.decodeFromString(request("/v1/briefings/today", buildJsonObject {}))
}
