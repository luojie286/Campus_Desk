package com.campusdesk.mobile

import android.app.Application
import com.campusdesk.mobile.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class DeskApplication : Application() {
    val container by lazy { AppContainer(this) }
}
class AppContainer(app: Application) {
    val settings = SettingsStore(app)
    val vault = TokenVault(app)
    val privateNetwork by lazy { EmbeddedTailnet(app) }
    private val demo by lazy { demoGateway() }
    suspend fun connection(): Connection = withContext(Dispatchers.IO) {
        val s = settings.read()
        Connection(s.base, if (s.demo) "" else vault.read(), s.demo)
    }
    suspend fun gateway(): Gateway {
        val connection = connection()
        return if (connection.demo && BuildConfig.DEBUG) demo else apiClient(connection)
    }
    suspend fun apiClient(connection: Connection): ApiClient =
        if (usesEmbeddedTailnet(connection.base)) ApiClient(connection, privateNetwork.client()) else ApiClient(connection)
}
