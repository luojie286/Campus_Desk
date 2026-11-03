package com.campusdesk.mobile

import com.campusdesk.mobile.data.*
import com.campusdesk.mobile.domain.approvalBlock

fun demoGateway(): Gateway = DemoGateway()

// 仅编入 debug；所有修改只改变内存，不访问网络或真实个人资料。
class DemoGateway : Gateway {
    private var briefingSettings = BriefingSettings()
    private val briefings = mutableListOf(Briefing(501, java.time.LocalDate.now().toString(), java.time.ZoneId.systemDefault().id, "ready", "ai",
        BriefingContent("早上好，这是合成技术早报，仅用于演示布局，并非真实新闻。", listOf(
            BriefingSection("新技术进展", listOf(BriefingItem("示例：一种开发工具改进了代码检索流程。本条演示如何解释技术变化与适用场景，不代表真实发布。", "news:demo-tech", source = "合成示例"))),
            BriefingSection("重大事件观察", listOf(BriefingItem("示例：科研合作计划值得持续关注。实际早报会提供原始来源和发布时间。", "news:demo-event", source = "合成示例")))
        ))))
    private val suggestions = mutableListOf(Suggestion(101, "周五前提交实验报告", "通知与补充说明已合并，核对后可保留为待办。", "action", confidence = 0.94, sourceCount = 2,
        sources = listOf(Source(1, "请在周五前提交实验报告。"), Source(2, "报告请使用最新模板。"))))
    private val tasks = mutableListOf(
        Task(201, "awaiting_approval", currentPlanId = 301, targetRef = "演示：信息登记表", plan = Plan(301, 1, "demo-digest", plan = PlanBody("full", 3,
            listOf(Change(3, 3, "major", "", "计算机科学与技术"), Change(3, 4, "age", "", "19"))))),
        Task(202, "awaiting_input", targetRef = "演示：活动报名", questions = listOf(Question("phone", "联系电话"))),
        Task(203, "outcome_unknown", targetRef = "演示：需在电脑核对的任务")
    )
    private val todos = mutableListOf(Todo(401, "整理课程笔记", "open"))
    override suspend fun health() {}
    override suspend fun snapshot() = Snapshot(suggestions.toList(), tasks.toList(), todos.toList(), briefings.toList())
    override suspend fun task(id: Long) = tasks.first { it.id == id }
    override suspend fun decideSuggestion(id: Long, accept: Boolean) {
        val s = suggestions.first { it.id == id }
        suggestions.remove(s)
        if (accept) todos.add(Todo(id + 1000, s.title, "open"))
    }
    override suspend fun answer(id: Long, answers: Map<String, String>) {
        val index = tasks.indexOfFirst { it.id == id }
        val task = tasks[index]
        tasks[index] = task.copy(state = "awaiting_approval", currentPlanId = 302, stateVersion = task.stateVersion + 1, questions = emptyList(),
            plan = Plan(302, 1, "demo-answer-digest", plan = PlanBody("full", 3, answers.map { (k, v) -> Change(3, 5, k, "", v) })))
    }
    override suspend fun approve(task: Task, requestId: String) {
        require(approvalBlock(task) == null)
        tasks[tasks.indexOfFirst { it.id == task.id }] = task.copy(state = "completed")
    }
    override suspend fun cancel(id: Long) { val i = tasks.indexOfFirst { it.id == id }; tasks[i] = tasks[i].copy(state = "cancelled") }
    override suspend fun briefing(id: Long) = briefings.first { it.id == id }
    override suspend fun briefingSettings() = briefingSettings
    override suspend fun saveBriefingSettings(value: BriefingSettings): BriefingSettings { briefingSettings = value; return value }
    override suspend fun generateToday() = briefings.first()
}
