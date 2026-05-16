import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { changedPathsSince, dirtyPaths, GitCliBranchManager, GitCliCommitter } from "./git";
import type { BranchManager, Committer } from "./git";
import { CodexImplementerAgent } from "./implementer-agent";
import type { ImplementerAgent } from "./implementer-agent";
import { MarkdownState } from "./state";
import type { PlanPaths } from "./state";

export type CommitUnit = {
  number: number;
  title: string;
  content: string;
};

export type RunNextOptions = {
  planPath?: string;
  receivedAt?: string;
};

export type RunNextResult =
  | {
      action: "complete";
      planPath: string;
      message: string;
    }
  | {
      action: "needs_work";
      planPath: string;
      unitNumber: number;
      reason: string;
    }
  | {
      action: "skipped";
      planPath: string;
      unitNumber: number;
      message: string;
    }
  | {
      action: "committed";
      planPath: string;
      unitNumber: number;
      commitHash: string;
      message: string;
    };

type SelectedPlan = {
  paths: PlanPaths;
  planContent: string;
  logContent: string;
};

export class ImplementerRunner {
  private readonly state: MarkdownState;
  private readonly agent: ImplementerAgent;
  private readonly committer: Committer;
  private readonly branchManager: BranchManager;

  constructor(
    state: MarkdownState,
    agent: ImplementerAgent = new CodexImplementerAgent(),
    committer?: Committer,
    branchManager?: BranchManager,
  ) {
    this.state = state;
    this.agent = agent;
    this.committer = committer ?? new GitCliCommitter(state.repoRoot);
    this.branchManager = branchManager ?? new GitCliBranchManager(state.repoRoot);
  }

  async runNext(options: RunNextOptions = {}): Promise<RunNextResult> {
    const selectedPlan = await this.selectPlan(options.planPath);
    const unit = selectNextCommitUnit(selectedPlan.planContent, selectedPlan.logContent);

    if (!unit) {
      return {
        action: "complete",
        planPath: selectedPlan.paths.plan,
        message: "No remaining commit units.",
      };
    }

    const branchName = branchNameFromPlan(selectedPlan.planContent);
    if (!branchName) {
      throw new Error("Plan is missing a Branch line.");
    }

    const initialStatus = await this.committer.status();
    const preExistingPaths = dirtyPaths(initialStatus);
    const blockingPaths = dirtyPathsExceptActivePlanLog(
      preExistingPaths,
      this.state.repoRoot,
      selectedPlan.paths.log,
    );
    if (blockingPaths.length > 0) {
      throw new Error(`Working tree must be clean before run-next: ${blockingPaths.join(", ")}`);
    }

    await this.branchManager.prepareBranch(branchName);

    await this.state.appendPlanLog(
      selectedPlan.paths,
      [`Started commit unit ${unit.number}: ${unit.title}.`],
      options.receivedAt,
    );

    const beforeStatus = await this.committer.status();
    const previousCommit = await this.committer.headSummary();
    const implementation = await this.agent.implement({
      repoRoot: this.state.repoRoot,
      planPath: selectedPlan.paths.plan,
      planContent: selectedPlan.planContent,
      unitNumber: unit.number,
      unitTitle: unit.title,
      unitContent: unit.content,
      previousCommit,
      gitStatus: beforeStatus.raw,
    });

    if (implementation.review.status === "needs_work") {
      await this.state.appendPlanLog(
        selectedPlan.paths,
        [
          `Codex session: ${implementation.sessionId}.`,
          `Commit unit ${unit.number} needs more work: ${implementation.review.reason}`,
        ],
        options.receivedAt,
      );

      return {
        action: "needs_work",
        planPath: selectedPlan.paths.plan,
        unitNumber: unit.number,
        reason: implementation.review.reason,
      };
    }

    const afterStatus = await this.committer.status();
    const pathsToCommit = changedPathsSince(beforeStatus, afterStatus);

    if (pathsToCommit.length === 0) {
      const message = "No new git changes were produced.";
      await this.state.appendPlanLog(
        selectedPlan.paths,
        [
          `Codex session: ${implementation.sessionId}.`,
          `Review summary: ${implementation.review.summary}`,
          `Skipped commit unit ${unit.number}: ${message}`,
          `Completed commit unit ${unit.number}.`,
        ],
        options.receivedAt,
      );

      return {
        action: "skipped",
        planPath: selectedPlan.paths.plan,
        unitNumber: unit.number,
        message,
      };
    }

    const commitMessage = normalizeCommitMessage(implementation.review.title || unit.title, unit.number);
    const commitHash = await this.committer.commit(pathsToCommit, commitMessage);

    await this.state.appendPlanLog(
      selectedPlan.paths,
      [
        `Codex session: ${implementation.sessionId}.`,
        `Review summary: ${implementation.review.summary}`,
        `Committed ${commitHash} with message "${commitMessage}".`,
        `Completed commit unit ${unit.number}.`,
      ],
      options.receivedAt,
    );

    return {
      action: "committed",
      planPath: selectedPlan.paths.plan,
      unitNumber: unit.number,
      commitHash,
      message: commitMessage,
    };
  }

  private async selectPlan(planPath?: string): Promise<SelectedPlan> {
    await this.state.initialize();

    if (planPath) {
      const paths = this.state.existingPlanPaths(planPath);
      return readSelectedPlan(paths);
    }

    const activePlans = await this.state.listActivePlans();
    if (activePlans.length === 0) {
      throw new Error("No active plans found");
    }

    if (activePlans.length > 1) {
      throw new Error("Multiple active plans found; pass --plan <path>");
    }

    return readSelectedPlan(activePlans[0]);
  }
}

export function parseCommitUnits(planContent: string): CommitUnit[] {
  const lines = planContent.split(/\r?\n/);
  const starts: Array<{ index: number; number: number; title: string }> = [];

  lines.forEach((line, index) => {
    const match = line.match(/^###\s+Commit\s+(\d+)\s*:?\s*(.*?)\s*$/i);
    if (!match) {
      return;
    }

    starts.push({
      index,
      number: Number.parseInt(match[1], 10),
      title: match[2]?.trim() || `Commit unit ${match[1]}`,
    });
  });

  return starts.map((start, index) => {
    const nextStart = starts[index + 1]?.index ?? lines.length;
    return {
      number: start.number,
      title: start.title,
      content: lines.slice(start.index, nextStart).join("\n").trim(),
    };
  });
}

export function completedCommitUnitNumbers(logContent: string): Set<number> {
  const completed = new Set<number>();

  for (const match of logContent.matchAll(/Completed commit unit\s+(\d+)\b/gi)) {
    completed.add(Number.parseInt(match[1], 10));
  }

  return completed;
}

export function selectNextCommitUnit(planContent: string, logContent: string): CommitUnit | undefined {
  const completed = completedCommitUnitNumbers(logContent);
  return parseCommitUnits(planContent).find((unit) => !completed.has(unit.number));
}

function branchNameFromPlan(content: string): string | undefined {
  return content.match(/^Branch:\s*(.+)\s*$/m)?.[1]?.trim() || undefined;
}

async function readSelectedPlan(paths: PlanPaths): Promise<SelectedPlan> {
  if (!existsSync(paths.plan)) {
    throw new Error(`Plan does not exist: ${paths.plan}`);
  }

  const planContent = await readFile(paths.plan, "utf8");
  const logContent = existsSync(paths.log) ? await readFile(paths.log, "utf8") : "";

  return { paths, planContent, logContent };
}

function normalizeCommitMessage(title: string, unitNumber: number): string {
  const firstLine = title.trim().split(/\r?\n/)[0]?.trim();
  return (firstLine || `Commit unit ${unitNumber}`).slice(0, 120);
}

function dirtyPathsExceptActivePlanLog(
  dirtyPathList: string[],
  repoRoot: string,
  logPath: string,
): string[] {
  const activePlanLogPath = path.relative(repoRoot, logPath).split(path.sep).join("/");

  return dirtyPathList.filter((dirtyPath) => dirtyPath !== activePlanLogPath);
}
