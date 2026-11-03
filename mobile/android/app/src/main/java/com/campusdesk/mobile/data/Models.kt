package com.campusdesk.mobile.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable data class Items<T>(val items: List<T> = emptyList())
@Serializable data class Source(val id: Long, val text: String? = null, @SerialName("received_at") val receivedAt: String? = null)
@Serializable data class Suggestion(
    val id: Long, val title: String, val summary: String? = null, val category: String = "other",
    val status: String = "pending", val confidence: Double? = null,
    @SerialName("source_count") val sourceCount: Int = 1,
    @SerialName("message_text") val messageText: String? = null,
    val sources: List<Source> = emptyList()
)
@Serializable data class Todo(val id: Long, val title: String, val status: String,
    @SerialName("due_at") val dueAt: String? = null, @SerialName("created_at") val createdAt: String = "")
@Serializable data class Change(val row: Int, val col: Int, val field: String, val before: String? = "", val value: String? = null)
@Serializable data class Warning(val field: String? = null, val reason: String? = null)
@Serializable data class Missing(val field: String, val header: String? = null, val reason: String? = null)
// plan 的字段来自已有 camelCase 合约；外层 API 则是 snake_case。
@Serializable data class PlanBody(val identityMode: String? = null, val identityRow: Int? = null,
    val changes: List<Change> = emptyList(), val missing: List<Missing> = emptyList(),
    val warnings: List<Warning> = emptyList(), val notes: String? = null)
@Serializable data class Plan(val id: Long, val version: Int, val digest: String, val status: String = "current", val plan: PlanBody)
@Serializable data class Question(val key: String, val label: String, val kind: String = "text", val reason: String? = null)
@Serializable data class Task(val id: Long, val state: String,
    @SerialName("state_version") val stateVersion: Int = 1,
    @SerialName("updated_at") val updatedAt: String = "",
    @SerialName("target_ref") val targetRef: String = "",
    @SerialName("current_plan_id") val currentPlanId: Long? = null,
    val plan: Plan? = null, val questions: List<Question> = emptyList())

@Serializable data class BriefingItem(val text: String, val ref: String, val url: String? = null, val source: String? = null,
    @SerialName("published_at") val publishedAt: String? = null, val headline: String? = null)
@Serializable data class FeedCoverage(val source: String, val status: String, val count: Int = 0)
@Serializable data class BriefingSection(val title: String, val items: List<BriefingItem> = emptyList())
@Serializable data class BriefingContent(val intro: String, val sections: List<BriefingSection> = emptyList(), val coverage: List<FeedCoverage> = emptyList())
@Serializable data class Briefing(val id: Long, @SerialName("local_date") val localDate: String,
    @SerialName("time_zone") val timeZone: String, val state: String, val mode: String? = null,
    val content: BriefingContent? = null, @SerialName("generated_at") val generatedAt: String? = null)
@Serializable data class BriefingSettings(val enabled: Boolean = false, val time: String = "08:00",
    @SerialName("time_zone") val timeZone: String = java.time.ZoneId.systemDefault().id)
data class Snapshot(val suggestions: List<Suggestion> = emptyList(), val tasks: List<Task> = emptyList(), val todos: List<Todo> = emptyList(),
    val briefings: List<Briefing> = emptyList(), val briefingSupported: Boolean = true)
data class Connection(val base: String = "http://127.0.0.1:9087", val token: String = "", val demo: Boolean = false) {
    // 避免意外日志或调试输出泄露访问令牌。
    override fun toString() = "Connection(redacted)"
}

interface Gateway {
    suspend fun updateTodo(id: Long, action: String)
    suspend fun health()
    suspend fun snapshot(): Snapshot
    suspend fun task(id: Long): Task
    suspend fun decideSuggestion(id: Long, accept: Boolean)
    suspend fun answer(id: Long, answers: Map<String, String>)
    suspend fun approve(task: Task, requestId: String)
    suspend fun cancel(id: Long)
    suspend fun briefing(id: Long): Briefing
    suspend fun briefingSettings(): BriefingSettings
    suspend fun saveBriefingSettings(value: BriefingSettings): BriefingSettings
    suspend fun generateToday(): Briefing
}
