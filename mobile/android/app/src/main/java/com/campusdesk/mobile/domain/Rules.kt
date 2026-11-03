package com.campusdesk.mobile.domain

import com.campusdesk.mobile.data.*
import java.net.URI
import java.security.MessageDigest
import kotlinx.serialization.Serializable

class ApiException(val status: Int, val code: String = "request_failed") : Exception("API request failed ($status)")

fun connectionBase(raw: String): String {
    val uri = try { URI(raw.trim()) } catch (_: Exception) { throw IllegalArgumentException("请输入有效的服务地址") }
    require(uri.scheme in listOf("http", "https") && !uri.host.isNullOrBlank() && uri.rawUserInfo == null &&
        uri.rawQuery == null && uri.rawFragment == null && (uri.port == -1 || uri.port in 1..65535) &&
        (uri.path.isNullOrEmpty() || uri.path == "/")) { "地址应为 http(s)://主机:端口，不含路径或账号" }
    return uri.toASCIIString().trimEnd('/')
}

fun Connection.fingerprint(): String = MessageDigest.getInstance("SHA-256")
    .digest((base + "\n" + token + "\n" + demo).toByteArray()).joinToString("") { "%02x".format(it) }

fun approvalBlock(task: Task): String? = when {
    task.state != "awaiting_approval" -> "任务状态已变化，请刷新后核对"
    task.plan == null -> "尚未获得填写计划"
    task.plan.status != "current" || task.currentPlanId != task.plan.id -> "计划已经过期，请刷新"
    task.plan.digest.isBlank() || task.plan.version < 1 -> "计划校验信息不完整"
    task.plan.plan.warnings.isNotEmpty() -> "计划包含警告，请先在电脑端处理"
    task.plan.plan.missing.isNotEmpty() -> "资料尚未补全"
    task.plan.plan.changes.isEmpty() -> "没有需要写入的内容"
    task.plan.plan.changes.any { it.value.isNullOrBlank() || it.row < 1 || it.col < 1 || Regex("^[=+\\-@]").containsMatchIn(it.value) } -> "填写值需要人工处理"
    else -> null
}
fun errorText(error: Throwable): String = when (error) {
    is ApiException -> when (error.status) {
        401, 403 -> "认证失败，请到设置检查访问令牌与账号权限"
        404 -> "内容已不存在，请刷新列表"
        409 -> "任务状态或计划已变化，请刷新核对；若操作已生效，无需重复提交"
        else -> "服务暂时无法处理请求（${error.status}），请稍后刷新"
    }
    is IllegalArgumentException -> error.message ?: "请检查输入"
    else -> "连接中断或响应异常，请检查主机和 Tailscale / USB 连接；操作结果请刷新后核对"
}
fun cellAddress(col: Int, row: Int): String {
    var n = col; var label = ""
    while (n > 0) { n--; label = ('A' + n % 26) + label; n /= 26 }
    return label + row
}
fun stateLabel(state: String): String = mapOf(
    "created" to "已创建", "preparing" to "准备计划中", "awaiting_input" to "需要补充资料",
    "awaiting_approval" to "等待核对", "approved" to "已批准，等待执行", "executing" to "主机填写中",
    "verifying" to "主机回读中", "completed" to "已完成", "cancelled" to "已取消",
    "outcome_unknown" to "结果待电脑端核对", "paused_login_required" to "请在电脑端登录文档",
    "failed_retryable" to "请在电脑端恢复", "failed_terminal" to "处理失败"
)[state] ?: state

@Serializable data class SeenState(val initialized: Boolean = false, val suggestions: Set<Long> = emptySet(), val activeApprovals: Set<Long> = emptySet(), val briefings: Set<Long> = emptySet())
data class Notice(val kind: String, val id: Long)
data class NotificationBatch(val next: SeenState, val notices: List<Notice>)

// 只在首次进入待审批时提醒；版本变化不重复提醒，离开后重新进入可以再次提醒。
fun planNotifications(previous: SeenState, snapshot: Snapshot, notifyExisting: Boolean, now: java.time.Instant = java.time.Instant.now()): NotificationBatch {
    val candidates = snapshot.suggestions.filter { it.status == "pending" }.map { it.id }.toSet()
    val approvals = snapshot.tasks.filter { it.state == "awaiting_approval" }.map { it.id }.toSet()
    val baseNotices = if (!previous.initialized && !notifyExisting) emptyList() else
        (candidates - previous.suggestions).map { Notice("suggestion", it) } +
        (approvals - previous.activeApprovals).map { Notice("task", it) }
    val readyBriefings = snapshot.briefings.filter { it.state == "ready" }
    val today = readyBriefings.filter { brief ->
        try { brief.localDate == now.atZone(java.time.ZoneId.of(brief.timeZone)).toLocalDate().toString() }
        catch (_: Exception) { false }
    }
    val notices = baseNotices + today.filter { it.id !in previous.briefings }.map { Notice("briefing", it.id) }
    return NotificationBatch(SeenState(true, (previous.suggestions + candidates).takeLastIds(2000), approvals,
        (previous.briefings + readyBriefings.map { it.id }).takeLastIds(1000)), notices)
}
private fun Set<Long>.takeLastIds(limit: Int) = sortedDescending().take(limit).toSet()
fun retryDelayMillis(failures: Int): Long = (25_000L * (1L shl failures.coerceIn(0, 5))).coerceAtMost(600_000L)
