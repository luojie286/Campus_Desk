"""Fixed-origin, size-bounded network calls for abilities."""

import asyncio
import json

import httpx

from ..workbench_errors import WorkbenchError


async def request_json(client: httpx.AsyncClient, method: str, url: str, *,
                       limit: int = 1_048_576, timeout: float = 12, **kwargs) -> dict:
    try:
        async with asyncio.timeout(timeout), client.stream(method, url, follow_redirects=False, **kwargs) as response:
            if response.status_code == 429:
                raise WorkbenchError(503, "ability_rate_limited")
            response.raise_for_status()
            data = bytearray()
            async for block in response.aiter_bytes(chunk_size=65536):
                if len(block) + len(data) > limit:
                    raise WorkbenchError(502, "ability_response_too_large")
                data.extend(block)
        body = json.loads(data)
        if not isinstance(body, dict):
            raise ValueError()
        return body
    except (TimeoutError, httpx.TimeoutException) as error:
        raise WorkbenchError(504, "ability_timeout") from error
    except (ValueError, httpx.HTTPError) as error:
        raise WorkbenchError(502, "ability_provider_failed") from error
