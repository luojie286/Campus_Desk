package com.campusdesk.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalUriHandler
import com.campusdesk.mobile.BuildConfig
import com.campusdesk.mobile.data.*
import com.campusdesk.mobile.domain.*

private val green = Color(0xFF317D69)
private val scheme = lightColorScheme(primary = green, secondary = Color(0xFF52776C),
    primaryContainer = Color(0xFFDCEFE4), secondaryContainer = Color(0xFFE1EDE5),
    surfaceContainer = Color(0xFFF2F5F0), surfaceContainerHighest = Color(0xFFE7EDE5),
    background = Color(0xFFF7F8F4), surface = Color(0xFFFFFFFF), surfaceVariant = Color(0xFFEDF2EC))

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun DeskApp(state: ScreenState, model: DeskViewModel, onStartSync: () -> Unit) {
    MaterialTheme(colorScheme = scheme) {
        val detail = state.task != null || state.suggestion != null || state.briefing != null || state.briefingSettings != null
        BackHandler(detail) { model.back() }
        Scaffold(
            topBar = { TopAppBar(title = { Column {
                Text(if (state.briefingSettings != null) "早报设置" else if (state.briefing != null) "早报详情" else if (detail) "核对详情" else listOf("待处理", "技术早报", "我的待办", "连接与通知")[state.tab], fontWeight = FontWeight.Bold)
                Text(if (state.settings.demo) "课桌 · 离线演示" else "课桌 · 由你确认，再行动", style = MaterialTheme.typography.labelMedium, color = green)
            } }, navigationIcon = { if (detail) TextButton(onClick = model::back) { Text("返回") } },
                actions = { TextButton(onClick = model::refresh, enabled = !state.loading && !state.acting) { Text("刷新") } }) },
            bottomBar = { NavigationBar { listOf("待处理", "早报", "待办", "设置").forEachIndexed { index, title ->
                NavigationBarItem(selected = state.tab == index, onClick = { model.tab(index) },
                    icon = { Text(listOf("◉", "☀", "▤", "⚙")[index]) }, label = { Text(title) })
            } } }
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                if (state.loading || state.acting) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (state.settings.demo) Banner("演示模式 · 操作仅改变本机示例，不会填写真实表格")
                state.message?.let { text ->
                    Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                            TextButton(onClick = model::dismissMessage) { Text("收起") }
                        }
                    }
                }
                when {
                    !state.ready -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    state.briefingSettings != null -> BriefingSettingsScreen(state.briefingSettings, state.acting, model)
                    state.task != null -> TaskDetails(state.task, state.acting, state.settings.demo, model)
                    state.suggestion != null -> SuggestionDetails(state.suggestion, state.acting, model)
                    state.briefing != null -> BriefingDetails(state.briefing)
                    state.tab == 0 -> PullToRefreshBox(isRefreshing = state.loading, onRefresh = model::refresh) { Inbox(state, model) }
                    state.tab == 1 -> PullToRefreshBox(isRefreshing = state.loading, onRefresh = model::refresh) { BriefingsScreen(state, model) }
                    state.tab == 2 -> PullToRefreshBox(isRefreshing = state.loading, onRefresh = model::refresh) { Todos(state.snapshot.todos) }
                    else -> SettingsScreen(state, model, onStartSync)
                }
            }
        }
    }
}

@Composable private fun BriefingsScreen(state: ScreenState, model: DeskViewModel) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item { Section("技术在变，早上读一点", "新技术进展 · 科研与行业动态 · 重大事件") }
        item { Text("从公开订阅源整理最近 48 小时资讯，每条保留来源与发布时间。定时开关、时间与时区保存在主机。", style = MaterialTheme.typography.bodySmall) }
        if (!state.snapshot.briefingSupported) item { Empty("当前主机尚未提供早报功能，请更新并重启后台。原有待办与审批仍可使用。") }
        else {
            item { Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(onClick = model::generateBriefing, enabled = !state.acting) { Text("生成今日早报") }
                OutlinedButton(onClick = model::loadBriefingSettings, enabled = !state.acting) { Text("定时设置") }
            } }
            if (state.snapshot.briefings.isEmpty()) item { Empty("还没有早报。可以先生成今日早报，或在定时设置中开启每天生成。") }
            items(state.snapshot.briefings, key = { it.id }) { brief ->
                OutlinedCard(onClick = { model.openBriefing(brief.id) }, modifier = Modifier.fillMaxWidth(), enabled = !state.acting) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("${brief.localDate} 早报", style = MaterialTheme.typography.titleMedium)
                        Text(if (brief.state == "ready") { if (brief.mode == "ai") "AI 已整理" else "规则早报 · AI 暂未参与" } else if (brief.state == "generating") "正在生成" else "排队或等待重试", color = green)
                        brief.content?.let { Text(it.intro, maxLines = 3, style = MaterialTheme.typography.bodyMedium) }
                    }
                }
            }
        }
    }
}
@Composable private fun BriefingDetails(brief: Briefing) {
    val uriHandler = LocalUriHandler.current
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("${brief.localDate} · 每日早报", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("${if (brief.mode == "ai") "公开订阅源 · AI 中文整理" else "公开订阅源 · 标题索引"} · ${brief.timeZone}", color = green)
        if (brief.state != "ready") Empty("主机仍在生成或等待重试，请返回列表稍后刷新。")
        brief.content?.let { content ->
            Text(content.intro)
            content.sections.forEach { section ->
                Section(section.title)
                section.items.forEach { item ->
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(item.text)
                            Text("${item.source ?: "演示来源"}${item.publishedAt?.let { " · " + it.replace('T', ' ').take(16) + " UTC" } ?: ""}", color = green, style = MaterialTheme.typography.labelSmall)
                            item.url?.let { url ->
                                if (url.startsWith("https://")) TextButton(onClick = { runCatching { uriHandler.openUri(url) } }) { Text("阅读原文") }
                            }
                        }
                    }
                }
            }
            if (content.coverage.isNotEmpty()) {
                Section("本次资讯覆盖")
                content.coverage.forEach { feed -> Text("${feed.source}：${when (feed.status) { "ok" -> "获得 ${feed.count} 条近期资讯"; "no_recent_items" -> "未发现窗口内条目"; else -> "抓取不可用" }}", style = MaterialTheme.typography.bodySmall) }
            }
            Text("内容基于订阅标题与摘要，未抓取全文；技术分析可能不完整，请打开原文核对。部分源失败时不代表没有重大事件。", style = MaterialTheme.typography.bodySmall)
        }
    }
}
@Composable private fun BriefingSettingsScreen(value: BriefingSettings, busy: Boolean, model: DeskViewModel) {
    var enabled by remember(value) { mutableStateOf(value.enabled) }
    var time by remember(value) { mutableStateOf(value.time) }
    var zone by remember(value) { mutableStateOf(value.timeZone) }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Section("每天一份技术早报", "设置会保存到主机，未开启时仍可手动生成")
            SettingSwitch("每天自动生成", "需要电脑后台保持运行", enabled) { enabled = it }
            OutlinedTextField(time, { time = it }, label = { Text("时间，例如 08:00") }, singleLine = true)
            OutlinedTextField(zone, { zone = it }, label = { Text("时区，例如 Asia/Shanghai") }, singleLine = true)
            TextButton(onClick = { zone = java.time.ZoneId.systemDefault().id }) { Text("使用手机时区") }
            Text("服务当天晚启动会补生成；当前手机仍需 USB 连接与同步通知，暂不能保证远程准点送达。", style = MaterialTheme.typography.bodySmall)
            Button(onClick = { model.saveBriefingSettings(BriefingSettings(enabled, time, zone)) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("保存到主机") }
            TextButton(onClick = model::closeBriefingSettings) { Text("取消修改") }
        }
}

@Composable private fun Banner(text: String) {
    Text(text, Modifier.fillMaxWidth().background(Color(0xFFE7F2E8)).padding(horizontal = 20.dp, vertical = 10.dp),
        style = MaterialTheme.typography.bodySmall, color = Color(0xFF245C48))
}
@Composable private fun Section(title: String, subtitle: String? = null) {
    Column(Modifier.padding(top = 14.dp, bottom = 4.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
@Composable private fun Empty(text: String) {
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceVariant) {
        Text(text, Modifier.fillMaxWidth().padding(24.dp), style = MaterialTheme.typography.bodyMedium)
    }
}
@Composable private fun Inbox(state: ScreenState, model: DeskViewModel) {
    val waiting = state.snapshot.tasks.filter { it.state in listOf("awaiting_input", "awaiting_approval") }
    val recent = state.snapshot.tasks.filter { it.state !in listOf("awaiting_input", "awaiting_approval") }.take(15)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Section("今天，先处理这些", "${state.snapshot.suggestions.size} 条候选 · ${waiting.size} 项需要你确认") }
        item { Section("待办候选", "消息经过整理，保留后才会成为正式待办") }
        if (state.snapshot.suggestions.isEmpty()) item { Empty("暂无待确认候选。主机收到新消息后，可在这里刷新查看。") }
        items(state.snapshot.suggestions, key = { "suggestion-${it.id}" }) { suggestion ->
            Card(onClick = { model.openSuggestion(suggestion.id) }, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(suggestion.title, style = MaterialTheme.typography.titleMedium)
                    suggestion.summary?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    Text("合并 ${suggestion.sourceCount} 条来源 · 点击查看", style = MaterialTheme.typography.labelMedium, color = green)
                }
            }
        }
        item { Section("文档计划", "逐项核对填写内容，再决定是否执行") }
        if (waiting.isEmpty()) item { Empty("暂无待核对计划。填表由电脑执行，手机负责确认。") }
        items(waiting, key = { "waiting-${it.id}" }) { task -> TaskCard(task) { model.openTask(task.id) } }
        if (recent.isNotEmpty()) {
            item { Section("最近任务", "批准之后，可在这里关注执行与回读结果") }
            items(recent, key = { "recent-${it.id}" }) { task -> TaskCard(task) { model.openTask(task.id) } }
        }
        item { Spacer(Modifier.height(12.dp)) }
    }
}
@Composable private fun TaskCard(task: Task, onClick: () -> Unit) {
    OutlinedCard(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("文档任务 #${task.id}", style = MaterialTheme.typography.titleMedium)
            Text(stateLabel(task.state), color = green)
            if (task.updatedAt.isNotBlank()) Text(task.updatedAt.replace('T', ' ').take(19), style = MaterialTheme.typography.bodySmall)
        }
    }
}
@Composable private fun SuggestionDetails(s: Suggestion, busy: Boolean, model: DeskViewModel) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(s.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        s.summary?.let { Text(it) }
        Text("${s.category} · ${s.sourceCount} 条来源", color = green)
        Section("来源消息")
        if (s.sources.isEmpty()) Empty(s.messageText ?: "暂无来源片段")
        s.sources.forEach { source -> OutlinedCard(Modifier.fillMaxWidth()) { Text(source.text ?: "附件消息", Modifier.padding(16.dp)) } }
        Button(onClick = { model.decide(s.id, true) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("保留为待办") }
        OutlinedButton(onClick = { model.decide(s.id, false) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("忽略这条候选") }
    }
}
@Composable private fun TaskDetails(task: Task, busy: Boolean, demo: Boolean, model: DeskViewModel) {
    var confirming by remember(task.id, task.plan?.digest) { mutableStateOf(false) }
    var cancelling by remember(task.id) { mutableStateOf(false) }
    var answers by remember(task.id, task.stateVersion) { mutableStateOf<Map<String, String>>(emptyMap()) }
    val block = approvalBlock(task)
    val plan = task.plan
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("文档任务 #${task.id}", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(stateLabel(task.state), color = green)
        if (task.targetRef.isNotBlank()) Text(task.targetRef, style = MaterialTheme.typography.bodySmall)
        if (plan != null) {
            Text("计划 v${plan.version} · ${identityLabel(plan.plan.identityMode)} · 第 ${plan.plan.identityRow ?: "?"} 行")
            Section("拟填写内容", "以下值将由电脑写入共享文档，请逐项核对")
            if (plan.plan.changes.isEmpty()) Empty("当前计划没有填写项")
            plan.plan.changes.forEach { change ->
                OutlinedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text("${cellAddress(change.col, change.row)} · ${fieldLabel(change.field)}", color = green, fontWeight = FontWeight.Bold)
                        Text("原值：${change.before?.ifBlank { "（空）" } ?: "（空）"}")
                        Text("拟填：${change.value ?: "（缺失）"}", fontWeight = FontWeight.Medium)
                    }
                }
            }
            plan.plan.warnings.forEach { Banner("需要人工处理：${it.reason ?: "计划警告"}") }
            plan.plan.missing.forEach { Banner("缺少资料：${it.header ?: it.field}") }
        }
        if (task.state == "awaiting_input") {
            Section("补充资料", "本次回答仅用于这个任务，提交后重新生成计划")
            task.questions.forEach { question ->
                OutlinedTextField(value = answers[question.key] ?: "", onValueChange = { value -> if (value.length <= 500) answers = answers + (question.key to value) },
                    label = { Text(question.label) }, modifier = Modifier.fillMaxWidth(), enabled = !busy)
            }
            Button(onClick = { model.answer(task, answers) }, enabled = !busy && task.questions.isNotEmpty() && task.questions.all { !answers[it.key].isNullOrBlank() }, modifier = Modifier.fillMaxWidth()) { Text("提交并重新准备计划") }
        }
        if (task.state == "awaiting_approval") {
            if (block != null) Banner(block)
            Button(onClick = { confirming = true }, enabled = !busy && block == null, modifier = Modifier.fillMaxWidth()) { Text("核对无误，批准填写") }
        }
        if (task.state in listOf("awaiting_input", "awaiting_approval", "approved"))
            OutlinedButton(onClick = { cancelling = true }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("取消任务") }
        if (task.state in listOf("outcome_unknown", "paused_login_required", "failed_retryable", "failed_terminal"))
            Empty("此状态需要在电脑端处理。不要再次创建相同填写任务来替代结果核对。")
        if (task.state in listOf("approved", "executing", "verifying")) Empty("主机正在处理，页面会定期刷新；请保持主机在线。")
    }
    if (confirming) AlertDialog(onDismissRequest = { confirming = false }, title = { Text("确认写入共享文档？") },
        text = { Text("批准计划 v${plan?.version}，共 ${plan?.plan?.changes?.size ?: 0} 个单元格。确认后主机会执行真实填写并回读。${if (demo) "当前为演示，不执行真实操作。" else ""}") },
        confirmButton = { TextButton(onClick = { confirming = false; model.approve(task) }, enabled = !busy && block == null) { Text("确认并批准") } },
        dismissButton = { TextButton(onClick = { confirming = false }) { Text("再核对一下") } })
    if (cancelling) AlertDialog(onDismissRequest = { cancelling = false }, title = { Text("取消这个任务？") }, text = { Text("取消尚未执行的任务，不会撤回已经写入的内容。") },
        confirmButton = { TextButton(onClick = { cancelling = false; model.cancel(task) }, enabled = !busy) { Text("确认取消") } },
        dismissButton = { TextButton(onClick = { cancelling = false }) { Text("返回") } })
}
private fun identityLabel(mode: String?) = when (mode) {
    "full" -> "姓名与学号匹配"; "name_only" -> "仅姓名匹配，请重点核对"; "student_id_only" -> "仅学号匹配"
    "new_row" -> "新增一行，请核对位置"; "reserved" -> "占位行"; else -> "身份模式待核对"
}
private fun fieldLabel(field: String) = mapOf("name" to "姓名", "student_id" to "学号", "major" to "专业", "sex" to "性别", "age" to "年龄", "phone" to "联系电话")[field] ?: field
@Composable private fun Todos(todos: List<Todo>) {
    LazyColumn(contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Section("已保留的待办", "本版只读展示；候选需要你保留后才出现在这里") }
        if (todos.isEmpty()) item { Empty("还没有正式待办") }
        items(todos, key = { it.id }) { todo -> OutlinedCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(todo.title, style = MaterialTheme.typography.titleMedium)
                Text(if (todo.status == "open") "待完成" else todo.status, color = green)
                todo.dueAt?.let { Text("截止：$it", style = MaterialTheme.typography.bodySmall) }
            }
        } }
    }
}
@Composable private fun SettingsScreen(state: ScreenState, model: DeskViewModel, onStartSync: () -> Unit) {
    var base by rememberSaveable(state.settings.base) { mutableStateOf(state.settings.base) }
    // 令牌输入不使用 rememberSaveable，防止明文进入系统 SavedState。
    var token by remember { mutableStateOf("") }
    var demo by rememberSaveable(state.settings.demo) { mutableStateOf(state.settings.demo) }
    var notify by rememberSaveable(state.settings.notifyExisting) { mutableStateOf(state.settings.notifyExisting) }
    var clearing by remember { mutableStateOf(false) }
    var invitation by remember { mutableStateOf("") }
    var deviceName by rememberSaveable { mutableStateOf("我的安卓手机") }
    var pairing by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Section("连接到你的电脑", "电脑负责接收与执行，手机负责核对与审批")
        OutlinedButton(onClick = { pairing = !pairing }, modifier = Modifier.fillMaxWidth()) { Text("使用私网邀请配对") }
        if (pairing) {
            Text("手机先登录并启用 Tailscale，再粘贴主机生成的邀请文件内容。邀请 5 分钟内有效。", style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(deviceName, { deviceName = it.take(80) }, label = { Text("设备名称") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(invitation, { invitation = it.take(4097) }, label = { Text("配对邀请 JSON") },
                visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
            Button(onClick = { model.pair(invitation, deviceName); invitation = ""; token = "" },
                enabled = !state.acting && invitation.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("配对并加密保存") }
            Text("邀请只使用一次。若兑换中断，请在主机撤销未使用设备，再生成新邀请。", style = MaterialTheme.typography.bodySmall)
        }
        OutlinedTextField(base, { base = it }, label = { Text("服务地址") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth())
        OutlinedTextField(token, { token = it }, label = { Text(if (state.tokenStored) "已加密保存；留空保留原令牌" else "访问令牌") },
            singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        if (BuildConfig.DEBUG) SettingSwitch("离线演示", "使用示例数据，不访问电脑", demo) { demo = it }
        SettingSwitch("启动时提醒已有待处理", "默认只提醒之后新出现的内容", notify) { notify = it }
        Button(onClick = { model.save(base, token, demo, notify); token = "" }, enabled = !state.acting, modifier = Modifier.fillMaxWidth()) { Text("保存设置") }
        OutlinedButton(onClick = model::testConnection, enabled = !state.acting, modifier = Modifier.fillMaxWidth()) { Text("测试已保存的连接与令牌") }
        Section("同步与通知", "${state.settings.syncStatus}${if (state.settings.syncEnabled) " · 同步中" else ""}")
        if (state.settings.lastSync.isNotBlank()) Text("上次同步：${state.settings.lastSync}", style = MaterialTheme.typography.bodySmall)
        Button(onClick = onStartSync, enabled = !state.acting && !state.settings.demo && state.tokenStored, modifier = Modifier.fillMaxWidth()) { Text("开启后台同步") }
        OutlinedButton(onClick = model::stopSync, modifier = Modifier.fillMaxWidth()) { Text("停止后台同步") }
        Text("需要允许通知。同步每 25 秒查询，网络失败会退避；系统可能限制后台运行时长。关闭通知或认证失效会停止同步。", style = MaterialTheme.typography.bodySmall)
        Section("USB 开发连接")
        Text("手机连接电脑并启用 USB 调试后，电脑需执行 adb reverse tcp:9087 tcp:9087。未转发时，手机的 127.0.0.1 不会指向电脑。无线连接请使用上方私网配对；主机需开机联网。", style = MaterialTheme.typography.bodySmall)
        Text("本版最多显示后端当前返回的 100 条候选、200 条任务；通知以成功同步为准，不保证全天实时推送。", style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { clearing = true }, enabled = !state.acting) { Text("清除令牌与本地同步记录") }
        Spacer(Modifier.height(20.dp))
    }
    if (clearing) AlertDialog(onDismissRequest = { clearing = false }, title = { Text("清除本机连接资料？") },
        text = { Text("停止同步并删除手机保存的令牌与通知去重记录，不会删除电脑上的消息、待办或文档。") },
        confirmButton = { TextButton(onClick = { clearing = false; token = ""; model.clear() }) { Text("确认清除") } },
        dismissButton = { TextButton(onClick = { clearing = false }) { Text("返回") } })
}
@Composable private fun SettingSwitch(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) { Text(title); Text(subtitle, style = MaterialTheme.typography.bodySmall) }
        Switch(checked, onChange)
    }
}
