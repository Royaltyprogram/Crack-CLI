from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template_string, request

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from tools.flask_branch_visualizer.actions import ActionError, run_action
    from tools.flask_branch_visualizer.state import find_repo_root, read_repository_snapshot
else:
    from .actions import ActionError, run_action
    from .state import find_repo_root, read_repository_snapshot


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5050
DEFAULT_WEB_MAX_COMMITS = 12

PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Localhost Crack GUI</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --panel-soft: #f0f4f7;
      --ink: #182026;
      --muted: #65727d;
      --line: #d9e0e6;
      --accent: #1f6f8b;
      --accent-strong: #164f63;
      --good: #287a4f;
      --warn: #95621b;
      --danger: #a13d37;
      --code-bg: #172026;
      --code-ink: #eef7f9;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.5;
    }

    .shell {
      width: min(1280px, calc(100% - 32px));
      margin: 0 auto;
      padding: 22px 0 42px;
    }

    .topbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: start;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line);
    }

    h1,
    h2,
    h3,
    p {
      margin-top: 0;
    }

    h1 {
      margin-bottom: 6px;
      font-size: 1.75rem;
      line-height: 1.15;
    }

    h2 {
      margin-bottom: 10px;
      font-size: 0.82rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    h3 {
      margin-bottom: 4px;
      font-size: 1rem;
    }

    .muted,
    .meta,
    .label,
    .activity {
      color: var(--muted);
      font-size: 0.88rem;
    }

    .repo-path,
    .activity,
    pre {
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .panel,
    .notice,
    .plan-list-item,
    .branch-item,
    .commit-item,
    .status-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }

    .local-note {
      max-width: 760px;
      margin-bottom: 0;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }

    .status-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(130px, 1fr));
      gap: 10px;
      margin-top: 18px;
    }

    .status-card {
      padding: 12px;
      min-width: 0;
    }

    .status-card strong {
      display: block;
      margin-top: 4px;
      font-size: 1rem;
    }

    .notice {
      margin-top: 14px;
      padding: 14px;
    }

    .notice.warning {
      border-color: rgba(156, 63, 58, 0.35);
      color: var(--danger);
    }

    .notice ul {
      margin: 8px 0 0;
      padding-left: 18px;
    }

    .main-grid {
      display: grid;
      grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
      gap: 16px;
      padding-top: 24px;
    }

    .side-column,
    .detail-column {
      display: grid;
      align-content: start;
      gap: 16px;
    }

    .section {
      padding-top: 24px;
    }

    .panel {
      padding: 14px;
    }

    .panel-head,
    .item-head,
    .command-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }

    .plan-list {
      display: grid;
      gap: 10px;
    }

    .plan-list-item {
      display: block;
      padding: 12px;
      color: inherit;
      text-decoration: none;
    }

    .plan-list-item:hover,
    .plan-list-item:focus {
      border-color: rgba(31, 111, 139, 0.55);
      outline: none;
    }

    .plan-list-item.selected,
    .branch-item.current {
      border-color: rgba(35, 115, 90, 0.58);
    }

    .item-head {
      margin-bottom: 8px;
    }

    .metrics {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 8px 0 10px;
    }

    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--muted);
      font-size: 0.74rem;
      font-weight: 700;
      white-space: nowrap;
    }

    .pill.current {
      border-color: rgba(35, 115, 90, 0.45);
      color: var(--accent-strong);
    }

    .pill.warning {
      border-color: rgba(149, 98, 27, 0.4);
      color: var(--warn);
    }

    .pill.good {
      border-color: rgba(40, 122, 79, 0.4);
      color: var(--good);
    }

    .progress {
      height: 7px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--panel-soft);
    }

    .progress span {
      display: block;
      height: 100%;
      background: var(--accent);
    }

    .detail-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    button {
      border: 1px solid var(--accent);
      border-radius: 6px;
      background: var(--accent);
      color: #ffffff;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      padding: 7px 10px;
    }

    button.secondary {
      border-color: var(--line);
      background: var(--panel);
      color: var(--ink);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    .tabs {
      display: grid;
      gap: 10px;
    }

    details {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      overflow: hidden;
    }

    summary {
      cursor: pointer;
      padding: 10px 12px;
      font-weight: 800;
      background: var(--panel-soft);
    }

    pre {
      max-height: 420px;
      margin: 0;
      overflow: auto;
      padding: 12px;
      background: var(--code-bg);
      color: var(--code-ink);
      font: 0.84rem/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      white-space: pre-wrap;
    }

    .empty {
      margin: 0;
      padding: 12px;
      border-radius: 6px;
      background: var(--panel-soft);
      color: var(--muted);
    }

    .branch-list,
    .commit-list,
    .log-list,
    .queue-list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .branch-item,
    .commit-item {
      padding: 10px;
    }

    .hash {
      color: var(--accent-strong);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-weight: 800;
    }

    .subject {
      margin-bottom: 4px;
      font-weight: 700;
    }

    .refs {
      color: var(--warn);
      font-size: 0.84rem;
    }

    .command-output {
      display: block;
      min-height: 140px;
    }

    .repo-path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.86rem;
    }

    .queue-request,
    .log-entry {
      padding: 10px;
      border-radius: 6px;
      background: var(--panel-soft);
    }

    .queue-request p,
    .log-entry p {
      margin-bottom: 0;
    }

    @media (max-width: 980px) {
      .topbar,
      .main-grid {
        grid-template-columns: 1fr;
      }

      .toolbar {
        justify-content: flex-start;
      }

      .status-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    @media (max-width: 620px) {
      .shell {
        width: min(100% - 20px, 1120px);
        padding-top: 16px;
      }

      .status-grid {
        grid-template-columns: 1fr;
      }

      button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>Localhost Crack GUI</h1>
        <p class="muted local-note">Local-only control surface for this repository. Buttons run allowlisted Crack commands on this machine; merge remains CLI-only.</p>
      </div>
      <div class="toolbar" aria-label="Global maintenance actions">
        <button type="button" class="secondary" data-refresh-button>Refresh State</button>
        <button type="button" data-action-button data-action="pr-check">Check PR Status</button>
        <button type="button" data-action-button data-action="drain">Drain Inbox</button>
      </div>
    </header>

    <section class="status-grid" aria-label="Repository status">
      <div class="status-card">
        <span class="label">Repository</span>
        <strong class="repo-path">{{ snapshot.repo_root }}</strong>
      </div>
      <div class="status-card">
        <span class="label">Crack state</span>
        <strong>{{ ".crack found" if snapshot.initialized else "No .crack directory" }}</strong>
      </div>
      <div class="status-card">
        <span class="label">Current branch</span>
        <strong>{{ snapshot.git.current_branch or "detached or unknown" }}</strong>
      </div>
      <div class="status-card">
        <span class="label">Dirty files</span>
        <strong>{{ snapshot.git.dirty.changed_file_count|default(0, true) }} changed</strong>
        <span class="meta">{{ snapshot.git.dirty.staged_file_count|default(0, true) }} staged, {{ snapshot.git.dirty.unstaged_file_count|default(0, true) }} unstaged, {{ snapshot.git.dirty.untracked_file_count|default(0, true) }} untracked</span>
      </div>
      <div class="status-card">
        <span class="label">PR lock</span>
        {% if snapshot.pr_lock %}
          <strong>{{ snapshot.pr_lock.status or "active" }}</strong>
          <span class="meta">{{ snapshot.pr_lock.branch or "unknown branch" }}</span>
        {% else %}
          <strong>None</strong>
        {% endif %}
      </div>
      <div class="status-card">
        <span class="label">Inbox</span>
        <strong>{{ snapshot.inbox.request_count|default(0, true) }} requests</strong>
      </div>
    </section>

    {% if snapshot.warnings %}
      <section class="notice warning" aria-label="Warnings">
        <strong>Warnings</strong>
        <ul>
          {% for warning in snapshot.warnings %}
            <li>{{ warning }}</li>
          {% endfor %}
        </ul>
      </section>
    {% endif %}

    {% if not snapshot.initialized %}
      <section class="notice">
        <h2>No .crack State Found</h2>
        <p class="muted">This repository has no readable <strong>.crack/</strong> directory yet. Git branches and recent commits are still shown when available.</p>
      </section>
    {% endif %}

    <div class="main-grid">
      <div class="side-column">
        <section class="panel" aria-labelledby="plans-heading">
          <div class="panel-head">
            <div>
              <h2 id="plans-heading">Plans</h2>
              <p class="muted">Select a plan to inspect queue, log, and actions.</p>
            </div>
          </div>
        {% if snapshot.plans %}
          <div class="plan-list">
            {% for plan in snapshot.plans %}
              <a class="plan-list-item{% if selected_plan and plan.relative_plan_path == selected_plan.relative_plan_path %} selected{% endif %}" href="/?plan={{ plan.relative_plan_path|urlencode }}">
                <div class="item-head">
                  <div>
                    <h3>{{ plan.title }}</h3>
                    <p class="meta">{{ plan.branch }}</p>
                  </div>
                  <span class="pill{% if plan.queue_request_count %} warning{% endif %}">{{ plan.queue_request_count }} queued</span>
                </div>
                <div class="progress" aria-label="Plan progress">
                  <span style="width: {{ progress_percent(plan) }}%"></span>
                </div>
                <div class="metrics">
                  <span class="pill">{{ plan.completed_commit_unit_count }}/{{ plan.total_commit_unit_count }} units</span>
                  <span class="pill">{{ progress_percent(plan) }}% complete</span>
                </div>
                <p class="subject">Next: {{ next_commit_text(plan) }}</p>
                <p class="activity">{{ recent_activity_text(plan) }}</p>
              </a>
            {% endfor %}
          </div>
        {% else %}
          <p class="empty">No plan files were found under <strong>.crack/plans/</strong>.</p>
        {% endif %}
        </section>

        <section class="panel" aria-labelledby="branches-heading">
          <h2 id="branches-heading">Branches</h2>
          {% if snapshot.git.branches %}
            <ul class="branch-list">
              {% for branch in snapshot.git.branches %}
                <li class="branch-item{% if branch.name == snapshot.git.current_branch %} current{% endif %}">
                  <div class="item-head">
                    <h3>{{ branch.name }}</h3>
                    {% if branch.name == snapshot.git.current_branch %}
                      <span class="pill current">current</span>
                    {% endif %}
                  </div>
                  <p><span class="hash">{{ branch.short_hash or "no hash" }}</span></p>
                  <p class="subject">{{ branch.subject or "No commit subject" }}</p>
                  <p class="meta">{{ branch.committed_at or "No commit date" }}</p>
                </li>
              {% endfor %}
            </ul>
          {% else %}
            <p class="empty">No local branch data found.</p>
          {% endif %}
        </section>
      </div>

      <div class="detail-column">
        <section class="panel" aria-labelledby="detail-heading">
          {% if selected_plan %}
            <div class="panel-head">
              <div>
                <h2 id="detail-heading">Selected Plan</h2>
                <h3>{{ selected_plan.title }}</h3>
                <p class="meta">{{ selected_plan.relative_plan_path }} &middot; {{ selected_plan.branch }}</p>
              </div>
              <span class="pill{% if selected_plan.next_commit_unit %} current{% else %} good{% endif %}">{{ next_commit_text(selected_plan) }}</span>
            </div>
            <div class="progress" aria-label="Selected plan progress">
              <span style="width: {{ progress_percent(selected_plan) }}%"></span>
            </div>
            <div class="metrics">
              <span class="pill">{{ selected_plan.completed_commit_unit_count }}/{{ selected_plan.total_commit_unit_count }} commit units</span>
              <span class="pill">{{ selected_plan.queue_request_count }} queued requests</span>
              <span class="pill">{{ progress_percent(selected_plan) }}% complete</span>
            </div>

            <div class="detail-actions" aria-label="Plan actions">
              <button type="button" data-action-button data-action="run-next" data-plan-path="{{ selected_plan.relative_plan_path }}" {% if not selected_plan.next_commit_unit %}disabled{% endif %}>Run Next Unit</button>
              <button type="button" data-action-button data-action="run-all" data-plan-path="{{ selected_plan.relative_plan_path }}" {% if not selected_plan.next_commit_unit %}disabled{% endif %}>Run All Remaining</button>
              <button type="button" class="secondary" data-action-button data-action="open-pr" data-plan-path="{{ selected_plan.relative_plan_path }}">Open PR</button>
            </div>

            <div class="tabs section">
              <details open>
                <summary>Plan Markdown</summary>
                {% if selected_plan.plan_content %}
                  <pre>{{ selected_plan.plan_content }}</pre>
                {% else %}
                  <p class="empty">No plan Markdown content found.</p>
                {% endif %}
              </details>
              <details>
                <summary>Queue</summary>
                {% if selected_plan.queued_requests %}
                  <ul class="queue-list">
                    {% for request in selected_plan.queued_requests %}
                      <li class="queue-request">
                        <p class="meta">{{ request.received_at or "No received timestamp" }}</p>
                        <p>{{ request.prompt }}</p>
                        {% if request.reason %}
                          <p class="meta">Reason: {{ request.reason }}</p>
                        {% endif %}
                      </li>
                    {% endfor %}
                  </ul>
                {% else %}
                  <p class="empty">No queued requests for this plan.</p>
                {% endif %}
                {% if selected_plan.queue_content %}
                  <pre>{{ selected_plan.queue_content }}</pre>
                {% endif %}
              </details>
              <details>
                <summary>Log</summary>
                {% if selected_plan.recent_log_entries %}
                  <ul class="log-list">
                    {% for entry in selected_plan.recent_log_entries %}
                      <li class="log-entry">
                        <p class="meta">{{ entry.logged_at or "No timestamp" }}</p>
                        <p>{{ entry.text }}</p>
                      </li>
                    {% endfor %}
                  </ul>
                {% else %}
                  <p class="empty">No log entries found for this plan.</p>
                {% endif %}
                {% if selected_plan.log_content %}
                  <pre>{{ selected_plan.log_content }}</pre>
                {% endif %}
              </details>
            </div>
          {% else %}
            <h2 id="detail-heading">Selected Plan</h2>
            <p class="empty">No plan is selected because no plan files were found.</p>
          {% endif %}
        </section>

        <section class="panel" aria-labelledby="command-output-heading">
          <div class="command-head">
            <div>
              <h2 id="command-output-heading">Command Output</h2>
              <p class="muted" data-action-status>No command has run in this browser session.</p>
            </div>
            <button type="button" class="secondary" data-clear-output>Clear Output</button>
          </div>
          <pre class="command-output" data-command-output>Action results will appear here.</pre>
        </section>

        <section class="panel" aria-labelledby="commits-heading">
          <h2 id="commits-heading">Recent Commits</h2>
          {% if snapshot.git.recent_commits %}
            <ul class="commit-list">
              {% for commit in snapshot.git.recent_commits %}
                <li class="commit-item">
                  <div class="item-head">
                    <div>
                      <div class="hash">{{ commit.short_hash }}</div>
                      <div class="refs">{{ commit.refs or "no decorations" }}</div>
                    </div>
                    <span class="meta">{{ commit.committed_at or "No commit date" }}</span>
                  </div>
                  <p class="subject">{{ commit.subject or "No commit subject" }}</p>
                  <p class="meta">{{ commit.author or "Unknown author" }}</p>
                </li>
              {% endfor %}
            </ul>
          {% else %}
            <p class="empty">No recent commits found.</p>
          {% endif %}
        </section>
      </div>
    </div>
  </main>

  <script>
    (function () {
      const buttons = Array.from(document.querySelectorAll("[data-action-button]"));
      const refreshButton = document.querySelector("[data-refresh-button]");
      const clearButton = document.querySelector("[data-clear-output]");
      const status = document.querySelector("[data-action-status]");
      const output = document.querySelector("[data-command-output]");
      const storageKey = "crack-gui:last-action-result";

      function renderResult(result) {
        if (!result || !output || !status) {
          return;
        }

        const lines = [
          "Action: " + (result.action || "unknown"),
          "Command: " + (result.command || "not available"),
          "Exit code: " + String(result.exit_code),
          "",
          "STDOUT:",
          result.stdout || "(empty)",
          "",
          "STDERR:",
          result.stderr || "(empty)"
        ];

        status.textContent = result.saved_at ? "Latest action result from " + result.saved_at : "Latest action result";
        output.textContent = lines.join("\\n");
      }

      function setRunning(isRunning) {
        buttons.forEach((button) => {
          if (isRunning) {
            button.dataset.originalDisabled = button.disabled ? "true" : "false";
            button.disabled = true;
          } else {
            button.disabled = button.dataset.originalDisabled === "true";
            delete button.dataset.originalDisabled;
          }
        });

        if (refreshButton) {
          refreshButton.disabled = isRunning;
        }
      }

      function saveAndRender(result) {
        const saved = Object.assign({}, result, { saved_at: new Date().toLocaleString() });
        sessionStorage.setItem(storageKey, JSON.stringify(saved));
        renderResult(saved);
      }

      const savedResult = sessionStorage.getItem(storageKey);
      if (savedResult) {
        try {
          renderResult(JSON.parse(savedResult));
        } catch (error) {
          sessionStorage.removeItem(storageKey);
        }
      }

      buttons.forEach((button) => {
        button.addEventListener("click", async () => {
          const body = { action: button.dataset.action };
          if (button.dataset.planPath) {
            body.plan_path = button.dataset.planPath;
          }

          setRunning(true);
          status.textContent = "Running " + body.action + "...";
          output.textContent = "Waiting for command output.";

          try {
            const response = await fetch("/api/actions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            });
            const payload = await response.json();

            if (!response.ok) {
              throw new Error(payload.error || "Action failed.");
            }

            saveAndRender({
              action: payload.action,
              command: payload.command,
              exit_code: payload.exit_code,
              stdout: payload.stdout,
              stderr: payload.stderr
            });
            window.location.reload();
          } catch (error) {
            saveAndRender({
              action: body.action,
              command: "POST /api/actions",
              exit_code: "request failed",
              stdout: "",
              stderr: error.message || String(error)
            });
            setRunning(false);
          }
        });
      });

      if (refreshButton) {
        refreshButton.addEventListener("click", async () => {
          refreshButton.disabled = true;
          status.textContent = "Refreshing state from /api/state...";
          try {
            const response = await fetch("/api/state");
            if (!response.ok) {
              throw new Error("State refresh failed.");
            }
            window.location.reload();
          } catch (error) {
            status.textContent = error.message || String(error);
            refreshButton.disabled = false;
          }
        });
      }

      if (clearButton) {
        clearButton.addEventListener("click", () => {
          sessionStorage.removeItem(storageKey);
          status.textContent = "No command has run in this browser session.";
          output.textContent = "Action results will appear here.";
        });
      }
    })();
  </script>
</body>
</html>
"""


def create_app(repo_path: str | Path | None = None, max_commits: int = DEFAULT_WEB_MAX_COMMITS) -> Flask:
    repo_root = find_repo_root(repo_path)
    app = Flask(__name__)
    app.config["REPO_ROOT"] = repo_root
    app.config["MAX_COMMITS"] = max_commits

    app.jinja_env.globals.update(
        next_commit_text=next_commit_text,
        progress_percent=progress_percent,
        recent_activity_text=recent_activity_text,
    )

    @app.get("/")
    def index() -> str:
        snapshot = read_repository_snapshot(repo_root, max_commits)
        selected_plan = select_plan(snapshot.get("plans", []), request.args.get("plan"))
        return render_template_string(PAGE_TEMPLATE, snapshot=snapshot, selected_plan=selected_plan)

    @app.get("/api/state")
    def api_state() -> Any:
        snapshot = read_repository_snapshot(repo_root, max_commits)
        return jsonify(snapshot)

    @app.post("/api/actions")
    def api_actions() -> Any:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "JSON body must be an object."}), 400

        plan_path = payload.get("plan_path")
        if plan_path is None:
            plan_path = payload.get("planPath")

        try:
            result = run_action(payload.get("action") or payload.get("name"), repo_root, plan_path)
        except ActionError as error:
            return jsonify({"error": str(error)}), 400

        response = result.to_dict()
        response["snapshot"] = read_repository_snapshot(repo_root, max_commits)
        return jsonify(response)

    return app


def progress_percent(plan: dict[str, Any]) -> int:
    total = int(plan.get("total_commit_unit_count") or 0)
    completed = int(plan.get("completed_commit_unit_count") or 0)
    if total <= 0:
        return 0

    return max(0, min(100, round((completed / total) * 100)))


def next_commit_text(plan: dict[str, Any]) -> str:
    next_unit = plan.get("next_commit_unit")
    if not next_unit:
        return "Plan complete"

    number = next_unit.get("number", "?")
    title = next_unit.get("title") or "Untitled commit unit"
    return f"Commit {number}: {title}"


def recent_activity_text(plan: dict[str, Any]) -> str:
    entries = plan.get("recent_log_entries") or []
    if not entries:
        return "No recent activity."

    latest = entries[-1]
    text = latest.get("text") or "No activity text."
    logged_at = latest.get("logged_at") or ""
    return f"{logged_at}: {text}" if logged_at else text


def select_plan(plans: Any, selected_path: str | None) -> dict[str, Any] | None:
    if not isinstance(plans, list) or not plans:
        return None

    if selected_path:
        for plan in plans:
            if selected_path in {
                plan.get("relative_plan_path"),
                plan.get("plan_path"),
                plan.get("relative_directory"),
                plan.get("directory"),
            }:
                return plan

    return plans[0]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local Crack branch visualizer.")
    parser.add_argument("--repo", default=None, help="Repository root to visualize. Defaults to the nearest git root.")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Host to bind. Defaults to {DEFAULT_HOST}.")
    parser.add_argument("--port", default=DEFAULT_PORT, type=int, help=f"Port to bind. Defaults to {DEFAULT_PORT}.")
    parser.add_argument(
        "--max-commits",
        default=DEFAULT_WEB_MAX_COMMITS,
        type=int,
        help=f"Recent commit count to show. Defaults to {DEFAULT_WEB_MAX_COMMITS}.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    app = create_app(args.repo, args.max_commits)
    app.run(host=args.host, port=args.port)


if __name__ == "__main__":
    main()
