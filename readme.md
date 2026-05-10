# Crack CLI

![Crack CLI Banner](./banner.png)

A CLI built for Codex. More precisely, it is a tiny remote control for making Codex boss around other agents.

## The Problem It Solves

0. Codex's Plan mode considers every step in a single context, which creates a performance bottleneck. It feels like inviting the entire company into one meeting room inside its head.
1. Codex tends to make the smallest possible change to the current codebase instead of thinking seriously about code quality. Sometimes the result feels like repairing a bridge with toothpicks.
2. Instead of using agents like the oh-my series or Aider directly in a TUI, I want Codex to use them for me inside the Codex app. I want to be the director, not the keyboard intern.
3. Most agent harnesses are only effective in specific situations, which makes them hard to use generally. They look like universal remotes, but somehow only turn on the air conditioner.

Crack CLI is a tool for making these problems slightly less sad.

## Quick Start

0. We prepared a skill for Codex, not for you. Give Codex this prompt and let it do the chores:

   ```text
   Install Crack CLI from https://github.com/Royaltyprogram/crack-cli.git.
   Clone the repository, run npm install, run npm run build, and link the crack binary with npm link.
   Then install the Codex skill by copying skills/crack-cli into ${CODEX_HOME:-$HOME/.codex}/skills/crack-cli.
   After that, verify the setup with crack --help.
   ```

1. Make sure the GitHub CLI is installed and authenticated:
   https://docs.github.com/en/github-cli/github-cli/quickstart
2. Make sure the Codex CLI is available, because Crack uses `codex exec` for planning, implementation, and conflict resolution.
3. Finished. In theory. If not, congratulations: you have discovered software.

## How It Works

Crack does not run a daemon, background queue, or secret little scheduler hiding under your desk. Every workflow step happens inside the CLI command you run, and the source of truth is plain Markdown under `.crack/`.

```text
.crack/
  inbox.md
  pr-lock.md
  plans/
    <plan-name>/
      plan.md
      queue.md
      log.md
```

### Branches

When Crack creates a new Plan, it also prepares a branch. If you do not pass `--branch`, it turns the request title into a `codex/<slug>` branch name.

- If the branch already exists, Crack runs `git switch <branch>`.
- If it does not exist, Crack runs `git switch -c <branch>`.
- The Plan lives under `.crack/plans/<name>/`.
- The real source branch is read back from the `Branch:` line in `plan.md`.

That last part matters: the Plan document is not decoration. It is the map. A tiny map, yes, but still a map.

### Scheduling

Crack's scheduling model is deliberately boring.

- `submit` and `route` do not immediately implement code.
- If `.crack/pr-lock.md` exists, new requests go to `inbox.md`.
- If you pass `--plan <path>`, the request goes to that Plan's `queue.md`.
- If active Plans exist, the Router decides whether to attach the request to an existing Plan or create a new branch.
- `run-next` executes one unfinished commit unit.
- `run-all` repeats `run-next` until the Plan is complete or something returns `needs_work`.

The next commit unit is selected by comparing `### Commit N:` sections in `plan.md` with `Completed commit unit N` entries in `log.md`. This is not glamorous. It is also very easy to read at 2 a.m., which is a feature.

### PR Locks

Remote PR mode creates `.crack/pr-lock.md`. While that file exists, Crack pauses new Plan creation and stores incoming requests in `inbox.md`.

The lock is cleared when `crack pr-check` sees that the PR was merged, or when remote merge succeeds for the same branch. After that, `drain` routes queued inbox requests back through the Router one at a time.

### Merge

Merge only runs for a complete Plan. Crack checks `plan.md` and `log.md`; if any commit unit is unfinished, merge stops with `needs_work`.

Local merge switches to the target branch, merges the Plan branch, and records the result in `log.md`. Remote merge pushes the source branch, reuses or creates a PR, and runs `gh pr merge --merge`.

If a conflict appears, Crack calls a Merge agent whose job is intentionally narrow: resolve the current conflict, not redesign the feature, not rewrite the Plan, not suddenly become a product manager. If the conflict cannot be fully resolved, Crack stops with `merge_needs_work` and writes the reason to the Plan log.
