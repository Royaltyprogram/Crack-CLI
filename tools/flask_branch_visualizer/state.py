from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

DEFAULT_MAX_COMMITS = 20

PLAN_TITLE_RE = re.compile(r"^#\s+Plan:\s*(.+?)\s*$", re.MULTILINE)
BRANCH_RE = re.compile(r"^Branch:\s*(.+?)\s*$", re.MULTILINE)
COMMIT_RE = re.compile(r"^###\s+Commit\s+(\d+)\s*:?\s*(.*?)\s*$", re.IGNORECASE | re.MULTILINE)
COMPLETED_RE = re.compile(r"Completed commit unit\s+(\d+)\b", re.IGNORECASE)
QUEUED_REQUEST_RE = re.compile(r"^##\s+Queued Request\s*$", re.MULTILINE)

FIELD_SEPARATOR = "\x1f"
RECORD_SEPARATOR = "\x1e"


def find_repo_root(start: str | Path | None = None) -> str:
    current = Path(start or Path.cwd()).resolve()
    if current.is_file():
        current = current.parent

    while True:
        if (current / ".git").exists():
            return str(current)

        parent = current.parent
        if parent == current:
            return str(Path(start or Path.cwd()).resolve())

        current = parent


def read_repository_snapshot(repo_path: str | Path | None = None, max_commits: int = DEFAULT_MAX_COMMITS) -> dict[str, Any]:
    repo_root = Path(find_repo_root(repo_path)).resolve()
    crack_dir = repo_root / ".crack"
    warnings: list[str] = []

    snapshot: dict[str, Any] = {
        "repo_root": str(repo_root),
        "crack_dir": str(crack_dir),
        "initialized": crack_dir.exists(),
        "warnings": warnings,
        "plans": [],
        "git": empty_git_snapshot(),
    }

    if crack_dir.exists():
        snapshot["plans"] = read_plan_snapshots(repo_root, warnings)
    else:
        warnings.append("No .crack directory found.")

    snapshot["git"] = read_git_snapshot(repo_root, max_commits, warnings)
    return snapshot


def parse_plan_markdown(content: str) -> dict[str, Any]:
    return {
        "title": title_from_plan(content),
        "branch": branch_from_plan(content),
        "commit_units": parse_commit_units(content),
    }


def title_from_plan(content: str) -> str:
    match = PLAN_TITLE_RE.search(content)
    return match.group(1).strip() if match else ""


def branch_from_plan(content: str) -> str:
    match = BRANCH_RE.search(content)
    return match.group(1).strip() if match else ""


def parse_commit_units(content: str) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []

    for line in content.splitlines():
        match = COMMIT_RE.match(line)
        if not match:
            continue

        number = int(match.group(1))
        title = match.group(2).strip() or f"Commit unit {number}"
        units.append({"number": number, "title": title})

    return units


def completed_commit_unit_numbers(log_content: str) -> list[int]:
    return sorted({int(match.group(1)) for match in COMPLETED_RE.finditer(log_content)})


def count_queued_requests(queue_content: str) -> int:
    return len(QUEUED_REQUEST_RE.findall(queue_content))


def read_plan_snapshots(repo_root: Path, warnings: list[str]) -> list[dict[str, Any]]:
    plans_dir = repo_root / ".crack" / "plans"
    if not plans_dir.exists():
        return []

    plans: list[dict[str, Any]] = []
    for plan_dir in sorted((entry for entry in plans_dir.iterdir() if entry.is_dir()), key=lambda path: path.name):
        plan_path = plan_dir / "plan.md"
        if not plan_path.exists():
            continue

        queue_path = plan_dir / "queue.md"
        log_path = plan_dir / "log.md"
        plan_content = read_text_if_exists(plan_path, warnings, "plan.md")
        queue_content = read_text_if_exists(queue_path, warnings, "queue.md")
        log_content = read_text_if_exists(log_path, warnings, "log.md")

        parsed = parse_plan_markdown(plan_content)
        units = parsed["commit_units"]
        completed_set = set(completed_commit_unit_numbers(log_content))
        completed_numbers = [unit["number"] for unit in units if unit["number"] in completed_set]
        remaining_units = [unit for unit in units if unit["number"] not in completed_set]

        plans.append(
            {
                "directory": str(plan_dir),
                "plan_path": str(plan_path),
                "queue_path": str(queue_path),
                "log_path": str(log_path),
                "relative_directory": relative_path(repo_root, plan_dir),
                "relative_plan_path": relative_path(repo_root, plan_path),
                "title": parsed["title"] or plan_dir.name,
                "branch": parsed["branch"] or plan_dir.name,
                "commit_units": units,
                "total_commit_unit_count": len(units),
                "completed_commit_unit_count": len(completed_numbers),
                "completed_commit_unit_numbers": completed_numbers,
                "queue_request_count": count_queued_requests(queue_content),
                "next_commit_unit": remaining_units[0] if remaining_units else None,
            }
        )

    return plans


def read_git_snapshot(repo_root: Path, max_commits: int, warnings: list[str]) -> dict[str, Any]:
    if not (repo_root / ".git").exists():
        warnings.append("No git repository found.")
        return empty_git_snapshot()

    current_branch = run_git(["git", "branch", "--show-current"], repo_root, warnings).strip()
    branches = read_local_branches(repo_root, warnings)
    recent_commits = read_recent_commits(repo_root, max_commits, warnings)

    if not current_branch and not branches and not recent_commits:
        warnings.append("No git data found.")

    return {
        "current_branch": current_branch,
        "branches": branches,
        "recent_commits": recent_commits,
    }


def read_local_branches(repo_root: Path, warnings: list[str]) -> list[dict[str, str]]:
    output = run_git(
        [
            "git",
            "for-each-ref",
            "refs/heads",
            "--sort=-committerdate",
            f"--format=%(refname:short)%x1f%(objectname:short)%x1f%(committerdate:iso-strict)%x1f%(subject)%x1e",
        ],
        repo_root,
        warnings,
    )

    branches: list[dict[str, str]] = []
    for name, short_hash, committed_at, subject in parse_separated_records(output, 4):
        branches.append(
            {
                "name": name,
                "short_hash": short_hash,
                "committed_at": committed_at,
                "subject": subject,
            }
        )

    return branches


def read_recent_commits(repo_root: Path, max_commits: int, warnings: list[str]) -> list[dict[str, str]]:
    commit_count = clean_max_commits(max_commits)
    if commit_count == 0:
        return []

    output = run_git(
        [
            "git",
            "log",
            "--all",
            "--max-count",
            str(commit_count),
            "--date=iso-strict",
            f"--pretty=format:%H%x1f%h%x1f%D%x1f%an%x1f%ad%x1f%s%x1e",
        ],
        repo_root,
        warnings,
    )

    commits: list[dict[str, str]] = []
    for full_hash, short_hash, refs, author, committed_at, subject in parse_separated_records(output, 6):
        commits.append(
            {
                "hash": full_hash,
                "short_hash": short_hash,
                "refs": refs,
                "author": author,
                "committed_at": committed_at,
                "subject": subject,
            }
        )

    return commits


def run_git(args: list[str], cwd: Path, warnings: list[str]) -> str:
    try:
        result = subprocess.run(
            args,
            cwd=str(cwd),
            shell=False,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError:
        warnings.append(f"Git command failed: {' '.join(args[:2])}.")
        return ""

    if result.returncode != 0:
        warnings.append(f"Git command failed: {' '.join(args[:2])}.")
        return ""

    return result.stdout


def parse_separated_records(output: str, field_count: int) -> list[list[str]]:
    records: list[list[str]] = []

    for raw_record in output.split(RECORD_SEPARATOR):
        record = raw_record.strip("\n")
        if not record:
            continue

        fields = record.split(FIELD_SEPARATOR)
        if len(fields) < field_count:
            fields.extend([""] * (field_count - len(fields)))

        records.append(fields[:field_count])

    return records


def read_text_if_exists(path: Path, warnings: list[str], label: str) -> str:
    if not path.exists():
        return ""

    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        warnings.append(f"Could not read {label}.")
        return ""


def clean_max_commits(max_commits: int) -> int:
    try:
        return max(0, int(max_commits))
    except (TypeError, ValueError):
        return DEFAULT_MAX_COMMITS


def empty_git_snapshot() -> dict[str, Any]:
    return {
        "current_branch": "",
        "branches": [],
        "recent_commits": [],
    }


def relative_path(repo_root: Path, path: Path) -> str:
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError:
        return path.as_posix()
