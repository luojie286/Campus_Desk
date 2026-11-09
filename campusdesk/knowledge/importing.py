"""Offline Python import for the shared knowledge format."""

from contextlib import closing
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
import stat
from tempfile import NamedTemporaryFile
from uuid import uuid4

from . import Evidence, FileKnowledge, MAX_FILE_BYTES, matches_digest, relative_parts, terms
from .parsing import chunks
from ..workspace import SCHEMA, WorkspaceError, default_workspace

KNOWLEDGE_SCHEMA = """
CREATE TABLE kb_schema(version INTEGER PRIMARY KEY);
INSERT INTO kb_schema VALUES(1),(2);
CREATE TABLE kb_roots(id TEXT PRIMARY KEY, owner TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, UNIQUE(owner,path));
CREATE TABLE kb_documents(id TEXT PRIMARY KEY, owner TEXT NOT NULL, root TEXT, name TEXT NOT NULL, rev TEXT NOT NULL, state TEXT NOT NULL);
CREATE UNIQUE INDEX kb_source_unique ON kb_documents(owner,root,name) WHERE state='active';
CREATE TABLE kb_revisions(id TEXT PRIMARY KEY, doc TEXT NOT NULL, digest TEXT NOT NULL, blob TEXT NOT NULL);
CREATE TABLE kb_chunks(id INTEGER PRIMARY KEY, rev TEXT NOT NULL, locator TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX kb_chunks_revision ON kb_chunks(rev);
CREATE VIRTUAL TABLE kb_fts USING fts5(terms);
CREATE TABLE kb_grants(owner TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY(owner,target));
CREATE TABLE assistant_operations(owner TEXT NOT NULL, id TEXT NOT NULL, preview TEXT NOT NULL, digest TEXT NOT NULL,
 state TEXT NOT NULL, work TEXT, result TEXT, PRIMARY KEY(owner,id), UNIQUE(owner,preview));
CREATE TABLE kb_todo_sources(rev TEXT PRIMARY KEY, message INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TABLE kb_todo_admissions(todo INTEGER NOT NULL, rev TEXT NOT NULL, PRIMARY KEY(todo,rev));
CREATE INDEX kb_admissions_revision ON kb_todo_admissions(rev);
CREATE TABLE profile_deleted_fields(key TEXT PRIMARY KEY);
"""


def initialize(root: Path) -> dict:
    knowledge = FileKnowledge(root)
    knowledge.database.parent.mkdir(exist_ok=True)
    # Exclusive file creation prevents accidentally initializing a legacy database.
    try:
        with knowledge.database.open("xb"):
            pass
    except FileExistsError as error:
        raise WorkspaceError("knowledge_database_exists") from error
    owner = str(uuid4())
    try:
        with closing(sqlite3.connect(knowledge.database)) as db, db:
            db.executescript("BEGIN;" + ";".join(SCHEMA[:2]) + ";" + KNOWLEDGE_SCHEMA)
            db.execute("INSERT INTO local_workspaces(workspace_id, slot) VALUES (?,1)", (owner,))
    except Exception:
        knowledge.database.unlink()
        raise
    return {"workspace_id": owner}


def snapshot(db: sqlite3.Connection, source: Path, digest: str) -> tuple:
    owner = default_workspace(db)
    if not owner:
        raise WorkspaceError("knowledge_workspace_required")
    current = []
    for root_id, path, kind in db.execute("SELECT id,path,kind FROM kb_roots WHERE owner=?", (owner,)):
        base = Path(path)
        if kind == "file" and base == source:
            name = source.name
        elif kind == "directory" and source.is_relative_to(base):
            name = source.relative_to(base).as_posix()
        else:
            continue
        current.extend(db.execute(
            "SELECT d.id,d.rev,r.digest FROM kb_documents d JOIN kb_revisions r ON r.id=d.rev AND r.doc=d.id "
            "WHERE d.owner=? AND d.state='active' AND d.root=? AND d.name=?", (owner, root_id, name),
        ))
    if len(current) > 1:
        raise WorkspaceError("ambiguous_document_source")
    return owner, tuple(current[0]) if current else None, digest


def preview_digest(source: Path, state: tuple) -> str:
    return sha256(json.dumps([str(source), state], ensure_ascii=False).encode()).hexdigest()


def publish_object(storage: Path, name: str, data: bytes, digest: str) -> None:
    directory = storage / "objects"
    directory.mkdir(parents=True, exist_ok=True)
    if directory.resolve() != directory or any(
        getattr(item.lstat(), "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
        for item in (storage.parent, storage, directory)
    ):
        raise WorkspaceError("invalid_knowledge_storage")
    target = directory / name
    # Publish immutable bytes before making the revision visible. An interrupted
    # transaction can leave an unreferenced object, never a dangling revision.
    with NamedTemporaryFile(dir=directory, delete=False) as stage:
        temporary = Path(stage.name)
    try:
        with temporary.open("wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, target)
        except FileExistsError:
            if not matches_digest(target, digest):
                raise WorkspaceError("knowledge_object_conflict")
    finally:
        temporary.unlink()


def import_file(root: Path, source: Path, approval: str | None = None) -> dict:
    source = source.absolute()
    if source.resolve(strict=True) != source or source.is_relative_to(root / ".private"):
        raise WorkspaceError("invalid_source")
    relative_parts(source.name)
    if not source.is_file():
        raise WorkspaceError("invalid_source")
    with source.open("rb") as stream:
        data = stream.read(MAX_FILE_BYTES + 1)
    digest = sha256(data).hexdigest()
    if not matches_digest(source, digest):
        raise WorkspaceError("invalid_source")
    knowledge = FileKnowledge(root)
    with closing(knowledge._open()) as db:
        state = snapshot(db, source, digest)
    expected = preview_digest(source, state)
    if approval is not None and approval != expected:
        raise WorkspaceError("preview_changed")
    owner, previous, _ = state
    unchanged = previous is not None and previous[2] == digest
    blocks = [] if unchanged else chunks(source.name, data)
    if approval is None:
        return {"digest": expected, "chunks": len(blocks), "unchanged": unchanged}
    if unchanged:
        with closing(knowledge._open()) as db:
            if snapshot(db, source, digest) != state or not matches_digest(source, digest):
                raise WorkspaceError("preview_changed")
        return {"document_id": previous[0], "revision": previous[1], "unchanged": True}

    revision = str(uuid4())
    object_name = digest + source.suffix.lower()
    publish_object(knowledge.storage, object_name, data, digest)
    if not matches_digest(source, digest):
        raise WorkspaceError("preview_changed")
    with closing(sqlite3.connect(knowledge.database.absolute().as_uri() + "?mode=rw", uri=True)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        if snapshot(db, source, digest) != state:
            raise WorkspaceError("preview_changed")
        if previous:
            document = previous[0]
            db.execute("UPDATE kb_documents SET rev=? WHERE id=? AND owner=?", (revision, document, owner))
        else:
            root_id, document = str(uuid4()), str(uuid4())
            db.execute("INSERT OR IGNORE INTO kb_roots VALUES (?, ?, ?, 'file')", (root_id, owner, str(source)))
            root_id, kind = db.execute("SELECT id,kind FROM kb_roots WHERE owner=? AND path=?",
                                       (owner, str(source))).fetchone()
            if kind != "file":
                raise WorkspaceError("invalid_source")
            db.execute("INSERT INTO kb_documents VALUES (?, ?, ?, ?, ?, 'active')",
                       (document, owner, root_id, source.name, revision))
        db.execute("INSERT INTO kb_revisions VALUES (?, ?, ?, ?)",
                   (revision, document, digest, "objects/" + object_name))
        for locator, text in blocks:
            chunk = db.execute("INSERT INTO kb_chunks(rev,locator,body) VALUES (?,?,?)",
                               (revision, locator, text)).lastrowid
            db.execute("INSERT INTO kb_fts(rowid,terms) VALUES (?,?)", (chunk, " ".join(terms(text))))
    return {"document_id": document, "revision": revision, "unchanged": False}


def publish_note(root: Path, name: str, text: str, document: str, sources: list[Evidence]) -> dict:
    """Publish an approved generated report without creating an external source file."""
    if relative_parts(name) != (name,) or not name.lower().endswith(".md") or len(name) > 120:
        raise WorkspaceError("invalid_report_name")
    data = text.encode()
    blocks = chunks(name, data)
    digest = sha256(data).hexdigest()
    knowledge = FileKnowledge(root)
    object_name = digest + ".md"
    with closing(sqlite3.connect(knowledge.database.absolute().as_uri() + "?mode=rw", uri=True)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        owner = default_workspace(db)
        if not owner:
            raise WorkspaceError("knowledge_workspace_required")
        # Serialize publication with SQLite permission changes. The write
        # reservation lets the evidence reader see the last committed snapshot.
        if any(knowledge.evidence(item.id) != item for item in sources):
            raise WorkspaceError("preview_changed")
        existing = db.execute(
            "SELECT d.id,d.rev,r.digest FROM kb_documents d JOIN kb_revisions r ON r.id=d.rev "
            "WHERE d.owner=? AND d.root IS NULL AND d.name=? AND d.state='active'", (owner, name),
        ).fetchone()
        if existing:
            if existing[0] == document and existing[2] == digest:
                return {"document_id": document, "revision": existing[1]}
            raise WorkspaceError("report_name_exists")
        publish_object(knowledge.storage, object_name, data, digest)
        revision = str(uuid4())
        db.execute("INSERT INTO kb_documents VALUES (?,?,NULL,?,?,'active')", (document, owner, name, revision))
        db.execute("INSERT INTO kb_revisions VALUES (?,?,?,?)", (revision, document, digest, "objects/" + object_name))
        for locator, body in blocks:
            chunk = db.execute("INSERT INTO kb_chunks(rev,locator,body) VALUES (?,?,?)", (revision, locator, body)).lastrowid
            db.execute("INSERT INTO kb_fts(rowid,terms) VALUES (?,?)", (chunk, " ".join(terms(body))))
    return {"document_id": document, "revision": revision}
