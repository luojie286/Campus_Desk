package com.campusdesk.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.*
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.campusdesk.mobile.sync.ApprovalSyncService
import com.campusdesk.mobile.ui.*
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
    private val model: DeskViewModel by viewModels()
    private var pendingLink by mutableStateOf<Pair<String, Long>?>(null)
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startSync() else model.showMessage("未允许通知，后台同步未开启；仍可在前台手动刷新")
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        readLink(intent)
        setContent {
            val state by model.state.collectAsStateWithLifecycle()
            LaunchedEffect(Unit) {
                lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                    while (true) { model.refreshNow(); delay(15_000) }
                }
            }
            LaunchedEffect(state.ready, pendingLink) {
                if (state.ready) pendingLink?.let { (kind, id) ->
                    pendingLink = null
                    // 网络读取交给 ViewModel；不让 loading 状态变化取消通知跳转的协程。
                    model.openNotification(kind, id)
                }
            }
            DeskApp(state, model, onStartSync = {
                if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                    permissions.launch(Manifest.permission.POST_NOTIFICATIONS)
                else startSync()
            })
        }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); readLink(intent) }
    private fun readLink(intent: Intent?) {
        val kind = intent?.getStringExtra("kind")
        val id = intent?.getLongExtra("id", 0) ?: 0
        if (id > 0 && kind in listOf("task", "suggestion", "briefing")) pendingLink = kind!! to id
    }
    private fun startSync() {
        try {
            ContextCompat.startForegroundService(this, Intent(this, ApprovalSyncService::class.java))
            model.showMessage("已请求启动同步，可在设置查看状态")
        } catch (_: Exception) { model.showMessage("系统暂不允许启动同步，请保持应用在前台后重试") }
    }
}
