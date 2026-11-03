package com.campusdesk.mobile.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.preferences.core.*
import androidx.datastore.preferences.preferencesDataStore
import com.campusdesk.mobile.BuildConfig
import com.campusdesk.mobile.domain.SeenState
import kotlinx.coroutines.flow.first
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val Context.deskData by preferencesDataStore("desk_settings")
data class Settings(val base: String = "http://127.0.0.1:9087", val demo: Boolean = BuildConfig.DEBUG,
    val notifyExisting: Boolean = false, val syncEnabled: Boolean = false, val syncStatus: String = "尚未同步", val lastSync: String = "")

// SharedPreferences 仅保存密文和随机 IV，密钥不可从 Android Keystore 导出。
class TokenVault(context: Context) {
    private val prefs = context.getSharedPreferences("desk_token", Context.MODE_PRIVATE)
    private val alias = "campusdesk_api_token"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun read(): String {
        val encoded = prefs.getString("cipher", null) ?: return ""
        val iv = Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(Base64.decode(encoded, Base64.NO_WRAP)), Charsets.UTF_8)
    }
    @Synchronized fun save(token: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        check(prefs.edit().putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("cipher", Base64.encodeToString(cipher.doFinal(token.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)).commit())
    }
    @Synchronized fun clear() { check(prefs.edit().clear().commit()) }
}

class SettingsStore(private val context: Context) {
    private val base = stringPreferencesKey("base")
    private val demo = booleanPreferencesKey("demo")
    private val notify = booleanPreferencesKey("notify_existing")
    private val enabled = booleanPreferencesKey("sync_enabled")
    private val status = stringPreferencesKey("sync_status")
    private val synced = stringPreferencesKey("last_sync")
    private val seen = stringPreferencesKey("seen")
    private val owner = stringPreferencesKey("seen_owner")
    private val session = stringPreferencesKey("sync_session")
    suspend fun read(): Settings {
        val p = context.deskData.data.first()
        return Settings(p[base] ?: "http://127.0.0.1:9087", BuildConfig.DEBUG && (p[demo] ?: true),
            p[notify] ?: false, p[enabled] ?: false, p[status] ?: "尚未同步", p[synced] ?: "")
    }
    suspend fun save(value: Settings) {
        context.deskData.edit { p -> p[base] = value.base; p[demo] = value.demo; p[notify] = value.notifyExisting
            p[enabled] = false; p[status] = "设置已更新，请重新启动同步"; p.remove(seen); p.remove(owner); p.remove(synced); p.remove(session) }
    }
    suspend fun sync(enabledValue: Boolean, message: String, timestamp: String? = null) {
        context.deskData.edit { it[enabled] = enabledValue; it[status] = message; if (!enabledValue) it.remove(session); if (timestamp != null) it[synced] = timestamp }
    }
    suspend fun beginSync(id: String) {
        context.deskData.edit { it[session] = id; it[enabled] = true; it[status] = "正在连接" }
    }
    // 停止旧服务后的异步落盘不能覆盖刚启动的新服务，保存连接时也会撤销旧会话。
    suspend fun syncSession(id: String, running: Boolean, message: String, timestamp: String? = null) {
        context.deskData.edit {
            if (it[session] == id) {
                it[enabled] = running; it[status] = message
                if (timestamp != null) it[synced] = timestamp
                if (!running) it.remove(session)
            }
        }
    }
    suspend fun readSeen(fingerprint: String): SeenState {
        val p = context.deskData.data.first()
        if (p[owner] != fingerprint) return SeenState()
        return try { apiJson.decodeFromString(p[seen] ?: "{}") } catch (_: Exception) { SeenState() }
    }
    suspend fun saveSeen(fingerprint: String, value: SeenState) {
        context.deskData.edit { it[owner] = fingerprint; it[seen] = apiJson.encodeToString(value) }
    }
    suspend fun clear() { context.deskData.edit { it.clear() } }
}
