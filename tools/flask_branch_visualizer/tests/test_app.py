from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.flask_branch_visualizer.actions import ActionError, ActionResult

try:
    import flask  # noqa: F401
except ImportError as error:
    create_app = None
    FLASK_IMPORT_ERROR = error
else:
    from tools.flask_branch_visualizer.app import create_app

    FLASK_IMPORT_ERROR = None


@unittest.skipIf(create_app is None, f"Flask is not installed: {FLASK_IMPORT_ERROR}")
class FlaskAppTest(unittest.TestCase):
    def test_index_and_api_state_return_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            snapshot = sample_snapshot(root)

            with patch(
                "tools.flask_branch_visualizer.app.read_repository_snapshot",
                return_value=snapshot,
            ) as read_snapshot:
                app = create_app(root, max_commits=5)
                client = app.test_client()

                index_response = client.get("/")
                api_response = client.get("/api/state")

            self.assertEqual(index_response.status_code, 200)
            self.assertIn("text/html", index_response.content_type)
            self.assertIn(b"Localhost Crack GUI", index_response.data)
            self.assertIn(b"Local-only control surface", index_response.data)
            self.assertIn(b"Repository status", index_response.data)
            self.assertIn(b"Plans", index_response.data)
            self.assertIn(b"Selected Plan", index_response.data)
            self.assertIn(b"Command Output", index_response.data)
            self.assertIn(b"Branches", index_response.data)
            self.assertIn(b"Recent Commits", index_response.data)
            self.assertIn(b"codex/demo", index_response.data)
            self.assertIn(b"Commit 2: Add the Flask view", index_response.data)
            self.assertIn(b"Follow up on queue handling.", index_response.data)
            self.assertIn(b"Completed commit unit 1.", index_response.data)

            self.assertEqual(api_response.status_code, 200)
            self.assertTrue(api_response.is_json)
            self.assertEqual(api_response.get_json(), snapshot)
            self.assertEqual(api_response.get_json()["inbox"]["request_count"], 2)
            self.assertEqual(api_response.get_json()["git"]["dirty"]["changed_file_count"], 2)
            self.assertEqual(read_snapshot.call_count, 2)
            read_snapshot.assert_any_call(str(root), 5)

    def test_index_includes_plan_and_global_action_controls(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            snapshot = sample_snapshot(root)

            with patch("tools.flask_branch_visualizer.app.read_repository_snapshot", return_value=snapshot):
                app = create_app(root)
                response = app.test_client().get("/")

            self.assertEqual(response.status_code, 200)
            self.assertIn(b'data-action="run-next"', response.data)
            self.assertIn(b'data-action="run-all"', response.data)
            self.assertIn(b'data-action="open-pr"', response.data)
            self.assertIn(b'data-plan-path=".crack/plans/demo/plan.md"', response.data)
            self.assertIn(b"Run Next Unit", response.data)
            self.assertIn(b"Run All Remaining", response.data)
            self.assertIn(b"Open PR", response.data)
            self.assertIn(b'data-action="pr-check"', response.data)
            self.assertIn(b'data-action="drain"', response.data)
            self.assertIn(b"Check PR Status", response.data)
            self.assertIn(b"Drain Inbox", response.data)

    def test_index_renders_queue_and_log_empty_states(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            snapshot = sample_snapshot(root)
            plan = snapshot["plans"][0]
            plan["queue_request_count"] = 0
            plan["queued_requests"] = []
            plan["queue_content"] = ""
            plan["recent_log_entries"] = []
            plan["log_content"] = ""

            with patch("tools.flask_branch_visualizer.app.read_repository_snapshot", return_value=snapshot):
                app = create_app(root)
                response = app.test_client().get("/")

            self.assertEqual(response.status_code, 200)
            self.assertIn(b"No queued requests for this plan.", response.data)
            self.assertIn(b"No log entries found for this plan.", response.data)

    def test_index_renders_empty_state_without_crack_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            snapshot = sample_snapshot(root)
            snapshot["initialized"] = False
            snapshot["repository"]["initialized"] = False
            snapshot["plans"] = []
            snapshot["warnings"] = ["No .crack directory found."]

            with patch("tools.flask_branch_visualizer.app.read_repository_snapshot", return_value=snapshot):
                app = create_app(root)
                response = app.test_client().get("/")

            self.assertEqual(response.status_code, 200)
            self.assertIn(b"No .crack State Found", response.data)
            self.assertIn(b"No .crack directory found.", response.data)
            self.assertIn(b"No plan files were found", response.data)
            self.assertIn(b"No plan is selected", response.data)

    def test_api_actions_runs_action_and_returns_refreshed_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            snapshot = sample_snapshot(root)
            result = ActionResult(
                action="run-next",
                command="crack run-next --plan .crack/plans/demo/plan.md",
                exit_code=0,
                stdout="ok\n",
                stderr="",
            )

            with (
                patch("tools.flask_branch_visualizer.app.run_action", return_value=result) as run,
                patch("tools.flask_branch_visualizer.app.read_repository_snapshot", return_value=snapshot) as read_snapshot,
            ):
                app = create_app(root, max_commits=5)
                response = app.test_client().post(
                    "/api/actions",
                    json={"action": "run-next", "plan_path": ".crack/plans/demo/plan.md"},
                )

            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.is_json)
            self.assertEqual(
                response.get_json(),
                {
                    "action": "run-next",
                    "command": "crack run-next --plan .crack/plans/demo/plan.md",
                    "exit_code": 0,
                    "stdout": "ok\n",
                    "stderr": "",
                    "snapshot": snapshot,
                },
            )
            run.assert_called_once_with("run-next", str(root), ".crack/plans/demo/plan.md")
            read_snapshot.assert_called_once_with(str(root), 5)

    def test_api_actions_rejects_invalid_requests_without_running_snapshot_refresh(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()

            with (
                patch(
                    "tools.flask_branch_visualizer.app.run_action",
                    side_effect=ActionError("Unsupported action: merge."),
                ) as run,
                patch("tools.flask_branch_visualizer.app.read_repository_snapshot") as read_snapshot,
            ):
                app = create_app(root)
                response = app.test_client().post("/api/actions", json={"action": "merge"})

            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.get_json(), {"error": "Unsupported action: merge."})
            run.assert_called_once_with("merge", str(root), None)
            read_snapshot.assert_not_called()

def sample_snapshot(root: Path) -> dict[str, object]:
    return {
        "repository": {
            "repo_root": str(root),
            "crack_dir": str(root / ".crack"),
            "initialized": True,
            "warnings": [],
        },
        "repo_root": str(root),
        "crack_dir": str(root / ".crack"),
        "initialized": True,
        "warnings": [],
        "inbox": {
            "path": str(root / ".crack" / "inbox.md"),
            "relative_path": ".crack/inbox.md",
            "request_count": 2,
            "requests": [
                {
                    "received_at": "2026-05-10 09:00",
                    "prompt": "Review the PR feedback.",
                    "reason": "PR lock is active.",
                },
                {
                    "received_at": "2026-05-10 09:05",
                    "prompt": "Add a GUI action.",
                    "reason": "",
                },
            ],
        },
        "pr_lock": {
            "path": str(root / ".crack" / "pr-lock.md"),
            "relative_path": ".crack/pr-lock.md",
            "valid": True,
            "branch": "codex/demo",
            "pr_url": "https://github.com/example/repo/pull/7",
            "status": "reviewing",
        },
        "plans": [
            {
                "directory": str(root / ".crack" / "plans" / "demo"),
                "plan_path": str(root / ".crack" / "plans" / "demo" / "plan.md"),
                "queue_path": str(root / ".crack" / "plans" / "demo" / "queue.md"),
                "log_path": str(root / ".crack" / "plans" / "demo" / "log.md"),
                "relative_directory": ".crack/plans/demo",
                "relative_plan_path": ".crack/plans/demo/plan.md",
                "relative_queue_path": ".crack/plans/demo/queue.md",
                "relative_log_path": ".crack/plans/demo/log.md",
                "title": "Demo Visualizer",
                "branch": "codex/demo",
                "plan_content": "\n".join(
                    [
                        "# Plan: Demo Visualizer",
                        "",
                        "Branch: codex/demo",
                        "",
                        "### Commit 1: Add the data layer",
                        "",
                        "### Commit 2: Add the Flask view",
                    ]
                ),
                "queue_content": "\n".join(
                    [
                        "# Queue",
                        "",
                        "## Queued Request",
                        "",
                        "Received: 2026-05-10 09:15",
                        "",
                        "User prompt:",
                        "",
                        "> Follow up on queue handling.",
                    ]
                ),
                "log_content": "\n".join(
                    [
                        "# Log",
                        "",
                        "## 2026-05-10 09:20",
                        "",
                        "- Started commit unit 1.",
                        "- Completed commit unit 1.",
                    ]
                ),
                "commit_units": [
                    {"number": 1, "title": "Add the data layer"},
                    {"number": 2, "title": "Add the Flask view"},
                ],
                "completed_commit_units": [{"number": 1, "title": "Add the data layer"}],
                "remaining_commit_units": [{"number": 2, "title": "Add the Flask view"}],
                "total_commit_unit_count": 2,
                "completed_commit_unit_count": 1,
                "completed_commit_unit_numbers": [1],
                "queue_request_count": 1,
                "queued_requests": [
                    {
                        "received_at": "2026-05-10 09:15",
                        "prompt": "Follow up on queue handling.",
                        "reason": "",
                    }
                ],
                "recent_log_entries": [
                    {"logged_at": "2026-05-10 09:20", "text": "Started commit unit 1."},
                    {"logged_at": "2026-05-10 09:20", "text": "Completed commit unit 1."},
                ],
                "next_commit_unit": {"number": 2, "title": "Add the Flask view"},
                "suggested_commands": [
                    {"kind": "run-next", "command": "crack run-next --plan .crack/plans/demo/plan.md"},
                    {"kind": "run-all", "command": "crack run-all --plan .crack/plans/demo/plan.md"},
                ],
            }
        ],
        "git": {
            "current_branch": "codex/demo",
            "branches": [
                {
                    "name": "codex/demo",
                    "short_hash": "abc1234",
                    "committed_at": "2026-05-10T10:00:00+09:00",
                    "subject": "Add the data layer",
                }
            ],
            "dirty": {
                "raw": " M tools/flask_branch_visualizer/app.py\n?? notes.txt\n",
                "entries": [
                    {
                        "status": " M",
                        "path": "tools/flask_branch_visualizer/app.py",
                        "raw": " M tools/flask_branch_visualizer/app.py",
                    },
                    {"status": "??", "path": "notes.txt", "raw": "?? notes.txt"},
                ],
                "is_dirty": True,
                "changed_file_count": 2,
                "staged_file_count": 0,
                "unstaged_file_count": 1,
                "untracked_file_count": 1,
            },
            "recent_commits": [
                {
                    "hash": "abc123456789",
                    "short_hash": "abc1234",
                    "refs": "HEAD -> codex/demo",
                    "author": "Dev",
                    "committed_at": "2026-05-10T10:00:00+09:00",
                    "subject": "Add the data layer",
                }
            ],
        },
    }


if __name__ == "__main__":
    unittest.main()
