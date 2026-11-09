"""Offline ownership transfer for the existing business database."""

from contextlib import closing, contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
from uuid import uuid4

from .workspace import WorkspaceError, _check_host_stopped, _read_only, default_workspace, read_config, table_exists

OWNER = "python-business.owner"
LEGACY_LOCK = "legacy-business.sqlite"
AUDIT_TABLES = ("local_workspaces", "workspace_source_bindings", "workspace_tasks", "todos", "todo_messages",
                "tasks", "plans", "approvals", "operations", "task_questions", "task_answers", "runs", "jobs",
                "messages", "profile_fields", "kb_documents", "kb_grants", "kb_revisions")
SCHEMA = (
    "CREATE TABLE IF NOT EXISTS python_sheet_rechecks(task_id INTEGER PRIMARY KEY)",
    "CREATE TABLE IF NOT EXISTS python_qq_todos(event_id INTEGER NOT NULL, workspace TEXT NOT NULL,"
    " todo_id INTEGER NOT NULL UNIQUE, PRIMARY KEY(workspace,event_id))",
)


def owned(root: Path) -> bool:
    return (root / ".private" / OWNER).is_file()


@contextmanager
def legacy_gate(private: Path):
    with closing(sqlite3.connect(private / LEGACY_LOCK, timeout=0)) as gate:
        try:
            gate.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError as error:
            if error.sqlite_errorcode != sqlite3.SQLITE_BUSY:
                raise
            raise WorkspaceError("legacy_business_locked") from error
        yield


@contextmanager
def runtime_lock(root: Path, name: str = "python-sheets.lock"):
    """An OS lock releases on exit or crash, even if the file remains."""
    path = root / ".private" / name
    with path.open("a+b") as file:
        file.seek(0)
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise WorkspaceError("python_business_locked") from error
            try:
                yield
            finally:
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            try:
                fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise WorkspaceError("python_business_locked") from error
            try:
                yield
            finally:
                fcntl.flock(file, fcntl.LOCK_UN)


def inspect(db: sqlite3.Connection) -> dict:
    if not default_workspace(db) or any(not table_exists(db, table) for table in AUDIT_TABLES):
        raise WorkspaceError("legacy_business_schema_missing")
    counts = {}
    fingerprint = sha256()
    for table in AUDIT_TABLES:
        fingerprint.update(table.encode())
        rows = db.execute(f"SELECT * FROM {table} ORDER BY rowid")
        count = 0
        for row in rows:
            fingerprint.update(json.dumps(tuple(row), ensure_ascii=False, default=str).encode())
            fingerprint.update(b"\n")
            count += 1
        counts[table] = count
    interrupted = db.execute("SELECT COUNT(*) FROM tasks WHERE executor_type='tencent_sheet' "
                             "AND state IN ('executing','verifying')").fetchone()[0]
    unresolved = db.execute("SELECT COUNT(*) FROM runs WHERE state IN ('writing','outcome_unknown')").fetchone()[0]
    return {"digest": fingerprint.hexdigest(), "counts": counts, "interrupted_tasks": interrupted,
            "unresolved_legacy_runs": unresolved}


def preview(root: Path) -> dict:
    with closing(_read_only(root / ".private" / "poc.sqlite")) as db:
        db.execute("BEGIN")
        return inspect(db) | {"python_owner": owned(root)}


def recover(db: sqlite3.Connection) -> None:
    # A crash after claiming a write is treated as uncertain. Recovery never
    # queues another write, even when the remote write did not start.
    claimed = "executor_type='tencent_sheet' AND state IN ('executing','verifying')"
    db.execute("UPDATE operations SET state='unknown',error_class='interrupted_write' WHERE state='running' "
               f"AND task_id IN (SELECT id FROM tasks WHERE {claimed})")
    db.execute(f"INSERT OR IGNORE INTO python_sheet_rechecks SELECT id FROM tasks WHERE {claimed}")
    db.execute("UPDATE tasks SET state='outcome_unknown',state_version=state_version+1,waiting_reason='interrupted_write' "
               f"WHERE {claimed}")
    db.execute("DELETE FROM document_locks WHERE task_id IN (SELECT id FROM tasks WHERE executor_type='tencent_sheet')")


def backup(source: Path, target: Path) -> None:
    with closing(_read_only(source)) as origin, closing(sqlite3.connect(target)) as copy:
        origin.backup(copy)
        if copy.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise WorkspaceError("business_backup_integrity_failed")


def apply(root: Path, digest: str, *, workbench_port: int | None = None) -> dict:
    private = root / ".private"
    config = read_config(root)
    source = private / "poc.sqlite"
    with legacy_gate(private), runtime_lock(root), runtime_lock(root, "python-qq.lock"):
        if owned(root):
            raise WorkspaceError("python_business_already_owner")
        _check_host_stopped(config)
        if workbench_port is not None:
            _check_host_stopped({"port": workbench_port})
        current = preview(root)
        if current["digest"] != digest:
            raise WorkspaceError("business_preview_changed")
        if current["unresolved_legacy_runs"]:
            raise WorkspaceError("legacy_run_outcome_unresolved")
        folder = private / "backups" / ("business-" + uuid4().hex)
        folder.mkdir(parents=True)
        backup(source, folder / "poc.sqlite")
        if (private / "abilities.sqlite").is_file():
            backup(private / "abilities.sqlite", folder / "abilities.sqlite")
        with closing(sqlite3.connect(source)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if inspect(db)["digest"] != digest:
                raise WorkspaceError("business_preview_changed")
            for statement in SCHEMA:
                db.execute(statement)
            recover(db)
        with (private / OWNER).open("x", encoding="ascii") as marker:
            marker.write("python-v1\n")
        return current | {"python_owner": True, "backup": folder.name}
