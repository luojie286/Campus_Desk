"""Ability contract, consent, persistent dispatch and synthetic NapCat acceptance."""

import asyncio
from contextlib import closing
import hmac
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

import httpx

from campusdesk.abilities import Abilities
from campusdesk.abilities.qq import QQ, QQSettings
from campusdesk.abilities.search import Search, SearchInput
from campusdesk.knowledge.importing import import_file, initialize
from campusdesk.inbox import QQInbox
from campusdesk.knowledge_api import create_app

TOKEN = "synthetic-desktop-token-" * 2
QQ_TOKEN = "synthetic-callback-token"
SEARCH = "/api/v1/interaction"
CALLBACK = "/api/v1/abilities/qq/callback"


def qq_event(identifier, text="请报名参加合成讲座", **extra):
    return {"post_type": "message", "message_type": "group", "self_id": 120,
            "group_id": 900, "user_id": 240, "message_id": identifier,
            "message": [{"type": "text", "data": {"text": text}}], **extra}


class AbilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.owner = initialize(self.root)["workspace_id"]
        self.db = self.root / ".private" / "poc.sqlite"
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("INSERT INTO workspace_source_bindings VALUES (?,'qq','120',1,1)", (self.owner,))
            db.executescript("""
                CREATE TABLE sources(id INTEGER PRIMARY KEY,platform,account_ref,enabled,
                  conversation_type,conversation_id,sender_id,display_name);
                INSERT INTO sources VALUES(1,'qq','120',1,'group','900','240','合成群');
                INSERT INTO sources VALUES(2,'qq','120',1,'private','245','','合成好友');
            """)
        note = self.root / "local.md"
        note.write_text("本机证据编号 8049", encoding="utf-8")
        import_file(self.root, note, import_file(self.root, note)["digest"])
        self.calls = []
        self.fail_search = False
        self.qq_account = 120
        self.runtime = Abilities()
        self.qq = QQ(self.root, QQSettings("120", "synthetic-api-token", QQ_TOKEN),
                     httpx.MockTransport(self.napcat))
        self.runtime.register(self.qq)
        self.runtime.register(Search("crossref", transport=httpx.MockTransport(self.crossref)))
        self.app = create_app(self.root, TOKEN, abilities=self.runtime)
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()
        self.addAsyncCleanup(self.lifespan.__aexit__, None, None, None)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                       base_url="http://test", headers={"Authorization": "Bearer " + TOKEN})
        self.addAsyncCleanup(self.client.aclose)

    async def napcat(self, request):
        self.assertEqual(request.headers.get("Authorization"), "Bearer synthetic-api-token")
        payload = json.loads(request.content)
        self.calls.append((request.url.path, payload))
        if request.url.path == "/get_login_info":
            data = {"user_id": self.qq_account}
        elif request.url.path == "/get_group_msg_history":
            self.assertEqual(payload, {"group_id": 900, "count": 20})
            data = {"messages": [qq_event(1), qq_event(2, "请提交作业"), qq_event(88) | {"user_id": 444}]}
        elif request.url.path == "/get_friend_msg_history":
            self.assertEqual(payload, {"user_id": 245, "count": 20})
            data = {"messages": [{"user_id": 245, "message_id": 3, "message": "请确认出席"}]}
        else:
            self.fail("unexpected OneBot API action")
        return httpx.Response(200, json={"status": "ok", "data": data})

    async def crossref(self, request):
        self.assertEqual(request.url.host, "api.crossref.org")
        self.calls.append(("search", request.url.params["query.bibliographic"]))
        if self.fail_search:
            return httpx.Response(429)
        return httpx.Response(200, json={"message": {"items": [
            {"DOI": "10.1234/synthetic", "title": ["合成论文"], "abstract": "<p>公开元数据</p>"}
        ]}})

    async def api(self, path, data=None, status=200):
        response = await (self.client.get(SEARCH + path) if data is None else self.client.post(SEARCH + path, json=data))
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    async def callback(self, value, signature=False, expected=200):
        headers = {"Authorization": "Bearer " + QQ_TOKEN}
        data = json.dumps(value).encode()
        if signature:
            headers = {"Authorization": "", "X-Signature": "sha1=" + hmac.new(QQ_TOKEN.encode(), data, "sha1").hexdigest()}
        result = await self.client.post(CALLBACK, headers=headers, content=data)
        self.assertEqual(result.status_code, expected, result.text)
        return result.json()

    async def candidates(self, count):
        for _ in range(100):
            items = (await self.api("/qq/candidates"))["items"]
            if len(items) == count:
                return items
            await asyncio.sleep(.02)
        self.fail("expected queued candidate count")

    async def test_explicit_search_and_fault_isolation(self):
        capabilities = (await self.api("/abilities"))["items"]
        self.assertEqual({item["id"]: item["state"] for item in capabilities},
                         {"web.search": "available", "qq.listen": "running"})
        await self.api("/answers", {"question": "8049"})
        self.assertEqual(self.calls, [])
        answer = await self.api("/answers", {"question": "8049", "web_query": "only this query"})
        self.assertEqual(self.calls, [("search", "only this query")])
        self.assertEqual({item["provider"] for item in answer["evidence"]}, {None, "crossref"})
        self.assertEqual(answer["evidence"][-1]["url"], "https://doi.org/10.1234/synthetic")
        self.fail_search = True
        self.assertEqual((await self.api("/answers", {"question": "8049", "web_query": "limited"}))["status"],
                         "local_evidence")
        self.assertEqual((await self.api("/abilities/search", {"query": "limited"}, 503))["detail"], "ability_rate_limited")
        self.runtime.single.clear()
        self.assertEqual((await self.api("/answers", {"question": "8049", "web_query": "disabled"}))["abilityError"],
                         "ability_disabled")
        self.assertEqual((await self.api("/answers", {"question": "8049"}))["status"], "local_evidence")

    async def test_brave_shape_and_untrusted_links(self):
        async def brave(request):
            self.assertEqual(request.url.host, "api.search.brave.com")
            self.assertEqual(request.headers["X-Subscription-Token"], "fixture-key")
            return httpx.Response(200, json={"web": {"results": [
                {"title": "公网样本", "description": "<b>证据</b>", "url": "https://example.org/page"},
                {"title": "unsafe", "url": "https://127.0.0.1/admin"},
                {"title": "unsafe", "url": "https://127.0.0.0x1/admin"},
                {"title": "unsafe", "url": "https://foo.localhost./admin"},
                {"title": "unsafe", "url": "https://user@example.org/page"},
            ]}})
        hits = await Search("brave", "fixture-key", httpx.MockTransport(brave)).invoke(SearchInput("fixture"))
        self.assertEqual([(item.url, item.excerpt) for item in hits], [("https://example.org/page", "证据")])

    async def test_realtime_and_history_share_identity(self):
        self.assertEqual((await self.client.post(CALLBACK, json=qq_event(1))).status_code, 401)
        self.assertEqual((await self.callback(qq_event(1)))["stored"], 1)
        self.assertEqual((await self.callback(qq_event(1), signature=True))["duplicates"], 1)
        self.assertEqual((await self.callback(qq_event(99) | {"group_id": 800}))["filtered"], 1)
        self.assertEqual((await self.callback(qq_event(98) | {"user_id": 444}))["filtered"], 1)
        self.assertEqual((await self.api("/qq/history", {"sourceId": 1}))["duplicates"], 1)
        self.assertEqual((await self.api("/qq/history", {"sourceId": 2}))["stored"], 1)
        (draft,) = await self.candidates(1)
        self.assertEqual(draft["origin"], "realtime")
        self.assertEqual((await self.api(f"/qq/candidates/{draft['id']}/decision", {"decision": "accepted"}))["state"], "accepted")
        self.assertEqual((await self.api(f"/qq/candidates/{draft['id']}/decision", {"decision": "accepted"}))["state"], "accepted")
        await self.api(f"/qq/candidates/{draft['id']}/decision", {"decision": "dismissed"}, 409)
        self.assertEqual(len((await self.api("/qq/events"))["items"]), 3)
        await self.callback(qq_event(2))
        await self.candidates(2)
        self.assertEqual((await self.api("/qq/probe"))["state"], "reachable")
        self.qq_account = 987
        await self.api("/qq/probe", status=409)
        await self.api("/qq/history", {"sourceId": 1}, 409)
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE workspace_source_bindings SET history_allowed=0")
        self.assertEqual((await self.api("/qq/candidates"))["items"], [])
        await self.api("/qq/history", {"sourceId": 1}, 403)

    async def test_queue_persists_across_restart_and_history_opt_in(self):
        await self.qq.stop()
        self.assertEqual((await self.client.post(CALLBACK, json=qq_event(10))).status_code, 503)
        # Simulate a committed webhook transaction whose worker has not run.
        self.qq.store([qq_event(10)])
        restarted = QQ(self.root, QQSettings("120", "synthetic-api-token", QQ_TOKEN, history_suggestions=True),
                       httpx.MockTransport(self.napcat))
        restarted.consumer = QQInbox(restarted)
        self.runtime.continuous["qq.listen"] = restarted
        await restarted.start()
        await self.candidates(1)
        result = await self.api("/qq/history", {"sourceId": 1})
        self.assertEqual(result, {"stored": 2, "duplicates": 0, "filtered": 1})
        self.assertEqual(sum(item["origin"] == "history" for item in await self.candidates(3)), 2)
