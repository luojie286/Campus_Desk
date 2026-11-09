"""Python task planning, approval and write recovery over the existing records."""

import asyncio
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import parse_qs, quote, urlsplit

from .abilities.qq import QQ
from .abilities.tencent import SheetAdapterError, TencentAdapter
from .cutover import owned, recover, runtime_lock
from .knowledge.sources import profile_fields
from .workbench_errors import WorkbenchError
from .workspace import WorkspaceError, default_workspace, read_config

VISIBLE = """
t.id IN (SELECT task_id FROM workspace_tasks WHERE workspace_id=?)
AND (t.account_ref=? OR EXISTS (
 SELECT 1 FROM workspace_source_bindings b WHERE b.workspace_id=? AND b.provider='qq'
 AND b.account_ref=t.account_ref AND b.history_allowed=1))
AND (t.todo_id IS NULL OR EXISTS (SELECT 1 FROM todos v WHERE v.id=t.todo_id AND v.status<>'deleted'
 AND EXISTS (SELECT 1 FROM todo_messages x WHERE x.todo_id=v.id)
 AND NOT EXISTS (SELECT 1 FROM todo_messages x LEFT JOIN messages m ON m.id=x.message_id
  WHERE x.todo_id=v.id AND NOT EXISTS (SELECT 1 FROM workspace_source_bindings b WHERE b.workspace_id=?
   AND b.provider=m.platform AND b.account_ref=m.account_ref AND b.history_allowed=1))))
"""
TODO_VISIBLE = """
EXISTS (SELECT 1 FROM todo_messages x WHERE x.todo_id=t.id)
AND NOT EXISTS (SELECT 1 FROM todo_messages x LEFT JOIN messages m ON m.id=x.message_id
 WHERE x.todo_id=t.id AND NOT EXISTS (SELECT 1 FROM workspace_source_bindings b
 WHERE b.workspace_id=? AND b.provider=m.platform AND b.account_ref=m.account_ref AND b.history_allowed=1))
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def json_text(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value: str) -> str:
    return sha256(value.encode()).hexdigest()


def canonical(raw: str) -> str:
    try:
        url = urlsplit(raw)
        if (len(raw) > 2048 or url.scheme != "https" or url.hostname != "docs.qq.com" or url.port is not None
                or url.username is not None or url.password is not None
                or not re.fullmatch(r"/sheet/[A-Za-z0-9_-]+", url.path)):
            raise ValueError()
        tab = parse_qs(url.query).get("tab", [""])[0]
        return "https://docs.qq.com" + url.path + ("?tab=" + quote(tab, safe="!'()*~") if tab else "")
    except ValueError as error:
        raise WorkbenchError(422, "invalid_target") from error


def inputs(db, task_id):
    profile = profile_fields(db)
    overrides = {}
    for row in db.execute("SELECT key,value FROM task_answers WHERE task_id=? ORDER BY task_version DESC,key", (task_id,)):
        if row["key"] in profile:
            overrides.setdefault(row["key"], row["value"])
    return profile | overrides


def fingerprint(plan: dict, profile: dict) -> str:
    keys = {"name", "student_id"}
    for section in ("columns", "changes", "missing"):
        keys.update(row["field"] for row in plan.get(section, []))
    return digest(json_text([[key, profile.get(key)] for key in sorted(keys)]))


class Sheets:
    def __init__(self, root: Path, execute: bool = False, adapter=None, qq: QQ | None = None):
        self.root = root
        self.database = root / ".private" / "poc.sqlite"
        self.execute = execute
        self.adapter = adapter or TencentAdapter(root)
        self.qq = qq
        self.worker: asyncio.Task | None = None
        self.stopping = False
        self.wake = asyncio.Event()

    @contextmanager
    def db(self, write=False):
        uri = self.database.resolve(strict=True).as_uri() + ("?mode=rw" if write else "?mode=ro")
        with closing(sqlite3.connect(uri, uri=True, timeout=5)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield db

    @staticmethod
    def owner(db):
        workspace = default_workspace(db)
        if workspace is None:
            raise WorkbenchError(503, "workspace_not_initialized")
        return workspace

    def active(self):
        if not owned(self.root) or not self.worker or self.worker.done() or self.stopping:
            raise WorkbenchError(503, "python_business_inactive")

    def can_execute(self):
        if not self.execute or not owned(self.root):
            return False
        try:
            return read_config(self.root).get("execute") is True
        except WorkspaceError:
            return False

    async def start(self):
        if not owned(self.root):
            return
        lock = runtime_lock(self.root)
        lock.__enter__()
        try:
            with self.db(write=True) as db:
                recover(db)
            self.stopping = False
            self.worker = asyncio.create_task(self.consume())
        except BaseException:
            lock.__exit__(None, None, None)
            raise
        self.lock = lock

    async def stop(self):
        if self.worker:
            self.stopping = True
            self.wake.set()
            await asyncio.gather(self.worker, return_exceptions=True)
            self.worker = None
            self.lock.__exit__(None, None, None)

    def visible(self, db, identifier):
        owner = self.owner(db)
        row = db.execute("SELECT t.* FROM tasks t WHERE t.id=? AND t.executor_type='tencent_sheet' AND " + VISIBLE,
                         (identifier, owner, owner, owner, owner)).fetchone()
        if not row:
            raise WorkbenchError(404, "task_not_found")
        return row

    @staticmethod
    def current_plan(db, task):
        return db.execute("SELECT * FROM plans WHERE task_id=? AND id=? AND status='current'",
                          (task["id"], task["current_plan_id"])).fetchone()

    @staticmethod
    def change(db, identifier, state, reason=None):
        db.execute("UPDATE tasks SET state=?,state_version=state_version+1,updated_at=?,waiting_reason=?,"
                   "completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END WHERE id=?",
                   (state, now(), reason, state, now(), identifier))

    def create(self, target, key, todo=None):
        self.active()
        target = canonical(target)
        with self.db(write=True) as db:
            owner = self.owner(db)
            if todo is not None and not db.execute(
                "SELECT 1 FROM todos t WHERE t.id=? AND t.status='open' AND " + TODO_VISIBLE, (todo, owner),
            ).fetchone():
                raise WorkbenchError(404, "todo_not_found")
            row = db.execute("SELECT id,target_ref,todo_id FROM tasks WHERE account_ref=? AND request_key=?",
                             (owner, "desktop:" + key)).fetchone()
            if row:
                if row["target_ref"] != target or row["todo_id"] != todo:
                    raise WorkbenchError(409, "idempotency_conflict")
                return {"id": row["id"]}
            if todo is not None:
                prior = db.execute("SELECT id FROM tasks WHERE todo_id=? AND target_ref=? AND kind='doc_fill'",
                                   (todo, target)).fetchone()
                if prior:
                    return {"id": self.visible(db, prior["id"])["id"]}
            identifier = db.execute(
                """INSERT INTO tasks(todo_id,kind,executor_type,account_ref,target_ref,state,created_at,updated_at,request_key)
                   VALUES(?,'doc_fill','tencent_sheet',?,?,'preparing',?,?,?)""",
                (todo, owner, target, now(), now(), "desktop:" + key),
            ).lastrowid
            db.execute("INSERT INTO workspace_tasks VALUES(?,?,'desktop')", (identifier, owner))
        return {"id": identifier}

    def list(self):
        self.active()
        with self.db() as db:
            owner = self.owner(db)
            return [dict(row) for row in db.execute(
                "SELECT t.* FROM tasks t WHERE t.executor_type='tencent_sheet' AND " + VISIBLE +
                " ORDER BY t.updated_at DESC,t.id DESC LIMIT 100", (owner, owner, owner, owner),
            )]

    def detail(self, identifier):
        self.active()
        with self.db() as db:
            task = dict(self.visible(db, identifier))
            plan = self.current_plan(db, task)
            task["plan"] = (dict(plan) | {"plan": json.loads(plan["plan_json"]), "preconditions": None}) if plan else None
            questions = db.execute("SELECT * FROM task_questions WHERE task_id=? AND task_version=? ORDER BY key",
                                   (identifier, task["state_version"]))
            task["questions"] = [dict(row) for row in questions]
            task["answers"] = [dict(row) for row in db.execute(
                "SELECT a.* FROM task_answers a WHERE a.task_id=? AND a.task_version="
                "(SELECT MAX(b.task_version) FROM task_answers b WHERE b.task_id=a.task_id AND b.key=a.key)",
                (identifier,),
            )]
            operation = db.execute("SELECT * FROM operations WHERE task_id=? ORDER BY id DESC LIMIT 1",
                                   (identifier,)).fetchone()
            task["latest_operation"] = dict(operation) | {
                "evidence": json.loads(operation["evidence_json"]) if operation["evidence_json"] else None,
            } if operation else None
            return task

    def approve(self, identifier, plan_id, version, expected, request_id):
        self.active()
        if not self.can_execute():
            raise WorkbenchError(403, "execute_disabled")
        stale = False
        with self.db(write=True) as db:
            task = self.visible(db, identifier)
            existing = db.execute("SELECT * FROM approvals WHERE client_request_id=?", (request_id,)).fetchone()
            if existing:
                if (existing["task_id"], existing["plan_id"], existing["plan_version"], existing["plan_digest"]) != (
                    identifier, plan_id, version, expected
                ):
                    raise WorkbenchError(409, "idempotency_conflict")
                return {"id": identifier, "state": task["state"]}
            plan = self.current_plan(db, task)
            if (not plan or (plan["id"], plan["version"], plan["digest"]) != (plan_id, version, expected)
                    or digest(plan["plan_json"]) != expected or plan["document_ref"] != task["target_ref"]
                    or (plan["expires_at"] and plan["expires_at"] <= now())):
                raise WorkbenchError(409, "plan_not_current")
            operation_key = f"{identifier}:{plan_id}:fill"
            if db.execute("SELECT 1 FROM operations WHERE idempotency_key=?", (operation_key,)).fetchone():
                return {"id": identifier, "state": task["state"]}
            if task["state"] != "awaiting_approval":
                raise WorkbenchError(409, "invalid_task_state")
            data = json.loads(plan["plan_json"])
            if data.get("warnings") or data.get("missing") or not data.get("changes"):
                raise WorkbenchError(409, "plan_has_warnings")
            if data.get("profileFingerprint") != fingerprint(data, inputs(db, identifier)):
                self.change(db, identifier, "preparing", "profile_changed")
                stale = True
            else:
                db.execute("INSERT INTO approvals(task_id,plan_id,plan_version,plan_digest,decision,client_request_id,created_at)"
                           " VALUES(?,?,?,?,'approved',?,?)", (identifier, plan_id, version, expected, request_id, now()))
                db.execute("INSERT INTO operations(task_id,plan_id,kind,state,idempotency_key) VALUES(?,?,'fill','queued',?)",
                           (identifier, plan_id, operation_key))
                self.change(db, identifier, "approved")
        if stale:
            raise WorkbenchError(409, "profile_changed")
        return {"id": identifier, "state": "approved"}

    def answer(self, identifier, answers, expected_version):
        self.active()
        with self.db(write=True) as db:
            task = self.visible(db, identifier)
            if task["state"] != "awaiting_input" or task["state_version"] != expected_version:
                raise WorkbenchError(409, "invalid_task_state")
            allowed = {row[0] for row in db.execute(
                "SELECT key FROM task_questions WHERE task_id=? AND task_version=?", (identifier, expected_version),
            )}
            keys = [entry["key"] for entry in answers]
            if len(keys) != len(set(keys)) or not set(keys) <= allowed:
                raise WorkbenchError(422, "invalid_task_answers")
            for item in answers:
                db.execute("INSERT INTO task_answers(task_id,task_version,key,value,answered_at) VALUES(?,?,?,?,?)",
                           (identifier, expected_version, item["key"], item["value"], now()))
            self.change(db, identifier, "preparing")

    def action(self, identifier, action):
        self.active()
        with self.db(write=True) as db:
            task = self.visible(db, identifier)
            state = task["state"]
            if action == "resume" and state in ("failed_retryable", "paused_login_required"):
                self.change(db, identifier, "preparing")
            elif action == "reconcile" and state == "outcome_unknown":
                db.execute("INSERT OR IGNORE INTO python_sheet_rechecks VALUES(?)", (identifier,))
            elif action == "cancel" and state in (
                "created", "preparing", "awaiting_input", "awaiting_approval", "approved",
                "failed_retryable", "paused_login_required", "cancelled",
            ):
                db.execute("UPDATE operations SET state='failed_terminal',error_class='cancelled',finished_at=? "
                           "WHERE task_id=? AND state='queued'", (now(), identifier))
                if state != "cancelled":
                    self.change(db, identifier, "cancelled")
            else:
                raise WorkbenchError(409, "invalid_task_state")

    def claim(self):
        with self.db(write=True) as db:
            # The sole worker is between adapter calls. A lingering write
            # marker here means result recording failed, so only read back.
            if db.execute("SELECT 1 FROM tasks WHERE executor_type='tencent_sheet' "
                          "AND state IN ('executing','verifying') LIMIT 1").fetchone():
                recover(db)
            owner = self.owner(db)
            base = "SELECT t.* FROM tasks t WHERE t.executor_type='tencent_sheet' AND " + VISIBLE
            args = (owner, owner, owner, owner)
            check = db.execute(base + " AND t.state='outcome_unknown' AND t.id IN (SELECT task_id FROM python_sheet_rechecks)"
                               " ORDER BY t.id LIMIT 1", args).fetchone()
            if check:
                db.execute("DELETE FROM python_sheet_rechecks WHERE task_id=?", (check["id"],))
                write = db.execute(
                    "SELECT o.id,p.plan_json,p.digest,p.document_ref FROM operations o LEFT JOIN plans p "
                    "ON p.id=o.plan_id AND p.task_id=o.task_id WHERE o.task_id=? AND o.kind='fill' "
                    "AND o.state='unknown' ORDER BY o.id DESC LIMIT 1", (check["id"],),
                ).fetchone()
                if (not write or not write["plan_json"] or digest(write["plan_json"]) != write["digest"]
                        or write["document_ref"] != check["target_ref"]):
                    self.change(db, check["id"], "failed_terminal", "reconcile_plan_invalid")
                else:
                    return "reconcile", dict(check), json.loads(write["plan_json"]), None, write["id"]
            pending = db.execute(base + " AND t.state IN ('created','preparing') ORDER BY t.id LIMIT 1", args).fetchone()
            if pending:
                reservation = db.execute("SELECT * FROM reservations WHERE url=? ORDER BY created_at DESC LIMIT 1",
                                         (pending["target_ref"],)).fetchone()
                return "prepare", dict(pending), None, inputs(db, pending["id"]), dict(reservation) if reservation else None
            if not self.can_execute():
                return None
            approved = db.execute(base + " AND t.state='approved' ORDER BY t.id LIMIT 1", args).fetchone()
            if not approved:
                return None
            plan = self.current_plan(db, approved)
            if not plan:
                self.change(db, approved["id"], "failed_retryable", "plan_not_current")
                return None
            operation = db.execute("SELECT o.id FROM operations o WHERE o.task_id=? AND o.plan_id=? AND o.state='queued' "
                                   "AND EXISTS (SELECT 1 FROM approvals a WHERE a.task_id=o.task_id AND a.plan_id=o.plan_id "
                                   "AND a.plan_version=? AND a.plan_digest=? AND a.decision='approved')",
                                   (approved["id"], plan["id"], plan["version"], plan["digest"])).fetchone()
            data, profile = json.loads(plan["plan_json"]), inputs(db, approved["id"])
            valid = (operation and digest(plan["plan_json"]) == plan["digest"]
                     and data.get("document") == approved["target_ref"] and plan["document_ref"] == approved["target_ref"]
                     and not data.get("missing") and not data.get("warnings") and data.get("changes")
                     and data.get("profileFingerprint") == fingerprint(data, profile)
                     and (not plan["expires_at"] or plan["expires_at"] > now()))
            if not valid:
                db.execute("UPDATE operations SET state='failed_terminal',error_class='plan_not_current',finished_at=? "
                           "WHERE task_id=? AND state='queued'", (now(), approved["id"]))
                self.change(db, approved["id"], "failed_retryable", "plan_not_current")
                return None
            db.execute("UPDATE operations SET state='running',attempt=attempt+1,started_at=? WHERE id=?",
                       (now(), operation["id"]))
            self.change(db, approved["id"], "executing")
            return "execute", dict(approved), data, profile, operation["id"]

    def prepared(self, db, task, profile, data):
        identifier = task["id"]
        current = self.visible(db, identifier)
        if current["state"] not in ("created", "preparing") or current["state_version"] != task["state_version"]:
            return
        if profile != inputs(db, identifier):
            self.change(db, identifier, "preparing", "profile_changed")
            return
        data["profileFingerprint"] = fingerprint(data, profile)
        payload = json_text(data)
        version = db.execute("SELECT COALESCE(MAX(version),0)+1 FROM plans WHERE task_id=?", (identifier,)).fetchone()[0]
        expires = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        db.execute("UPDATE plans SET status='superseded' WHERE task_id=? AND status='current'", (identifier,))
        plan_id = db.execute(
            "INSERT INTO plans(task_id,version,kind,document_ref,digest,plan_json,status,expires_at,created_at)"
            " VALUES(?,?,'doc_fill',?,?,?,'current',?,?)",
            (identifier, version, task["target_ref"], digest(payload), payload, expires, now()),
        ).lastrowid
        db.execute("UPDATE tasks SET current_plan_id=? WHERE id=?", (plan_id, identifier))
        missing = {item["field"]: item for item in data.get("missing", [])}
        if missing:
            self.change(db, identifier, "awaiting_input")
            for key, item in missing.items():
                db.execute("INSERT INTO task_questions(task_id,task_version,key,label,kind,reason,created_at)"
                           " VALUES(?,?,?,?,'text','profile_value_missing',?)",
                           (identifier, task["state_version"] + 1, key, item.get("header") or key, now()))
        elif not data.get("changes"):
            self.change(db, identifier, "completed")
        else:
            self.change(db, identifier, "awaiting_approval", "plan_has_warnings" if data.get("warnings") else None)

    def run_one(self):
        job = self.claim()
        if not job:
            return False
        action, task, plan, profile, extra = job
        identifier = task["id"]
        try:
            payload = {"target": task["target_ref"], "plan": plan, "profile": profile}
            if action == "prepare":
                payload["reservation"] = extra
            if action == "execute":
                payload["task_id"], payload["operation_id"] = identifier, extra
                # Scope and data may change after the claim. Never call the
                # browser with a stale grant, even if a queued approval exists.
                with self.db() as db:
                    self.visible(db, identifier)
                    if not self.can_execute() or plan["profileFingerprint"] != fingerprint(plan, inputs(db, identifier)):
                        raise SheetAdapterError("profile_or_execution_changed")
            result = self.adapter.call(action, **payload)
            error = None if action == "prepare" or result.get("matched") is True else "readback_mismatch"
            attempted = action == "execute"
        except (SheetAdapterError, WorkbenchError) as failure:
            result = {}
            error = str(failure)
            attempted = isinstance(failure, SheetAdapterError) and failure.attempted
        with self.db(write=True) as db:
            if action == "prepare":
                try:
                    current = self.visible(db, identifier)
                except WorkbenchError:
                    return True
                if current["state"] in ("created", "preparing") and current["state_version"] == task["state_version"]:
                    if error:
                        state = "paused_login_required" if error == "login_required" else "failed_retryable"
                        self.change(db, identifier, state, error)
                    else:
                        self.prepared(db, task, profile, result["plan"])
            else:
                uncertain = action == "reconcile" or attempted
                state = "completed" if not error else "outcome_unknown" if uncertain else (
                    "paused_login_required" if error == "login_required" else "failed_retryable")
                evidence = json_text({"readback": "matched" if not error else "unknown" if uncertain else "not_started"})
                if extra is not None:
                    db.execute("UPDATE operations SET state=?,error_class=?,finished_at=?,evidence_json=? WHERE id=?",
                               ("completed" if not error else "unknown" if uncertain else "failed_retryable",
                                error, now(), evidence, extra))
                self.change(db, identifier, state, error)
                if not error and plan.get("identityMode") == "reserved":
                    db.execute('DELETE FROM reservations WHERE url=? AND "row"=?', (task["target_ref"], plan["identityRow"]))
        return True

    async def consume(self):
        while not self.stopping:
            self.wake.clear()
            try:
                await asyncio.to_thread(self.sync_candidates)
            except (OSError, sqlite3.Error, WorkspaceError):
                pass
            try:
                if await asyncio.to_thread(self.run_one):
                    continue
            except (OSError, sqlite3.Error, WorkspaceError, ValueError):
                pass
            if not self.stopping:
                try:
                    await asyncio.wait_for(self.wake.wait(), timeout=1)
                except TimeoutError:
                    pass

    def todos(self):
        self.active()
        with self.db() as db:
            owner = self.owner(db)
            rows = db.execute("SELECT t.* FROM todos t WHERE t.status IN ('open','done') AND " + TODO_VISIBLE +
                              " ORDER BY t.updated_at DESC,t.id DESC LIMIT 100", (owner,))
            items = []
            for row in rows:
                targets = set()
                for (body,) in db.execute("SELECT m.content_text FROM todo_messages x JOIN messages m ON m.id=x.message_id "
                                          "WHERE x.todo_id=? ORDER BY x.message_id LIMIT 32", (row["id"],)):
                    for candidate in re.findall(r"https://docs\.qq\.com/sheet/[A-Za-z0-9_-]+(?:\?[^\s<>\"]*)?", body or ""):
                        try:
                            targets.add(canonical(candidate))
                        except WorkbenchError:
                            continue
                items.append(dict(row) | {"target": next(iter(targets)) if len(targets) == 1 else None})
            return items

    def todo_status(self, identifier, status):
        self.active()
        with self.db(write=True) as db:
            owner = self.owner(db)
            row = db.execute("SELECT t.status FROM todos t WHERE t.id=? AND " + TODO_VISIBLE,
                             (identifier, owner)).fetchone()
            if not row or row["status"] == "deleted" and status != "deleted":
                raise WorkbenchError(404, "todo_not_found")
            db.execute("UPDATE todos SET status=?,updated_at=? WHERE id=?", (status, now(), identifier))

    def legacy_runs(self):
        self.active()
        with self.db() as db:
            owner = self.owner(db)
            rows = db.execute(
                "SELECT r.id,r.url,r.state FROM runs r WHERE EXISTS (SELECT 1 FROM workspace_source_bindings b "
                "WHERE b.workspace_id=? AND b.provider='qq' AND b.history_allowed=1 "
                "AND substr(r.source_key,1,length(b.account_ref)+1)=b.account_ref||':') "
                "ORDER BY r.id DESC LIMIT 100", (owner,),
            )
            return [dict(row) for row in rows]

    def prepare_legacy(self, identifier):
        item = next((entry for entry in self.legacy_runs() if entry["id"] == identifier), None)
        if item is None:
            raise WorkbenchError(404, "legacy_run_not_found")
        if item["state"] not in ("received", "prepared", "needs_identity", "awaiting_approval", "failed"):
            raise WorkbenchError(409, "legacy_run_not_repreparable")
        return self.create(item["url"], f"legacy-run-{identifier}")

    def sync_candidates(self):
        if not self.qq or not self.qq.database.is_file():
            return
        scope = self.qq.scope()
        if not scope[2]:
            return
        with closing(self.qq.open()) as source, self.db(write=True) as db:
            owner = self.owner(db)
            accepted = source.execute(
                "SELECT e.*,c.title FROM qq_events e JOIN qq_candidates c ON c.event_id=e.id "
                "WHERE e.workspace=? AND e.account=? AND c.state='accepted' ORDER BY e.id",
                (owner, self.qq.settings.account),
            )
            for item in accepted:
                if not self.qq.visible(item, scope) or db.execute(
                    "SELECT 1 FROM python_qq_todos WHERE workspace=? AND event_id=?", (owner, item["id"]),
                ).fetchone():
                    continue
                keys = (item["account"], item["kind"], item["conversation"], item["message"])
                timestamp = now()
                db.execute(
                    """INSERT OR IGNORE INTO messages(platform,adapter_instance,account_ref,conversation_type,
                    conversation_id,sender_id,source_message_id,received_at,kind,content_text,created_at,updated_at,
                    conversation_name,identity_quality) VALUES('qq','python-qq',?,?,?,?,?,?,'text',?,?,?,?,'stable_id')""",
                    (*keys[:3], item["sender"], keys[3], timestamp, item["body"], timestamp, timestamp, item["source_name"]),
                )
                message = db.execute("SELECT id,sender_id FROM messages WHERE platform='qq' AND account_ref=? "
                                     "AND conversation_type=? AND conversation_id=? AND source_message_id=?", keys).fetchone()
                if message["sender_id"] != item["sender"]:
                    continue
                existing = db.execute("SELECT tm.todo_id FROM todo_messages tm JOIN todos t ON t.id=tm.todo_id "
                                      "WHERE tm.message_id=? AND t.status<>'deleted' ORDER BY tm.todo_id LIMIT 1",
                                      (message["id"],)).fetchone()
                if existing:
                    todo = existing[0]
                else:
                    todo = db.execute("INSERT INTO todos(title,status,priority,created_at,updated_at)"
                                      " VALUES(?,'open',0,?,?)", (item["title"], timestamp, timestamp)).lastrowid
                    db.execute("INSERT INTO todo_messages VALUES(?,?,?)", (todo, message["id"], timestamp))
                db.execute("INSERT INTO python_qq_todos VALUES(?,?,?)", (item["id"], owner, todo))
