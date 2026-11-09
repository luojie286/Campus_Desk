from contextlib import closing
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

from docx import Document

from campusdesk.knowledge import FileKnowledge
from campusdesk.knowledge.admission import admit_todo
from campusdesk.knowledge.importing import import_file, initialize
from campusdesk.knowledge.permissions import set_cloud_permission
from campusdesk.workspace import WorkspaceError


class NativeKnowledgeTest(unittest.TestCase):
    def setUp(self):
        fixture = TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name).resolve()
        self.owner = initialize(self.root)["workspace_id"]
        self.knowledge = FileKnowledge(self.root)

    def test_native_import_and_historical_reference(self):
        source = self.root / "note.md"
        source.write_text("独立检索编号 6139", encoding="utf-8")
        preview = import_file(self.root, source)
        self.assertEqual(self.knowledge.search("6139"), [])
        first = import_file(self.root, source, preview["digest"])
        evidence, = self.knowledge.search("6139")
        set_cloud_permission(self.root, first["document_id"], True)
        self.assertTrue(self.knowledge.evidence(evidence.id).cloud_allowed)
        source.write_text("更新检索编号 6140", encoding="utf-8")
        with self.assertRaisesRegex(WorkspaceError, "preview_changed"):
            import_file(self.root, source, preview["digest"])
        self.assertIsNone(self.knowledge.evidence(evidence.id))
        second = import_file(self.root, source, import_file(self.root, source)["digest"])
        self.assertEqual(first["document_id"], second["document_id"])
        self.assertNotEqual(first["revision"], second["revision"])
        self.assertEqual(self.knowledge.search("6139"), [])
        self.assertEqual(self.knowledge.evidence(evidence.id, evidence.revision).quote, evidence.quote)
        self.assertTrue(import_file(self.root, source, import_file(self.root, source)["digest"])["unchanged"])
        set_cloud_permission(self.root, first["document_id"], False)
        self.assertFalse(self.knowledge.evidence(evidence.id, evidence.revision).cloud_allowed)

    def test_docx_import(self):
        source = self.root / "note.docx"
        document = Document()
        document.add_paragraph("synthetic milestone 7421")
        document.save(source)
        import_file(self.root, source, import_file(self.root, source)["digest"])
        evidence, = self.knowledge.search("7421")
        self.assertEqual(evidence.locator, "第 1 段")

    def test_pdf_import(self):
        source = self.root / "note.pdf"
        stream = b"BT /F1 24 Tf 72 720 Td (synthetic evidence 8921) Tj ET"
        objects = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ]
        data = bytearray(b"%PDF-1.4\n")
        offsets = []
        for index, item in enumerate(objects, 1):
            offsets.append(len(data))
            data.extend(b"%d 0 obj\n" % index + item + b"\nendobj\n")
        xref = len(data)
        data.extend(b"xref\n0 6\n0000000000 65535 f \n")
        for offset in offsets:
            data.extend(b"%010d 00000 n \n" % offset)
        data.extend(b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % xref)
        source.write_bytes(data)
        import_file(self.root, source, import_file(self.root, source)["digest"])
        evidence, = self.knowledge.search("8921")
        self.assertEqual(evidence.locator, "第 1 页")

    def test_todo_and_profile_current_permissions(self):
        with closing(sqlite3.connect(self.knowledge.database)) as db, db:
            db.executescript("""
                CREATE TABLE messages(id, content_text, platform, account_ref);
                INSERT INTO messages VALUES (1,'实验报告 8892','qq','fixture');
                CREATE TABLE todos(id, title, due_at, status);
                INSERT INTO todos VALUES (1,'待办标题',NULL,'open');
                CREATE TABLE todo_messages(todo_id, message_id);
                INSERT INTO todo_messages VALUES (1,1);
                CREATE TABLE profile_fields(key,value);
                INSERT INTO profile_fields VALUES ('major','合成专业');
            """)
            db.execute("INSERT INTO workspace_source_bindings VALUES (?,'qq','fixture',0,1)", (self.owner,))
        self.assertEqual(self.knowledge.search("8892"), [])
        plan = admit_todo(self.root, 1)
        self.assertEqual(admit_todo(self.root, 1, plan["digest"]), {"admitted": 1})
        self.assertEqual(admit_todo(self.root, 1, plan["digest"]), {"admitted": 0})
        source, = self.knowledge.search("8892")
        self.assertEqual(self.knowledge.evidence("todo-1").quote, "待办标题")
        profile, = self.knowledge.search("我的专业")
        self.assertFalse(profile.cloud_allowed)
        set_cloud_permission(self.root, profile.id, True)
        self.assertTrue(self.knowledge.evidence(profile.id, profile.revision).cloud_allowed)
        with closing(sqlite3.connect(self.knowledge.database)) as db, db:
            db.execute("UPDATE workspace_source_bindings SET history_allowed=0")
            db.execute("INSERT INTO profile_deleted_fields VALUES ('major')")
        self.assertIsNone(self.knowledge.evidence(source.id))
        self.assertIsNone(self.knowledge.evidence("todo-1"))
        self.assertIsNone(self.knowledge.evidence(profile.id))
