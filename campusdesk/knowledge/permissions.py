"""Local cloud-consent management. Reading and sharing remain separate."""

from contextlib import closing
from pathlib import Path
import sqlite3

from . import FileKnowledge
from .sources import profile_fields, todo_rows
from ..workspace import WorkspaceError, default_workspace


def set_cloud_permission(root: Path, target: str, allowed: bool) -> dict:
    knowledge = FileKnowledge(root)
    with closing(sqlite3.connect(knowledge.database.absolute().as_uri() + "?mode=rw", uri=True)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        owner = default_workspace(db)
        if owner is None:
            raise WorkspaceError("knowledge_workspace_required")
        if not allowed:
            db.execute("DELETE FROM kb_grants WHERE owner=? AND target=?", (owner, target))
        else:
            valid = db.execute("SELECT 1 FROM kb_documents WHERE owner=? AND id=? AND state='active' "
                               "UNION ALL SELECT 1 FROM kb_roots WHERE owner=? AND id=?",
                               (owner, target, owner, target)).fetchone()
            if target.startswith("profile-"):
                valid = target[8:] in profile_fields(db)
            elif target.startswith("todo-") and target[5:].isascii() and target[5:].isdigit() and len(target) <= 24:
                number = int(target[5:])
                valid = number < 2**63 and bool(todo_rows(db, owner, number))
            if not valid:
                raise WorkspaceError("knowledge_target_not_found")
            db.execute("INSERT OR IGNORE INTO kb_grants VALUES (?,?)", (owner, target))
    return {"cloud_allowed": allowed}
