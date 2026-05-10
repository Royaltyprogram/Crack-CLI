import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunNextOptions, RunNextResult } from "../src/implementer";
import type { OpenPullRequestOptions, OpenPullRequestResult } from "../src/pr";
import { RunAllRunner } from "../src/run-all";
import type { NextUnitRunner, ReadyPullRequestOpener } from "../src/run-all";
import { MarkdownState } from "../src/state";

test("runAll runs commit units until the plan is complete and asks the PR opener", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const planPath = path.join(root, ".crack", "plans", "demo", "plan.md");
    const implementer = new StubNextUnitRunner([
      {
        action: "committed",
        planPath,
        unitNumber: 1,
        commitHash: "aaa111",
        message: "First unit",
      },
      {
        action: "committed",
        planPath,
        unitNumber: 2,
        commitHash: "bbb222",
        message: "Second unit",
      },
      {
        action: "complete",
        planPath,
        message: "No remaining commit units.",
      },
    ]);
    const pullRequests = new StubPullRequestOpener({
      action: "opened",
      planPath,
      branchName: "codex/demo",
      prUrl: "https://github.com/example/repo/pull/7",
      title: "Demo",
      lockPath: path.join(root, ".crack", "pr-lock.md"),
    });

    const result = await new RunAllRunner(state, implementer, pullRequests).runAll({
      planPath: ".crack/plans/demo",
      receivedAt: "2026-05-09 12:00",
    });

    assert.equal(result.action, "opened");
    assert.equal(implementer.calls.length, 3);
    assert.equal(implementer.calls[0].planPath, ".crack/plans/demo");
    assert.equal(implementer.calls[1].planPath, planPath);
    assert.equal(implementer.calls[2].planPath, planPath);
    assert.equal(pullRequests.calls.length, 1);
    assert.equal(pullRequests.calls[0].planPath, planPath);
    assert.equal(pullRequests.calls[0].branchMode, undefined);
  });
});

test("runAll forwards remote branch mode to PR opening", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const planPath = path.join(root, ".crack", "plans", "demo", "plan.md");
    const implementer = new StubNextUnitRunner([
      {
        action: "complete",
        planPath,
        message: "No remaining commit units.",
      },
    ]);
    const pullRequests = new StubPullRequestOpener({
      action: "opened",
      planPath,
      branchName: "codex/demo",
      prUrl: "https://github.com/example/repo/pull/7",
      title: "Demo",
      lockPath: path.join(root, ".crack", "pr-lock.md"),
    });

    const result = await new RunAllRunner(state, implementer, pullRequests).runAll({
      planPath,
      branchMode: "remote",
    });

    assert.equal(result.action, "opened");
    assert.equal(pullRequests.calls.length, 1);
    assert.equal(pullRequests.calls[0].branchMode, "remote");
  });
});

test("runAll stops when a commit unit needs work", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const planPath = path.join(root, ".crack", "plans", "demo", "plan.md");
    const implementer = new StubNextUnitRunner([
      {
        action: "committed",
        planPath,
        unitNumber: 1,
        commitHash: "aaa111",
        message: "First unit",
      },
      {
        action: "needs_work",
        planPath,
        unitNumber: 2,
        reason: "Tests fail.",
      },
    ]);
    const pullRequests = new StubPullRequestOpener({
      action: "opened",
      planPath,
      branchName: "codex/demo",
      prUrl: "https://github.com/example/repo/pull/7",
      title: "Demo",
      lockPath: path.join(root, ".crack", "pr-lock.md"),
    });

    const result = await new RunAllRunner(state, implementer, pullRequests).runAll({
      planPath,
    });

    assert.equal(result.action, "needs_work");
    assert.equal(implementer.calls.length, 2);
    assert.equal(pullRequests.calls.length, 0);
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

class StubNextUnitRunner implements NextUnitRunner {
  readonly calls: RunNextOptions[] = [];

  constructor(private readonly results: RunNextResult[]) {}

  async runNext(options: RunNextOptions = {}): Promise<RunNextResult> {
    this.calls.push(options);
    const result = this.results.shift();

    if (!result) {
      throw new Error("Unexpected runNext call");
    }

    return result;
  }
}

class StubPullRequestOpener implements ReadyPullRequestOpener {
  readonly calls: OpenPullRequestOptions[] = [];

  constructor(private readonly result: OpenPullRequestResult) {}

  async openWhenReady(options: OpenPullRequestOptions = {}): Promise<OpenPullRequestResult> {
    this.calls.push(options);
    return this.result;
  }
}
