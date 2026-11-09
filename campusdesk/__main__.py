"""本机操作者入口：Python 负责工作区，兼容桥调用现有解析与桌面后端。"""
from __future__ import annotations

import argparse
from hashlib import file_digest
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

from .workspace import WorkspaceError, apply_migration, bind_qq, migration_plan, set_history_access

PROJECT = Path(__file__).resolve().parents[1]


def node_entry(root: Path, script: str, *arguments: str) -> None:
    executable = PROJECT / ".private" / "runtime" / "node-v24.22.2" / "node.exe"
    if not executable.is_file():
        raise WorkspaceError("verified_node_runtime_missing")
    checksums = executable.with_name("SHASUMS256.txt").read_text(encoding="utf-8").splitlines()
    expected = next((line.split()[0] for line in checksums if line.endswith("  win-x64/node.exe")), None)
    with executable.open("rb") as stream:
        if expected != file_digest(stream, "sha256").hexdigest():
            raise WorkspaceError("node_runtime_checksum_mismatch")
    result = subprocess.run([str(executable), str(PROJECT / script), *arguments], cwd=root, check=False)
    if result.returncode:
        raise WorkspaceError("compatibility_adapter_failed")


def parse_args():
    parser = argparse.ArgumentParser(prog="python -m campusdesk")
    parser.add_argument("--root", type=Path, default=PROJECT, help="本机工作目录，默认项目根")
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="初始化没有 QQ 账号的新工作区")
    init.add_argument("--port", type=int, default=9087)
    plan = commands.add_parser("migration-plan", help="核对旧库工作区迁移范围")
    plan.add_argument("--legacy-account")
    migrate = commands.add_parser("migrate", help="按摘要备份并迁移旧库")
    migrate.add_argument("digest")
    migrate.add_argument("--legacy-account")
    history = commands.add_parser("history-access", help="调整已绑定账号的历史检索权限")
    history.add_argument("account")
    history.add_argument("state", choices=("allow", "revoke"))
    bind = commands.add_parser("bind-qq", help="绑定本机配置中的当前 QQ 来源账号")
    bind.add_argument("account")
    ingest = commands.add_parser("import-notes", help="预览或批准本机资料导入")
    ingest.add_argument("action", choices=("plan", "apply"))
    ingest.add_argument("source")
    ingest.add_argument("exclude")
    ingest.add_argument("digest", nargs="?")
    serve = commands.add_parser("serve", help="启动桌面知识库及明确选用的可选能力")
    serve.add_argument("--copy-token", action="store_true")
    serve.add_argument("--qq", action="store_true")
    serve.add_argument("--sheets", action="store_true")
    serve.add_argument("--briefings", action="store_true")
    knowledge = commands.add_parser("serve-knowledge", help="启动 Python 知识工作台")
    knowledge.add_argument("--port", type=int, default=9089)
    knowledge.add_argument("--search-provider", choices=("crossref", "brave"))
    knowledge.add_argument("--qq-ability", action="store_true")
    knowledge.add_argument("--qq-history-suggestions", action="store_true")
    knowledge.add_argument("--sheets", action="store_true")
    knowledge.add_argument("--execute-sheets", action="store_true")
    cutover = commands.add_parser("business-cutover", help="预览或按摘要备份并接管旧业务")
    cutover.add_argument("--approve", metavar="DIGEST")
    cutover.add_argument("--workbench-port", type=int, default=9089)
    commands.add_parser("init-knowledge", help="初始化独立 Python 知识工作区")
    import_knowledge = commands.add_parser("import-knowledge", help="预览或批准导入一个本机文件")
    import_knowledge.add_argument("source", type=Path)
    import_knowledge.add_argument("--approve", metavar="DIGEST")
    admission = commands.add_parser("admit-knowledge-todo", help="预览或批准纳入现有待办来源")
    admission.add_argument("todo_id", type=int)
    admission.add_argument("--approve", metavar="DIGEST")
    cloud = commands.add_parser("knowledge-cloud", help="变更资料的云端模型处理许可")
    cloud.add_argument("target")
    cloud.add_argument("decision", choices=("allow", "revoke"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = args.root.resolve(strict=True)
    if args.command == "init":
        if not (root / ".private" / "poc.sqlite").exists():
            node_entry(root, "tools/workspace-bootstrap.cjs", str(args.port))
        plan = migration_plan(root)
        if plan["workspace_id"]:
            result = {"workspace_id": plan["workspace_id"], "initialized": False}
        elif plan["bind_existing_account"] or plan["unmapped_records"] or any(plan["mapped_records"].values()):
            raise WorkspaceError("review_workspace_migration_first")
        else:
            result = apply_migration(root, plan["digest"])
    elif args.command == "migration-plan":
        result = migration_plan(root, args.legacy_account)
    elif args.command == "migrate":
        result = apply_migration(root, args.digest, args.legacy_account)
    elif args.command == "history-access":
        result = set_history_access(root, "qq", args.account, args.state == "allow")
    elif args.command == "bind-qq":
        result = bind_qq(root, args.account)
    elif args.command == "import-notes":
        extra = [args.digest] if args.digest is not None else []
        node_entry(root, "tools/import-notes.cjs", args.action, args.source, args.exclude, *extra)
        return
    elif args.command in ("init-knowledge", "import-knowledge"):
        try:
            from .knowledge.importing import import_file, initialize
        except ImportError as error:
            raise WorkspaceError("knowledge_dependencies_missing") from error
        if args.command == "init-knowledge":
            result = initialize(root)
        else:
            result = import_file(root, args.source, args.approve)
    elif args.command == "admit-knowledge-todo":
        from .knowledge.admission import admit_todo
        if not 1 <= args.todo_id < 2**63:
            raise WorkspaceError("invalid_todo_id")
        result = admit_todo(root, args.todo_id, args.approve)
    elif args.command == "knowledge-cloud":
        from .knowledge.permissions import set_cloud_permission
        result = set_cloud_permission(root, args.target, args.decision == "allow")
    elif args.command == "business-cutover":
        from .cutover import apply, preview
        result = apply(root, args.approve, workbench_port=args.workbench_port) if args.approve else preview(root)
    elif args.command == "serve-knowledge":
        if not 1 <= args.port <= 65535:
            raise WorkspaceError("knowledge_port_invalid")
        token = os.environ.get("CAMPUSDESK_KNOWLEDGE_TOKEN", "")
        if len(token) < 32:
            raise WorkspaceError("knowledge_token_required")
        try:
            import uvicorn
            from .knowledge_api import create_app
            from .models import load_models
            from .abilities.setup import load_abilities
            from .cutover import owned
            from .sheets import Sheets
        except ImportError as error:
            raise WorkspaceError("knowledge_dependencies_missing") from error
        try:
            models = load_models(root)
        except (KeyError, TypeError, AttributeError, OSError, ValueError) as error:
            raise WorkspaceError("invalid_model_config") from error
        abilities = load_abilities(root, args.search_provider, args.qq_ability, args.qq_history_suggestions)
        if args.execute_sheets and not args.sheets:
            raise WorkspaceError("sheets_not_enabled")
        if args.sheets and not owned(root):
            raise WorkspaceError("business_cutover_required")
        sheets = Sheets(root, execute=args.execute_sheets) if args.sheets else None
        uvicorn.run(create_app(root, token, models=models, abilities=abilities, sheets=sheets),
                    host="127.0.0.1", port=args.port, access_log=False)
        return
    else:
        if root != PROJECT:
            raise WorkspaceError("use_workspace_launcher_in_project_root")
        flags = [name for flag, name in (
            (args.copy_token, "-CopyDesktopToken"), (args.qq, "-WithQQ"),
            (args.sheets, "-WithSheets"), (args.briefings, "-WithBriefings")
        ) if flag]
        status = subprocess.call(["powershell.exe", "-NoProfile", "-File",
                                  str(PROJECT / "tools/start-assistant.ps1"), *flags], cwd=root,
                                 env={**os.environ, "CAMPUS_DESK_PYTHON": sys.executable})
        raise SystemExit(status)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except WorkspaceError as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
    except (OSError, ValueError, sqlite3.Error):
        print("workspace_input_failed", file=sys.stderr)
        raise SystemExit(1) from None
