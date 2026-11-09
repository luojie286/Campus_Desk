"""NapCat callback and history intake, with a separate durable candidate queue."""

import asyncio
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
import re
import sqlite3

import httpx

from . import AbilityEvent, AbilitySpec, EventConsumer
from .http import request_json
from ..messages import select_source
from ..workbench_errors import WorkbenchError
from ..workspace import default_workspace, table_exists

SCHEMA = """
CREATE TABLE IF NOT EXISTS qq_events(
    id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, account TEXT NOT NULL,
    kind TEXT NOT NULL, conversation TEXT NOT NULL, sender TEXT NOT NULL, message TEXT NOT NULL,
    source_name TEXT NOT NULL, body TEXT NOT NULL, source_time INTEGER,
    origin TEXT NOT NULL, queued INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
    UNIQUE(workspace,account,kind,conversation,message)
);
CREATE INDEX IF NOT EXISTS qq_pending ON qq_events(queued,processed,id);
"""


@dataclass(frozen=True)
class QQSettings:
    account: str
    api_token: str
    callback_token: str
    port: int = 9088
    history_suggestions: bool = False


class QQ:
    spec = AbilitySpec("qq.listen", 1, "continuous")

    def __init__(self, root: Path, settings: QQSettings, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.knowledge = root / ".private" / "poc.sqlite"
        self.database = root / ".private" / "abilities.sqlite"
        self.transport = transport
        self.worker: asyncio.Task | None = None
        self.wake = asyncio.Event()
        self.history_lock = asyncio.Lock()
        self.degraded = False
        self.consumer: EventConsumer | None = None
        self.stopping = False

    def scope(self) -> tuple[str | None, bool, bool, list[dict]]:
        uri = self.knowledge.resolve(strict=True).as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN")
            owner = default_workspace(db)
            bound = db.execute(
                "SELECT ingress_enabled,history_allowed FROM workspace_source_bindings "
                "WHERE workspace_id=? AND provider='qq' AND account_ref=?",
                (owner, self.settings.account),
            ).fetchone()
            rows = []
            if bound and table_exists(db, "sources"):
                rows = db.execute(
                    """SELECT id,platform,enabled,conversation_type AS type,account_ref AS account,
                              conversation_id AS conversation,sender_id AS sender,display_name
                       FROM sources WHERE platform='qq' AND account_ref=? AND enabled=1 ORDER BY id DESC""",
                    (self.settings.account,),
                ).fetchall()
        return owner, bool(bound and bound[0]), bool(bound and bound[1]), [dict(row) for row in rows]

    def open(self):
        db = sqlite3.connect(self.database, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def prepare(self):
        self.scope()
        with closing(self.open()) as db:
            db.executescript(SCHEMA)
            if self.consumer:
                self.consumer.initialize(db)

    async def start(self):
        if self.worker is None:
            await asyncio.to_thread(self.prepare)
            self.stopping = False
            self.worker = asyncio.create_task(self.consume())

    async def stop(self):
        if self.worker:
            # Let the current SQLite transaction close before releasing the
            # runtime. Unclaimed rows remain queued for the next start.
            self.stopping = True
            self.wake.set()
            await asyncio.gather(self.worker, return_exceptions=True)
            self.worker = None

    def status(self):
        if not self.worker:
            return "stopped"
        return "degraded" if self.degraded or self.worker.done() else "running"

    @staticmethod
    def body(event: dict) -> str:
        value = event.get("message", event.get("raw_message", ""))
        if isinstance(value, str):
            return value.strip()[:12000]
        if not isinstance(value, list):
            return ""
        chunks = []
        for part in value:
            if not isinstance(part, dict) or not isinstance(part.get("data"), dict):
                continue
            data = part["data"]
            if part.get("type") == "text" and isinstance(data.get("text"), str):
                chunks.append(data["text"])
            elif part.get("type") in ("json", "xml") and isinstance(data.get("data"), str):
                chunks.extend(re.findall(r"https://docs\.qq\.com/(?:sheet|doc)/[A-Za-z0-9_-]+",
                                         data["data"].replace(r"\/", "/"), flags=re.I)[:4])
        return " ".join(chunks).strip()[:12000]

    def store(self, events: list[dict], history=False) -> dict:
        owner, ingress, history_allowed, sources = self.scope()
        if history and not history_allowed:
            raise WorkbenchError(403, "qq_history_denied")
        context = {"account": self.settings.account, "ingress_allowed": bool(owner and (history_allowed if history else ingress))}
        count = duplicates = filtered = 0
        with closing(self.open()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            for event in events:
                selected = select_source(context, event, sources).get("source_id")
                if not selected or str(event.get("user_id")) == self.settings.account:
                    filtered += 1
                    continue
                source = next(row for row in sources if row["id"] == selected)
                body = self.body(event)
                if not body:
                    filtered += 1
                    continue
                sender = str(event["user_id"])
                message = str(event["message_id"])
                time = event.get("time")
                time = time if type(time) is int and 0 <= time < 2**63 else None
                identity = (owner, self.settings.account, source["type"], source["conversation"], message)
                queued = int((not history or self.settings.history_suggestions) and history_allowed)
                cursor = db.execute(
                    """INSERT OR IGNORE INTO qq_events(workspace,account,kind,conversation,message,sender,
                        source_name,body,source_time,origin,queued) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (*identity, sender, source["display_name"] or source["type"], body, time,
                     "history" if history else "realtime", queued),
                )
                if cursor.rowcount:
                    count += 1
                else:
                    duplicates += 1
                    if not history:
                        # A message previously imported with history automation
                        # disabled can still earn one live dispatch.
                        db.execute(
                            "UPDATE qq_events SET origin='realtime',queued=MAX(queued,?) "
                            "WHERE workspace=? AND account=? AND kind=? AND conversation=? AND message=? AND sender=?",
                            (queued, *identity, sender),
                        )
        return {"stored": count, "duplicates": duplicates, "filtered": filtered}

    async def receive(self, event: dict) -> dict:
        self.require_running()
        result = await asyncio.to_thread(self.store, [event])
        self.wake.set()
        return result

    @staticmethod
    def visible(row: sqlite3.Row, scope: tuple) -> bool:
        owner, _, history, sources = scope
        return bool(history and row["workspace"] == owner and any(
            source["account"] == row["account"] and source["type"] == row["kind"]
            and source["conversation"] == row["conversation"]
            and (not source["sender"] or source["sender"] == row["sender"])
            for source in sources
        ))

    def dispatch(self):
        if not self.consumer:
            return 0
        scope = self.scope()
        with closing(self.open()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute(
                "SELECT * FROM qq_events WHERE workspace=? AND account=? AND queued=1 AND processed=0 ORDER BY id LIMIT 32",
                (scope[0], self.settings.account),
            ).fetchall()
            for row in rows:
                if self.visible(row, scope):
                    self.consumer.accept(db, AbilityEvent(row["id"], row["workspace"], self.spec.id,
                                                         "message.received", dict(row)))
                db.execute("UPDATE qq_events SET processed=1 WHERE id=?", (row["id"],))
        return len(rows)

    async def consume(self):
        while not self.stopping:
            try:
                self.wake.clear()
                size = await asyncio.to_thread(self.dispatch)
                self.degraded = False
                if size:
                    continue
            except (OSError, sqlite3.Error):
                self.degraded = True
            if self.stopping:
                return
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=2)
            except TimeoutError:
                pass

    def require_running(self):
        if self.stopping or self.worker is None or self.worker.done():
            raise WorkbenchError(503, "ability_unavailable")

    async def call(self, client: httpx.AsyncClient, action: str, payload: dict) -> dict:
        body = await request_json(client, "POST", f"http://127.0.0.1:{self.settings.port}/{action}",
                                  headers={"Authorization": "Bearer " + self.settings.api_token}, json=payload)
        if body.get("status") != "ok" or not isinstance(body.get("data"), dict):
            raise WorkbenchError(502, "qq_api_unavailable")
        return body["data"]

    async def confirm_account(self, client: httpx.AsyncClient):
        login = await self.call(client, "get_login_info", {})
        if str(login.get("user_id")) != self.settings.account:
            raise WorkbenchError(409, "qq_account_mismatch")

    async def probe(self) -> dict:
        self.require_running()
        async with httpx.AsyncClient(transport=self.transport, trust_env=False) as client:
            await self.confirm_account(client)
        return {"state": "reachable"}

    async def pull(self, source_id: int, count: int) -> dict:
        self.require_running()
        if self.history_lock.locked():
            raise WorkbenchError(429, "qq_history_busy")
        async with self.history_lock:
            _, _, allowed, sources = await asyncio.to_thread(self.scope)
            if not allowed:
                raise WorkbenchError(403, "qq_history_denied")
            source = next((row for row in sources if row["id"] == source_id), None)
            if not source:
                raise WorkbenchError(404, "qq_source_not_found")
            group = source["type"] == "group"
            action = "get_group_msg_history" if group else "get_friend_msg_history"
            key = "group_id" if group else "user_id"
            async with httpx.AsyncClient(transport=self.transport, trust_env=False) as client:
                await self.confirm_account(client)
                data = await self.call(client, action, {key: int(source["conversation"]), "count": count})
            events = data.get("messages")
            if not isinstance(events, list):
                raise WorkbenchError(502, "qq_api_unavailable")
            normalized = []
            for item in events[:count]:
                if not isinstance(item, dict):
                    continue
                if str(item.get("self_id", self.settings.account)) != self.settings.account:
                    continue
                if item.get("message_type", source["type"]) != source["type"]:
                    continue
                if group and str(item.get("group_id", source["conversation"])) != source["conversation"]:
                    continue
                sender = item.get("sender")
                sender_id = sender.get("user_id", item.get("user_id")) if isinstance(sender, dict) else item.get("user_id")
                if not group and str(sender_id) != source["conversation"]:
                    continue
                event = {**item, "post_type": "message", "self_id": self.settings.account,
                         "message_type": source["type"], "user_id": sender_id}
                if group:
                    event["group_id"] = source["conversation"]
                normalized.append(event)
            result = await asyncio.to_thread(self.store, normalized, True)
            self.wake.set()
            return result
