from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.flask_branch_visualizer.actions import (
    ActionError,
    build_action_command,
    run_action,
    validate_plan_path,
)


class ActionRunnerTest(unittest.TestCase):
    def test_builds_allowlisted_plan_and_repository_commands(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = make_repo(Path(temp_dir))
            (root / "dist" / "src").mkdir(parents=True)
            (root / "dist" / "src" / "cli.js").write_text("#!/usr/bin/env node\n", encoding="utf-8")

            for action in ["run-next", "run-all", "open-pr"]:
                with self.subTest(action=action):
                    command = build_action_command(action, root, ".crack/plans/demo/plan.md")
                    self.assertEqual(
                        command.argv,
                        ["node", "dist/src/cli.js", action, "--plan", ".crack/plans/demo/plan.md"],
                    )
                    self.assertEqual(
                        command.display,
                        f"node dist/src/cli.js {action} --plan .crack/plans/demo/plan.md",
                    )

            (root / "dist" / "src" / "cli.js").unlink()

            for action in ["pr-check", "drain"]:
                with self.subTest(action=action):
                    command = build_action_command(action, root)
                    self.assertEqual(command.argv, ["crack", action])
                    self.assertEqual(command.display, f"crack {action}")

    def test_plan_path_validation_only_accepts_plan_files_under_crack_plans(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = make_repo(Path(temp_dir))

            self.assertEqual(
                validate_plan_path(root, root / ".crack" / "plans" / "demo" / "plan.md"),
                ".crack/plans/demo/plan.md",
            )

            cases = [
                ("missing", None, "requires a plan path"),
                ("outside", str(root / "plan.md"), "under .crack/plans"),
                ("wrong filename", ".crack/plans/demo/notes.md", "plan.md file"),
                ("direct child", ".crack/plans/plan.md", "plan.md file"),
                ("missing file", ".crack/plans/missing/plan.md", "does not exist"),
            ]
            (root / ".crack" / "plans" / "demo" / "notes.md").write_text("notes\n", encoding="utf-8")
            (root / ".crack" / "plans" / "plan.md").write_text("bad\n", encoding="utf-8")

            for _label, plan_path, message in cases:
                with self.subTest(plan_path=plan_path):
                    with self.assertRaisesRegex(ActionError, message):
                        validate_plan_path(root, plan_path)

    def test_rejects_unsupported_actions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = make_repo(Path(temp_dir))

            with self.assertRaisesRegex(ActionError, "Unsupported action: merge"):
                build_action_command("merge", root)

            with self.assertRaisesRegex(ActionError, "does not accept a plan path"):
                build_action_command("drain", root, ".crack/plans/demo/plan.md")

    def test_run_action_returns_subprocess_output_without_raising_on_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = make_repo(Path(temp_dir))
            completed = subprocess.CompletedProcess(
                args=["crack", "run-all"],
                returncode=9,
                stdout="command output\n",
                stderr="command error\n",
            )

            with patch("tools.flask_branch_visualizer.actions.subprocess.run", return_value=completed) as run:
                result = run_action("run-all", root, ".crack/plans/demo/plan.md")

            self.assertEqual(result.action, "run-all")
            self.assertEqual(result.command, "crack run-all --plan .crack/plans/demo/plan.md")
            self.assertEqual(result.exit_code, 9)
            self.assertEqual(result.stdout, "command output\n")
            self.assertEqual(result.stderr, "command error\n")
            run.assert_called_once_with(
                ["crack", "run-all", "--plan", ".crack/plans/demo/plan.md"],
                cwd=str(root.resolve()),
                shell=False,
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )


def make_repo(root: Path) -> Path:
    plan_dir = root / ".crack" / "plans" / "demo"
    plan_dir.mkdir(parents=True)
    (plan_dir / "plan.md").write_text("# Plan: Demo\n", encoding="utf-8")
    return root.resolve()


if __name__ == "__main__":
    unittest.main()
