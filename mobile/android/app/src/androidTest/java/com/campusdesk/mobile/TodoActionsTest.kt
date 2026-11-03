package com.campusdesk.mobile

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import com.campusdesk.mobile.data.Snapshot
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class TodoActionsTest {
    @Test fun modifyOnlySyntheticTodo() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        instrumentation.startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val input = File(context.filesDir,"todo-device-fixture.json")
        try {
            val fixture = JSONObject(input.readText()); val id = fixture.getLong("id")
            val gateway = (context.applicationContext as DeskApplication).container.gateway()
            // A cold private tunnel may need another read while peers reconnect.
            // Retry this GET only; mutations below are each sent exactly once.
            var initial: Snapshot? = null
            repeat(4) {
                if (initial == null) try { initial = gateway.snapshot() } catch (error: java.io.IOException) {
                    if (it == 3) throw error
                    delay(5000)
                }
            }
            val todo = requireNotNull(initial).todos.single { it.id==id }
            assertEquals("课桌待办操作测试",todo.title)
            gateway.updateTodo(id,"complete"); assertEquals("done",gateway.snapshot().todos.single { it.id==id }.status)
            gateway.updateTodo(id,"reopen"); assertEquals("open",gateway.snapshot().todos.single { it.id==id }.status)
            gateway.updateTodo(id,"delete"); assertFalse(gateway.snapshot().todos.any { it.id==id })
        } finally { input.delete() }
    }
}
