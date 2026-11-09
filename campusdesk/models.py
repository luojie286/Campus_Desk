"""Async DeepSeek transport with bounded responses and no credential disclosure."""

import asyncio
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit

import httpx


class ModelError(RuntimeError):
    pass


@dataclass(frozen=True)
class Model:
    id: str
    label: str
    name: str
    endpoint: str
    credential_env: str
    context: int = 32768
    output: int = 1024
    timeout: float = 30

    @property
    def available(self) -> bool:
        return bool(os.getenv(self.credential_env))


def load_models(root: Path) -> dict[str, Model]:
    path = root / ".private" / "assistant.config.json"
    if not path.is_file():
        return {}
    config = json.loads(path.read_text(encoding="utf-8-sig"))
    if config.get("enabled") is not True:
        return {}
    entries = config.get("models", [])
    if not isinstance(entries, list) or len(entries) > 16:
        raise ValueError("invalid_model_config")
    models = {}
    for item in entries:
        url = urlsplit(item["base_url"])
        if (item["adapter"] != "chat-completions" or url.username or url.password or url.query or url.fragment
                or not (url.scheme == "https" and url.hostname == "api.deepseek.com" and url.port in (None, 443)
                        or url.scheme == "http" and url.hostname == "127.0.0.1")):
            raise ValueError("unsupported_model_provider")
        identifier, label, name, credential = (item[key] for key in ("id", "label", "model", "credential_env"))
        if (not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", identifier) or identifier in models
                or not 1 <= len(label) <= 100 or not 1 <= len(name) <= 128
                or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", credential)):
            raise ValueError("invalid_model_config")
        models[identifier] = Model(
            identifier, label, name, item["base_url"].rstrip("/") + "/chat/completions", credential,
            min(1_000_000, max(1024, int(item.get("context_limit_tokens", 32768)))),
            min(2048, max(64, int(item.get("output_limit_tokens", 1024)))),
            min(60, max(1, int(item.get("timeout_ms", 30000)) / 1000)),
        )
    return models


def estimate(messages: list[dict]) -> int:
    return 256 + sum(64 + len(item["content"].encode()) for item in messages)


class ChatTransport:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None):
        self.transport = transport

    async def complete(self, model: Model, messages: list[dict], output: int, timeout: float) -> tuple[dict, int | None]:
        credential = os.getenv(model.credential_env)
        if not credential:
            raise ModelError("model_unavailable")
        payload = {"model": model.name, "messages": messages, "max_tokens": output, "stream": False,
                   "response_format": {"type": "json_object"}}
        if urlsplit(model.endpoint).hostname == "api.deepseek.com":
            payload["thinking"] = {"type": "disabled"}
        try:
            async with asyncio.timeout(timeout), httpx.AsyncClient(
                transport=self.transport, follow_redirects=False, trust_env=False
            ) as client:
                async with client.stream("POST", model.endpoint, json=payload,
                                         headers={"Authorization": "Bearer " + credential}) as response:
                    response.raise_for_status()
                    data = bytearray()
                    async for block in response.aiter_bytes():
                        if len(data) + len(block) > 256 * 1024:
                            raise ModelError("invalid_model_output")
                        data.extend(block)
        except (TimeoutError, httpx.TimeoutException) as error:
            raise ModelError("model_timeout") from error
        except httpx.HTTPError as error:
            raise ModelError("model_failed") from error
        try:
            envelope = json.loads(data)
            choice = envelope["choices"][0]
            result = json.loads(choice["message"]["content"])
            if not isinstance(result, dict) or choice.get("finish_reason") not in (None, "stop"):
                raise ValueError()
            tokens = envelope.get("usage", {}).get("total_tokens")
        except (AttributeError, KeyError, IndexError, TypeError, ValueError) as error:
            raise ModelError("invalid_model_output") from error
        return result, tokens if type(tokens) is int and tokens >= 0 else None
