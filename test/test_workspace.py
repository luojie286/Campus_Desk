"""R1 集成验收，使用独立目录和回环主机，不连接 QQ 或模型服务。"""

from __future__ import annotations

from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import re
import sqlite3
import subprocess
import sys
import tempfile
from threading import Thread
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from campusdesk.workspace import apply_migration, migration_plan, set_history_access

PROJECT = Path(__file__).resolve().parents[1]
NODE = PROJECT / ".private/runtime/node-v24.22.2/node.exe"
TOKEN = "synthetic-workspace-token-0000000000000000000000"


def free_port() -> int:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return server.getsockname()[1]


@unittest.skipUnless(NODE.is_file(), "requires the pinned compatibility runtime")
class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory(prefix="lab1-workspace-test-")
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name).resolve()
        self.port = free_port()
        self.local = self.root / ".private"

    def cli(self, *args):
        result = subprocess.run(
            [sys.executable, "-m", "campusdesk", "--root", str(self.root), *args],
            cwd=PROJECT, capture_output=True, encoding="utf-8", timeout=25,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"}, check=False
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def start_host(self, *flags):
        host = subprocess.Popen(
            [str(NODE), str(PROJECT / "src/poc.cjs"), "serve-assistant", *flags],
            cwd=self.root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={**os.environ, "CAMPUS_DESK_ASSISTANT_TOKEN": TOKEN, "DEEPSEEK_API_KEY": "", "LAB1_TEST_MODEL": "fixture"}
        )

        def stop():
            if host.poll() is None:
                host.terminate()
            host.wait(timeout=10)

        self.addCleanup(stop)
        self.stop_host = stop
        for _ in range(100):
            self.assertIsNone(host.poll())
            try:
                return self.get("/health")
            except OSError:
                time.sleep(0.05)
        self.fail("loopback_host_not_started")

    def get(self, route, body=None, token=TOKEN):
        data = None if body is None else json.dumps(body).encode()
        request = Request(f"http://127.0.0.1:{self.port}" + route, data=data,
                          headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with urlopen(request, timeout=3) as response:
            payload = json.load(response)
            return payload.get("data", payload)

    def test_fresh_import_and_reference_without_qq(self):
        initialized = self.cli("init", "--port", str(self.port))
        self.assertTrue(initialized["upgraded"])
        self.assertFalse(initialized["bind_existing_account"])
        self.assertEqual(initialized["workspace_id"], self.cli("init")["workspace_id"])
        source = self.root / "notes"
        source.mkdir()
        (source / "example.md").write_text("本机工作区检索编号 6139", encoding="utf-8")
        plan = self.cli("import-notes", "plan", str(source), "archive")
        self.assertEqual(plan["count"], 1)
        result = self.cli("import-notes", "apply", str(source), "archive", plan["digest"])
        self.assertEqual(result["verified"], 1)
        config = json.loads((self.local / "config.json").read_text(encoding="utf-8"))
        self.assertNotIn("account_id", config)

        class Model(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                system, user = payload["messages"]
                content = json.loads(user["content"])
                source_id = content["evidence"][0]["id"]
                phase = re.search(r"当前阶段 (\w+)", system["content"])
                if phase and phase[1] == "review":
                    output = {"claim_id": content["shared"][0]["id"], "finding": "保留原文依据",
                              "severity": "low", "evidence_ids": [source_id], "proposed_revision": "说明样本范围"}
                elif phase and phase[1] == "assess":
                    output = {"preferred": "new", "reason": "引用可核对", "complete": True}
                else:
                    output = {"answer": "检索编号 6139", "citations": [source_id]}
                data = json.dumps({"choices": [{"message": {"content": json.dumps(output)}}],
                                   "usage": {"total_tokens": 30}}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        thread = Thread(target=model.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(model.server_close)
        self.addCleanup(model.shutdown)
        settings_file = self.local / "assistant.config.json"
        settings = json.loads(settings_file.read_text(encoding="utf-8"))
        settings["models"] = [{"id": "fixture", "label": "Fixture", "model": "fixture", "adapter": "chat-completions",
                              "base_url": f"http://127.0.0.1:{model.server_port}", "credential_env": "LAB1_TEST_MODEL"}]
        settings_file.write_text(json.dumps(settings), encoding="utf-8")
        health = self.start_host()
        self.assertEqual(health["capabilities"], {"knowledge": True, "qq": False, "sheets": False, "briefings": False})
        base = "/v1/assistant"
        session = self.get(base + "/sessions", {})
        self.get(base + "/sessions/" + session["id"] + "/turns", {
            "question": "6139", "useModel": False, "clientRequestId": "fixture-turn"
        })
        for _ in range(50):
            turn = self.get(base + "/sessions/" + session["id"])["turns"][0]
            if "result" in turn:
                break
            time.sleep(0.03)
        self.assertEqual(turn["result"]["status"], "local_evidence")
        item = turn["result"]["evidence"][0]
        self.assertEqual(self.get(base + "/evidence/" + item["id"])["quote"], "本机工作区检索编号 6139")
        doc = item["documentId"]
        preview = self.get(base + "/previews", {"kind": "cloud_grant", "documentId": doc})
        self.get(base + "/previews/" + preview["id"] + "/decision", {
            "decision": "approve", "digest": preview["digest"], "clientRequestId": "fixture-grant"
        })
        self.get(base + "/sessions/" + session["id"] + "/turns", {
            "question": "6139", "useModel": True, "modelId": "fixture", "clientRequestId": "fixture-model-turn"
        })
        for _ in range(80):
            turn = self.get(base + "/sessions/" + session["id"])["turns"][-1]
            if "result" in turn:
                break
            time.sleep(0.03)
        self.assertEqual(turn["result"]["status"], "answered")
        started = self.get(base + "/research", {
            "question": "核对编号", "sourceIds": [doc], "clientRequestId": "fixture-research"
        })
        for _ in range(100):
            research = self.get(base + "/research/" + started["id"])
            if research["state"] != "running":
                break
            time.sleep(0.03)
        self.assertEqual(research["state"], "completed")
        self.assertEqual(research["budget"]["calls"], 6)
        with self.assertRaises(HTTPError) as error:
            self.get("/onebot", {"post_type": "message"})
        self.assertEqual(error.exception.code, 404)

    def test_onebot_adapter_deduplicates_and_disabled_ingress_keeps_history(self):
        self.cli("init", "--port", str(self.port))
        filename = self.local / "config.json"
        config = json.loads(filename.read_text(encoding="utf-8"))
        config["account_id"] = "9991"
        config["source"] = {"type": "private", "id": "7316"}
        filename.write_text(json.dumps(config), encoding="utf-8")
        self.cli("bind-qq", "9991")
        self.assertTrue(self.start_host("--qq")["capabilities"]["qq"])
        event = {"post_type": "message", "message_type": "private", "self_id": "9991", "user_id": "7316",
                 "message_id": "fixture-event", "message": "合成历史消息 2841"}
        with ThreadPoolExecutor(max_workers=4) as pool:
            outcomes = list(pool.map(lambda _: self.get("/onebot", event, config["token"]), range(4)))
        self.assertEqual(sum(result["stored"] for result in outcomes), 1)
        self.assertEqual(sum(result["duplicate"] for result in outcomes), 3)
        self.assertEqual(self.get("/onebot", {**event, "self_id": "9992"}, config["token"])["reason"], "source_filtered")
        self.assertEqual(self.get("/onebot", {**event, "user_id": "7317"}, config["token"])["reason"], "source_filtered")
        self.stop_host()
        self.assertFalse(self.start_host()["capabilities"]["qq"])
        self.assertEqual(len(self.get("/v1/assistant/messages?text=2841")["items"]), 1)
        with self.assertRaises(HTTPError) as error:
            self.get("/onebot", event, config["token"])
        self.assertEqual(error.exception.code, 404)

    def test_migration_keeps_ids_and_does_not_merge_unknown_owner(self):
        subprocess.run([str(NODE), str(PROJECT / "tools/workspace-bootstrap.cjs"), str(self.port)],
                       cwd=self.root, check=True, timeout=10)
        config_file = self.local / "config.json"
        config = json.loads(config_file.read_text(encoding="utf-8"))
        config["account_id"] = "9991"
        config_file.write_text(json.dumps(config), encoding="utf-8")
        filename = self.local / "poc.sqlite"
        content = b"synthetic evidence 6630"
        (self.local / "kb/objects/example.md").write_bytes(content)
        with closing(sqlite3.connect(filename)) as db, db:
            db.execute("INSERT INTO kb_documents VALUES('same-id','9991',NULL,'example.md','same-rev','active')")
            db.execute("INSERT INTO kb_revisions VALUES('same-rev','same-id',?,'objects/example.md')", (hashlib.sha256(content).hexdigest(),))
            db.execute("INSERT INTO kb_chunks VALUES(91,'same-rev','line 1',?)", (content.decode(),))
            db.execute("INSERT INTO kb_fts(rowid,terms) VALUES(91,'synthetic evidence 6630')")
            db.execute("INSERT INTO kb_grants VALUES('9991','same-id')")
            db.execute("INSERT INTO kb_grants VALUES('9992','other-resource')")
            db.execute("INSERT INTO messages(id,platform,adapter_instance,account_ref,conversation_type,conversation_id,sender_id,"
                       "source_message_id,received_at,content_text,created_at,updated_at) "
                       "VALUES(12,'qq','fixture','9991','private','fixture','fixture','m1','now','合成消息 5126','now','now')")
            db.execute("INSERT INTO todos(id,title,created_at,updated_at) VALUES(23,'旧待办','now','now')")
            db.execute("INSERT INTO todo_messages VALUES(23,12,'now')")
            db.execute("INSERT INTO kb_documents VALUES('old-todo-id','9991',NULL,'旧待办来源','old-todo-rev','active')")
            db.execute("INSERT INTO kb_revisions VALUES('old-todo-rev','old-todo-id','fixture','')")
            db.execute("INSERT INTO kb_chunks VALUES(92,'old-todo-rev','source','合成消息 5126')")
            db.execute("INSERT INTO kb_fts(rowid,terms) VALUES(92,'5126')")
            db.execute("INSERT INTO kb_todo_sources VALUES('old-todo-rev',12,'合成消息 5126')")
            db.execute("INSERT INTO kb_todo_admissions VALUES(23,'old-todo-rev')")
        plan = migration_plan(self.root)
        self.assertEqual(plan["unmapped_records"], 1)
        result = apply_migration(self.root, plan["digest"])
        self.assertEqual(result["verified_objects"], 1)
        workspace = result["workspace_id"]
        self.assertFalse(apply_migration(self.root, plan["digest"])["upgraded"])
        with closing(sqlite3.connect(filename)) as db:
            self.assertEqual(db.execute("SELECT owner,rev FROM kb_documents WHERE id='same-id'").fetchone(), (workspace, "same-rev"))
            self.assertEqual(db.execute("SELECT owner FROM kb_grants WHERE target='other-resource'").fetchone(), ("9992",))
            self.assertEqual(db.execute("SELECT owner FROM kb_grants WHERE target='same-id'").fetchone(), (workspace,))
        self.assertEqual(len(list((self.local / "backups").glob("before-workspace-*.sqlite"))), 1)
        health = self.start_host("--sheets")
        self.assertTrue(health["capabilities"]["sheets"])
        self.assertFalse(health["capabilities"]["qq"])
        self.assertEqual(self.get("/v1/assistant/evidence/91")["documentId"], "same-id")
        self.assertEqual(self.get("/v1/assistant/evidence/92")["documentId"], "old-todo-id")
        with closing(sqlite3.connect(filename)) as db, db:
            db.execute("UPDATE workspace_source_bindings SET history_allowed=0 WHERE account_ref='9991'")
        with self.assertRaises(HTTPError) as error:
            self.get("/v1/assistant/evidence/92")
        self.assertEqual(error.exception.code, 404)
