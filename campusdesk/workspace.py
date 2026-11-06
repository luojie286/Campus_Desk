"""本机工作区及旧库迁移。运行期 SQLite 写入仍由主机连接统一处理。"""

from __future__ import annotations

from contextlib import closing
from hashlib import sha256
import json
from pathlib import Path
import re
import socket
import sqlite3
from uuid import uuid4


OWNED_TABLES = ("kb_roots", "kb_documents", "kb_grants", "assistant_operations")
SNAPSHOT_TABLES = (*OWNED_TABLES, "kb_revisions", "kb_chunks", "kb_todo_sources",
                   "kb_todo_admissions", "tasks", "plans", "approvals", "operations")
SCHEMA = (
    "CREATE TABLE IF NOT EXISTS local_workspaces("
    "workspace_id TEXT PRIMARY KEY, slot INTEGER UNIQUE NOT NULL CHECK(slot=1), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS workspace_source_bindings("
    "workspace_id TEXT NOT NULL REFERENCES local_workspaces(workspace_id), provider TEXT NOT NULL, "
    "account_ref TEXT NOT NULL, ingress_enabled INTEGER NOT NULL CHECK(ingress_enabled IN (0,1)), "
    "history_allowed INTEGER NOT NULL CHECK(history_allowed IN (0,1)), PRIMARY KEY(provider,account_ref))",
    "CREATE TABLE IF NOT EXISTS workspace_tasks("
    "task_id INTEGER PRIMARY KEY REFERENCES tasks(id), workspace_id TEXT NOT NULL REFERENCES local_workspaces(workspace_id), "
    "origin_kind TEXT NOT NULL CHECK(origin_kind IN ('legacy','message','desktop','tool')))",
)


class WorkspaceError(RuntimeError):
    """可对操作者展示的稳定错误类别。"""


def table_exists(db: sqlite3.Connection, table: str) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


def default_workspace(db: sqlite3.Connection) -> str | None:
    if not table_exists(db, "local_workspaces"):
        return None
    row = db.execute("SELECT workspace_id FROM local_workspaces WHERE slot=1").fetchone()
    return row[0] if row else None


def read_config(root: Path) -> dict:
    filename = root / ".private" / "config.json"
    try:
        value = json.loads(filename.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (OSError, ValueError) as error:
        raise WorkspaceError("host_config_invalid") from error


def _read_only(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(path.resolve(strict=True).as_uri() + "?mode=ro", uri=True, timeout=0)


def _digest(value) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, default=lambda item: item.hex(),
                             sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _account(config: dict, explicit: str | None) -> str:
    account = explicit if explicit is not None else str(config.get("account_id") or "")
    if account and not re.fullmatch(r"[0-9]+", account):
        raise WorkspaceError("invalid_legacy_account")
    return account


def _plan(db: sqlite3.Connection, account: str) -> dict:
    existing = default_workspace(db)
    counts = {}
    ambiguous = 0
    for table in OWNED_TABLES:
        if not table_exists(db, table):
            raise WorkspaceError("knowledge_schema_missing")
        counts[table] = db.execute(f"SELECT COUNT(*) FROM {table} WHERE owner=?", (account,)).fetchone()[0] if account else 0
        if not existing:
            ambiguous += db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] - counts[table]
    task_count = db.execute("SELECT COUNT(*) FROM tasks WHERE account_ref=?", (account,)).fetchone()[0] if account else 0
    signatures = {}
    for table in SNAPSHOT_TABLES:
        if table_exists(db, table):
            rows = sorted(_digest(row) for row in db.execute(f"SELECT * FROM {table}"))
            signatures[table] = _digest(rows)
    return {
        "workspace_id": existing,
        "bind_existing_account": bool(account),
        "mapped_records": counts,
        "mapped_tasks": task_count,
        "unmapped_records": ambiguous,
        "digest": _digest([existing, account, signatures]),
    }


def migration_plan(root: Path, legacy_account: str | None = None) -> dict:
    config = read_config(root)
    with closing(_read_only(root / ".private" / "poc.sqlite")) as db:
        return _plan(db, _account(config, legacy_account))


def _check_host_stopped(config: dict) -> None:
    port = config.get("port")
    if type(port) is not int or not 1 <= port <= 65535:
        raise WorkspaceError("host_config_invalid")
    try:
        with socket.socket() as probe:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind(("127.0.0.1", port))
    except OSError as error:
        raise WorkspaceError("host_port_in_use") from error


def _verify_objects(db: sqlite3.Connection, root: Path, owner: str) -> int:
    storage = (root / ".private" / "kb").resolve()
    rows = db.execute(
        "SELECT r.blob,r.digest FROM kb_documents d JOIN kb_revisions r ON r.id=d.rev "
        "WHERE d.owner=? AND d.state='active' AND r.blob<>''", (owner,)
    )
    checked = 0
    for blob, expected in rows:
        source = storage / blob
        try:
            file = source.resolve(strict=True)
            if not file.is_relative_to(storage) or file != source or not file.is_file():
                raise WorkspaceError("knowledge_object_outside_root")
            digest = sha256()
            with file.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                raise WorkspaceError("knowledge_object_changed")
        except OSError as error:
            raise WorkspaceError("knowledge_object_missing") from error
        checked += 1
    return checked


def apply_migration(root: Path, expected_digest: str, legacy_account: str | None = None) -> dict:
    config = read_config(root)
    _check_host_stopped(config)
    account = _account(config, legacy_account)
    private = root / ".private"
    filename = private / "poc.sqlite"
    with closing(_read_only(filename)) as source:
        before = _plan(source, account)
        if before["workspace_id"]:
            return {"workspace_id": before["workspace_id"], "upgraded": False}
        if before["digest"] != expected_digest:
            raise WorkspaceError("workspace_plan_changed")
        if source.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise WorkspaceError("database_integrity_failed")
        checked = _verify_objects(source, root, account) if account else 0
        backups = private / "backups"
        backups.mkdir(exist_ok=True)
        if backups.resolve() != backups or not backups.resolve().is_relative_to(private.resolve()):
            raise WorkspaceError("invalid_backup_root")
        backup = backups / f"before-workspace-{uuid4().hex}.sqlite"
        with closing(sqlite3.connect(backup)) as target:
            source.backup(target)
            if target.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise WorkspaceError("backup_integrity_failed")
            if _plan(target, account)["digest"] != expected_digest:
                raise WorkspaceError("workspace_plan_changed")

    workspace = str(uuid4())
    with closing(sqlite3.connect(filename, timeout=0, isolation_level=None)) as db:
        # Windows 上的旧 Python SQLite 使用离线回滚日志。在线主机用已修复的 SQLite 恢复 WAL。
        if db.execute("PRAGMA journal_mode=DELETE").fetchone()[0].lower() != "delete":
            raise WorkspaceError("database_busy")
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("BEGIN EXCLUSIVE")
        try:
            if _plan(db, account)["digest"] != expected_digest:
                raise WorkspaceError("workspace_plan_changed")
            for query in (
                "SELECT 1 FROM assistant_operations WHERE state='approved' LIMIT 1",
                "SELECT 1 FROM tasks WHERE state IN ('executing','verifying') LIMIT 1",
                "SELECT 1 FROM runs WHERE state='writing' LIMIT 1",
            ):
                if db.execute(query).fetchone():
                    raise WorkspaceError("operations_in_flight")
            for statement in SCHEMA:
                db.execute(statement)
            db.execute("INSERT INTO local_workspaces(workspace_id,slot) VALUES(?,1)", (workspace,))
            if account:
                db.execute("INSERT INTO workspace_source_bindings VALUES(?,'qq',?,1,1)", (workspace, account))
                for table in OWNED_TABLES:
                    db.execute(f"UPDATE {table} SET owner=? WHERE owner=?", (workspace, account))
                db.execute("INSERT INTO workspace_tasks SELECT id,?,'legacy' FROM tasks WHERE account_ref=?", (workspace, account))
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise WorkspaceError("migration_verification_failed")
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise
    return {**before, "workspace_id": workspace, "upgraded": True, "verified_objects": checked}


def set_history_access(root: Path, provider: str, account: str, allowed: bool) -> dict:
    _check_host_stopped(read_config(root))
    filename = (root / ".private" / "poc.sqlite").resolve(strict=True)
    with closing(sqlite3.connect(filename, timeout=0, isolation_level=None)) as db:
        if db.execute("PRAGMA journal_mode=DELETE").fetchone()[0].lower() != "delete":
            raise WorkspaceError("database_busy")
        workspace = default_workspace(db)
        result = db.execute(
            "UPDATE workspace_source_bindings SET history_allowed=? WHERE workspace_id=? AND provider=? AND account_ref=?",
            (int(allowed), workspace, provider, account)
        )
        if result.rowcount != 1:
            raise WorkspaceError("source_binding_not_found")
    return {"history_allowed": allowed}


def bind_qq(root: Path, account: str) -> dict:
    config = read_config(root)
    if not account or _account(config, None) != account:
        raise WorkspaceError("configured_account_mismatch")
    _check_host_stopped(config)
    filename = (root / ".private" / "poc.sqlite").resolve(strict=True)
    with closing(sqlite3.connect(filename, timeout=0, isolation_level=None)) as db:
        if db.execute("PRAGMA journal_mode=DELETE").fetchone()[0].lower() != "delete":
            raise WorkspaceError("database_busy")
        workspace = default_workspace(db)
        if not workspace:
            raise WorkspaceError("workspace_not_initialized")
        existing = db.execute("SELECT workspace_id FROM workspace_source_bindings WHERE provider='qq' AND account_ref=?", (account,)).fetchone()
        if existing and existing[0] != workspace:
            raise WorkspaceError("source_binding_conflict")
        db.execute("INSERT OR IGNORE INTO workspace_source_bindings VALUES(?,'qq',?,1,1)", (workspace, account))
    return {"bound": True, "workspace_id": workspace}
