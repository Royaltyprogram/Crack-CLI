import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { Router } from "../src/router";
import { parseRouteDecision } from "../src/router-agent";
import type { RouterAgent, RouterAgentDecision, RouterAgentInput } from "../src/router-agent";
import { MarkdownState } from "../src/state";

test("route creates a new plan when no lock or plan is selected", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);

    const decision = await new Router(state).route("Add router state files", {
      branchName: "codex/router-state",
      planTitle: "Router State",
      receivedAt: "2026-05-09 12:00",
    });

    const planDir = path.join(root, ".crack", "plans", "codex-router-state");
    assert.equal(decision.action, "create_new_plan");
    assert.equal(decision.target, path.join(planDir, "plan.md"));
    assert.match(await readFile(path.join(planDir, "plan.md"), "utf8"), /Branch: codex\/router-state/);
    assert.match(await readFile(path.join(planDir, "queue.md"), "utf8"), /# Queue/);
  });
});

test("route appends to inbox while PR lock exists", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    await state.setPrLock({
      branchName: "codex/reviewing",
      prUrl: "https://github.com/example/repo/pull/1",
      reason: "PR is reviewing.",
    });

    const decision = await new Router(state).route("Start another feature", {
      receivedAt: "2026-05-09 12:00",
    });

    assert.equal(decision.action, "pause_for_pr_review");
    assert.match(await readFile(path.join(root, ".crack", "inbox.md"), "utf8"), /> Start another feature/);
  });
});

test("route appends to an existing plan queue when selected", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await state.createPlan({
      branchName: "codex/current",
      planTitle: "Current",
      prompt: "Initial request",
      reason: "test setup",
      receivedAt: "2026-05-09 12:00",
    });

    const decision = await new Router(state).route("Add dependent follow-up", {
      planPath: plan.directory,
      reason: "Depends on current plan.",
      receivedAt: "2026-05-09 12:05",
    });

    assert.equal(decision.action, "route_to_existing_plan");
    const queue = await readFile(plan.queue, "utf8");
    assert.match(queue, /> Add dependent follow-up/);
    assert.match(queue, /Depends on current plan\./);
  });
});

test("route asks the router agent when active plans exist", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await state.createPlan({
      branchName: "codex/current",
      planTitle: "Current",
      prompt: "Initial request",
      reason: "test setup",
      receivedAt: "2026-05-09 12:00",
    });
    const agent = new StubRouterAgent({
      action: "existing_plan",
      planPath: plan.plan,
      reason: "Depends on current plan.",
    });

    const decision = await new Router(state, agent).route("Add dependent follow-up", {
      receivedAt: "2026-05-09 12:05",
    });

    assert.equal(decision.action, "route_to_existing_plan");
    assert.equal(agent.inputs.length, 1);
    assert.equal(agent.inputs[0].activePlans.length, 1);
    assert.match(agent.inputs[0].activePlans[0].planContent, /Branch: codex\/current/);
    assert.match(await readFile(plan.queue, "utf8"), /> Add dependent follow-up/);
  });
});

test("route creates a new plan from the router agent decision", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    await state.createPlan({
      branchName: "codex/current",
      planTitle: "Current",
      prompt: "Initial request",
      reason: "test setup",
      receivedAt: "2026-05-09 12:00",
    });
    const agent = new StubRouterAgent({
      action: "new_plan",
      branchName: "codex/separate",
      planTitle: "Separate",
      reason: "Independent work.",
    });

    const decision = await new Router(state, agent).route("Add separate feature", {
      receivedAt: "2026-05-09 12:05",
    });

    const planPath = path.join(root, ".crack", "plans", "codex-separate", "plan.md");
    assert.equal(decision.action, "create_new_plan");
    assert.equal(decision.target, planPath);
    assert.match(await readFile(planPath, "utf8"), /# Plan: Separate/);
  });
});

test("parseRouteDecision reads router final response lines", () => {
  assert.deepEqual(
    parseRouteDecision('ROUTE new_plan branchName="codex/demo" planTitle="Demo" reason="Independent."'),
    {
      action: "new_plan",
      branchName: "codex/demo",
      planTitle: "Demo",
      reason: "Independent.",
    },
  );
  assert.deepEqual(
    parseRouteDecision('notes\nROUTE existing_plan planPath=".crack/plans/demo/plan.md" reason="Depends on it."'),
    {
      action: "existing_plan",
      planPath: ".crack/plans/demo/plan.md",
      reason: "Depends on it.",
    },
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

class StubRouterAgent implements RouterAgent {
  readonly inputs: RouterAgentInput[] = [];

  constructor(private readonly decision: RouterAgentDecision) {}

  async decide(input: RouterAgentInput): Promise<RouterAgentDecision> {
    this.inputs.push(input);
    return this.decision;
  }
}
