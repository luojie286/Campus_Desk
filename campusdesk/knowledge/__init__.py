"""Knowledge retrieval with current workspace and source authorization."""

from contextlib import closing
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
import sqlite3
import stat
import unicodedata

import regex

from ..workspace import default_workspace
from .sources import LABELS, LIVE_ADMISSION, has_todos, profile_fields, todo_rows

WORDS = regex.compile(r"\p{Script=Han}+|[a-z0-9]+")
HAN = regex.compile(r"\p{Script=Han}")
FILLERS = regex.compile("请问|帮我|告诉我|解释一下|请解释|是什么|有哪些|怎么|如何|介绍一下|请|一下|吗|什么|请介绍")
STOP = set("what is the a an how can i do please explain".split())
MAX_FILE_BYTES = 32 * 1024 * 1024
SELECT = """
SELECT c.id, c.body, c.locator, d.id AS document_id, d.name, r.id AS rev, d.root,
       r.blob, r.digest, k.path AS root_path, k.kind AS root_kind,
       current.digest AS current_digest,
       EXISTS (SELECT 1 FROM kb_grants g
               WHERE g.owner=d.owner AND g.target IN (d.id, d.root)) AS cloud_allowed
"""
FROM = """
JOIN kb_revisions r ON r.id=c.rev
JOIN kb_documents d ON d.id=r.doc
JOIN kb_revisions current ON current.id=d.rev AND current.doc=d.id
LEFT JOIN kb_roots k ON k.id=d.root AND k.owner=d.owner
WHERE d.owner=? AND d.state='active'
"""


@dataclass(frozen=True)
class Evidence:
    id: str
    document_id: str
    revision: str
    title: str
    locator: str
    quote: str
    cloud_allowed: bool


def terms(text: str):
    for word in WORDS.findall(unicodedata.normalize("NFKC", text).lower()):
        if len(word) == 1 or not HAN.match(word):
            yield word
        else:
            for index in range(len(word) - 1):
                yield word[index:index + 2]


def relative_parts(value: str) -> tuple[str, ...]:
    parts = tuple(value.replace("\\", "/").split("/"))
    if any(not part or part in (".", "..") or part.endswith((".", " "))
           or regex.search(r'[<>:"|?*\x00-\x1f]', part)
           or regex.fullmatch(r'(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part, regex.I)
           for part in parts):
        raise ValueError("invalid_file_reference")
    return parts


def matches_digest(path: Path, expected: str) -> bool:
    if not path.is_absolute() or path.anchor.startswith("\\\\") or ".." in path.parts:
        return False
    # Reject junctions and symlinks throughout the authorized path.
    for part in (*reversed(path.parents), path):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            return False
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
        return False
    with path.open("rb") as stream:
        data = stream.read(MAX_FILE_BYTES + 1)
    return len(data) <= MAX_FILE_BYTES and sha256(data).hexdigest() == expected


class FileKnowledge:
    def __init__(self, root: Path):
        self.database = root / ".private" / "poc.sqlite"
        self.storage = root / ".private" / "kb"

    def _open(self):
        db = sqlite3.connect(self.database.absolute().as_uri() + "?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        return db

    def _evidence(self, row: sqlite3.Row) -> Evidence | None:
        if not row["blob"]:
            # Admission and the live message body were checked in the SQL snapshot.
            return self._from_row(row)
        try:
            parts = relative_parts(row["blob"])
            if len(parts) != 2 or parts[0] != "objects":
                return None
            if not matches_digest(self.storage.joinpath(*parts), row["digest"]):
                return None
            if row["root"] is not None:
                if row["root_path"] is None:
                    return None
                source_parts = relative_parts(row["name"])
                base = Path(row["root_path"])
                if row["root_kind"] == "file":
                    if source_parts != (base.name,):
                        return None
                    source = base
                elif row["root_kind"] == "directory":
                    source = base.joinpath(*source_parts)
                else:
                    return None
                if not matches_digest(source, row["current_digest"]):
                    return None
        except (OSError, ValueError):
            return None
        return self._from_row(row)

    @staticmethod
    def _from_row(row: sqlite3.Row) -> Evidence:
        return Evidence(str(row["id"]), row["document_id"], row["rev"], row["name"],
                        row["locator"], row["body"], bool(row["cloud_allowed"]))

    @staticmethod
    def _visibility(db):
        return " AND (r.blob<>'' OR " + LIVE_ADMISSION + ")" if has_todos(db) else " AND r.blob<>''"

    @staticmethod
    def _special(db, owner, identifier, title, locator, quote):
        granted = db.execute("SELECT 1 FROM kb_grants WHERE owner=? AND target=?", (owner, identifier)).fetchone()
        return Evidence(identifier, identifier, sha256(quote.encode()).hexdigest(), title, locator, quote, bool(granted))

    def _todo(self, db, owner, row):
        identifier = f"todo-{row['id']}"
        due = f"\n截止时间 {row['due_at']}" if row["due_at"] else ""
        return self._special(db, owner, identifier, "当前待办", f"当前待办 #{row['id']}", row["title"] + due)

    def _profile(self, db, owner, key, value):
        label = LABELS.get(key, key)
        return self._special(db, owner, f"profile-{key}", "个人资料", label, f"{label} · {value}")

    def search(self, query: str, document_ids: tuple[str, ...] = ()) -> list[Evidence]:
        keywords = list(dict.fromkeys(term for term in terms(FILLERS.sub(" ", query)) if term not in STOP))[:32]
        with closing(self._open()) as db:
            db.execute("BEGIN")
            owner = default_workspace(db)
            if owner is None:
                return []
            if not document_ids:
                if regex.search(r"待办|\btodos?\b", query, regex.I):
                    todos = [self._todo(db, owner, row) for row in todo_rows(db, owner)]
                    if has_todos(db):
                        rows = db.execute(SELECT + "FROM kb_chunks c " + FROM +
                                          " AND r.id=d.rev AND r.blob='' AND " + LIVE_ADMISSION +
                                          " ORDER BY c.id LIMIT 8", (owner,))
                        todos.extend(self._from_row(row) for row in rows)
                    return todos
                profile = []
                for key, value in profile_fields(db).items():
                    label = LABELS.get(key, key)
                    if query.strip().lower() == key.lower() or query.strip() == label or (
                        regex.search("我|个人资料|档案", query) and (label in query or regex.search("个人资料|档案", query))
                    ):
                        profile.append(self._profile(db, owner, key, value))
                if profile:
                    return profile[:20]
            if not keywords:
                return []
            sql = SELECT + "FROM kb_fts JOIN kb_chunks c ON c.id=kb_fts.rowid " + FROM
            parameters = [owner, " OR ".join(f'"{word}"' for word in keywords)]
            sql += self._visibility(db) + " AND r.id=d.rev AND kb_fts MATCH ?"
            if document_ids:
                sql += " AND d.id IN (" + ",".join("?" for _ in document_ids) + ")"
                parameters.extend(document_ids)
            rows = db.execute(sql + " ORDER BY bm25(kb_fts),c.id LIMIT 96", parameters).fetchall()
        result = []
        counts: dict[str, int] = {}
        for row in rows:
            doc = row["document_id"]
            if counts.get(doc, 0) >= 3:
                continue
            if len(keywords) >= 4 and len(set(keywords).intersection(terms(row["body"]))) < 2:
                continue
            evidence = self._evidence(row)
            if evidence:
                result.append(evidence)
                counts[doc] = counts.get(doc, 0) + 1
                if len(result) == 8:
                    break
        return result

    def research_sources(self, query: str, document_ids: tuple[str, ...]) -> list[Evidence]:
        matches = self.search(query, document_ids)
        if not document_ids:
            return matches
        found = {item.id: item for item in matches}
        with closing(self._open()) as db:
            db.execute("BEGIN")
            owner = default_workspace(db)
            sql = (SELECT + "FROM kb_chunks c " + FROM + self._visibility(db) +
                   " AND r.id=d.rev AND d.id=? ORDER BY c.id LIMIT 3")
            for document_id in document_ids:
                for row in db.execute(sql, (owner, document_id)):
                    if str(row["id"]) not in found and (item := self._evidence(row)):
                        found[item.id] = item
        return list(found.values())

    def documents(self) -> list[dict]:
        with closing(self._open()) as db:
            owner = default_workspace(db)
            return [dict(row) for row in db.execute(
                "SELECT id,name,state AS status FROM kb_documents WHERE owner=? AND state='active' ORDER BY name,id LIMIT 500",
                (owner,),
            )]

    def evidence(self, evidence_id: int | str, revision: str | None = None) -> Evidence | None:
        with closing(self._open()) as db:
            db.execute("BEGIN")
            owner = default_workspace(db)
            if owner is None:
                return None
            identifier = str(evidence_id)
            if regex.fullmatch(r"todo-[1-9][0-9]{0,18}", identifier) and int(identifier[5:]) < 2**63:
                rows = todo_rows(db, owner, int(identifier[5:]))
                item = self._todo(db, owner, rows[0]) if rows else None
                return item if item and revision in (None, item.revision) else None
            if identifier.startswith("profile-"):
                key = identifier[8:]
                value = profile_fields(db).get(key)
                item = self._profile(db, owner, key, value) if value is not None else None
                return item if item and revision in (None, item.revision) else None
            if not regex.fullmatch(r"[1-9][0-9]{0,18}", identifier) or int(identifier) >= 2**63:
                return None
            sql = SELECT + "FROM kb_chunks c " + FROM + self._visibility(db) + " AND c.id=?"
            parameters = [owner, int(identifier)]
            if revision is None:
                sql += " AND r.id=d.rev"
            else:
                sql += " AND r.id=? AND (r.id=d.rev OR r.blob<>'')"
                parameters.append(revision)
            row = db.execute(sql, parameters).fetchone()
        return self._evidence(row) if row else None
