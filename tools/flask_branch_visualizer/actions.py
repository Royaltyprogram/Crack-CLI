from __future__ import annotations

import shlex
import subprocess
from dataclasses import dataclass
from os import PathLike
from pathlib import Path
from typing import Any

PLAN_ACTIONS = {"run-next", "run-all", "open-pr"}
REPOSITORY_ACTIONS = {"pr-check", "drain"}
SUPPORTED_ACTIONS = PLAN_ACTIONS | REPOSITORY_ACTIONS


class ActionError(ValueError):
    """Raised when a requested GUI action is not safe to run."""


@dataclass(frozen=True)
class ActionCommand:
    action: str
    argv: list[str]
    display: str


@dataclass(frozen=True)
class ActionResult:
    action: str
    command: str
    exit_code: int
    stdout: str
    stderr: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "command": self.command,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
        }


def run_action(action: object, repo_root: str | Path, plan_path: object = None) -> ActionResult:
    root = Path(repo_root).resolve()
    command = build_action_command(action, root, plan_path)

    try:
        completed = subprocess.run(
            command.argv,
            cwd=str(root),
            shell=False,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        return ActionResult(
            action=command.action,
            command=command.display,
            exit_code=127,
            stdout="",
            stderr=str(error),
        )

    return ActionResult(
        action=command.action,
        command=command.display,
        exit_code=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )


def build_action_command(action: object, repo_root: str | Path, plan_path: object = None) -> ActionCommand:
    root = Path(repo_root).resolve()
    action_name = clean_action_name(action)
    argv = resolve_crack_command(root)

    if action_name in PLAN_ACTIONS:
        relative_plan_path = validate_plan_path(root, plan_path)
        argv.extend([action_name, "--plan", relative_plan_path])
    else:
        if plan_path is not None and plan_path != "":
            raise ActionError(f"Action {action_name!r} does not accept a plan path.")
        argv.append(action_name)

    return ActionCommand(action=action_name, argv=argv, display=shlex.join(argv))


def clean_action_name(action: object) -> str:
    if not isinstance(action, str) or not action.strip():
        raise ActionError("Missing action name.")

    action_name = action.strip()
    if action_name not in SUPPORTED_ACTIONS:
        raise ActionError(f"Unsupported action: {action_name}.")

    return action_name


def resolve_crack_command(repo_root: str | Path) -> list[str]:
    root = Path(repo_root).resolve()
    local_cli = root / "dist" / "src" / "cli.js"
    if local_cli.is_file():
        return ["node", "dist/src/cli.js"]

    return ["crack"]


def validate_plan_path(repo_root: str | Path, plan_path: object) -> str:
    if isinstance(plan_path, PathLike):
        candidate = Path(plan_path)
    elif isinstance(plan_path, str) and plan_path.strip():
        candidate = Path(plan_path.strip())
    else:
        raise ActionError("Plan action requires a plan path.")

    root = Path(repo_root).resolve()
    plans_dir = (root / ".crack" / "plans").resolve()
    if not candidate.is_absolute():
        candidate = root / candidate

    resolved = candidate.resolve(strict=False)

    try:
        relative_to_plans = resolved.relative_to(plans_dir)
    except ValueError as error:
        raise ActionError("Plan path must be under .crack/plans/.") from error

    try:
        relative_to_root = resolved.relative_to(root)
    except ValueError as error:
        raise ActionError("Plan path must be under the selected repository root.") from error

    if resolved.name != "plan.md" or len(relative_to_plans.parts) < 2:
        raise ActionError("Plan path must point to a plan.md file inside a plan directory.")

    if not resolved.is_file():
        raise ActionError("Plan file does not exist.")

    return relative_to_root.as_posix()
