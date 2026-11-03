package com.campusdesk.mobile

import android.app.NotificationManager
import android.content.Context
import com.campusdesk.mobile.data.Settings
import com.campusdesk.mobile.data.SettingsStore
import com.campusdesk.mobile.domain.SeenState
import com.campusdesk.mobile.sync.ApprovalSyncService
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AndroidStorageTest {
    @Test fun `sticky system recovery stops when user no longer enabled sync`() = runBlocking {
        val store = SettingsStore(RuntimeEnvironment.getApplication()); store.save(Settings(demo=false))
        val controller = Robolectric.buildService(ApprovalSyncService::class.java).create()
        try {
            val service = controller.get()
            assertTrue(com.campusdesk.mobile.sync.SyncRuntime.running)
            assertEquals(android.app.Service.START_STICKY,service.onStartCommand(null,0,1))
            withTimeout(3000) { while (!shadowOf(service).isStoppedBySelf) delay(10) }
        } finally { controller.destroy() }
        assertFalse(com.campusdesk.mobile.sync.SyncRuntime.running)
    }
    @Test fun `dead service cannot leave persisted connected state and keeps notification history`() = runBlocking {
        val store = SettingsStore(RuntimeEnvironment.getApplication())
        val seen = SeenState(true,setOf(7),setOf(9))
        store.beginSync("old-process"); store.sync(true,"连接正常")
        store.saveSeen("device",seen)
        assertTrue(store.recoverStoppedSync(false))
        assertFalse(store.read().syncEnabled)
        assertTrue(store.read().syncStatus.contains("中断"))
        assertEquals(seen,store.readSeen("device"))
        store.beginSync("live-process")
        assertFalse(store.recoverStoppedSync(true)); assertTrue(store.read().syncEnabled)
        store.clear()
    }
    @Test fun `settings persist seen IDs and isolate connection baselines`() = runBlocking {
        val store = SettingsStore(RuntimeEnvironment.getApplication())
        store.save(Settings(demo = false))
        val seen = SeenState(true, setOf(1, 2), setOf(3))
        store.saveSeen("first-server", seen)
        assertEquals(seen, store.readSeen("first-server"))
        assertEquals(SeenState(), store.readSeen("other-server"))
        store.save(Settings(base = "https://example.com", demo = false))
        assertEquals(SeenState(), store.readSeen("first-server"))
        assertEquals("https://example.com", store.read().base)
        store.clear()
    }
    @Test fun `service creates channels and stops itself on system timeout`() {
        val controller = Robolectric.buildService(ApprovalSyncService::class.java).create()
        val service = controller.get()
        val manager = service.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        assertNotNull(manager.getNotificationChannel("approvals"))
        assertNotNull(manager.getNotificationChannel("suggestions"))
        service.onTimeout(1, 1)
        assertTrue(shadowOf(service).isStoppedBySelf)
        controller.destroy()
    }
    @Test fun `old service cannot overwrite new sync session or settings`() = runBlocking {
        val store = SettingsStore(RuntimeEnvironment.getApplication())
        store.beginSync("old"); store.beginSync("new")
        store.syncSession("old", false, "stopped")
        assertTrue(store.read().syncEnabled)
        store.syncSession("new", true, "connected")
        assertEquals("connected", store.read().syncStatus)
        store.save(Settings(demo = false))
        store.syncSession("new", true, "stale-update")
        assertFalse(store.read().syncEnabled)
        assertNotEquals("stale-update", store.read().syncStatus)
        store.clear()
    }
}
