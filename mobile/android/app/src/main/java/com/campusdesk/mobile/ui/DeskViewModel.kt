package com.campusdesk.mobile.ui

import android.app.Application
import android.content.Intent
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.campusdesk.mobile.DeskApplication
import com.campusdesk.mobile.data.*
import com.campusdesk.mobile.domain.*
import com.campusdesk.mobile.sync.ApprovalSyncService
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import java.util.UUID

data class ScreenState(val snapshot: Snapshot = Snapshot(), val settings: Settings = Settings(),
    val privateNetwork: TailnetState = TailnetState(),
    val tokenStored: Boolean = false, val loading: Boolean = false, val acting: Boolean = false,
    val message: String? = null, val task: Task? = null, val suggestion: Suggestion? = null,
    val briefing: Briefing? = null, val briefingSettings: BriefingSettings? = null,
    val tab: Int = 0, val ready: Boolean = false)

class DeskViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as DeskApplication).container
    private val mutable = MutableStateFlow(ScreenState())
    val state = mutable.asStateFlow()
    private val refreshLock = Mutex()
    private var generation = 0
    init {
        viewModelScope.launch { initialize() }
        viewModelScope.launch { container.privateNetwork.state.collect { value -> mutable.update { it.copy(privateNetwork = value) } } }
    }
    fun startPrivateNetwork() = action { withContext(Dispatchers.IO) { container.privateNetwork.start() } }
    fun stopPrivateNetwork() = action {
        stopSyncNow()
        withContext(Dispatchers.IO) { container.privateNetwork.stop() }
    }
    private suspend fun initialize() {
        try {
            val interrupted = container.settings.recoverStoppedSync(com.campusdesk.mobile.sync.SyncRuntime.running)
            val settings = container.settings.read()
            val stored = withContext(Dispatchers.IO) { container.vault.read().isNotBlank() }
            mutable.update { it.copy(settings = settings, tokenStored = stored, ready = true,
                message = if (interrupted) "后台同步已中断，请到设置重新开启，并检查手机的后台运行限制" else it.message) }
            refreshNow()
        } catch (error: Exception) {
            mutable.update { it.copy(ready = true, tab = 3, message = "无法读取加密设置，请重新保存或清除令牌") }
        }
    }
    fun tab(index: Int) { mutable.update { it.copy(tab = index, task = null, suggestion = null, briefing = null, briefingSettings = null) } }
    fun dismissMessage() { mutable.update { it.copy(message = null) } }
    fun showMessage(text: String) { mutable.update { it.copy(message = text) } }
    fun back() { mutable.update { it.copy(task = null, suggestion = null, briefing = null, briefingSettings = null) } }
    fun refresh() { viewModelScope.launch { refreshNow() } }
    suspend fun refreshNow() {
        if (!mutable.value.ready || !refreshLock.tryLock()) return
        val epoch = generation
        mutable.update { it.copy(loading = true) }
        try {
            val settings = container.settings.read()
            if (!settings.demo && !mutable.value.tokenStored) {
                mutable.update { it.copy(settings = settings, snapshot = Snapshot(), message = "请先到设置填写主机地址和访问令牌") }
                return
            }
            val gateway = container.gateway()
            val snapshot = gateway.snapshot()
            val detail = mutable.value.task?.let { gateway.task(it.id) }
            val briefingDetail = mutable.value.briefing?.let { gateway.briefing(it.id) }
            if (epoch == generation) mutable.update { it.copy(snapshot = snapshot, task = detail, briefing = briefingDetail, settings = settings) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (epoch == generation) mutable.update {
                if (error is ApiException && error.status in listOf(401, 403))
                    it.copy(message = errorText(error), tab = 3, snapshot = Snapshot(), task = null, suggestion = null, briefing = null)
                else it.copy(message = errorText(error))
            }
        } finally { mutable.update { it.copy(loading = false) }; refreshLock.unlock() }
    }
    fun openSuggestion(id: Long) {
        val suggestion = mutable.value.snapshot.suggestions.find { it.id == id }
        mutable.update { it.copy(tab = 0, task = null, suggestion = suggestion, briefing = null,
            message = if (suggestion == null) "候选已处理或不在当前列表，请刷新" else null) }
    }
    fun openTask(id: Long) = action {
        val detail = container.gateway().task(id)
        mutable.update { it.copy(tab = 0, task = detail, suggestion = null, briefing = null) }
    }
    fun openNotification(kind: String, id: Long) = action {
        val gateway = container.gateway()
        if (kind == "briefing") {
            val detail = gateway.briefing(id)
            mutable.update { it.copy(tab = 1, briefing = detail, task = null, suggestion = null) }
        } else if (kind == "task") {
            val detail = gateway.task(id)
            mutable.update { it.copy(tab = 0, task = detail, suggestion = null, briefing = null) }
        } else if (kind == "suggestion") {
            val snapshot = gateway.snapshot()
            mutable.update { it.copy(snapshot = snapshot) }
            openSuggestion(id)
        }
    }
    fun openBriefing(id: Long) = action {
        val detail = container.gateway().briefing(id)
        mutable.update { it.copy(tab = 1, briefing = detail, task = null, suggestion = null) }
    }
    fun loadBriefingSettings() = action {
        val settings = container.gateway().briefingSettings()
        mutable.update { it.copy(briefingSettings = settings) }
    }
    fun closeBriefingSettings() { mutable.update { it.copy(briefingSettings = null) } }
    fun saveBriefingSettings(value: BriefingSettings) = action {
        require(Regex("^([01]\\d|2[0-3]):[0-5]\\d$").matches(value.time)) { "请输入 24 小时制时间，例如 08:00" }
        try { java.time.ZoneId.of(value.timeZone) } catch (_: Exception) { throw IllegalArgumentException("时区无效，例如 Asia/Shanghai") }
        container.gateway().saveBriefingSettings(value)
        mutable.update { it.copy(briefingSettings = null, message = "早报时间与开关已保存到主机") }
    }
    fun generateBriefing() = action {
        val report = container.gateway().generateToday()
        mutable.update { it.copy(message = if (report.state == "ready") "今日早报已存在，可直接阅读" else "已请求生成，主机完成后会出现在列表中") }
        refreshNow()
    }
    fun decide(id: Long, accept: Boolean) = action {
        container.gateway().decideSuggestion(id, accept)
        mutable.update { it.copy(suggestion = null, message = if (accept) "已保留为待办" else "已忽略") }
        refreshNow()
    }
    fun updateTodo(todo: Todo, operation: String) = action {
        container.gateway().updateTodo(todo.id, operation)
        mutable.update { it.copy(message = when(operation) { "delete" -> "待办已删除"; "complete" -> "待办已完成"; else -> "已恢复为待办" }) }
        refreshNow()
    }
    fun answer(task: Task, answers: Map<String, String>) = action {
        require(task.questions.all { !answers[it.key].isNullOrBlank() && answers[it.key]!!.length <= 500 }) { "请填写所有问题，每项不超过 500 字" }
        container.gateway().answer(task.id, answers)
        mutable.update { it.copy(task = null, message = "资料已提交，主机将重新准备计划，仍需你审批") }
        refreshNow()
    }
    fun approve(task: Task) = action {
        // 对话框确认的是这份计划；版本摘要与请求一起提交，禁止自动批准新版本。
        container.gateway().approve(task, UUID.randomUUID().toString())
        mutable.update { it.copy(message = if (it.settings.demo) "演示任务已完成（未写入真实表格）" else "已批准，主机将执行并回读，请关注任务状态") }
        refreshNow()
    }
    fun cancel(task: Task) = action { container.gateway().cancel(task.id); back(); refreshNow() }
    fun testConnection() = action { container.gateway().health(); mutable.update { it.copy(message = "连接与访问令牌验证通过") } }
    fun save(base: String, token: String, demo: Boolean, notifyExisting: Boolean) = action {
        val normalized = connectionBase(base)
        require(token.isBlank() || token.trim().length >= 32) { "访问令牌长度不足，请复制完整令牌" }
        require(demo || token.isNotBlank() || mutable.value.tokenStored) { "请填写访问令牌，或先启用演示模式" }
        persistConnection(normalized, token, demo, notifyExisting)
    }
    fun pair(invitation: String, name: String) = action {
        val invite = parsePairingInvitation(invitation)
        val result = container.apiClient(Connection(invite.base)).pair(invite.code, name.trim())
        persistConnection(invite.base, result.token, false, mutable.value.settings.notifyExisting)
        mutable.update { it.copy(message = "私网配对已保存，请测试连接后开启后台同步") }
    }
    private suspend fun persistConnection(normalized: String, token: String, demo: Boolean, notifyExisting: Boolean) {
        stopSyncNow()
        androidx.core.app.NotificationManagerCompat.from(getApplication()).cancelAll()
        generation++
        if (token.isNotBlank()) withContext(Dispatchers.IO) { container.vault.save(token.trim()) }
        val settings = Settings(normalized, demo, notifyExisting)
        container.settings.save(settings)
        val stored = withContext(Dispatchers.IO) { container.vault.read().isNotBlank() }
        mutable.update { ScreenState(settings = settings, privateNetwork = container.privateNetwork.state.value, tokenStored = stored, ready = true, acting = true, tab = 3, message = "设置已保存") }
        refreshNow()
    }
    fun clear() = action {
        stopSyncNow(); generation++
        androidx.core.app.NotificationManagerCompat.from(getApplication()).cancelAll()
        withContext(Dispatchers.IO) { container.vault.clear() }
        container.settings.clear()
        mutable.update { ScreenState(settings = Settings(demo = false), privateNetwork = container.privateNetwork.state.value, ready = true, tab = 3, acting = true, message = "令牌和本地同步记录已清除") }
        container.settings.save(Settings(demo = false))
    }
    fun stopSync() {
        viewModelScope.launch { stopSyncNow() }
    }
    private suspend fun stopSyncNow() {
        getApplication<Application>().stopService(Intent(getApplication(), ApprovalSyncService::class.java))
        container.settings.sync(false, "同步已停止")
        val settings = container.settings.read()
        mutable.update { it.copy(settings = settings) }
    }
    private fun action(block: suspend () -> Unit) {
        if (mutable.value.acting) return
        mutable.update { it.copy(acting = true, message = null) }
        viewModelScope.launch {
            try { block() }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                mutable.update {
                    if (error is ApiException && error.status in listOf(401, 403))
                        it.copy(message = errorText(error), tab = 3, snapshot = Snapshot(), task = null, suggestion = null, briefing = null)
                    else it.copy(message = errorText(error))
                }
                // 修改请求异常不自动重试；只刷新服务端最新状态。
                if (error is ApiException && error.status == 409) {
                    val text = errorText(error); refreshNow(); mutable.update { it.copy(message = text) }
                }
            } finally { mutable.update { it.copy(acting = false) } }
        }
    }
}
