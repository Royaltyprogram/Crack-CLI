from __future__ import annotations

import unittest

from tools.flask_branch_visualizer.state import (
    completed_commit_unit_numbers,
    count_queued_requests,
    parse_git_status_short,
    parse_plan_markdown,
    parse_pr_lock,
    parse_queued_requests,
    recent_log_entries,
)


class PlanParserTest(unittest.TestCase):
    def test_parse_plan_markdown_reads_only_weak_conventions(self) -> None:
        content = "\n".join(
            [
                "# Plan: Demo Visualizer",
                "",
                "Branch: codex/demo",
                "",
                "## Commit Units",
                "",
                "### Commit 1: Add snapshot model",
                "",
                "Create the model.",
                "",
                "### Commit 2 Render page",
                "",
                "Render it.",
                "",
                "### Commit 3:",
                "",
                "Fallback title.",
            ]
        )

        parsed = parse_plan_markdown(content)

        self.assertEqual(parsed["title"], "Demo Visualizer")
        self.assertEqual(parsed["branch"], "codex/demo")
        self.assertEqual(
            parsed["commit_units"],
            [
                {"number": 1, "title": "Add snapshot model"},
                {"number": 2, "title": "Render page"},
                {"number": 3, "title": "Commit unit 3"},
            ],
        )

    def test_log_and_queue_parsers_count_simple_markdown_markers(self) -> None:
        log_content = "\n".join(
            [
                "- Completed commit unit 2.",
                "- completed commit unit 1",
                "- Completed commit unit 2 again.",
            ]
        )
        queue_content = "\n".join(
            [
                "# Queue",
                "",
                "## Queued Request",
                "",
                "First.",
                "",
                "## Queued Request",
                "",
                "Second.",
            ]
        )

        self.assertEqual(completed_commit_unit_numbers(log_content), [1, 2])
        self.assertEqual(count_queued_requests(queue_content), 2)

    def test_parse_queued_requests_reads_summaries_and_tolerates_loose_text(self) -> None:
        content = "\n".join(
            [
                "# Inbox",
                "",
                "## Queued Request",
                "",
                "Received: 2026-05-10 09:30",
                "",
                "User prompt:",
                "",
                "> First line",
                ">",
                "> Second line",
                "",
                "Reason:",
                "",
                "PR lock is active.",
                "",
                "## Queued Request",
                "",
                "Loose request without labels.",
            ]
        )

        self.assertEqual(
            parse_queued_requests(content),
            [
                {
                    "received_at": "2026-05-10 09:30",
                    "prompt": "First line\n\nSecond line",
                    "reason": "PR lock is active.",
                },
                {
                    "received_at": "",
                    "prompt": "Loose request without labels.",
                    "reason": "",
                },
            ],
        )

    def test_parse_pr_lock_reads_required_fields(self) -> None:
        content = "\n".join(
            [
                "# PR Lock",
                "",
                "Branch: codex/demo",
                "PR: https://github.com/example/repo/pull/7",
                "Status: reviewing",
            ]
        )

        self.assertEqual(
            parse_pr_lock(content),
            {
                "branch": "codex/demo",
                "pr_url": "https://github.com/example/repo/pull/7",
                "status": "reviewing",
            },
        )
        self.assertIsNone(parse_pr_lock("Status: reviewing\n"))

    def test_recent_log_entries_tracks_heading_context_and_limit(self) -> None:
        content = "\n".join(
            [
                "# Log",
                "",
                "- Created plan.",
                "",
                "## 2026-05-10 09:30",
                "",
                "- Started commit unit 1.",
                "- Completed commit unit 1.",
                "",
                "## 2026-05-10 10:00",
                "",
                "- Started commit unit 2.",
            ]
        )

        self.assertEqual(
            recent_log_entries(content, limit=2),
            [
                {"logged_at": "2026-05-10 09:30", "text": "Completed commit unit 1."},
                {"logged_at": "2026-05-10 10:00", "text": "Started commit unit 2."},
            ],
        )

    def test_parse_git_status_short_summarizes_dirty_working_tree(self) -> None:
        raw_status = "\n".join(
            [
                "M  src/staged.ts",
                " M src/unstaged.ts",
                "?? tests/new.py",
                "R  old-name.txt -> new-name.txt",
                "",
            ]
        )

        summary = parse_git_status_short(raw_status)

        self.assertTrue(summary["is_dirty"])
        self.assertEqual(summary["changed_file_count"], 4)
        self.assertEqual(summary["staged_file_count"], 2)
        self.assertEqual(summary["unstaged_file_count"], 1)
        self.assertEqual(summary["untracked_file_count"], 1)
        self.assertEqual(summary["entries"][3]["path"], "new-name.txt")


if __name__ == "__main__":
    unittest.main()
