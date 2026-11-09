"""The daily launcher follows the workspace's business owner."""

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from campusdesk import __main__ as cli
from campusdesk.cutover import OWNER
from campusdesk.workspace import WorkspaceError


class WorkbenchLauncherTest(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        (self.root / ".private").mkdir()

    def run_serve(self, *flags):
        with patch.object(cli, "PROJECT", self.root), patch.object(
            cli.sys, "argv", ["campusdesk", "serve", *flags],
        ), patch.object(cli.subprocess, "call", return_value=0) as launch:
            with self.assertRaises(SystemExit) as exit_status:
                cli.main()
            self.assertEqual(exit_status.exception.code, 0)
            return launch.call_args.args[0][3:]

    def cut_over(self):
        (self.root / ".private" / OWNER).write_text("python-v1\n", encoding="ascii")

    def test_old_workspace_keeps_legacy_launcher(self):
        command = self.run_serve("--qq", "--sheets", "--copy-token", "--briefings")
        self.assertEqual(command, [str(self.root / "tools/start-assistant.ps1"),
                                   "-CopyDesktopToken", "-WithQQ", "-WithSheets", "-WithBriefings"])

    def test_cutover_routes_business_to_read_only_python_by_default(self):
        self.cut_over()
        command = self.run_serve("--qq", "--sheets", "--copy-token", "--search-provider", "crossref")
        self.assertEqual(command, [str(self.root / "tools/start-python-workbench.ps1"),
                                   "-CopyToken", "-QQAbility", "-Sheets", "-SearchProvider", "crossref"])
        self.assertIn("-ExecuteSheets", self.run_serve("--sheets", "--execute-sheets"))

    def test_legacy_management_cannot_start_business_workers_after_cutover(self):
        self.cut_over()
        self.assertEqual(self.run_serve("--legacy-assistant", "--copy-token"),
                         [str(self.root / "tools/start-assistant.ps1"), "-CopyDesktopToken"])
        with self.assertRaisesRegex(WorkspaceError, "legacy_assistant_knowledge_only"):
            self.run_serve("--legacy-assistant", "--qq")
        with self.assertRaisesRegex(WorkspaceError, "briefings_unavailable_after_cutover"):
            self.run_serve("--briefings")

    def test_write_flag_requires_sheet_capability_and_cutover(self):
        with self.assertRaisesRegex(WorkspaceError, "business_cutover_required"):
            self.run_serve("--sheets", "--execute-sheets")
        self.cut_over()
        with self.assertRaisesRegex(WorkspaceError, "sheets_not_enabled"):
            self.run_serve("--execute-sheets")
