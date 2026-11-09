"""Local HTTP entry point for the Python knowledge migration."""

from pathlib import Path
from secrets import compare_digest
import sqlite3
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Path as PathParam, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, StringConstraints

from .knowledge import Evidence, FileKnowledge
from .interaction import answer_routes
from .llm import AnswerModel, GroundedAnswers

DocumentId = Annotated[str, StringConstraints(min_length=1, max_length=128)]


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2048)
    document_ids: list[DocumentId] = Field(default_factory=list, max_length=16)


def create_app(root: Path, token: str, *, model: AnswerModel | None = None) -> FastAPI:
    if len(token) < 32:
        raise ValueError("knowledge_token_required")
    bearer = HTTPBearer(auto_error=False)
    knowledge = FileKnowledge(root)
    app = FastAPI(title="CampusDesk Knowledge")

    def authorize(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
        if credentials is None or not compare_digest(credentials.credentials.encode(), token.encode()):
            raise HTTPException(401, "unauthorized", headers={"WWW-Authenticate": "Bearer"})

    @app.middleware("http")
    async def prevent_cache(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(sqlite3.Error)
    async def unavailable(_request: Request, _error: sqlite3.Error):
        return JSONResponse({"detail": "knowledge_unavailable"}, status_code=503)

    @app.post("/api/v1/knowledge/search", dependencies=[Depends(authorize)])
    def search(body: SearchRequest) -> list[Evidence]:
        return knowledge.search(body.query, tuple(body.document_ids))

    @app.get("/api/v1/knowledge/evidence/{evidence_id}", dependencies=[Depends(authorize)])
    def evidence(evidence_id: Annotated[str, PathParam(min_length=1, max_length=64)],
                 revision: Annotated[str | None, StringConstraints(max_length=128)] = None) -> Evidence:
        item = knowledge.evidence(evidence_id, revision)
        if item is None:
            raise HTTPException(404, "evidence_not_found")
        return item

    app.include_router(answer_routes(GroundedAnswers(knowledge, model)), dependencies=[Depends(authorize)])
    return app
