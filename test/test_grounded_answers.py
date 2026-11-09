from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock

from campusdesk.knowledge import FileKnowledge
from campusdesk.knowledge.importing import import_file, initialize
from campusdesk.knowledge.permissions import set_cloud_permission
from campusdesk.knowledge_api import create_app
from campusdesk.llm import GroundedAnswers, ModelAnswer


class GroundedAnswerTest(unittest.TestCase):
    def setUp(self):
        fixture = TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name).resolve()
        initialize(self.root)
        source = self.root / "notice.md"
        source.write_text("合成课程编号 8049", encoding="utf-8")
        self.document = import_file(self.root, source, import_file(self.root, source)["digest"])["document_id"]
        self.knowledge = FileKnowledge(self.root)
        self.model = Mock()
        self.service = GroundedAnswers(self.knowledge, self.model)

    def test_model_requires_explicit_request_and_document_consent(self):
        self.assertEqual(self.service.ask("8049", (), False).status, "local_evidence")
        self.assertEqual(self.service.ask("8049", (), True).status, "cloud_grant_required")
        self.assertEqual(self.service.ask("9877", (), True).status, "no_evidence")
        self.model.answer.assert_not_called()

    def test_model_output_and_citation_are_validated(self):
        set_cloud_permission(self.root, self.document, True)
        citation, = self.knowledge.search("8049")
        self.model.answer.return_value = ModelAnswer("课程编号是 8049", (citation.id,))
        result = self.service.ask("8049", (), True)
        self.assertEqual(result.status, "answered")
        self.assertEqual(result.evidence, [citation])
        self.model.answer.assert_called_once_with("8049", (citation,))
        self.model.answer.return_value = ModelAnswer("错误引用", ("unknown",))
        self.assertEqual(self.service.ask("8049", (), True).status, "invalid_model_output")

    def test_grant_revoked_during_answer_discards_result(self):
        set_cloud_permission(self.root, self.document, True)
        citation, = self.knowledge.search("8049")

        def revoke(_question, _evidence):
            set_cloud_permission(self.root, self.document, False)
            return ModelAnswer("课程编号是 8049", (citation.id,))

        self.model.answer.side_effect = revoke
        result = self.service.ask("8049", (), True)
        self.assertEqual(result.status, "cloud_grant_required")
        self.assertEqual(result.answer, "")
        self.assertEqual(result.evidence, [])

    def test_interaction_route_requires_bearer(self):
        schema = create_app(self.root, "synthetic-token" * 3).openapi()
        operation = schema["paths"]["/api/v1/interaction/answers"]["post"]
        self.assertEqual(operation["security"], [{"HTTPBearer": []}])
