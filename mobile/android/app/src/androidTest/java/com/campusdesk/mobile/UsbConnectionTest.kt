package com.campusdesk.mobile

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.campusdesk.mobile.data.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyStore
import com.campusdesk.mobile.domain.fingerprint
import com.campusdesk.mobile.domain.planNotifications

/** 真机 USB 只读验收。配置仅从应用私有文件接收，不接受命令行令牌参数。 */
@RunWith(AndroidJUnit4::class)
class UsbConnectionTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @Test fun configureAndReadBackend() = runBlocking {
        val input = File(context.filesDir, "usb-test-config.json")
        assertTrue("Missing private USB test config", input.exists())
        try {
            val config = JSONObject(input.readText())
            val base = config.getString("base")
            val token = config.getString("token")
            assertEquals("Only loopback USB test allowed", "http://127.0.0.1:9087", base)
            val vault = TokenVault(context)
            vault.save(token)
            assertTrue("Encrypted token roundtrip failed", vault.read() == token)
            SettingsStore(context).save(Settings(base = base, demo = false))
            val gateway = ApiClient(Connection(base, token))
            gateway.health()
            val snapshot = gateway.snapshot()
            assertTrue("Latest backend briefing API unavailable", snapshot.briefingSupported)
            // 只记录脱敏计数，不记录任务内容或访问令牌。
            File(context.filesDir, "usb-test-evidence.json").writeText(JSONObject().apply {
                put("authenticated", true); put("tasks", snapshot.tasks.size)
                put("suggestions", snapshot.suggestions.size); put("briefings", snapshot.briefings.size)
                put("androidApi", Build.VERSION.SDK_INT)
                put("processId", android.os.Process.myPid())
            }.toString())
            val raw = File(context.applicationInfo.dataDir, "shared_prefs/desk_token.xml").readText()
            assertFalse("Plaintext token found in preferences", raw.contains(token))
        } finally { input.delete() }
    }
    @Test fun readSavedTokenInNewProcess() = runBlocking {
        val settings = SettingsStore(context).read()
        assertFalse("Demo mode unexpectedly active", settings.demo)
        val token = TokenVault(context).read()
        assertTrue("Encrypted token missing after process restart", token.isNotBlank())
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertTrue("Keystore key missing", keyStore.containsAlias("campusdesk_api_token"))
        val evidence = JSONObject(File(context.filesDir, "usb-test-evidence.json").readText())
        assertTrue("This check must run in a fresh app process", evidence.getInt("processId") != android.os.Process.myPid())
        ApiClient(Connection(settings.base, token)).health()
    }
    @Test fun postSyntheticNotification() {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 33) {
            // 权限由用户在手机上明确授予；测试不能绕过系统授权。
            assertEquals(PackageManager.PERMISSION_GRANTED, ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS))
        }
        manager.createNotificationChannel(NotificationChannel("usb_test", "USB 联机测试", NotificationManager.IMPORTANCE_DEFAULT))
        val pending = PendingIntent.getActivity(context, 9021, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        manager.notify(9021, NotificationCompat.Builder(context, "usb_test").setSmallIcon(R.drawable.ic_desk)
            .setContentTitle("课桌 USB 联机测试").setContentText("测试通知，不含个人资料，点击可打开课桌")
            .setContentIntent(pending).setAutoCancel(true).build())
        assertTrue("Notification not registered by Android", manager.activeNotifications.any { it.id == 9021 })
    }
    @Test fun diagnoseSyncRoundTrip() = runBlocking {
        var stage = "settings"
        try {
            val store = SettingsStore(context)
            val settings = store.read()
            val connection = Connection(settings.base, TokenVault(context).read(), settings.demo)
            stage = "snapshot"
            val snapshot = ApiClient(connection).snapshot()
            stage = "fingerprint"
            val owner = connection.fingerprint()
            stage = "read_seen"
            val previous = store.readSeen(owner)
            stage = "plan_notifications"
            val batch = planNotifications(previous, snapshot, settings.notifyExisting)
            stage = "save_seen"
            store.saveSeen(owner, batch.next)
            File(context.filesDir, "usb-sync-diagnostic.json").writeText(JSONObject().put("passed", true).toString())
        } catch (error: Exception) {
            File(context.filesDir, "usb-sync-diagnostic.json").writeText(JSONObject().put("passed", false).put("stage", stage)
                .put("errorClass", error.javaClass.simpleName).toString())
            throw AssertionError("Sync stage $stage failed (${error.javaClass.simpleName})")
        }
    }
    @Test fun readAgainAfterConnectionIdle() = runBlocking {
        val settings = SettingsStore(context).read()
        val gateway = ApiClient(Connection(settings.base, TokenVault(context).read()))
        gateway.snapshot()
        kotlinx.coroutines.delay(8000)
        try { gateway.snapshot() }
        catch (error: Exception) { throw AssertionError("Idle HTTP read failed: ${error.javaClass.simpleName}") }
        Unit
    }
}
