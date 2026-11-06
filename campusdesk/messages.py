"""消息应用规则。接入适配器只传入身份和来源元数据。"""
from __future__ import annotations

import json
import sys


def _id(value) -> str | None:
    if type(value) is int:
        return str(value)
    if isinstance(value, str) and value.strip() and len(value) <= 128 and ":" not in value:
        return value
    return None


def select_source(context: dict, event: dict, sources: list[dict]) -> dict:
    """选择一个已配置的来源，返回给接入层固定结果类别。"""
    account = context.get("account")
    if not account or not context.get("ingress_allowed"):
        return {"reason": "source_not_configured"}
    if event.get("post_type") != "message" or _id(event.get("self_id")) != account:
        return {"reason": "source_filtered"}
    kind = event.get("message_type")
    if kind not in ("private", "group"):
        return {"reason": "source_filtered"}
    sender = _id(event.get("user_id"))
    conversation = _id(event.get("group_id")) if kind == "group" else sender
    if not sender or not conversation or not _id(event.get("message_id")):
        return {"reason": "missing_stable_id"}
    for source in sources:
        if (source["platform"] == "qq" and source["enabled"] and source["type"] == kind
                and source["account"] == account and source["conversation"] == conversation
                and (not source["sender"] or source["sender"] == sender)):
            return {"source_id": source["id"]}
    return {"reason": "source_filtered" if sources else "source_not_configured"}


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        result = select_source(payload["context"], payload["event"], payload["sources"])
        print(json.dumps(result, ensure_ascii=True))
    except (KeyError, TypeError, ValueError):
        print(json.dumps({"reason": "invalid_message_metadata"}))
        raise SystemExit(1) from None
