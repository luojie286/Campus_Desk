"""Grounded question answering. Model providers implement a small typed port."""

from dataclasses import dataclass, field
from typing import Literal, Protocol

from .knowledge import Evidence, FileKnowledge

Status = Literal["answered", "no_evidence", "local_evidence", "model_unavailable",
                 "cloud_grant_required", "model_failed", "invalid_model_output"]


@dataclass(frozen=True)
class ModelAnswer:
    text: str
    citations: tuple[str, ...]


class AnswerModel(Protocol):
    def answer(self, question: str, evidence: tuple[Evidence, ...]) -> ModelAnswer: ...


@dataclass(frozen=True)
class Answer:
    status: Status
    answer: str = ""
    evidence: list[Evidence] = field(default_factory=list)


class GroundedAnswers:
    def __init__(self, knowledge: FileKnowledge, model: AnswerModel | None = None):
        self.knowledge = knowledge
        self.model = model

    def ask(self, question: str, document_ids: tuple[str, ...], use_model: bool) -> Answer:
        matches = self.knowledge.search(question, document_ids)
        if not matches:
            return Answer("no_evidence")
        if not use_model:
            return Answer("local_evidence", evidence=matches)
        if self.model is None:
            return Answer("model_unavailable", evidence=matches)

        allowed = []
        for candidate in matches:
            current = self.knowledge.evidence(candidate.id)
            if current == candidate and current.cloud_allowed:
                allowed.append(current)
            if len(allowed) == 8:
                break
        if not allowed:
            return Answer("cloud_grant_required")

        try:
            output = self.model.answer(question, tuple(allowed))
        except (TimeoutError, OSError, ValueError):
            return Answer("model_failed")
        # Check every item sent to the model. The answer may use an item even
        # when the model omitted its ID from the returned citation list.
        if any(self.knowledge.evidence(item.id) != item for item in allowed):
            return Answer("cloud_grant_required")
        by_id = {item.id: item for item in allowed}
        if (not isinstance(output, ModelAnswer) or not isinstance(output.text, str)
                or not output.text.strip() or not isinstance(output.citations, tuple)
                or not output.citations or len(output.citations) > len(by_id)
                or any(not isinstance(key, str) or key not in by_id for key in output.citations)):
            return Answer("invalid_model_output")
        return Answer("answered", output.text.strip(), [by_id[key] for key in dict.fromkeys(output.citations)])
