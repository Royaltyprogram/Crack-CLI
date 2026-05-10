# Flask Localhost Crack GUI

`tools/flask_branch_visualizer` is a local-only Flask GUI for Crack workflow state and a small set of safe Crack actions.

The page reads `.crack/` Markdown state and git history to show repository status, inbox and PR lock state, plan progress, queue and log detail, branches, and recent commits. It also exposes allowlisted buttons for common workflow commands, so localhost users can continue a plan without leaving the browser.

This is not a remote dashboard. Bind to `127.0.0.1` for local use, and do not expose it to an untrusted network.

## Setup

```bash
source "$(git rev-parse --show-toplevel)/myenv/bin/activate"
pip install -r tools/flask_branch_visualizer/requirements.txt
```

If you want GUI actions to use the repository-local Crack CLI, build the TypeScript CLI first:

```bash
npm run build
```

The action runner prefers `node dist/src/cli.js` when that file exists. If `dist/src/cli.js` is missing, it falls back to a `crack` command available on `PATH`.

Run `npm run build` after changing TypeScript CLI code, after a fresh clone without `dist/`, or whenever `dist/src/cli.js` may be stale.

## Run Locally

```bash
python tools/flask_branch_visualizer/app.py --repo . --port 5050
```

Open `http://127.0.0.1:5050` after the server starts. The default bind address is `127.0.0.1` for local development.

Useful options:

```bash
python tools/flask_branch_visualizer/app.py --repo /path/to/repo --host 127.0.0.1 --port 5050 --max-commits 12
```

## GUI Actions

Supported plan actions:

- `run-next`: run the next pending commit unit for the selected plan.
- `run-all`: run all remaining commit units for the selected plan until complete or `needs_work`.
- `open-pr`: open the PR stage for a completed selected plan.

Supported repository actions:

- `pr-check`: inspect the active PR lock and drain merged PR state when appropriate.
- `drain`: route queued inbox requests when no PR lock is active.

The GUI does not support merge. Merge remains CLI-only:

```bash
crack merge --plan .crack/plans/<plan>/plan.md
```

Action requests are synchronous. The browser disables action buttons while a command is running and then refreshes the snapshot from `/api/state`.

## Verify

Run the full Python visualizer tests:

```bash
source "$(git rev-parse --show-toplevel)/myenv/bin/activate"
python -m unittest discover tools/flask_branch_visualizer/tests
```

Run the parser-only tests when dependencies are not installed and you want to isolate Markdown parsing behavior:

```bash
python -m unittest tools.flask_branch_visualizer.tests.test_parser
```

Flask route tests live in `tools.flask_branch_visualizer.tests.test_app` and run when Flask is installed from the requirements file. Without Flask, those tests are skipped so parser and snapshot failures remain visible.

Run the existing TypeScript CLI tests:

```bash
npm test
```

When practical, start the server and manually check the GUI:

```bash
source "$(git rev-parse --show-toplevel)/myenv/bin/activate"
python tools/flask_branch_visualizer/app.py --repo . --port 5050
```

Then open `http://127.0.0.1:5050` and confirm that repository status, plan detail, action controls, and `/api/state` load.

## Troubleshooting

Missing Flask:

- Activate the existing virtualenv with `source "$(git rev-parse --show-toplevel)/myenv/bin/activate"`.
- Install the visualizer dependencies with `pip install -r tools/flask_branch_visualizer/requirements.txt`.
- Without Flask, the server will not start and Flask route tests are skipped.

Missing Crack CLI:

- Run `npm run build` so the GUI can execute `node dist/src/cli.js`.
- If you do not build locally, make sure a `crack` executable is available on `PATH`.
- The GUI action result panel will show command stderr when neither option can be executed.

Dirty working tree before run actions:

- Check `git status --short` before using `run-next`, `run-all`, or `open-pr`.
- Commit, stash, or otherwise resolve unrelated local changes first.
- The GUI shows dirty file counts, but it does not decide whether your uncommitted changes are safe to include in a Crack run.
