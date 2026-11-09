"""Invoke the verified, existing Tencent browser adapter from Python."""

from hashlib import file_digest
import json
from pathlib import Path
import subprocess

from ..workspace import WorkspaceError

PROJECT = Path(__file__).resolve().parents[2]


class SheetAdapterError(RuntimeError):
    def __init__(self, code: str, attempted: bool = False):
        super().__init__(code)
        self.attempted = attempted


class TencentAdapter:
    def __init__(self, root: Path):
        self.root = root

    def call(self, action: str, **payload) -> dict:
        executable = PROJECT / ".private" / "runtime" / "node-v24.22.2" / "node.exe"
        try:
            checksums = executable.with_name("SHASUMS256.txt").read_text(encoding="utf-8").splitlines()
            expected = next(line.split()[0] for line in checksums if line.endswith("  win-x64/node.exe"))
            with executable.open("rb") as stream:
                if file_digest(stream, "sha256").hexdigest() != expected:
                    raise WorkspaceError("node_runtime_checksum_mismatch")
            result = subprocess.run([str(executable), str(PROJECT / "tools/python-sheet-adapter.cjs")],
                                    input=json.dumps({"action": action, **payload}, ensure_ascii=False).encode(),
                                    capture_output=True, cwd=self.root, timeout=220, check=True)
            data = json.loads(result.stdout)
            if not isinstance(data, dict):
                raise ValueError("invalid_adapter_result")
            if data.get("ok") is True and (
                action == "prepare" and not isinstance(data.get("plan"), dict)
                or action in ("execute", "reconcile") and type(data.get("matched")) is not bool
            ):
                raise ValueError("invalid_adapter_result")
        except (OSError, ValueError, StopIteration, WorkspaceError, subprocess.SubprocessError) as error:
            raise SheetAdapterError("sheet_adapter_failed", action == "execute") from error
        if data.get("ok") is not True:
            raise SheetAdapterError(data.get("code", "sheet_adapter_failed"), data.get("attempted") is True)
        return data
