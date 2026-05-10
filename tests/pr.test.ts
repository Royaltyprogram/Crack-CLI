import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { PullRequestRunner, parsePullRequestUrl } from "../src/pr";
import type { PullRequest, PullRequestCreator, PullRequestInput } from "../src/pr";
import { Router } from "../src/router";
import { MarkdownState } from "../src/state";

test("openWhenReady creates a draft PR and writes a PR lock", async () => {
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
    await writeFile(
      plan.log,
      [
        "# Log",
        "",
        "- Completed commit unit 1.",
        "- Completed commit unit 2.",
        "",
      ].join("\n"),
      "utf8",
    );

    const creator = new StubPullRequestCreator("https://github.com/example/repo/pull/7");
    const result = await new PullRequestRunner(state, creator).openWhenReady({
      planPath: plan.plan,
      receivedAt: "2026-05-09 14:00",
      branchMode: "remote",
    });

    assert.equal(result.action, "opened");
    assert.equal(creator.inputs.length, 1);
    assert.equal(creator.inputs[0].branchName, "codex/current");
    assert.equal(creator.inputs[0].title, "Current");
    assert.match(creator.inputs[0].body, /Commit 1: Add model/);
    assert.match(creator.inputs[0].body, /Commit 2: Wire command/);

    const lock = await readFile(path.join(root, ".crack", "pr-lock.md"), "utf8");
    assert.match(lock, /Branch: codex\/current/);
    assert.match(lock, /PR: https:\/\/github\.com\/example\/repo\/pull\/7/);

    const log = await readFile(plan.log, "utf8");
    assert.match(log, /Created draft PR https:\/\/github\.com\/example\/repo\/pull\/7\./);

    const decision = await new Router(state).route("Start another feature", {
      receivedAt: "2026-05-09 14:05",
    });
    assert.equal(decision.action, "pause_for_pr_review");
    assert.match(await readFile(path.join(root, ".crack", "inbox.md"), "utf8"), /> Start another feature/);
  });
});

test("openWhenReady defaults to keeping completed work on the local branch", async () => {
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
    await writeFile(
      plan.log,
      [
        "# Log",
        "",
        "- Completed commit unit 1.",
        "- Completed commit unit 2.",
        "",
      ].join("\n"),
      "utf8",
    );

    const creator = new StubPullRequestCreator("https://github.com/example/repo/pull/7");
    const result = await new PullRequestRunner(state, creator).openWhenReady({
      planPath: plan.plan,
      receivedAt: "2026-05-09 14:00",
    });

    assert.deepEqual(result, {
      action: "local_branch",
      planPath: plan.plan,
      branchName: "codex/current",
      reason: "Plan is complete on a local branch; remote PR was not opened.",
    });
    assert.equal(creator.inputs.length, 0);

    await assert.rejects(
      readFile(path.join(root, ".crack", "pr-lock.md"), "utf8"),
      /ENOENT/,
    );

    const log = await readFile(plan.log, "utf8");
    assert.match(log, /Plan is complete on a local branch; remote PR was not opened\./);
  });
});

test("openWhenReady waits until all commit units are complete", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await state.createPlan({
      branchName: "codex/current",
      planTitle: "Current",
      prompt: "Initial request",
      reason: "test setup",
    });
    await writePlan(plan.plan);
    await writeFile(plan.log, "- Completed commit unit 1.\n", "utf8");

    const creator = new StubPullRequestCreator("https://github.com/example/repo/pull/7");
    const result = await new PullRequestRunner(state, creator).openWhenReady({
      planPath: plan.plan,
    });

    assert.deepEqual(result, {
      action: "not_ready",
      planPath: plan.plan,
      reason: "Commit units not complete: 2.",
    });
    assert.equal(creator.inputs.length, 0);
  });
});

test("parsePullRequestUrl reads the gh PR URL", () => {
  assert.equal(
    parsePullRequestUrl("Creating pull request for codex/current into main\nhttps://github.com/example/repo/pull/7\n"),
    "https://github.com/example/repo/pull/7",
  );
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

class StubPullRequestCreator implements PullRequestCreator {
  readonly inputs: PullRequestInput[] = [];

  constructor(private readonly url: string) {}

  async createDraft(input: PullRequestInput): Promise<PullRequest> {
    this.inputs.push(input);
    return {
      url: this.url,
      title: input.title,
    };
  }
}
