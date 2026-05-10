from __future__ import annotations

import json
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any

DEFAULT_MAX_COMMITS = 20
DEFAULT_RECENT_LOG_LIMIT = 5

PLAN_TITLE_RE = re.compile(r"^#\s+Plan:\s*(.+?)\s*$", re.MULTILINE)
BRANCH_RE = re.compile(r"^Branch:\s*(.+?)\s*$", re.MULTILINE)
COMMIT_RE = re.compile(r"^###\s+Commit\s+(\d+)\s*:?\s*(.*?)\s*$", re.IGNORECASE | re.MULTILINE)
COMPLETED_RE = re.compile(r"Completed commit unit\s+(\d+)\b", re.IGNORECASE)
QUEUED_REQUEST_RE = re.compile(r"^##\s+Queued Request\s*$", re.MULTILINE)
RECEIVED_RE = re.compile(r"^Received:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
PR_BRANCH_RE = re.compile(r"^Branch:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
PR_URL_RE = re.compile(r"^PR:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
PR_STATUS_RE = re.compile(r"^Status:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
LOG_HEADING_RE = re.compile(r"^##\s+(.+?)\s*$")
LOG_BULLET_RE = re.compile(r"^-\s+(.+?)\s*$")

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
    repository = {
        "repo_root": str(repo_root),
        "crack_dir": str(crack_dir),
        "initialized": crack_dir.exists(),
        "warnings": warnings,
    }

    snapshot: dict[str, Any] = {
        "repository": repository,
        "repo_root": str(repo_root),
        "crack_dir": str(crack_dir),
        "initialized": crack_dir.exists(),
        "warnings": warnings,
        "inbox": read_inbox_snapshot(repo_root, warnings),
        "pr_lock": read_pr_lock_snapshot(repo_root, warnings),
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


def parse_queued_requests(queue_content: str) -> list[dict[str, str]]:
    requests: list[dict[str, str]] = []

    for section in QUEUED_REQUEST_RE.split(queue_content)[1:]:
        request = parse_queued_request_section(section)
        if request:
            requests.append(request)

    return requests


def parse_queued_request_section(section: str) -> dict[str, str] | None:
    lines = section.splitlines()
    received_at = match_line(section, RECEIVED_RE) or ""
    prompt_label_index = line_label_index(lines, "User prompt:")
    reason_label_index = line_label_index(lines, "Reason:")

    if prompt_label_index >= 0:
        prompt_end = reason_label_index if reason_label_index > prompt_label_index else len(lines)
        prompt_lines = lines[prompt_label_index + 1 : prompt_end]
        reason_lines = lines[reason_label_index + 1 :] if reason_label_index > prompt_label_index else []
    else:
        prompt_lines = [line for line in lines if not RECEIVED_RE.match(line)]
        reason_lines = []

    prompt = "\n".join(unquote_prompt_lines(trim_outer_empty_lines(prompt_lines))).strip()
    reason = "\n".join(trim_outer_empty_lines(reason_lines)).strip()

    if not prompt:
        return None

    return {
        "received_at": received_at,
        "prompt": prompt,
        "reason": reason,
    }


def parse_pr_lock(content: str) -> dict[str, str] | None:
    branch = match_line(content, PR_BRANCH_RE)
    pr_url = match_line(content, PR_URL_RE)
    status = match_line(content, PR_STATUS_RE) or ""

    if not branch or not pr_url:
        return None

    return {
        "branch": branch,
        "pr_url": pr_url,
        "status": status,
    }


def recent_log_entries(log_content: str, limit: int = DEFAULT_RECENT_LOG_LIMIT) -> list[dict[str, str]]:
    if limit <= 0:
        return []

    entries: list[dict[str, str]] = []
    logged_at = ""

    for line in log_content.splitlines():
        heading = LOG_HEADING_RE.match(line)
        if heading:
            logged_at = heading.group(1).strip()
            continue

        bullet = LOG_BULLET_RE.match(line)
        if bullet:
            entries.append({"logged_at": logged_at, "text": bullet.group(1).strip()})

    return entries[-limit:]


def read_inbox_snapshot(repo_root: Path, warnings: list[str]) -> dict[str, Any]:
    inbox_path = repo_root / ".crack" / "inbox.md"
    content = read_text_if_exists(inbox_path, warnings, "inbox.md")
    return {
        "path": str(inbox_path),
        "relative_path": relative_path(repo_root, inbox_path),
        "request_count": count_queued_requests(content),
        "requests": parse_queued_requests(content),
    }


def read_pr_lock_snapshot(repo_root: Path, warnings: list[str]) -> dict[str, Any] | None:
    lock_path = repo_root / ".crack" / "pr-lock.md"
    if not lock_path.exists():
        return None

    content = read_text_if_exists(lock_path, warnings, "pr-lock.md")
    parsed = parse_pr_lock(content)
    snapshot: dict[str, Any] = {
        "path": str(lock_path),
        "relative_path": relative_path(repo_root, lock_path),
        "valid": parsed is not None,
    }

    if parsed:
        snapshot.update(parsed)

    return snapshot


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
        completed_units = [unit for unit in units if unit["number"] in completed_set]
        remaining_units = [unit for unit in units if unit["number"] not in completed_set]
        relative_plan = relative_path(repo_root, plan_path)

        plans.append(
            {
                "directory": str(plan_dir),
                "plan_path": str(plan_path),
                "queue_path": str(queue_path),
                "log_path": str(log_path),
                "relative_directory": relative_path(repo_root, plan_dir),
                "relative_plan_path": relative_plan,
                "relative_queue_path": relative_path(repo_root, queue_path),
                "relative_log_path": relative_path(repo_root, log_path),
                "title": parsed["title"] or plan_dir.name,
                "branch": parsed["branch"] or plan_dir.name,
                "plan_content": plan_content,
                "queue_content": queue_content,
                "log_content": log_content,
                "commit_units": units,
                "completed_commit_units": completed_units,
                "remaining_commit_units": remaining_units,
                "total_commit_unit_count": len(units),
                "completed_commit_unit_count": len(completed_numbers),
                "completed_commit_unit_numbers": completed_numbers,
                "queue_request_count": count_queued_requests(queue_content),
                "queued_requests": parse_queued_requests(queue_content),
                "recent_log_entries": recent_log_entries(log_content),
                "next_commit_unit": remaining_units[0] if remaining_units else None,
                "suggested_commands": suggested_plan_commands(relative_plan, bool(remaining_units)),
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
    dirty = read_dirty_working_tree(repo_root, warnings)

    if not current_branch and not branches and not recent_commits and not dirty["entries"]:
        warnings.append("No git data found.")

    return {
        "current_branch": current_branch,
        "branches": branches,
        "recent_commits": recent_commits,
        "dirty": dirty,
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


def read_dirty_working_tree(repo_root: Path, warnings: list[str]) -> dict[str, Any]:
    output = run_git(["git", "status", "--short"], repo_root, warnings)
    return parse_git_status_short(output)


def parse_git_status_short(output: str) -> dict[str, Any]:
    entries: list[dict[str, str]] = []
    staged_count = 0
    unstaged_count = 0
    untracked_count = 0

    for raw_line in output.splitlines():
        if not raw_line.strip():
            continue

        status = raw_line[:2]
        raw_path = raw_line[3:] if len(raw_line) > 3 else ""
        rename_separator = raw_path.rfind(" -> ")
        path = unquote_status_path(raw_path[rename_separator + 4 :] if rename_separator >= 0 else raw_path)

        entries.append({"status": status, "path": path, "raw": raw_line})

        if status == "??":
            untracked_count += 1
            continue

        if status[:1] and status[0] not in {" ", "?"}:
            staged_count += 1

        if len(status) > 1 and status[1] != " ":
            unstaged_count += 1

    return {
        "raw": output,
        "entries": entries,
        "is_dirty": bool(entries),
        "changed_file_count": len(entries),
        "staged_file_count": staged_count,
        "unstaged_file_count": unstaged_count,
        "untracked_file_count": untracked_count,
    }


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
        "dirty": parse_git_status_short(""),
    }


def relative_path(repo_root: Path, path: Path) -> str:
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError:
        return path.as_posix()


def suggested_plan_commands(relative_plan_path: str, has_remaining_units: bool) -> list[dict[str, str]]:
    plan_arg = shlex.quote(relative_plan_path)
    if has_remaining_units:
        return [
            {"kind": "run-next", "command": f"crack run-next --plan {plan_arg}"},
            {"kind": "run-all", "command": f"crack run-all --plan {plan_arg}"},
        ]

    return [{"kind": "open-pr", "command": f"crack open-pr --plan {plan_arg}"}]


def match_line(content: str, pattern: re.Pattern[str]) -> str | None:
    match = pattern.search(content)
    return match.group(1).strip() if match else None


def line_label_index(lines: list[str], label: str) -> int:
    normalized = label.casefold()
    for index, line in enumerate(lines):
        if line.strip().casefold() == normalized:
            return index

    return -1


def trim_outer_empty_lines(lines: list[str]) -> list[str]:
    start = 0
    end = len(lines)

    while start < end and lines[start].strip() == "":
        start += 1

    while end > start and lines[end - 1].strip() == "":
        end -= 1

    return lines[start:end]


def unquote_prompt_lines(lines: list[str]) -> list[str]:
    unquoted: list[str] = []
    for line in lines:
        if line == ">":
            unquoted.append("")
        elif line.startswith("> "):
            unquoted.append(line[2:])
        elif line.startswith(">"):
            unquoted.append(line[1:])
        else:
            unquoted.append(line)

    return unquoted


def unquote_status_path(value: str) -> str:
    if not value.startswith('"') or not value.endswith('"'):
        return value

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return value[1:-1]

    return parsed if isinstance(parsed, str) else value
