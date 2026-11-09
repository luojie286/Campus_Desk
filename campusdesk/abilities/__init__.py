"""Registered abilities have a public identity, a mode, and an explicit lifecycle."""

import asyncio
from dataclasses import dataclass
import sqlite3
from typing import Generic, Protocol, TypeVar

from ..workbench_errors import WorkbenchError

Input = TypeVar("Input", contravariant=True)
Output = TypeVar("Output", covariant=True)


@dataclass(frozen=True)
class AbilitySpec:
    id: str
    version: int
    mode: str


@dataclass(frozen=True)
class AbilityEvent:
    id: int
    workspace: str
    ability: str
    type: str
    payload: dict


class EventConsumer(Protocol):
    def initialize(self, db: sqlite3.Connection) -> None: ...
    def accept(self, db: sqlite3.Connection, event: AbilityEvent) -> None: ...


class OneShot(Protocol[Input, Output]):
    spec: AbilitySpec

    async def invoke(self, value: Input) -> Output: ...


class Continuous(Protocol):
    spec: AbilitySpec

    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    def status(self) -> str: ...


class Abilities:
    def __init__(self):
        self.single: dict[str, OneShot] = {}
        self.continuous: dict[str, Continuous] = {}
        self.failed: set[str] = set()
        self.unavailable: dict[str, AbilitySpec] = {}

    def register(self, ability: OneShot | Continuous) -> None:
        spec = ability.spec
        if spec.id in self.single or spec.id in self.continuous:
            raise ValueError("duplicate_ability")
        if spec.mode == "single":
            self.single[spec.id] = ability
        elif spec.mode == "continuous":
            self.continuous[spec.id] = ability
        else:
            raise ValueError("invalid_ability_mode")

    async def invoke(self, key: str, value):
        ability = self.single.get(key)
        if ability is None:
            raise WorkbenchError(503, "ability_disabled")
        return await ability.invoke(value)

    async def start(self) -> None:
        self.failed.clear()
        for key, ability in self.continuous.items():
            try:
                await ability.start()
            except Exception:
                self.failed.add(key)

    async def stop(self) -> None:
        await asyncio.gather(*(ability.stop() for ability in self.continuous.values()), return_exceptions=True)

    def catalog(self) -> list[dict]:
        return [vars(item.spec) | {"state": "available"} for item in self.single.values()] + [
            vars(item.spec) | {"state": "failed" if key in self.failed else item.status()}
            for key, item in self.continuous.items()
        ] + [vars(spec) | {"state": "unavailable"} for spec in self.unavailable.values()]
