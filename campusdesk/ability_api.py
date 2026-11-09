"""Interaction entry points for abilities and a distinct NapCat callback credential."""

import asyncio
from dataclasses import asdict
import hmac
import json
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from .abilities import Abilities
from .abilities.qq import QQ
from .abilities.search import SearchInput
from .inbox import QQInbox
from .workbench_errors import WorkbenchError

MAX_EVENT = 256 * 1024
MAX_ID = 2**63 - 1


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=200)
    limit: int = Field(default=5, ge=1, le=10)


class PullRequest(BaseModel):
    sourceId: int = Field(gt=0, le=MAX_ID)
    count: int = Field(default=20, ge=1, le=50)


class CandidateDecision(BaseModel):
    decision: Literal["accepted", "dismissed"]


def listener(runtime: Abilities) -> QQ:
    ability = runtime.continuous.get("qq.listen")
    if not isinstance(ability, QQ):
        raise WorkbenchError(503, "ability_disabled")
    return ability


def ability_routes(runtime: Abilities) -> APIRouter:
    router = APIRouter(prefix="/api/v1/interaction")

    @router.get("/abilities")
    async def catalog():
        return {"items": runtime.catalog()}

    @router.post("/abilities/search")
    async def search(body: SearchRequest):
        result = await runtime.invoke("web.search", SearchInput(body.query, body.limit))
        return {"items": [asdict(hit) for hit in result]}

    @router.get("/qq/sources")
    async def sources():
        qq = listener(runtime)
        qq.require_running()
        _, ingress, history, rows = await asyncio.to_thread(qq.scope)
        items = [{"id": row["id"], "name": row["display_name"] or row["type"], "type": row["type"]} for row in rows]
        return {"items": items if ingress or history else [], "historyAllowed": history, "ingressAllowed": ingress}

    @router.post("/qq/history")
    async def pull(body: PullRequest):
        return await listener(runtime).pull(body.sourceId, body.count)

    @router.get("/qq/probe")
    async def probe():
        return await listener(runtime).probe()

    @router.get("/qq/events")
    async def events(before: Annotated[int, Query(gt=0, le=MAX_ID)] = MAX_ID,
                     limit: Annotated[int, Query(ge=1, le=100)] = 50):
        return {"items": await asyncio.to_thread(QQInbox(listener(runtime)).items, candidates=False, before=before, limit=limit)}

    @router.get("/qq/candidates")
    async def candidates(before: Annotated[int, Query(gt=0, le=MAX_ID)] = MAX_ID,
                         limit: Annotated[int, Query(ge=1, le=100)] = 50):
        return {"items": await asyncio.to_thread(QQInbox(listener(runtime)).items, candidates=True, before=before, limit=limit)}

    @router.post("/qq/candidates/{identifier}/decision")
    async def decide(identifier: int, body: CandidateDecision):
        if not 1 <= identifier <= MAX_ID:
            raise WorkbenchError(404, "qq_candidate_not_found")
        return await asyncio.to_thread(QQInbox(listener(runtime)).decide, identifier, body.decision)

    return router


def napcat_routes(runtime: Abilities) -> APIRouter:
    router = APIRouter()

    @router.post("/api/v1/abilities/qq/callback")
    async def callback(request: Request):
        qq = listener(runtime)
        qq.require_running()
        data = bytearray()
        async for block in request.stream():
            if len(data) + len(block) > MAX_EVENT:
                raise WorkbenchError(413, "event_too_large")
            data.extend(block)
        secret = qq.settings.callback_token.encode()
        expected = b"sha1=" + hmac.new(secret, data, "sha1").hexdigest().encode()
        bearer = request.headers.get("authorization", "").encode()
        signature = request.headers.get("x-signature", "").encode()
        if not (hmac.compare_digest(bearer, b"Bearer " + secret) or hmac.compare_digest(signature, expected)):
            raise WorkbenchError(401, "unauthorized")
        try:
            event = json.loads(data)
        except (ValueError, RecursionError) as error:
            raise WorkbenchError(400, "invalid_event") from error
        if not isinstance(event, dict):
            raise WorkbenchError(400, "invalid_event")
        return await qq.receive(event)

    return router
