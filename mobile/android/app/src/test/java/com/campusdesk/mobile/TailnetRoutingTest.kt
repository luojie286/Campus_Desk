package com.campusdesk.mobile

import com.campusdesk.mobile.data.usesEmbeddedTailnet
import org.junit.Assert.*
import org.junit.Test

class TailnetRoutingTest {
    @Test fun `private HTTPS always selects embedded route`() {
        assertTrue(usesEmbeddedTailnet("https://desk.example.ts.net"))
        assertTrue(usesEmbeddedTailnet("https://DESK.example.ts.net"))
        assertFalse(usesEmbeddedTailnet("http://127.0.0.1:9087"))
        assertFalse(usesEmbeddedTailnet("https://desk.ts.net.attacker.example"))
        assertFalse(usesEmbeddedTailnet("invalid address"))
    }
}
