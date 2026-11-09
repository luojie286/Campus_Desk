"""Deeper Research runs: separate agent context, resumable phases and shared budget."""

import asyncio
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import json
from time import monotonic
from uuid import uuid4

from pydantic import BaseModel, Field, StrictInt

from .conversations import Grounding, evidence_payload, model_messages, validate_answer
from .knowledge import Evidence
from .models import ChatTransport, Model, ModelError, estimate
from .workbench_errors import WorkbenchError

PRESETS = {
    "low": {"tokens": 36000, "calls": 9, "rounds": 1, "activeMs": 300000},
    "medium": {"tokens": 100000, "calls": 27, "rounds": 3, "activeMs": 900000},
    "high": {"tokens": 200000, "calls": 54, "rounds": 6, "activeMs": 1800000},
}
CEILINGS = {"tokens": 1_000_000, "calls": 100, "rounds": 12, "activeMs": 3600000}
EDITABLE = {"running", "paused", "budget_exhausted"}
PHASES = ("explore", "review", "synthesize", "assess")
SCHEMAS = {
    "explore": '{"answer":"…","citations":["证据ID"],"gaps":[],"disagreements":[]}',
    "review": '{"claim_id":"产物ID","finding":"…","evidence_ids":[],"severity":"low","proposed_revision":"…"}',
    "synthesize": '{"answer":"…","citations":["证据ID"],"gaps":[],"disagreements":[]}',
    "assess": '{"preferred":"new 或 previous 或 tie","reason":"…","complete":false}',
}
PROMPTS = ["梳理主要证据", "独立检查局限和反例", "探索替代解释", "检查遗漏和不确定性"]


class Agent(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,96}$")
    modelId: str = Field(min_length=1, max_length=64)
    prompt: str = Field(default="", max_length=2000)


class Effort(BaseModel):
    preset: str = "low"
    limits: dict[str, StrictInt] | None = None


def limits_for(effort: Effort) -> dict[str, int]:
    if effort.preset not in {*PRESETS, "custom"}:
        raise WorkbenchError(422, "invalid_budget")
    limits = {**PRESETS.get(effort.preset, {}), **(effort.limits or {})}
    if limits.keys() != CEILINGS.keys() or any(not 1 <= value <= CEILINGS[key] for key, value in limits.items()):
        raise WorkbenchError(422, "invalid_budget")
    return limits


@dataclass
class Budget:
    limits: dict[str, int]
    calls: int = 0
    rounds: int = 0
    tokens: int = 0
    reserved: int = 0
    estimatedCalls: int = 0
    excessTokens: int = 0
    elapsed: int = 0
    start: float | None = None

    def active_ms(self) -> int:
        return self.elapsed + (int((monotonic() - self.start) * 1000) if self.start is not None else 0)

    def stop(self) -> str | None:
        if self.excessTokens:
            return "usage_overrun"
        for reason, used, key in (("time", self.active_ms(), "activeMs"), ("calls", self.calls, "calls"),
                                  ("tokens", self.tokens + self.reserved, "tokens")):
            if used >= self.limits[key]:
                return reason
        return None

    def snapshot(self) -> dict:
        return {**{key: value for key, value in vars(self).items() if key not in ("start", "elapsed")},
                "activeMs": self.active_ms()}


@dataclass
class Run:
    id: str
    question: str
    criteria: str
    agents: list[Agent]
    sources: list[Evidence]
    limited: bool
    budget: Budget
    state: str = "queued"
    reason: str | None = None
    seq: int = 0
    version: int = 0
    phase: str | None = None
    summarizer: str = ""
    failed: dict[str, str] = field(default_factory=dict)
    controls: dict[str, dict] = field(default_factory=dict)
    requirements: list[dict] = field(default_factory=list)
    candidate_requirements: int = 0
    artifacts: list[dict] = field(default_factory=list)
    attempted: set[tuple[str, str]] = field(default_factory=set)
    best: dict | None = None
    evaluated: bool = False
    stagnant: int = 0
    worker: asyncio.Task | None = None

    def change(self, state: str, reason: str | None = None) -> None:
        self.budget.elapsed = self.budget.active_ms()
        self.budget.start = monotonic() if state == "running" else None
        self.state, self.reason = state, reason
        self.seq += 1
        self.version += 1

    def phase_artifacts(self, phase: str) -> list[dict]:
        return [item for item in self.artifacts if item["round"] == self.budget.rounds and item["phase"] == phase]


def summary(artifact: dict) -> dict:
    return {"id": artifact["id"], "agentId": artifact["agentId"], **artifact["data"]}


def text(value, size):
    return isinstance(value, str) and 1 <= len(value.strip()) <= size


def validated(data: dict, phase: str, sources: list[Evidence], shared: list[dict]) -> dict:
    if phase == "assess":
        if (data.get("preferred") not in ("new", "previous", "tie") or not text(data.get("reason"), 1500)
                or type(data.get("complete")) is not bool):
            raise ModelError("invalid_research_response")
        return {key: data[key] for key in ("preferred", "reason", "complete")}
    if phase == "review":
        ids = data.get("evidence_ids")
        if (not any(item["id"] == data.get("claim_id") for item in shared)
                or not text(data.get("finding"), 1500) or not text(data.get("proposed_revision"), 1500)
                or data.get("severity") not in ("low", "medium", "high")
                or not isinstance(ids, list) or len(ids) > 8
                or any(not any(item.id == key for item in sources) for key in ids)):
            raise ModelError("invalid_research_response")
        return {key: data[key] for key in ("claim_id", "finding", "proposed_revision", "severity", "evidence_ids")}
    result = validate_answer(data, sources)
    for key in ("gaps", "disagreements"):
        values = data.get(key, [])
        if not isinstance(values, list) or len(values) > 8 or any(not text(item, 500) for item in values):
            raise ModelError("invalid_research_response")
        result[key] = values
    return result


class Research:
    def __init__(self, grounding: Grounding, models: dict[str, Model], transport: ChatTransport):
        self.grounding = grounding
        self.models = models
        self.transport = transport
        self.runs: dict[str, Run] = {}
        self.receipts: dict[str, tuple[dict, str]] = {}
        self.active: Run | None = None

    def find(self, identifier: str) -> Run:
        if identifier not in self.runs:
            raise WorkbenchError(410, "session_expired")
        return self.runs[identifier]

    async def current(self, run: Run) -> bool:
        return len(await self.grounding.current(run.sources, cloud=True)) == len(run.sources)

    async def snapshot(self, run: Run) -> dict:
        current = await self.current(run)
        best = run.best if current else None
        result = None
        if best:
            result = {**summary(best), "provisional": not run.evaluated,
                      "evidence": [asdict(item) for item in run.sources if item.id in best["data"]["citations"]]}
        return {"id": run.id, "question": run.question, "state": run.state, "reason": run.reason if current else "source_changed",
                "seq": run.seq, "version": run.version, "phase": run.phase, "summarizer": run.summarizer,
                "sourceCount": len(run.sources) if current else 0, "limited": run.limited,
                "failed": [{"agentId": key, "code": code} for key, code in run.failed.items()],
                "budget": run.budget.snapshot(), "requirements": run.requirements.copy(), "result": result}

    async def create(self, data: dict, agents: list[Agent], effort: Effort) -> Run:
        key = data["clientRequestId"]
        prior = self.receipts.get(key)
        if prior:
            if prior[0] != data:
                raise WorkbenchError(409, "idempotency_conflict")
            return self.find(prior[1])
        if self.active or len(self.runs) >= 8:
            raise WorkbenchError(429, "busy")
        if len({agent.id for agent in agents}) != len(agents):
            raise WorkbenchError(422, "invalid_agents")
        if any(agent.modelId not in self.models or not self.models[agent.modelId].available for agent in agents):
            raise WorkbenchError(503, "model_unavailable")
        budget = Budget(limits_for(effort))
        matches = await asyncio.to_thread(self.grounding.knowledge.research_sources, data["question"], tuple(data["sourceIds"]))
        if not matches:
            raise WorkbenchError(422, "no_evidence")
        sources = (await self.grounding.current(matches, cloud=True))[:8]
        if not sources:
            raise WorkbenchError(403, "cloud_grant_required")
        prior = self.receipts.get(key)
        if prior:
            if prior[0] != data:
                raise WorkbenchError(409, "idempotency_conflict")
            return self.find(prior[1])
        if self.active or len(self.runs) >= 8:
            raise WorkbenchError(429, "busy")
        run = Run(str(uuid4()), data["question"], data.get("completionCriteria") or "", agents,
                  sources, len(sources) < len(matches), budget, summarizer=agents[0].id)
        self.runs[run.id] = run
        self.receipts[key] = (data, run.id)
        if len(self.receipts) > 256:
            self.receipts.pop(next(iter(self.receipts)))
        self.launch(run)
        return run

    def launch(self, run: Run) -> None:
        if self.active:
            raise WorkbenchError(429, "busy")
        self.active = run
        run.change("running")
        run.worker = asyncio.create_task(self.drive(run))
        run.worker.add_done_callback(lambda task: self.finished(run, task))

    def finished(self, run: Run, task: asyncio.Task) -> None:
        if run.worker is task:
            run.worker = None
        if self.active is run and run.worker is None:
            self.active = None
        if not task.cancelled() and task.exception() is not None and run.state == "running":
            run.change("failed", "research_failed")

    async def invoke(self, run: Run, agent: Agent, phase: str, shared: list[dict]) -> str | None:
        if not await self.current(run):
            run.change("paused", "source_changed")
            return None
        budget = run.budget
        if stop := budget.stop():
            return stop
        model = self.models[agent.modelId]
        requirement_count = len(run.requirements)
        own = [item for item in run.artifacts if item["agentId"] == agent.id][-2:]
        messages = model_messages(
            f"当前阶段 {phase}。依据提供的资料完成研究分工。输出格式 {SCHEMAS[phase]}。"
            "评审使用 shared 内的产物 ID，比较时 shared 第一项是候选报告，第二项是当前报告。"
            "complete 表示较优报告已满足 completionCriteria，或已基于现有证据回答全部可回答部分并标明局限。"
            "比较可以保留当前报告；已记录且资料无法解决的局限不需要再讨论",
            {"question": run.question, "completionCriteria": run.criteria, "requirements": run.requirements,
             "prompt": agent.prompt.strip() or PROMPTS[run.agents.index(agent)],
             "history": [summary(item) for item in own], "shared": [summary(item) for item in shared],
             "evidence": evidence_payload(run.sources)},
        )
        cost = estimate(messages)
        context_output = min(model.output, model.context - cost)
        key = (phase, agent.id)
        if context_output < 1:
            run.failed[agent.id] = "context_limit"
            run.attempted.add(key)
            return None
        output = min(context_output, budget.limits["tokens"] - budget.tokens - cost)
        if output < 1:
            return "tokens"
        # Each run dispatches one request at a time. Reserve input and output
        # before I/O, and charge the reservation if cancellation hides usage.
        budget.calls += 1
        budget.reserved = cost + output
        usage = None
        try:
            result, usage = await self.transport.complete(
                model, messages, output, min(model.timeout, max(.001, (budget.limits["activeMs"] - budget.active_ms()) / 1000)),
            )
            if not await self.current(run):
                run.change("paused", "source_changed")
                return None
            if budget.active_ms() >= budget.limits["activeMs"]:
                return "time"
            data = validated(result, phase, run.sources, shared)
            item = {"id": str(uuid4()), "seq": run.seq + 1, "round": budget.rounds, "phase": phase,
                    "agentId": agent.id, "modelId": model.id, "data": data}
            run.artifacts.append(item)
            if phase == "synthesize":
                run.candidate_requirements = requirement_count
            if phase == "explore" and run.best is None:
                run.best = item
            run.attempted.add(key)
        except ModelError as error:
            if budget.active_ms() >= budget.limits["activeMs"]:
                return "time"
            run.failed[agent.id] = str(error)
            run.attempted.add(key)
        finally:
            if usage is None:
                budget.estimatedCalls += 1
                usage = budget.reserved
            budget.excessTokens += max(0, usage - budget.reserved)
            budget.tokens += usage
            budget.reserved = 0
            run.seq += 1
        return "usage_overrun" if budget.excessTokens else None

    def next_calls(self, run: Run) -> list[tuple[Agent, list[dict]]]:
        agents = [agent for agent in run.agents if agent.id not in run.failed]
        explored, reviewed, candidate = (run.phase_artifacts(phase) for phase in PHASES[:3])
        if run.phase == "explore":
            return [(agent, [run.best] if run.best and run.best["round"] < run.budget.rounds else []) for agent in agents]
        if run.phase == "review":
            return [(agent, [item for item in explored if item["agentId"] != agent.id]) for agent in agents
                    if any(item["agentId"] != agent.id for item in explored)]
        if run.phase == "synthesize":
            if not agents or not explored or candidate:
                return []
            run.summarizer = agents[0].id
            return [(agents[0], explored + reviewed)]
        if not candidate or run.phase_artifacts("assess"):
            return []
        reviewer = next((agent for agent in agents if agent.id != candidate[0]["agentId"]), None)
        return [(reviewer, candidate + ([run.best] if run.best else []))] if reviewer else []

    async def drive(self, run: Run) -> None:
        while run.state == "running":
            if not run.phase:
                stop = run.budget.stop() or ("rounds" if run.budget.rounds >= run.budget.limits["rounds"] else None)
                if stop:
                    run.change("budget_exhausted", stop)
                    return
                run.budget.rounds += 1
                run.phase = "explore"
                run.attempted.clear()
                run.seq += 1
            if len(run.failed) == len(run.agents):
                run.change("partial" if run.best else "failed", "all_agents_failed")
                return
            next_call = next(((agent, shared) for agent, shared in self.next_calls(run)
                              if (run.phase, agent.id) not in run.attempted), None)
            if next_call:
                # Completed agent/phase pairs stay checkpointed across pause
                # and budget increases. A cancelled request can be retried.
                stop = await self.invoke(run, next_call[0], run.phase, next_call[1])
                if stop and run.state == "running":
                    run.change("budget_exhausted", stop)
                continue
            if run.phase != "assess":
                run.phase = PHASES[PHASES.index(run.phase) + 1]
                run.seq += 1
                continue
            candidate = run.phase_artifacts("synthesize")
            comparison = run.phase_artifacts("assess")
            if not candidate or not comparison:
                run.change("partial" if run.best else "failed", "review_unavailable" if run.best else "no_result")
                return
            decision = comparison[0]["data"]
            improved = decision["preferred"] == "new" or run.best is None
            if improved:
                run.best = candidate[0]
            run.evaluated = True
            run.stagnant = 0 if improved else run.stagnant + 1
            if run.candidate_requirements == len(run.requirements) and (decision["complete"] or run.stagnant >= 2):
                run.change("partial" if run.failed or not decision["complete"] else "completed",
                           None if decision["complete"] else "no_improvement")
                return
            run.phase = None

    async def control(self, run: Run, data: dict) -> None:
        key, action = data["clientRequestId"], data["action"]
        if key in run.controls:
            if run.controls[key] != data:
                raise WorkbenchError(409, "idempotency_conflict")
            return
        if data["expectedVersion"] != run.version:
            raise WorkbenchError(409, "stale_version")
        if len(run.controls) >= 200:
            raise WorkbenchError(429, "busy")
        allowed = {"pause": {"running"}, "resume": {"paused"}, "cancel": EDITABLE,
                   "add_requirement": EDITABLE, "increase_budget": {"budget_exhausted"}}
        if run.state not in allowed[action]:
            raise WorkbenchError(409, "invalid_state")
        if action in ("resume", "increase_budget"):
            if self.active:
                raise WorkbenchError(429, "busy")
            if not await self.current(run):
                raise WorkbenchError(409, "source_changed")
            if data["expectedVersion"] != run.version:
                raise WorkbenchError(409, "stale_version")
            if self.active:
                raise WorkbenchError(429, "busy")
            if action == "increase_budget":
                update = data["input"].get("limits")
                if (not isinstance(update, dict) or update.keys() != CEILINGS.keys()
                        or any(type(value) is not int or not run.budget.limits[k] <= value <= CEILINGS[k]
                               for k, value in update.items()) or update == run.budget.limits
                        or update["tokens"] < run.budget.tokens):
                    raise WorkbenchError(422, "invalid_budget")
                run.budget.limits = update
                run.budget.excessTokens = 0
            self.launch(run)
        elif action == "add_requirement":
            requirement = data["input"].get("requirement")
            if not text(requirement, 1000) or len(run.requirements) >= 12:
                raise WorkbenchError(422, "invalid_input")
            run.requirements.append({"text": requirement.strip(), "time": datetime.now(timezone.utc).isoformat()})
            run.seq += 1
            run.version += 1
        else:
            run.change("paused" if action == "pause" else "cancelled")
            if run.worker:
                run.worker.cancel()
        run.controls[key] = data
