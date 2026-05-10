import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunNextOptions, RunNextResult } from "../src/implementer";
import type {
  LocalMergeOptions,
  LocalMergeResult,
  RemoteMergeOptions,
  RemoteMergeResult,
} from "../src/merge";
import type { OpenPullRequestOptions, OpenPullRequestResult } from "../src/pr";
import { RunAllRunner } from "../src/run-all";
import type { NextUnitRunner, ReadyPlanMerger, ReadyPullRequestOpener } from "../src/run-all";
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

test("runAll merges locally when --merge is requested", async () => {
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
      action: "local_branch",
      planPath,
      branchName: "codex/demo",
      reason: "Plan is complete on a local branch; remote PR was not opened.",
    });
    const merger = new StubPlanMerger({
      local: {
        action: "merged_local",
        planPath,
        sourceBranch: "codex/demo",
        targetBranch: "release",
        summary: "Merged.",
      },
    });

    const result = await new RunAllRunner(state, implementer, pullRequests, merger).runAll({
      planPath,
      merge: true,
      targetBranch: "release",
    });

    assert.equal(result.action, "merged_local");
    assert.equal(pullRequests.calls.length, 0);
    assert.equal(merger.calls.length, 1);
    assert.equal(merger.calls[0].mode, "local");
    assert.equal(merger.calls[0].options.planPath, planPath);
    assert.equal(merger.calls[0].options.targetBranch, "release");
  });
});

test("runAll forwards remote branch mode to merge when --merge is requested", async () => {
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
    const merger = new StubPlanMerger({
      remote: {
        action: "merged_remote",
        planPath,
        sourceBranch: "codex/demo",
        targetBranch: "main",
        prUrl: "https://github.com/example/repo/pull/7",
        summary: "Merged.",
        lockCleared: true,
      },
    });

    const result = await new RunAllRunner(state, implementer, pullRequests, merger).runAll({
      planPath,
      branchMode: "remote",
      merge: true,
    });

    assert.equal(result.action, "merged_remote");
    assert.equal(pullRequests.calls.length, 0);
    assert.equal(merger.calls.length, 1);
    assert.equal(merger.calls[0].mode, "remote");
    assert.equal(merger.calls[0].options.planPath, planPath);
  });
});

test("runAll propagates merge failure after completed units", async () => {
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
      action: "local_branch",
      planPath,
      branchName: "codex/demo",
      reason: "Plan is complete on a local branch; remote PR was not opened.",
    });
    const merger = new StubPlanMerger({
      local: {
        action: "needs_work",
        planPath,
        sourceBranch: "codex/demo",
        targetBranch: "main",
        reason: "Working tree is not clean: src/cli.ts.",
      },
    });

    const result = await new RunAllRunner(state, implementer, pullRequests, merger).runAll({
      planPath,
      merge: true,
    });

    assert.equal(result.action, "merge_needs_work");
    assert.equal(result.merge.reason, "Working tree is not clean: src/cli.ts.");
    assert.equal(pullRequests.calls.length, 0);
    assert.equal(merger.calls.length, 1);
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
    const merger = new StubPlanMerger({
      local: {
        action: "merged_local",
        planPath,
        sourceBranch: "codex/demo",
        targetBranch: "main",
        summary: "Merged.",
      },
    });

    const result = await new RunAllRunner(state, implementer, pullRequests, merger).runAll({
      planPath,
      merge: true,
    });

    assert.equal(result.action, "needs_work");
    assert.equal(implementer.calls.length, 2);
    assert.equal(pullRequests.calls.length, 0);
    assert.equal(merger.calls.length, 0);
  });
});

test("runAll continues when a commit unit produces no git changes", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const planPath = path.join(root, ".crack", "plans", "demo", "plan.md");
    const implementer = new StubNextUnitRunner([
      {
        action: "skipped",
        planPath,
        unitNumber: 1,
        message: "No new git changes were produced.",
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
      action: "local_branch",
      planPath,
      branchName: "codex/demo",
      reason: "Plan is complete on a local branch; remote PR was not opened.",
    });

    const result = await new RunAllRunner(state, implementer, pullRequests).runAll({
      planPath,
    });

    assert.equal(result.action, "local_branch");
    assert.equal(implementer.calls.length, 3);
    assert.equal(pullRequests.calls.length, 1);
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

class StubPlanMerger implements ReadyPlanMerger {
  readonly calls: Array<{
    mode: "local" | "remote";
    options: LocalMergeOptions | RemoteMergeOptions;
  }> = [];

  constructor(private readonly results: { local?: LocalMergeResult; remote?: RemoteMergeResult }) {}

  async mergeLocal(options: LocalMergeOptions = {}): Promise<LocalMergeResult> {
    this.calls.push({ mode: "local", options });

    if (!this.results.local) {
      throw new Error("Unexpected mergeLocal call");
    }

    return this.results.local;
  }

  async mergeRemote(options: RemoteMergeOptions = {}): Promise<RemoteMergeResult> {
    this.calls.push({ mode: "remote", options });

    if (!this.results.remote) {
      throw new Error("Unexpected mergeRemote call");
    }

    return this.results.remote;
  }
}
