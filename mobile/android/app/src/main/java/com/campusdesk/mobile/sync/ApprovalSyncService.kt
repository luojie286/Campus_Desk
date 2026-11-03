package com.campusdesk.mobile.sync

import android.Manifest
import android.app.*
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.campusdesk.mobile.*
import com.campusdesk.mobile.domain.*
import kotlinx.coroutines.*
import java.time.Instant

class ApprovalSyncService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var polling: Job? = null
    private var stopMessage = "后台同步已停止"
    private val sessionId = java.util.UUID.randomUUID().toString()
    private val container get() = (application as DeskApplication).container
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(listOf(
            NotificationChannel("sync", "后台同步状态", NotificationManager.IMPORTANCE_LOW),
            NotificationChannel("suggestions", "待办候选", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel("approvals", "文档审批", NotificationManager.IMPORTANCE_DEFAULT)
            ,NotificationChannel("briefings", "每日早报", NotificationManager.IMPORTANCE_DEFAULT)
        ))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            startForeground(1, NotificationCompat.Builder(this, "sync").setSmallIcon(R.drawable.ic_desk)
                .setContentTitle("课桌正在同步").setContentText("点击查看；可在设置中停止")
                .setContentIntent(openIntent("home", 0)).setOngoing(true).build())
        } catch (_: RuntimeException) {
            stopMessage = "系统暂不允许后台同步，请保持应用前台后重试"
            stopSelf(); return START_NOT_STICKY
        }
        if (polling?.isActive == true) return START_NOT_STICKY
        polling = scope.launch {
            var failures = 0
            try {
                container.settings.beginSync(sessionId)
                val connection = container.connection()
                if (connection.demo || connection.token.isBlank() || !canNotify()) {
                    stopMessage = "请配置真实连接并允许通知后再启动同步"
                    container.settings.syncSession(sessionId, false, stopMessage); stopSelf(); return@launch
                }
                val fingerprint = connection.fingerprint()
                val gateway = container.gateway()
                while (isActive) {
                    if (container.connection().fingerprint() != fingerprint) break
                    try {
                        val snapshot = gateway.snapshot()
                        val settings = container.settings.read()
                        val previous = container.settings.readSeen(fingerprint)
                        val batch = planNotifications(previous, snapshot, settings.notifyExisting)
                        if (!canNotify()) { stopMessage = "通知权限已关闭，同步已停止"; break }
                        batch.notices.forEach(::notifyItem)
                        // 只有完整同步成功且通知已提交后才推进基线；失败时不吞掉新通知。
                        container.settings.saveSeen(fingerprint, batch.next)
                        container.settings.syncSession(sessionId, true, "连接正常", Instant.now().toString())
                        failures = 0
                    } catch (error: CancellationException) { throw error }
                    catch (error: Exception) {
                        if (error is SecurityException) { stopMessage = "通知权限已关闭，同步已停止"; break }
                        if (error is ApiException && error.status in listOf(401, 403)) {
                            stopMessage = "令牌失效，请打开设置重新配置"; break
                        }
                        failures++
                        container.settings.syncSession(sessionId, true, "连接失败，正在退避重试")
                    }
                    delay(retryDelayMillis(failures))
                }
            } catch (_: CancellationException) { /* 用户停止，onDestroy 负责取消。 */ }
            catch (_: Exception) { stopMessage = "同步无法启动，请检查加密设置" }
            finally { stopSelf() }
        }
        return START_NOT_STICKY
    }
    private fun canNotify() = (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
        NotificationManagerCompat.from(this).areNotificationsEnabled()

    private fun notifyItem(notice: Notice) {
        val task = notice.kind == "task"
        val briefing = notice.kind == "briefing"
        val manager = NotificationManagerCompat.from(this)
        if (!canNotify()) return
        try { manager.notify(notice.kind + ":" + notice.id, 2,
            NotificationCompat.Builder(this, if (briefing) "briefings" else if (task) "approvals" else "suggestions").setSmallIcon(R.drawable.ic_desk)
                .setContentTitle(if (briefing) "今日早报已准备好" else if (task) "有新的文档计划需要核对" else "有新的待办候选")
                .setContentText("打开课桌查看详情").setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setContentIntent(openIntent(notice.kind, notice.id)).setAutoCancel(true).build())
        } catch (error: SecurityException) { throw error }
    }
    private fun openIntent(kind: String, id: Long): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).setAction("desk.$kind.$id")
            .putExtra("kind", kind).putExtra("id", id).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    override fun onTimeout(startId: Int, fgsType: Int) {
        // Android 15+ 必须立即停服务；不尝试绕过配额或静默重启。
        scope.cancel()
        stopMessage = "系统同步时长已到，请在前台重新检查同步设置"
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    override fun onDestroy() {
        scope.cancel(); stopForeground(STOP_FOREGROUND_REMOVE)
        persistStopped(stopMessage)
        super.onDestroy()
    }
    private fun persistStopped(message: String) {
        // 独立短任务避免被服务 scope 的取消吞掉状态落盘；只保存状态，不保留正文。
        CoroutineScope(Dispatchers.IO).launch { container.settings.syncSession(sessionId, false, message) }
    }
}
