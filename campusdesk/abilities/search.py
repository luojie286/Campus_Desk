"""Explicit-query search. Providers are fixed origins; results are untrusted evidence."""

from dataclasses import dataclass
from html import unescape
import ipaddress
import re
from urllib.parse import quote, urlsplit

import httpx

from . import AbilitySpec
from .http import request_json
from ..workbench_errors import WorkbenchError


@dataclass(frozen=True)
class SearchInput:
    query: str
    limit: int = 5


@dataclass(frozen=True)
class SearchHit:
    title: str
    url: str
    excerpt: str
    provider: str


def plain(value, size: int) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(unescape(re.sub(r"<[^>]*>", " ", value)).split())[:size]


def safe_link(value) -> str | None:
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\\\x00-\x20\x7f]", value):
        return None
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").rstrip(".")
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None
        if not re.fullmatch(r"[a-zA-Z0-9.-]+", host) or "." not in host or host.endswith((".local", ".localhost")):
            return None
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            # Browsers can normalize ambiguous numeric hostnames to IPs.
            # Only accept DNS names whose final label has a DNS suffix shape.
            suffix = host.rsplit(".", 1)[-1]
            if not re.fullmatch(r"(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})", suffix, re.I):
                return None
        else:
            if not address.is_global:
                return None
    except ValueError:
        return None
    return value


class Search:
    spec = AbilitySpec("web.search", 1, "single")

    def __init__(self, provider: str, key: str = "", transport: httpx.AsyncBaseTransport | None = None):
        if provider not in ("crossref", "brave") or (provider == "brave" and not key):
            raise ValueError("invalid_search_config")
        self.provider, self.key, self.transport = provider, key, transport

    async def invoke(self, value: SearchInput) -> list[SearchHit]:
        query = value.query.strip()
        if not 1 <= len(query) <= 200 or not 1 <= value.limit <= 10:
            raise WorkbenchError(422, "invalid_search_query")
        async with httpx.AsyncClient(transport=self.transport, trust_env=False) as client:
            if self.provider == "crossref":
                body = await request_json(client, "GET", "https://api.crossref.org/works",
                                          params={"query.bibliographic": query, "rows": value.limit,
                                                  "select": "DOI,title,container-title,published,abstract"})
                envelope = body.get("message")
                rows = envelope.get("items") if isinstance(envelope, dict) else None
            else:
                body = await request_json(client, "GET", "https://api.search.brave.com/res/v1/web/search",
                                          params={"q": query, "count": value.limit},
                                          headers={"X-Subscription-Token": self.key})
                envelope = body.get("web", {})
                rows = envelope.get("results", []) if isinstance(envelope, dict) else None
        if not isinstance(rows, list):
            raise WorkbenchError(502, "ability_provider_failed")
        result = []
        for row in rows[:value.limit]:
            if not isinstance(row, dict):
                continue
            hit = self.hit(row)
            if hit and all(item.url != hit.url for item in result):
                result.append(hit)
        return result

    def hit(self, row: dict) -> SearchHit | None:
        if self.provider == "crossref":
            doi = row.get("DOI")
            titles = row.get("title")
            title = plain(titles[0], 240) if isinstance(titles, list) and titles else ""
            if not isinstance(doi, str) or not re.fullmatch(r"10\.\d{4,9}/\S{1,240}", doi):
                return None
            url = "https://doi.org/" + quote(doi, safe="/")
            venues = row.get("container-title")
            venue = plain(venues[0], 180) if isinstance(venues, list) and venues else ""
            excerpt = plain(row.get("abstract"), 700) or ("期刊：" + venue if venue else "Crossref DOI 元数据")
        else:
            url = safe_link(row.get("url"))
            title = plain(row.get("title"), 240)
            excerpt = plain(row.get("description"), 700)
        return SearchHit(title, url, excerpt, self.provider) if title and url else None
