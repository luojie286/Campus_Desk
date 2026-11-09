"""Interaction inbox and candidate decisions for the QQ event consumer."""

from contextlib import closing
import sqlite3

from .abilities import AbilityEvent
from .abilities.qq import QQ
from .automation import todo_draft
from .workbench_errors import WorkbenchError


class QQInbox:
    def __init__(self, listener: QQ):
        self.listener = listener

    def initialize(self, db: sqlite3.Connection) -> None:
        db.execute(
            """CREATE TABLE IF NOT EXISTS qq_candidates(
               event_id INTEGER PRIMARY KEY REFERENCES qq_events(id),
               title TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending')"""
        )
        db.commit()

    def accept(self, db: sqlite3.Connection, event: AbilityEvent) -> None:
        if event.ability != "qq.listen" or event.type != "message.received":
            return
        if draft := todo_draft(event.payload["body"]):
            db.execute("INSERT OR IGNORE INTO qq_candidates(event_id,title,reason) VALUES (?,?,?)",
                       (event.id, *draft))

    def items(self, *, candidates: bool, before: int, limit: int) -> list[dict]:
        qq = self.listener
        qq.require_running()
        scope = qq.scope()
        if not scope[2]:
            return []
        base = ("SELECT e.*,c.title,c.reason,c.state FROM qq_events e JOIN qq_candidates c ON c.event_id=e.id"
                if candidates else "SELECT e.* FROM qq_events e")
        with closing(qq.open()) as db:
            rows = db.execute(base + " WHERE e.workspace=? AND e.account=? AND e.id<? ORDER BY e.id DESC",
                              (scope[0], qq.settings.account, before))
            items = []
            fields = ["id", "kind", "source_name", "body", "source_time", "origin"]
            if candidates:
                fields += ["title", "reason", "state"]
            for row in rows:
                if qq.visible(row, scope):
                    items.append({key: row[key] for key in fields})
                    if len(items) >= limit:
                        break
        return items

    def decide(self, identifier: int, state: str) -> dict:
        qq = self.listener
        qq.require_running()
        scope = qq.scope()
        with closing(qq.open()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT e.*,c.state FROM qq_candidates c JOIN qq_events e ON e.id=c.event_id WHERE e.id=?",
                (identifier,),
            ).fetchone()
            if row is None or not qq.visible(row, scope):
                raise WorkbenchError(404, "qq_candidate_not_found")
            if row["state"] not in ("pending", state):
                raise WorkbenchError(409, "qq_candidate_already_decided")
            db.execute("UPDATE qq_candidates SET state=? WHERE event_id=?", (state, identifier))
        return {"id": identifier, "state": state}
