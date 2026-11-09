"""User-facing interaction routes for the Python workbench."""

import asyncio
from dataclasses import dataclass
from hashlib import sha256
import json
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, StringConstraints

from .conversations import Conversations, Grounding
from .abilities import Abilities
from .knowledge import FileKnowledge, relative_parts
from .knowledge.importing import publish_note
from .llm import GroundedAnswers
from .models import ChatTransport, Model
from .research import Agent, Effort, PRESETS, Research
from .workspace import WorkspaceError

RequestId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,96}$")]
Question = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2048)]
DocumentId = Annotated[str, StringConstraints(min_length=1, max_length=128)]
PublicQuery = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class AskRequest(BaseModel):
    question: Question
    document_ids: list[DocumentId] = Field(default_factory=list, max_length=16)
    use_model: bool = False
    model_id: str | None = Field(default=None, max_length=64)
    web_query: PublicQuery | None = None


class TurnRequest(BaseModel):
    clientRequestId: RequestId
    question: Question
    modelId: str = Field(default="", max_length=64)
    useModel: bool = False
    sourceIds: list[DocumentId] = Field(default_factory=list, max_length=16)
    webQuery: PublicQuery | None = None


class ResearchRequest(BaseModel):
    clientRequestId: RequestId
    question: Question
    completionCriteria: str | None = Field(default=None, max_length=1000)
    sourceIds: list[DocumentId] = Field(default_factory=list, max_length=16)
    agents: list[Agent] = Field(min_length=2, max_length=4)
    effort: Effort = Field(default_factory=Effort)


class Control(BaseModel):
    clientRequestId: RequestId
    expectedVersion: int = Field(ge=0)
    action: Literal["pause", "resume", "cancel", "increase_budget", "add_requirement"]
    input: dict = Field(default_factory=dict)


class ReportRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    includeProcess: bool = False


class Decision(BaseModel):
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    decision: Literal["approve", "reject"]


@dataclass
class Report:
    id: str
    run_id: str
    seq: int
    name: str
    text: str
    digest: str
    saving: bool = False
    result: dict | None = None


def workbench_routes(root: Path, knowledge: FileKnowledge, models: dict[str, Model], transport: ChatTransport,
                     compatibility_answers: GroundedAnswers | None = None, *, abilities: Abilities | None = None) -> APIRouter:
    router = APIRouter(prefix="/api/v1/interaction")
    grounding = Grounding(knowledge)
    conversations = Conversations(grounding, models, transport, abilities)
    research = Research(grounding, models, transport)
    reports: dict[str, Report] = {}

    @router.post("/answers")
    async def ask(body: AskRequest):
        if compatibility_answers is not None and not body.web_query:
            return await asyncio.to_thread(compatibility_answers.ask, body.question, tuple(body.document_ids), body.use_model)
        model_id = body.model_id if body.model_id is not None else next(
            (item.id for item in models.values() if item.available), "",
        )
        result = await conversations.single({"question": body.question, "sourceIds": body.document_ids,
                                              "useModel": body.use_model, "modelId": model_id, "webQuery": body.web_query})
        return {"answer": "", **result}

    @router.get("/capabilities")
    async def capabilities():
        return {"models": [{"id": item.id, "label": item.label} for item in models.values() if item.available],
                "effortPresets": PRESETS}

    @router.get("/documents")
    def documents():
        return {"items": knowledge.documents()}

    @router.get("/sessions")
    async def sessions():
        return {"items": [{"id": session.id, "state": "running" if session.worker else "idle"}
                          for session in conversations.sessions.values()]}

    @router.post("/sessions", status_code=201)
    async def create_session():
        return await conversations.snapshot(conversations.create())

    @router.get("/sessions/{identifier}")
    async def get_session(identifier: str):
        return await conversations.snapshot(conversations.find(identifier))

    @router.post("/sessions/{identifier}/turns", status_code=202)
    async def submit(identifier: str, body: TurnRequest):
        return conversations.submit(conversations.find(identifier), body.model_dump())

    @router.post("/sessions/{identifier}/cancel")
    async def cancel(identifier: str):
        session = conversations.find(identifier)
        conversations.cancel(session)
        return await conversations.snapshot(session)

    @router.post("/sessions/{identifier}/close")
    async def close(identifier: str):
        session = conversations.find(identifier)
        conversations.cancel(session)
        del conversations.sessions[identifier]
        return {"closed": True}

    @router.get("/research")
    async def list_research():
        return {"items": [{"id": run.id, "question": run.question, "state": run.state} for run in research.runs.values()]}

    @router.post("/research", status_code=202)
    async def start_research(body: ResearchRequest):
        return await research.snapshot(await research.create(body.model_dump(), body.agents, body.effort))

    @router.get("/research/{identifier}")
    async def get_research(identifier: str):
        return await research.snapshot(research.find(identifier))

    @router.get("/research/{identifier}/artifacts")
    async def artifacts(identifier: str, after: Annotated[int, Query(ge=0)] = 0):
        run = research.find(identifier)
        items = [item for item in run.artifacts if item["seq"] > after] if await research.current(run) else []
        return {"items": items[:20], "next": items[19]["seq"] if len(items) > 20 else 0}

    @router.post("/research/{identifier}/control")
    async def control(identifier: str, body: Control):
        run = research.find(identifier)
        await research.control(run, body.model_dump())
        return await research.snapshot(run)

    @router.post("/research/{identifier}/close")
    async def close_research(identifier: str):
        run = research.find(identifier)
        run.change("cancelled")
        if run.worker:
            run.worker.cancel()
        del research.runs[identifier]
        for key in [key for key, report in reports.items() if report.run_id == identifier and not report.saving]:
            del reports[key]
        return {"closed": True}

    @router.post("/research/{identifier}/save-preview", status_code=201)
    async def preview(identifier: str, body: ReportRequest):
        run = research.find(identifier)
        try:
            name = body.name.strip()
            if relative_parts(name) != (name,) or not name.lower().endswith(".md"):
                raise ValueError()
        except ValueError as error:
            raise HTTPException(422, "invalid_report_name") from error
        state = await research.snapshot(run)
        result = state["result"]
        if not result:
            raise HTTPException(409, "report_unavailable")
        lines = ["# 研究报告", "", run.question, "", result["answer"], "", "## 资料引用"]
        for item in result["evidence"]:
            lines += [f"- {item['title']} · {item['locator']}", f"  {item['quote']}"]
        for label, items in (("分歧", result["disagreements"]), ("未解决", result["gaps"])):
            if items:
                lines += ["", f"## {label}", *[f"- {item}" for item in items]]
        if body.includeProcess:
            lines += ["", "## 研究过程"]
            for item in run.artifacts:
                lines += ["", f"### {item['round']} · {item['agentId']} · {item['phase']}",
                          "", json.dumps(item["data"], ensure_ascii=False, indent=2)]
        report_text = "\n".join(lines)
        digest = sha256(json.dumps([identifier, state["seq"], name, report_text], ensure_ascii=False).encode()).hexdigest()
        for key in [key for key, report in reports.items() if report.run_id == identifier and not report.saving]:
            del reports[key]
        report = Report(str(uuid4()), identifier, state["seq"], name, report_text, digest)
        reports[report.id] = report
        return {"id": report.id, "name": name, "digest": digest, "text": report_text}

    @router.post("/report-previews/{identifier}/decision")
    async def decide(identifier: str, body: Decision):
        report = reports.get(identifier)
        if not report or report.digest != body.digest:
            raise HTTPException(409, "preview_changed")
        if report.saving:
            raise HTTPException(409, "busy")
        if report.result:
            if report.result["decision"] != body.decision:
                raise HTTPException(409, "idempotency_conflict")
            return report.result
        if body.decision == "reject":
            report.result = {"decision": "reject"}
            return report.result
        run = research.find(report.run_id)
        report.saving = True
        try:
            if not await research.current(run) or run.seq != report.seq or research.runs.get(run.id) is not run:
                raise HTTPException(409, "preview_changed")
            # Save only the reviewed text. The preview's ID is also the
            # immutable document ID, so retries cannot create another note.
            result = await asyncio.to_thread(publish_note, root, report.name, report.text, report.id, run.sources)
            report.result = {"decision": "approve", **result}
            return report.result
        except WorkspaceError as error:
            raise HTTPException(409, str(error)) from error
        finally:
            report.saving = False

    return router
