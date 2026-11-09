"""Explicit admission of an open todo's messages into the knowledge index."""

from contextlib import closing
from hashlib import sha256
import json
from pathlib import Path
import sqlite3

from . import FileKnowledge, terms
from .parsing import chunks
from .sources import todo_rows
from ..workspace import WorkspaceError, default_workspace


def digest(value) -> str:
    return sha256(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def admit_todo(root: Path, todo_id: int, approval: str | None = None) -> dict:
    knowledge = FileKnowledge(root)
    uri = knowledge.database.absolute().as_uri() + ("?mode=rw" if approval else "?mode=ro")
    with closing(sqlite3.connect(uri, uri=True)) as db, db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN IMMEDIATE" if approval else "BEGIN")
        owner = default_workspace(db)
        if not owner or not todo_rows(db, owner, todo_id):
            raise WorkspaceError("todo_unavailable")
        sources = db.execute(
            "SELECT m.id,m.content_text FROM todo_messages tm JOIN messages m ON m.id=tm.message_id "
            "WHERE tm.todo_id=? ORDER BY m.id LIMIT 33", (todo_id,),
        ).fetchall()
        if len(sources) > 32 or any(len((row[1] or "").encode()) > 256 * 1024 for row in sources):
            raise WorkspaceError("too_large")
        expected = digest([owner, todo_id, [tuple(row) for row in sources]])
        if approval is None:
            return {"digest": expected, "sources": len(sources)}
        if approval != expected:
            raise WorkspaceError("preview_changed")
        admitted = 0
        for message, body in sources:
            if not body or not body.strip():
                continue
            existing = db.execute(
                "SELECT d.id FROM kb_documents d JOIN kb_todo_sources s ON s.rev=d.rev "
                "WHERE d.owner=? AND s.message=?", (owner, message),
            ).fetchone()
            document = existing[0] if existing else digest([owner, "todo-source", message])
            revision = digest([document, body])
            if not db.execute("SELECT 1 FROM kb_revisions WHERE id=?", (revision,)).fetchone():
                db.execute("INSERT INTO kb_revisions VALUES (?,?,?,'')",
                           (revision, document, sha256(body.encode()).hexdigest()))
                db.execute("INSERT INTO kb_todo_sources VALUES (?,?,?)", (revision, message, body))
                for _, text in chunks("source.txt", body.encode()):
                    chunk = db.execute("INSERT INTO kb_chunks(rev,locator,body) VALUES (?,?,?)",
                                       (revision, f"来源消息 #{message}", text)).lastrowid
                    db.execute("INSERT INTO kb_fts(rowid,terms) VALUES (?,?)", (chunk, " ".join(terms(text))))
            db.execute("INSERT INTO kb_documents VALUES (?,?,NULL,?,?,'active') "
                       "ON CONFLICT(id) DO UPDATE SET rev=excluded.rev WHERE owner=excluded.owner",
                       (document, owner, f"待办来源 #{message}", revision))
            admitted += db.execute("INSERT OR IGNORE INTO kb_todo_admissions VALUES (?,?)",
                                   (todo_id, revision)).rowcount
    return {"admitted": admitted}
