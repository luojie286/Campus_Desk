"""Second-stage API acceptance against a synthetic model and private fixture store."""

import asyncio
import json
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import httpx

from campusdesk.knowledge import FileKnowledge
from campusdesk.knowledge.importing import import_file, initialize
from campusdesk.knowledge.permissions import set_cloud_permission
from campusdesk.knowledge_api import create_app
from campusdesk.models import ChatTransport, Model


class WorkbenchTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        fixture = TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name).resolve()
        initialize(self.root)
        note = self.root / "fixture.md"
        note.write_text("合成校验编号 8049", encoding="utf-8")
        self.document = import_file(self.root, note, import_file(self.root, note)["digest"])["document_id"]
        self.calls = []
        self.delay = 0
        self.bad_citation = False
        self.started = asyncio.Event()
        env = patch.dict(os.environ, {"CAMPUSDESK_TEST_MODEL": "fixture-only"})
        env.start()
        self.addCleanup(env.stop)
        model = Model("fixture", "Fixture", "test", "http://127.0.0.1:10000/chat/completions",
                      "CAMPUSDESK_TEST_MODEL", timeout=.08)
        transport = ChatTransport(httpx.MockTransport(self.provider))
        app = create_app(self.root, "fixture-token" * 3, models={"fixture": model}, transport=transport)
        self.transport = httpx.ASGITransport(app=app)
        self.headers = {"Authorization": "Bearer " + "fixture-token" * 3}
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test",
                                        headers=self.headers)
        self.addAsyncCleanup(self.client.aclose)

    async def provider(self, request):
        body = json.loads(request.content)
        system, user = body["messages"]
        data = json.loads(user["content"])
        phase = re.search(r"当前阶段 (\w+)", system["content"])
        phase = phase[1] if phase else "answer"
        self.calls.append((phase, data))
        self.started.set()
        if self.delay:
            await asyncio.sleep(self.delay)
        identifier = "unknown-fixture-citation" if self.bad_citation else data["evidence"][0]["id"]
        if phase == "review":
            result = {"claim_id": data["shared"][0]["id"], "finding": "核对编号", "evidence_ids": [identifier],
                      "severity": "low", "proposed_revision": "保留来源"}
        elif phase == "assess":
            result = {"preferred": "new", "reason": "有来源", "complete": True}
        else:
            result = {"answer": "编号 8049", "citations": [identifier]}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(result)},
                                                     "finish_reason": "stop"}], "usage": {"total_tokens": 120}})

    async def api(self, path, data=None, status=None, client=None):
        client = client or self.client
        response = (await client.get("/api/v1/interaction" + path) if data is None else
                    await client.post("/api/v1/interaction" + path, json=data))
        if status is None:
            self.assertLess(response.status_code, 300, response.text)
        else:
            self.assertEqual(response.status_code, status, response.text)
        return response.json()

    async def until(self, path, predicate, client=None):
        for _ in range(150):
            data = await self.api(path, client=client)
            if predicate(data):
                return data
            await asyncio.sleep(.01)
        self.fail("worker did not reach the expected state")

    async def test_session_reconnect_consent_timeout_and_cancel(self):
        session = await self.api("/sessions", {})
        route = "/sessions/" + session["id"]
        body = {"question": "8049", "modelId": "fixture", "useModel": True, "clientRequestId": "first"}
        await self.api(route + "/turns", body)
        idle = lambda data: data["state"] == "idle"
        self.assertEqual((await self.until(route, idle))["turns"][-1]["result"]["status"], "cloud_grant_required")
        self.assertEqual(self.calls, [])
        set_cloud_permission(self.root, self.document, True)
        await self.api(route + "/turns", {**body, "clientRequestId": "second"})
        async with httpx.AsyncClient(transport=self.transport, base_url="http://test", headers=self.headers) as reconnected:
            data = await self.until(route, idle, client=reconnected)
        self.assertEqual(data["turns"][-1]["result"]["answer"], "编号 8049")
        self.assertEqual(data["turns"][-1]["result"]["evidence"][0]["locator"], "第 1 行")
        await self.api(route + "/turns", {**body, "clientRequestId": "second"})
        self.assertEqual(len(self.calls), 1)
        self.delay = .2
        await self.api(route + "/turns", {**body, "clientRequestId": "timeout"})
        self.assertEqual((await self.until(route, idle))["turns"][-1]["result"]["status"], "model_timeout")
        self.started.clear()
        await self.api(route + "/turns", {**body, "clientRequestId": "cancel"})
        await asyncio.wait_for(self.started.wait(), 1)
        self.assertEqual((await self.api(route + "/cancel", {}))["turns"][-1]["result"]["status"], "cancelled")
        await asyncio.sleep(.1)
        set_cloud_permission(self.root, self.document, False)
        snapshot = await self.api(route)
        self.assertEqual(snapshot["turns"][1]["result"]["status"], "source_changed")
        self.assertEqual(snapshot["turns"][-1]["result"]["status"], "cancelled")

    def research_body(self, identifier="research", effort=None):
        return {"clientRequestId": identifier, "question": "8049",
                "agents": [{"id": "a", "modelId": "fixture"}, {"id": "b", "modelId": "fixture"}],
                "effort": effort or {"preset": "low"}}

    async def test_single_answer_respects_scope_and_rejects_unknown_citation(self):
        set_cloud_permission(self.root, self.document, True)
        missing = await self.api("/answers", {"question": "不存在的编号 9987", "document_ids": ["other-document"],
                                              "use_model": True, "model_id": "fixture"})
        self.assertEqual(missing["status"], "no_evidence")
        self.assertEqual(self.calls, [])
        self.bad_citation = True
        invalid = await self.api("/answers", {"question": "8049", "use_model": True, "model_id": "fixture"})
        self.assertEqual(invalid, {"answer": "", "status": "invalid_model_output", "evidence": []})

    async def test_research_phases_report_and_revocation(self):
        set_cloud_permission(self.root, self.document, True)
        body = self.research_body()
        created = await self.api("/research", body)
        route = "/research/" + created["id"]
        finished = await self.until(route, lambda data: data["state"] != "running")
        self.assertEqual(finished["state"], "completed", finished)
        self.assertEqual(finished["budget"]["calls"], 6)
        self.assertEqual(finished["budget"]["tokens"], 720)
        self.assertEqual([phase for phase, _ in self.calls], ["explore", "explore", "review", "review", "synthesize", "assess"])
        self.assertEqual([data["shared"] for _, data in self.calls[:2]], [[], []])
        self.assertEqual((await self.api("/research", body))["id"], created["id"])
        self.assertEqual(len((await self.api(route + "/artifacts"))["items"]), 6)
        preview = await self.api(route + "/save-preview", {"name": "approved.md", "includeProcess": True})
        knowledge = FileKnowledge(self.root)
        self.assertNotIn("approved.md", [item["name"] for item in knowledge.documents()])
        approve = {"decision": "approve", "digest": preview["digest"]}
        decision = "/report-previews/" + preview["id"] + "/decision"
        stored = await self.api(decision, approve)
        self.assertEqual(await self.api(decision, approve), stored)
        self.assertIn("approved.md", [item["name"] for item in knowledge.documents()])
        preview = await self.api(route + "/save-preview", {"name": "revoked.md"})
        set_cloud_permission(self.root, self.document, False)
        self.assertIsNone((await self.api(route))["result"])
        self.assertEqual((await self.api(route + "/artifacts"))["items"], [])
        await self.api("/report-previews/" + preview["id"] + "/decision",
                       {"decision": "approve", "digest": preview["digest"]}, status=409)
        self.assertNotIn("revoked.md", [item["name"] for item in knowledge.documents()])

    async def test_research_pause_resume_budget_and_control_replay(self):
        set_cloud_permission(self.root, self.document, True)
        self.delay = .5
        created = await self.api("/research", self.research_body(effort={"preset": "low", "limits": {"calls": 2}}))
        route = "/research/" + created["id"]
        await asyncio.wait_for(self.started.wait(), 1)
        pause = {"action": "pause", "clientRequestId": "pause", "expectedVersion": created["version"]}
        self.assertEqual((await self.api(route + "/control", pause))["state"], "paused")
        self.assertEqual((await self.api(route + "/control", pause))["state"], "paused")
        self.delay = 0
        paused = await self.until(route, lambda data: data["budget"]["reserved"] == 0)
        await self.api(route + "/control",
                       {"action": "resume", "clientRequestId": "resume", "expectedVersion": paused["version"]})
        exhausted = await self.until(route, lambda data: data["state"] == "budget_exhausted")
        self.assertEqual(exhausted["budget"]["calls"], 2)
        await self.api(route + "/control", {"action": "increase_budget", "clientRequestId": "increase",
                       "expectedVersion": exhausted["version"],
                       "input": {"limits": {**exhausted["budget"]["limits"], "calls": 9}}})
        self.assertEqual((await self.until(route, lambda data: data["state"] != "running"))["state"], "completed")
