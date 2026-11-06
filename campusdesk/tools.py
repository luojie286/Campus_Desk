"""模型工具输入规则。可信授权由宿主提供，参数中不接受身份或审批字段。"""
from __future__ import annotations

import json
from pathlib import Path
import sys

CONTRACT = json.loads(Path(__file__).with_name("tool_contract.json").read_text(encoding="utf-8"))


def validate_call(name: str, raw: str, enabled: list[str]) -> dict:
    if name not in enabled or name not in CONTRACT:
        return {"error": "tool_unavailable"}
    if not isinstance(raw, str) or len(raw) > 4096:
        return {"error": "invalid_tool_input"}
    try:
        arguments = json.loads(raw)
    except ValueError:
        return {"error": "invalid_tool_input"}
    fields = CONTRACT[name]["parameters"]["properties"]
    if not isinstance(arguments, dict) or set(arguments) != set(fields):
        return {"error": "invalid_tool_input"}
    result = {}
    for key, spec in fields.items():
        value = arguments[key]
        if not isinstance(value, str) or not value.strip() or len(value) > spec["maxLength"]:
            return {"error": "invalid_tool_input"}
        result[key] = value.strip()
    return {"arguments": result}


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        result = validate_call(payload["name"], payload["raw"], payload["enabled"])
        print(json.dumps(result, ensure_ascii=True))
    except (KeyError, TypeError, ValueError):
        print(json.dumps({"error": "invalid_tool_input"}))
