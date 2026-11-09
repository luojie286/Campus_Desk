from contextlib import closing
from hashlib import sha256
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

from campusdesk.knowledge import FileKnowledge, terms
from campusdesk.knowledge_api import create_app


class FileKnowledgeTest(unittest.TestCase):
    def setUp(self):
        fixture = TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name)
        self.knowledge = FileKnowledge(self.root)
        objects = self.knowledge.storage / "objects"
        objects.mkdir(parents=True)
        self.source = self.root / "notes"
        self.source.mkdir()
        self.body = "量子纠缠实验"
        data = self.body.encode()
        for folder in (objects, self.source):
            (folder / "sample.md").write_bytes(data)
        with closing(sqlite3.connect(self.knowledge.database)) as db, db:
            db.executescript("""
                CREATE TABLE local_workspaces(workspace_id, slot);
                INSERT INTO local_workspaces VALUES ('test', 1);
                CREATE TABLE kb_roots(id, owner, path, kind);
                CREATE TABLE kb_documents(id, owner, root, name, rev, state);
                CREATE TABLE kb_revisions(id, doc, digest, blob);
                CREATE TABLE kb_chunks(id INTEGER PRIMARY KEY, rev, locator, body);
                CREATE TABLE kb_grants(owner, target);
                CREATE VIRTUAL TABLE kb_fts USING fts5(terms);
                INSERT INTO kb_documents VALUES ('doc', 'test', 'root', 'sample.md', 'v1', 'active');
                INSERT INTO kb_documents VALUES ('other-doc', 'other', NULL, 'sample.md', 'v2', 'active');
                INSERT INTO kb_documents VALUES ('todo-doc', 'test', NULL, 'todo', 'v3', 'active');
                INSERT INTO kb_revisions VALUES ('v3', 'todo-doc', '', '');
                INSERT INTO kb_grants VALUES ('other', 'doc');
            """)
            db.execute("INSERT INTO kb_roots VALUES ('root', 'test', ?, 'directory')", (str(self.source),))
            db.executemany("INSERT INTO kb_revisions VALUES (?, ?, ?, 'objects/sample.md')",
                           [(rev, doc, sha256(data).hexdigest()) for rev, doc in (("v1", "doc"), ("v2", "other-doc"))])
            for index in (1, 2, 3):
                db.execute("INSERT INTO kb_chunks VALUES (?, ?, '段落 1', ?)", (index, f"v{index}", self.body))
                db.execute("INSERT INTO kb_fts(rowid, terms) VALUES (?, ?)", (index, " ".join(terms(self.body))))

    def test_search_keeps_citations_and_scope(self):
        evidence, = self.knowledge.search("请问量子纠缠是什么")
        self.assertEqual((evidence.id, evidence.document_id, evidence.revision, evidence.locator),
                         ("1", "doc", "v1", "段落 1"))
        self.assertEqual(self.knowledge.evidence(1), evidence)
        self.assertIsNone(self.knowledge.evidence(2))
        self.assertIsNone(self.knowledge.evidence(3))
        self.assertEqual(self.knowledge.search("量子纠缠", ("other-doc",)), [])
        self.assertFalse(evidence.cloud_allowed)

    def test_current_grant_and_source_freshness(self):
        with closing(sqlite3.connect(self.knowledge.database)) as db, db:
            db.execute("INSERT INTO kb_grants VALUES ('test', 'root')")
        self.assertTrue(self.knowledge.evidence(1).cloud_allowed)
        (self.source / "sample.md").write_text("source changed", encoding="utf-8")
        self.assertIsNone(self.knowledge.evidence(1))
        self.assertEqual(self.knowledge.search("量子纠缠"), [])

    def test_openapi_declares_bearer_authentication(self):
        schema = create_app(self.root, "fixture-token" * 3).openapi()
        operation = schema["paths"]["/api/v1/knowledge/search"]["post"]
        self.assertEqual(operation["security"], [{"HTTPBearer": []}])


if __name__ == "__main__":
    unittest.main()
