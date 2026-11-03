package com.campusdesk.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.lifecycle.ViewModelProvider
import com.campusdesk.mobile.ui.DeskViewModel
import java.io.File
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScreenTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @Test fun `demo opens candidate and retaining it creates a visible todo`() {
        compose.waitUntil(15_000) { compose.onAllNodesWithText("周五前提交实验报告").fetchSemanticsNodes().isNotEmpty() }
        screenshot("inbox")
        compose.onNodeWithText("周五前提交实验报告").performClick()
        compose.onNodeWithText("保留为待办").performScrollTo().performClick()
        compose.onNodeWithText("待办", useUnmergedTree = true).performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("周五前提交实验报告").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("周五前提交实验报告").performScrollTo().assertIsDisplayed()
        screenshot("todos")
    }
    @Test fun `approval requires explicit second confirmation`() {
        compose.waitUntil(15_000) { compose.onAllNodesWithText("周五前提交实验报告").fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("文档任务 #201"))
        compose.onNodeWithText("文档任务 #201").performScrollTo().performClick()
        screenshot("plan")
        compose.onNodeWithText("核对无误，批准填写").performScrollTo().performClick()
        compose.onNodeWithText("确认写入共享文档？").assertIsDisplayed()
        compose.onNodeWithText("再核对一下").performClick()
        compose.onNodeWithText("核对无误，批准填写").assertIsDisplayed()
    }
    @Test fun `settings show encrypted storage input and demo cannot start background sync`() {
        compose.onNodeWithText("设置", useUnmergedTree = true).performClick()
        compose.onNodeWithText("访问令牌").assertExists()
        compose.onNodeWithText("开启后台同步").performScrollTo().assertIsNotEnabled()
        screenshot("settings")
    }
    @Test fun `notification destination routes to requested task independently of list refresh`() {
        compose.waitUntil(15_000) { compose.onAllNodesWithText("周五前提交实验报告").fetchSemanticsNodes().isNotEmpty() }
        compose.runOnUiThread {
            ViewModelProvider(compose.activity)[DeskViewModel::class.java].openNotification("task", 201L)
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("核对无误，批准填写").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("核对无误，批准填写").performScrollTo().assertIsDisplayed()
    }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        val file = File("build/reports/mobile-preview/$name.png")
        requireNotNull(file.parentFile).mkdirs()
        // Robolectric 的 PixelCopy 不等同真设备；直接绘制 DecorView，避免截图回调永不返回。
        compose.runOnUiThread {
            val view = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
    @Test fun `daily briefing opens readable sections and schedule dialog saves to demo`() {
        // 其他演示交互可能已经保留该候选，早报不应依赖它仍存在。
        compose.waitUntil(15_000) { compose.onAllNodesWithText("文档计划").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("早报", useUnmergedTree = true).performClick()
        compose.onNodeWithText("AI 已整理").performClick()
        compose.onNodeWithText("新技术进展").assertExists()
        screenshot("briefing")
        compose.onNodeWithText("返回").performClick()
        compose.onNodeWithText("定时设置").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("保存到主机").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("保存到主机").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("早报时间与开关已保存到主机").fetchSemanticsNodes().isNotEmpty() }
    }
}
