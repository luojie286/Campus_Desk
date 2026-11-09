"""Cutover, approval, recovery and todo linkage on an isolated legacy database."""

import asyncio
from contextlib import closing
import json
import sqlite3
import subprocess
import unittest

import httpx

import test_workspace as legacy
from campusdesk.abilities import Abilities
from campusdesk.abilities.qq import QQ, QQSettings
from campusdesk.abilities.tencent import SheetAdapterError
from campusdesk.cutover import apply, inspect, preview, runtime_lock
from campusdesk.knowledge_api import create_app
from campusdesk.sheets import Sheets
from campusdesk.workspace import WorkspaceError

BASE = "/api/v1/interaction"
TARGET = "https://docs.qq.com/sheet/synthetic"
TOKEN = "synthetic-workspace-token" * 2


class FakeSheet:
    def __init__(self):
        self.calls = []
        self.matched = False
        self.interrupt = False

    def call(self, action, **data):
        self.calls.append(action)
        if action == "prepare":
            grade = data["profile"].get("grade")
            return {"plan": {"document": data["target"], "identityRow": 2, "identityMode": "full", "headerRow": 1,
                             "columns": [{"column": 3, "field": "grade", "header": "年级"}],
                             "missing": [] if grade else [{"field": "grade", "header": "年级"}],
                             "changes": [{"row": 2, "col": 3, "field": "grade", "before": "", "value": grade}] if grade else [],
                             "warnings": []}}
        if action == "execute":
            self.matched = True
            if self.interrupt:
                raise SheetAdapterError("synthetic_interrupted_write", attempted=True)
        return {"matched": self.matched}


@unittest.skipUnless(legacy.NODE.is_file(), "requires the verified legacy schema bootstrap")
class BusinessTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        fixture = legacy.WorkspaceTests("test_fresh_import_and_reference_without_qq")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.root = fixture.root
        self.owner = fixture.cli("init", "--port", str(fixture.port))["workspace_id"]
        path = fixture.local / "config.json"
        config = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps(config | {"execute": True}), encoding="utf-8")
        self.database = fixture.local / "poc.sqlite"
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("INSERT INTO profile VALUES(1,'合成姓名','001','样例',19,'fixture')")
            db.execute("INSERT INTO profile_fields VALUES('grade','','fixture','fixture')")
            db.execute("INSERT INTO workspace_source_bindings VALUES (?,'qq','120',1,1)", (self.owner,))
            db.execute("INSERT INTO sources(platform,account_ref,adapter_instance,conversation_type,"
                       "conversation_id,sender_id,display_name,enabled,auto_prepare,created_at,updated_at) "
                       "VALUES ('qq','120','fixture','group','900','240','合成群',1,0,'fixture','fixture')")
            db.execute("INSERT INTO runs(source_key,url,state,updated_at) VALUES('120:fixture',?,'awaiting_approval','fixture')",
                       (TARGET,))
        self.before = preview(self.root)
        self.cutover = apply(self.root, self.before["digest"])
        self.adapter = FakeSheet()
        self.sheets = Sheets(self.root, execute=False, adapter=self.adapter)
        self.runtime = Abilities()
        self.runtime.register(QQ(self.root, QQSettings("120", "synthetic-onebot-token", "synthetic-callback-token")))
        self.app = create_app(self.root, TOKEN, sheets=self.sheets, abilities=self.runtime)
        life = self.app.router.lifespan_context(self.app)
        await life.__aenter__()
        self.addAsyncCleanup(life.__aexit__, None, None, None)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test",
                                       headers={"Authorization": "Bearer " + TOKEN})
        self.addAsyncCleanup(self.client.aclose)

    async def request(self, path, data=None, expected=None):
        response = await (self.client.get(BASE + path) if data is None else self.client.post(BASE + path, json=data))
        if expected:
            self.assertEqual(response.status_code, expected, response.text)
        else:
            self.assertLess(response.status_code, 300, response.text)
        return response.json()

    async def wait_state(self, path, state):
        for _ in range(100):
            result = await self.request(path)
            if result["state"] == state:
                return result
            await asyncio.sleep(.035)
        self.fail(f"expected {state}, saw {result['state']}: {result['waiting_reason']}")

    async def prepared(self, todo=None):
        task = await self.request("/sheet-tasks", {"target": TARGET, "clientRequestId": "fixture", "todoId": todo})
        path = "/sheet-tasks/" + str(task["id"])
        waiting = await self.wait_state(path, "awaiting_input")
        answer = {"task_version": waiting["state_version"], "answers": [{"key": "grade", "value": "二年级"}]}
        await self.request(path + "/answers", answer)
        await self.request(path + "/answers", answer, 409)
        prepared = await self.wait_state(path, "awaiting_approval")
        plan = prepared["plan"]
        return path, {"plan_id": plan["id"], "plan_version": plan["version"], "plan_digest": plan["digest"],
                      "client_request_id": "approve-fixture"}

    async def test_preserves_backup_and_fences_legacy(self):
        backup = self.root / ".private" / "backups" / self.cutover["backup"] / "poc.sqlite"
        with closing(sqlite3.connect(backup)) as db:
            self.assertEqual(inspect(db), {key: self.before[key] for key in inspect(db)})
        self.assertEqual(len((await self.request("/legacy-runs"))["items"]), 1)
        with self.assertRaisesRegex(WorkspaceError, "python_business_locked"):
            with runtime_lock(self.root):
                pass
        process = subprocess.run([str(legacy.NODE), str(legacy.PROJECT / "src/poc.cjs"), "serve"],
                                 cwd=self.root, capture_output=True, timeout=6)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn(b"python_business_owner", process.stderr)
        self.assertEqual(self.adapter.calls, [])

    async def test_plan_confirmation_and_idempotent_write(self):
        path, approval = await self.prepared()
        await self.request(path + "/approvals", approval, 403)
        self.sheets.execute = True
        await self.request(path + "/approvals", {**approval, "plan_digest": "0" * 64}, 409)
        await self.request(path + "/approvals", approval)
        await self.request(path + "/approvals", approval)
        finished = await self.wait_state(path, "completed")
        self.assertEqual(finished["latest_operation"]["evidence"], {"readback": "matched"})
        self.assertEqual(self.adapter.calls, ["prepare", "prepare", "execute"])

    async def test_uncertain_write_can_only_be_reconciled(self):
        path, approval = await self.prepared()
        self.adapter.interrupt = True
        self.sheets.execute = True
        await self.request(path + "/approvals", approval)
        await self.wait_state(path, "outcome_unknown")
        await self.request(path + "/resume", {}, 409)
        self.sheets.execute = False
        await self.request(path + "/reconcile", {})
        await self.wait_state(path, "completed")
        self.assertEqual(self.adapter.calls, ["prepare", "prepare", "execute", "reconcile"])

    async def test_restart_fences_interrupted_claim(self):
        path, approval = await self.prepared()
        await self.sheets.stop()
        self.sheets.execute = True
        # Simulate a pre-existing durable approval and a worker crash after claiming it.
        with closing(sqlite3.connect(self.database)) as db, db:
            task = int(path.rsplit("/", 1)[-1])
            db.execute("INSERT INTO approvals(task_id,plan_id,plan_version,plan_digest,decision,client_request_id,created_at)"
                       " VALUES(?,?,?,?,'approved','crash-fixture','fixture')",
                       (task, approval["plan_id"], approval["plan_version"], approval["plan_digest"]))
            db.execute("INSERT INTO operations(task_id,plan_id,kind,state,idempotency_key)"
                       " VALUES(?,?,'fill','running','crash-fixture')", (task, approval["plan_id"]))
            db.execute("UPDATE tasks SET state='executing' WHERE id=?", (task,))
        self.adapter.matched = True
        await self.sheets.start()
        await self.wait_state(path, "completed")
        self.assertEqual(self.adapter.calls, ["prepare", "prepare", "reconcile"])

    async def test_qq_acceptance_links_todo_and_revocation_fences_task(self):
        from test_abilities import qq_event
        response = await self.client.post("/api/v1/abilities/qq/callback", json=qq_event(1, f"请提交表格 {TARGET}"),
                                          headers={"Authorization": "Bearer synthetic-callback-token"})
        self.assertEqual(response.status_code, 200, response.text)
        for _ in range(100):
            items = (await self.request("/qq/candidates"))["items"]
            if items:
                break
            await asyncio.sleep(.025)
        identifier = items[0]["id"]
        await self.request(f"/qq/candidates/{identifier}/decision", {"decision": "accepted"})
        for _ in range(100):
            items = (await self.request("/todos"))["items"]
            if items:
                break
            await asyncio.sleep(.035)
        todo = items[0]["id"]
        self.assertEqual(items[0]["target"], TARGET)
        path, approval = await self.prepared(todo)
        self.assertEqual((await self.request(path))["todo_id"], todo)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE workspace_source_bindings SET history_allowed=0")
        self.sheets.execute = True
        await self.request(path + "/approvals", approval, 404)
        self.assertEqual((await self.request("/todos"))["items"], [])
        self.assertNotIn("execute", self.adapter.calls)
