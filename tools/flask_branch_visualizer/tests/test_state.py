from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.flask_branch_visualizer.state import (
    read_repository_snapshot,
)


class RepositorySnapshotTest(unittest.TestCase):
    def test_missing_crack_state_returns_empty_snapshot_without_initializing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / ".git").mkdir()

            snapshot = read_repository_snapshot(root)

            self.assertFalse(snapshot["initialized"])
            self.assertEqual(snapshot["repository"]["repo_root"], str(root.resolve()))
            self.assertFalse(snapshot["repository"]["initialized"])
            self.assertEqual(snapshot["inbox"]["request_count"], 0)
            self.assertIsNone(snapshot["pr_lock"])
            self.assertEqual(snapshot["plans"], [])
            self.assertFalse((root / ".crack").exists())
            self.assertTrue(any(".crack" in warning for warning in snapshot["warnings"]))
            self.assertEqual(snapshot["git"]["branches"], [])
            self.assertFalse(snapshot["git"]["dirty"]["is_dirty"])

    def test_snapshot_summarizes_crack_files_and_git_data(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            nested = root / "src" / "nested"
            plan_dir = root / ".crack" / "plans" / "demo"
            nested.mkdir(parents=True)
            (root / ".git").mkdir()
            plan_dir.mkdir(parents=True)
            (root / ".crack" / "inbox.md").write_text(
                "\n".join(
                    [
                        "# Inbox",
                        "",
                        "## Queued Request",
                        "",
                        "Received: 2026-05-10 09:00",
                        "",
                        "User prompt:",
                        "",
                        "> Review PR feedback.",
                        "",
                        "Reason:",
                        "",
                        "PR lock is active.",
                    ]
                ),
                encoding="utf-8",
            )
            (root / ".crack" / "pr-lock.md").write_text(
                "\n".join(
                    [
                        "# PR Lock",
                        "",
                        "Branch: codex/demo",
                        "PR: https://github.com/example/repo/pull/7",
                        "Status: reviewing",
                    ]
                ),
                encoding="utf-8",
            )
            (plan_dir / "plan.md").write_text(
                "\n".join(
                    [
                        "# Plan: Demo Visualizer",
                        "",
                        "Branch: codex/demo",
                        "",
                        "### Commit 1: Add snapshot model",
                        "",
                        "### Commit 2: Render page",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            (plan_dir / "queue.md").write_text(
                "\n".join(
                    [
                        "# Queue",
                        "",
                        "## Queued Request",
                        "",
                        "Received: 2026-05-10 09:15",
                        "",
                        "User prompt:",
                        "",
                        "> Follow up.",
                        "",
                        "Reason:",
                        "",
                        "Depends on this plan.",
                    ]
                ),
                encoding="utf-8",
            )
            (plan_dir / "log.md").write_text(
                "\n".join(
                    [
                        "# Log",
                        "",
                        "## 2026-05-10 09:20",
                        "",
                        "- Started commit unit 1.",
                        "- Completed commit unit 1.",
                    ]
                ),
                encoding="utf-8",
            )

            with patch("tools.flask_branch_visualizer.state.run_git", side_effect=fake_run_git):
                snapshot = read_repository_snapshot(nested, max_commits=2)

            self.assertTrue(snapshot["initialized"])
            self.assertEqual(snapshot["repo_root"], str(root.resolve()))
            self.assertEqual(snapshot["repository"]["crack_dir"], str((root / ".crack").resolve()))
            self.assertEqual(snapshot["inbox"]["request_count"], 1)
            self.assertEqual(snapshot["inbox"]["requests"][0]["prompt"], "Review PR feedback.")
            self.assertEqual(snapshot["pr_lock"]["branch"], "codex/demo")
            self.assertEqual(snapshot["pr_lock"]["pr_url"], "https://github.com/example/repo/pull/7")
            self.assertEqual(len(snapshot["plans"]), 1)

            plan = snapshot["plans"][0]
            self.assertEqual(plan["title"], "Demo Visualizer")
            self.assertEqual(plan["branch"], "codex/demo")
            self.assertEqual(plan["relative_plan_path"], ".crack/plans/demo/plan.md")
            self.assertEqual(plan["relative_queue_path"], ".crack/plans/demo/queue.md")
            self.assertEqual(plan["relative_log_path"], ".crack/plans/demo/log.md")
            self.assertIn("### Commit 1: Add snapshot model", plan["plan_content"])
            self.assertEqual(plan["total_commit_unit_count"], 2)
            self.assertEqual(plan["completed_commit_unit_count"], 1)
            self.assertEqual(plan["completed_commit_unit_numbers"], [1])
            self.assertEqual(plan["completed_commit_units"], [{"number": 1, "title": "Add snapshot model"}])
            self.assertEqual(plan["queue_request_count"], 1)
            self.assertEqual(plan["queued_requests"][0]["reason"], "Depends on this plan.")
            self.assertEqual(
                plan["recent_log_entries"],
                [
                    {"logged_at": "2026-05-10 09:20", "text": "Started commit unit 1."},
                    {"logged_at": "2026-05-10 09:20", "text": "Completed commit unit 1."},
                ],
            )
            self.assertEqual(plan["next_commit_unit"], {"number": 2, "title": "Render page"})
            self.assertEqual(
                plan["suggested_commands"],
                [
                    {"kind": "run-next", "command": "crack run-next --plan .crack/plans/demo/plan.md"},
                    {"kind": "run-all", "command": "crack run-all --plan .crack/plans/demo/plan.md"},
                ],
            )

            self.assertEqual(snapshot["git"]["current_branch"], "codex/demo")
            self.assertEqual(snapshot["git"]["branches"][0]["name"], "codex/demo")
            self.assertEqual(snapshot["git"]["recent_commits"][0]["short_hash"], "abc1234")
            self.assertEqual(snapshot["git"]["dirty"]["changed_file_count"], 2)
            self.assertEqual(snapshot["git"]["dirty"]["untracked_file_count"], 1)

    def test_snapshot_handles_missing_plan_queue_and_log_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            plan_dir = root / ".crack" / "plans" / "demo"
            plan_dir.mkdir(parents=True)
            (plan_dir / "plan.md").write_text(
                "\n".join(["# Plan: Missing Files", "", "Branch: codex/missing", "", "### Commit 1: Start"]),
                encoding="utf-8",
            )

            snapshot = read_repository_snapshot(root)

            self.assertTrue(snapshot["initialized"])
            self.assertEqual(len(snapshot["plans"]), 1)
            plan = snapshot["plans"][0]
            self.assertEqual(plan["queue_content"], "")
            self.assertEqual(plan["log_content"], "")
            self.assertEqual(plan["queue_request_count"], 0)
            self.assertEqual(plan["queued_requests"], [])
            self.assertEqual(plan["recent_log_entries"], [])
            self.assertEqual(plan["completed_commit_unit_count"], 0)
            self.assertEqual(plan["next_commit_unit"], {"number": 1, "title": "Start"})

    def test_uninitialized_non_git_directory_returns_empty_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            snapshot = read_repository_snapshot(root)

            self.assertFalse(snapshot["initialized"])
            self.assertEqual(snapshot["plans"], [])
            self.assertEqual(snapshot["inbox"]["request_count"], 0)
            self.assertIsNone(snapshot["pr_lock"])
            self.assertFalse(snapshot["git"]["dirty"]["is_dirty"])
            self.assertTrue(any("No git repository" in warning for warning in snapshot["warnings"]))


def fake_run_git(args: list[str], cwd: Path, warnings: list[str]) -> str:
    field_separator = "\x1f"
    record_separator = "\x1e"
    command = args[1]

    if command == "branch":
        return "codex/demo\n"

    if command == "for-each-ref":
        return field_separator.join(
            ["codex/demo", "abc1234", "2026-05-10T09:30:00+09:00", "Add snapshot model"]
        ) + record_separator

    if command == "log":
        return field_separator.join(
            [
                "abc123456789",
                "abc1234",
                "HEAD -> codex/demo",
                "Dev",
                "2026-05-10T09:30:00+09:00",
                "Add snapshot model",
            ]
        ) + record_separator

    if command == "status":
        return "M  tools/flask_branch_visualizer/state.py\n?? notes.txt\n"

    return ""


if __name__ == "__main__":
    unittest.main()
