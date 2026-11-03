package com.campusdesk.mobile.sync

// Process-local liveness, unlike the persisted "enabled" preference. A system
// process kill resets this automatically, even when onDestroy was never called.
object SyncRuntime {
    @Volatile var session: String? = null
    val running: Boolean get() = session != null
}
