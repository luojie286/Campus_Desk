package com.campusdesk.mobile.data

import com.campusdesk.mobile.domain.connectionBase
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.net.URI
import java.time.Instant

// 邀请和兑换结果不能使用默认的 data class 日志输出，避免秘密出现在调试信息中。
class PairingInvitation(val base: String, val code: String) {
    override fun toString() = "PairingInvitation(redacted)"
}
@Serializable data class PairingResult(@SerialName("device_id") val deviceId: String, val token: String,
    @SerialName("expires_at") val expiresAt: String, val scopes: String) {
    override fun toString() = "PairingResult(redacted)"
}

fun parsePairingInvitation(raw: String, now: Instant = Instant.now()): PairingInvitation {
    require(raw.length <= 4096) { "配对邀请过长，请复制主机生成的邀请文件内容" }
    try {
        val value = apiJson.parseToJsonElement(raw).jsonObject
        require(value["version"]?.jsonPrimitive?.intOrNull == 1)
        val base = connectionBase(value["base"]!!.jsonPrimitive.content)
        val uri = URI(base)
        // 首版只有 Tailscale 私网入口；拒绝 HTTP、非标准端口和外部域名。
        require(uri.scheme == "https" && uri.host.endsWith(".ts.net") && uri.port == -1)
        val code = value["code"]!!.jsonPrimitive.content
        require(Regex("^[A-Za-z0-9_-]{43}$").matches(code))
        require(Instant.parse(value["expires_at"]!!.jsonPrimitive.content).isAfter(now))
        return PairingInvitation(base, code)
    } catch (_: Exception) {
        throw IllegalArgumentException("配对邀请无效或已过期，请在主机重新生成；手机需启用 Tailscale")
    }
}
