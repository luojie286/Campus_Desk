"""Live visibility rules for non-file evidence in the legacy workspace."""

import re
import sqlite3

from ..workspace import table_exists

LABELS = {"name": "姓名", "student_id": "学号", "sex": "性别", "age": "年龄",
          "major": "专业", "phone": "电话", "email": "邮箱"}
PROFILE_KEY = re.compile(r"[a-z][a-z0-9_]{0,49}", re.ASCII | re.IGNORECASE)
HISTORY = """EXISTS (SELECT 1 FROM workspace_source_bindings w
 WHERE w.workspace_id={owner} AND w.provider=m.platform AND w.account_ref=m.account_ref AND w.history_allowed=1)
 AND NOT EXISTS (SELECT 1 FROM todo_messages x JOIN messages other ON other.id=x.message_id
 WHERE x.todo_id=t.id AND (other.account_ref<>m.account_ref OR other.platform<>m.platform))"""
LIVE_ADMISSION = """EXISTS (
 SELECT 1 FROM kb_todo_sources s JOIN kb_todo_admissions a ON a.rev=s.rev
 JOIN todo_messages tm ON tm.todo_id=a.todo AND tm.message_id=s.message
 JOIN todos t ON t.id=tm.todo_id JOIN messages m ON m.id=tm.message_id
 WHERE s.rev=r.id AND t.status='open' AND m.content_text IS s.body AND """ + HISTORY.format(owner="d.owner") + ")"


def has_todos(db: sqlite3.Connection) -> bool:
    return all(table_exists(db, table) for table in ("todos", "todo_messages", "messages",
                "workspace_source_bindings", "kb_todo_sources", "kb_todo_admissions"))


def todo_rows(db: sqlite3.Connection, owner: str, todo_id: int | None = None):
    if not has_todos(db):
        return []
    sql = """SELECT DISTINCT t.id,t.title,t.due_at FROM todos t JOIN todo_messages tm ON tm.todo_id=t.id
             JOIN messages m ON m.id=tm.message_id WHERE t.status='open' AND """ + HISTORY.format(owner="?")
    parameters = [owner]
    if todo_id is not None:
        sql += " AND t.id=?"
        parameters.append(todo_id)
    return db.execute(sql + " ORDER BY t.id DESC LIMIT 200", parameters).fetchall()


def profile_fields(db: sqlite3.Connection) -> dict:
    fields = {}
    if table_exists(db, "profile"):
        row = db.execute("SELECT name,student_id,sex,age FROM profile WHERE id=1").fetchone()
        if row:
            fields.update((key, str(value)) for key, value in zip(("name", "student_id", "sex", "age"), row))
    if table_exists(db, "profile_fields"):
        fields.update((key, value) for key, value in db.execute("SELECT key,value FROM profile_fields")
                      if PROFILE_KEY.fullmatch(key) and key not in ("constructor", "toString", "valueOf"))
    if table_exists(db, "profile_deleted_fields"):
        for (key,) in db.execute("SELECT key FROM profile_deleted_fields"):
            fields.pop(key, None)
    return fields
