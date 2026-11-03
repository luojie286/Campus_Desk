package com.campusdesk.mobile

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.campusdesk.mobile.data.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Real tailnet acceptance: no adb reverse and no task mutation. */
@RunWith(AndroidJUnit4::class)
class EmbeddedConnectionTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val container get() = (context.applicationContext as DeskApplication).container
    private fun vpn(): Set<Long> {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        return manager.allNetworks.filter { manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true }.map { it.networkHandle }.toSet()
    }
    @Test fun pairAndRead() = runBlocking {
        // OEM task managers can freeze/kill a headless instrumentation target.
        // Keep the actual app in front; background reliability is a separate test.
        InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val before = vpn(); assertTrue("Keep existing VPN on", before.isNotEmpty())
        val file = File(context.filesDir,"embedded-test-invitation.json")
        try {
            val invitation = parsePairingInvitation(file.readText())
            val paired = container.apiClient(Connection(invitation.base)).pair(invitation.code,"课桌正式手机")
            container.vault.save(paired.token)
            container.settings.save(Settings(base=invitation.base,demo=false))
            val gateway = container.gateway(); gateway.health()
            val snapshot = gateway.snapshot()
            assertEquals(before,vpn())
            File(context.filesDir,"embedded-acceptance.json").writeText(JSONObject().apply {
                put("paired",true); put("tasks",snapshot.tasks.size); put("briefings",snapshot.briefings.size)
                put("vpnPreserved",true); put("pid",android.os.Process.myPid()); put("nodeOnline",container.privateNetwork.state.value.phase=="online")
            }.toString())
        } finally { file.delete() }
    }
    @Test fun readAfterProcessRestart() = runBlocking {
        InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val evidence = File(context.filesDir,"embedded-acceptance.json")
        val previous = JSONObject(evidence.readText())
        val marker = File(context.filesDir,"embedded-restart-marker.txt")
        val previousPid = marker.readText().trim().toInt()
        assertTrue(previousPid > 0)
        assertNotEquals(previousPid,android.os.Process.myPid())
        marker.delete()
        val before = vpn(); assertTrue(before.isNotEmpty())
        val connection = container.connection(); assertTrue(usesEmbeddedTailnet(connection.base)); assertTrue(connection.token.isNotBlank())
        val gateway = container.gateway(); gateway.health(); gateway.snapshot()
        assertEquals(before,vpn())
        previous.put("restartReadPassed",true); previous.remove("pid"); evidence.writeText(previous.toString())
    }
}
