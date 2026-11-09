"""User-facing interaction routes for the Python workbench."""

from typing import Annotated

from fastapi import APIRouter
from pydantic import BaseModel, Field, StringConstraints

from .llm import Answer, GroundedAnswers

DocumentId = Annotated[str, StringConstraints(min_length=1, max_length=128)]


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2048)
    document_ids: list[DocumentId] = Field(default_factory=list, max_length=16)
    use_model: bool = False


def answer_routes(answers: GroundedAnswers) -> APIRouter:
    router = APIRouter(prefix="/api/v1/interaction")

    @router.post("/answers")
    def ask(body: AskRequest) -> Answer:
        return answers.ask(body.question, tuple(body.document_ids), body.use_model)

    return router
