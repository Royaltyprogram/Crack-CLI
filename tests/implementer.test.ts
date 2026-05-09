import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Committer, GitStatusSnapshot } from "../src/git";
import { parseGitStatus, stagedPaths } from "../src/git";
import { ImplementerRunner, parseCommitUnits, selectNextCommitUnit } from "../src/implementer";
import type { ImplementerAgent, ImplementerAgentInput, ImplementerAgentResult } from "../src/implementer-agent";
import { parseCommitUnitReview, parseSessionId } from "../src/implementer-agent";
import { MarkdownState } from "../src/state";

test("parseCommitUnits reads commit headings and content", () => {
  const units = parseCommitUnits([
    "# Plan",
    "",
    "## Commit Units",
    "",
    "### Commit 1: Add core model",
    "",
    "Create files.",
    "",
    "### Commit 2: Wire command",
    "",
    "Add CLI command.",
  ].join("\n"));

  assert.equal(units.length, 2);
  assert.equal(units[0].number, 1);
  assert.equal(units[0].title, "Add core model");
  assert.match(units[0].content, /Create files\./);
  assert.equal(units[1].number, 2);
});

test("selectNextCommitUnit skips completed units from log", () => {
  const plan = [
    "### Commit 1: First",
    "",
    "### Commit 2: Second",
  ].join("\n");
  const log = "- Completed commit unit 1.\n";

  assert.equal(selectNextCommitUnit(plan, log)?.number, 2);
});

test("parseCommitUnitReview reads ready and needs-work decisions", () => {
  assert.deepEqual(
    parseCommitUnitReview('notes\nCOMMIT_UNIT_READY title="Add command" summary="Implemented and checked."'),
    {
      status: "ready",
      title: "Add command",
      summary: "Implemented and checked.",
    },
  );
  assert.deepEqual(
    parseCommitUnitReview('COMMIT_UNIT_NEEDS_WORK reason="Tests fail."'),
    {
      status: "needs_work",
      reason: "Tests fail.",
    },
  );
});

test("parseSessionId reads session id from JSONL", () => {
  assert.equal(
    parseSessionId('{"type":"session_configured","session_id":"11111111-2222-3333-4444-555555555555"}\n'),
    "11111111-2222-3333-4444-555555555555",
  );
  assert.equal(
    parseSessionId('{"type":"thread.started","thread_id":"22222222-3333-4444-5555-666666666666"}\n'),
    "22222222-3333-4444-5555-666666666666",
  );
});

test("stagedPaths ignores unstaged and untracked entries", () => {
  assert.deepEqual(
    stagedPaths(parseGitStatus("M  src/staged.ts\n M src/unstaged.ts\n?? src/new.ts\n")),
    ["src/staged.ts"],
  );
});

test("runNext implements the next unit and commits only new paths", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await state.createPlan({
      branchName: "codex/current",
      planTitle: "Current",
      prompt: "Initial request",
      reason: "test setup",
      receivedAt: "2026-05-09 12:00",
    });
    await writePlan(plan.plan);
    await writeFile(plan.log, "# Log\n\n- Completed commit unit 1.\n", "utf8");

    const agent = new StubImplementerAgent({
      sessionId: "session-1",
      implementationMessage: "implemented",
      reviewMessage: 'COMMIT_UNIT_READY title="Wire command" summary="Looks good."',
      review: {
        status: "ready",
        title: "Wire command",
        summary: "Looks good.",
      },
    });
    const committer = new StubCommitter([
      parseGitStatus("?? docs/workflow-design.md\n"),
      parseGitStatus("?? docs/workflow-design.md\n M src/cli.ts\n?? src/implementer.ts\n"),
    ]);

    const result = await new ImplementerRunner(state, agent, committer).runNext({
      planPath: plan.plan,
      receivedAt: "2026-05-09 13:00",
    });

    assert.equal(result.action, "committed");
    assert.equal(agent.inputs.length, 1);
    assert.equal(agent.inputs[0].unitNumber, 2);
    assert.equal(agent.inputs[0].unitTitle, "Wire command");
    assert.deepEqual(committer.commits, [
      {
        paths: ["src/cli.ts", "src/implementer.ts"],
        message: "Wire command",
      },
    ]);

    const log = await readFile(plan.log, "utf8");
    assert.match(log, /Started commit unit 2: Wire command\./);
    assert.match(log, /Completed commit unit 2\./);
  });
});

test("runNext does not commit when review needs more work", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await state.createPlan({
      branchName: "codex/current",
      planTitle: "Current",
      prompt: "Initial request",
      reason: "test setup",
    });
    await writePlan(plan.plan);

    const agent = new StubImplementerAgent({
      sessionId: "session-1",
      implementationMessage: "implemented",
      reviewMessage: 'COMMIT_UNIT_NEEDS_WORK reason="Tests fail."',
      review: {
        status: "needs_work",
        reason: "Tests fail.",
      },
    });
    const committer = new StubCommitter([parseGitStatus(""), parseGitStatus(" M src/cli.ts\n")]);

    const result = await new ImplementerRunner(state, agent, committer).runNext({
      planPath: plan.plan,
    });

    assert.equal(result.action, "needs_work");
    assert.equal(committer.commits.length, 0);
  });
});

async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "crack-"));

  try {
    await mkdir(path.join(root, ".git"));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePlan(planPath: string): Promise<void> {
  await writeFile(
    planPath,
    [
      "# Plan: Current",
      "",
      "Branch: codex/current",
      "",
      "## Commit Units",
      "",
      "### Commit 1: Add model",
      "",
      "Create the model.",
      "",
      "### Commit 2: Wire command",
      "",
      "Add the command.",
      "",
    ].join("\n"),
    "utf8",
  );
}

class StubImplementerAgent implements ImplementerAgent {
  readonly inputs: ImplementerAgentInput[] = [];

  constructor(private readonly result: ImplementerAgentResult) {}

  async implement(input: ImplementerAgentInput): Promise<ImplementerAgentResult> {
    this.inputs.push(input);
    return this.result;
  }
}

class StubCommitter implements Committer {
  readonly commits: Array<{ paths: string[]; message: string }> = [];
  private lastStatus: GitStatusSnapshot;

  constructor(private readonly statuses: GitStatusSnapshot[]) {
    this.lastStatus = statuses[statuses.length - 1] ?? parseGitStatus("");
  }

  async status(): Promise<GitStatusSnapshot> {
    const next = this.statuses.shift();
    if (next) {
      this.lastStatus = next;
    }

    return this.lastStatus;
  }

  async headSummary(): Promise<string | null> {
    return "abc123 Previous commit";
  }

  async commit(paths: string[], message: string): Promise<string> {
    this.commits.push({ paths, message });
    return "def456";
  }
}
