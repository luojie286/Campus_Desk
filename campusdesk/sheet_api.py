"""Interaction routes for approved spreadsheet operations and workspace todos."""

from typing import Annotated, Literal

from fastapi import APIRouter, Path
from pydantic import BaseModel, Field, StringConstraints

from .sheets import Sheets

Identifier = Annotated[int, Field(gt=0, le=2**63 - 1)]
PathId = Annotated[int, Path(gt=0, le=2**63 - 1)]
RequestId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,96}$")]


class Prepare(BaseModel):
    target: str = Field(min_length=1, max_length=2048)
    clientRequestId: RequestId
    todoId: Identifier | None = None


class Approval(BaseModel):
    plan_id: Identifier
    plan_version: Identifier
    plan_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    client_request_id: RequestId


class Answer(BaseModel):
    key: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{0,49}$")
    value: str = Field(min_length=1, max_length=1000, pattern=r"\S")


class Answers(BaseModel):
    answers: list[Answer] = Field(min_length=1, max_length=32)
    task_version: Identifier


class TodoDecision(BaseModel):
    status: Literal["open", "done", "deleted"]


def routes(sheets: Sheets | None):
    router = APIRouter(prefix="/api/v1/interaction")

    @router.get("/business")
    def capability():
        enabled = bool(sheets and sheets.worker and not sheets.worker.done())
        return {"enabled": enabled, "execute": bool(enabled and sheets.can_execute())}

    if sheets is None:
        return router

    @router.get("/sheet-tasks")
    def tasks():
        return {"items": sheets.list()}

    @router.post("/sheet-tasks", status_code=202)
    def prepare(body: Prepare):
        return sheets.create(body.target, body.clientRequestId, body.todoId)

    @router.get("/sheet-tasks/{identifier}")
    def detail(identifier: PathId):
        return sheets.detail(identifier)

    @router.post("/sheet-tasks/{identifier}/approvals")
    def approve(identifier: PathId, body: Approval):
        return sheets.approve(identifier, body.plan_id, body.plan_version, body.plan_digest, body.client_request_id)

    @router.post("/sheet-tasks/{identifier}/answers")
    def answers(identifier: PathId, body: Answers):
        sheets.answer(identifier, [answer.model_dump() for answer in body.answers], body.task_version)
        return {"id": identifier}

    @router.post("/sheet-tasks/{identifier}/{action}")
    def action(identifier: PathId, action: Literal["cancel", "reconcile", "resume"]):
        sheets.action(identifier, action)
        return {"id": identifier}

    @router.get("/todos")
    def todos():
        return {"items": sheets.todos()}

    @router.post("/todos/{identifier}/decision")
    def todo(identifier: PathId, body: TodoDecision):
        sheets.todo_status(identifier, body.status)
        return {"id": identifier}

    @router.get("/legacy-runs")
    def legacy_runs():
        return {"items": sheets.legacy_runs()}

    @router.post("/legacy-runs/{identifier}/prepare")
    def prepare_legacy(identifier: PathId):
        return sheets.prepare_legacy(identifier)

    return router
