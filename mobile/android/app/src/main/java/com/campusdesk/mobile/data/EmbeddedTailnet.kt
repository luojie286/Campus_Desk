package com.campusdesk.mobile.data

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.campusdesk.mobile.BuildConfig
import com.campusdesk.tsnet.probe.Client
import com.campusdesk.tsnet.probe.Probe
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Credentials
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Proxy
import java.net.URI
import java.util.Collections
import java.util.concurrent.TimeUnit

data class TailnetState(val phase: String = "stopped", val authUrl: String = "") {
    override fun toString() = "TailnetState($phase, redacted)"
}
fun usesEmbeddedTailnet(base: String): Boolean = try {
    val uri = URI(base)
    uri.scheme == "https" && uri.host?.lowercase()?.endsWith(".ts.net") == true
} catch (_: Exception) { false }

/** One userspace node shared by the UI and sync service. No Android VPN service. */
class EmbeddedTailnet(private val context: Context) {
    private fun trace(stage: String) {
        if (BuildConfig.DEBUG) {
            val file = java.io.File(context.filesDir,"embedded-debug-stage.txt")
            if (file.length() > 65536) file.writeText("")
            file.appendText(stage+"\n")
        }
    }
    private val mutable = MutableStateFlow(TailnetState())
    val state = mutable.asStateFlow()
    private var native: Client? = null
    private var http: OkHttpClient? = null
    private var epoch = 0L
    private val callbacks = Handler(Looper.getMainLooper())
    private val preferences = context.getSharedPreferences("desk_tailnet", Context.MODE_PRIVATE)
    private var paused = preferences.getBoolean("paused", false)

    fun start() = startNode(true)
    private fun startNode(manual: Boolean) {
        val node = synchronized(this) { createNode(manual) } ?: return
        // No Java monitor is held while entering Go. Native initialization may
        // invoke Java callbacks before the exported method returns.
        node.start()
        trace("start_returned")
    }
    private fun createNode(manual: Boolean): Client? {
        trace("start_node")
        if (manual) { paused = false; check(preferences.edit().putBoolean("paused",false).commit()) }
        require(!paused) { "私网已停止，请在设置重新连接" }
        if (native != null) return null
        val generation = ++epoch
        mutable.value = TailnetState("starting")
        try {
            val dir = java.io.File(context.filesDir, "embedded-tailnet").apply { mkdirs() }
            native = Probe.newClientNamed(dir.absolutePath, "campusdesk-android", { networkSnapshot() }, { event ->
                // Return to Go immediately. StateFlow consumers can call back
                // into native code; running them on the Go callback can deadlock.
                callbacks.post {
                    synchronized(this) {
                        if (generation == epoch) {
                            val value = JSONObject(event)
                            val phase = value.optString("stage", "start_failed")
                            val url = value.optString("url", "")
                            val safeUrl = try { URI(url).takeIf { it.scheme == "https" && it.host == "login.tailscale.com" }?.toString() ?: "" } catch (_: Exception) { "" }
                            mutable.value = TailnetState(phase, safeUrl)
                            trace("node_"+phase)
                        }
                    }
                }
            })
            return native
        } catch (_: Exception) { mutable.value = TailnetState("start_failed"); native = null }
        return null
    }
    suspend fun client(): OkHttpClient = withContext(Dispatchers.IO) {
        trace("client_start")
        startNode(false)
        trace("client_wait")
        val phase = withTimeoutOrNull(30_000) {
            state.first { it.phase in setOf("online", "login_required", "start_failed", "startup_panicked", "stopped") }.phase
        } ?: throw java.io.IOException("private_network_timeout")
        trace("client_"+phase)
        require(phase == "online") { "请在设置启动内嵌私网，并完成课桌节点授权" }
        synchronized(this@EmbeddedTailnet) {
            http ?: run {
                val node = requireNotNull(native)
                trace("proxy_address_start")
                val address = node.proxyAddress().split(":")
                trace("proxy_password_start")
                val credential = Credentials.basic("campusdesk", node.proxyPassword())
                trace("client_builder")
                OkHttpClient.Builder()
                    .proxy(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", address.last().toInt())))
                    .proxyAuthenticator { _, response ->
                        if (response.request.header("Proxy-Authorization") != null) null
                        else response.request.newBuilder().header("Proxy-Authorization", credential).build()
                    }
                    .connectTimeout(8, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).callTimeout(25, TimeUnit.SECONDS)
                    .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
                    .build().also { http = it }
            }
        }
    }
    fun stop() {
        val node = synchronized(this) {
            epoch++
            paused = true
            check(preferences.edit().putBoolean("paused",true).commit())
            http?.dispatcher?.cancelAll(); http?.connectionPool?.evictAll(); http = null
            val previous = native; native = null
            mutable.value = TailnetState()
            previous
        }
        // Native shutdown can wait for callbacks; never hold the callback lock.
        node?.close()
    }
    private fun networkSnapshot(): String {
        val rows = JSONArray()
        return try {
            Collections.list(NetworkInterface.getNetworkInterfaces()).forEach { nic ->
                var flags = if (nic.isUp) 33 else 0
                if (nic.isLoopback) flags = flags or 4
                if (nic.isPointToPoint) flags = flags or 8
                if (nic.supportsMulticast()) flags = flags or 16
                val addresses = JSONArray()
                nic.interfaceAddresses.forEach { address -> addresses.put(address.address.hostAddress!!.substringBefore('%') + "/" + address.networkPrefixLength) }
                rows.put(JSONObject().put("Name", nic.name).put("Index", nic.index).put("MTU", nic.mtu).put("Flags", flags).put("Addresses", addresses))
            }
            rows.toString()
        } catch (_: Exception) { "invalid" }
    }
}
