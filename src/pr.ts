import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseCommitUnits } from "./implementer";
import { branchNameFromPlan, checkPlanReady } from "./plan-readiness";
import { runProcess } from "./process";
import { MarkdownState } from "./state";
import type { PlanPaths } from "./state";

export type PullRequestInput = {
  repoRoot: string;
  branchName: string;
  title: string;
  body: string;
};

export type PullRequest = {
  url: string;
  title: string;
};

export interface PullRequestCreator {
  createDraft(input: PullRequestInput): Promise<PullRequest>;
}

export type BranchPublicationMode = "local" | "remote";

export type OpenPullRequestOptions = {
  planPath?: string;
  receivedAt?: string;
  branchMode?: BranchPublicationMode;
};

export type OpenPullRequestResult =
  | {
      action: "opened";
      planPath: string;
      branchName: string;
      prUrl: string;
      title: string;
      lockPath: string;
    }
  | {
      action: "not_ready";
      planPath: string;
      reason: string;
    }
  | {
      action: "local_branch";
      planPath: string;
      branchName: string;
      reason: string;
    }
  | {
      action: "locked";
      planPath?: string;
      lockPath: string;
      reason: string;
    };

type SelectedPlan = {
  paths: PlanPaths;
  planContent: string;
  logContent: string;
};

export class GitHubCliPullRequestCreator implements PullRequestCreator {
  constructor(
    private readonly command = "gh",
    private readonly extraArgs: string[] = [],
  ) {}

  async createDraft(input: PullRequestInput): Promise<PullRequest> {
    await pushBranch(input.repoRoot, input.branchName);

    const result = await runProcess(
      this.command,
      [
        "pr",
        "create",
        "--draft",
        "--head",
        input.branchName,
        "--title",
        input.title,
        "--body",
        input.body,
        ...this.extraArgs,
      ],
      { cwd: input.repoRoot },
    );

    if (result.status !== 0) {
      const details = result.stderr.trim() || result.stdout.trim();
      const suffix = details ? `: ${details}` : "";
      throw new Error(`Failed to create draft PR${suffix}`);
    }

    const output = [result.stdout, result.stderr].join("\n");
    const url = parsePullRequestUrl(output);
    if (!url) {
      throw new Error(`Failed to read PR URL from gh output: ${output.trim()}`);
    }

    return { url, title: input.title };
  }
}

async function pushBranch(repoRoot: string, branchName: string): Promise<void> {
  const result = await runProcess(
    "git",
    ["push", "-u", "origin", branchName],
    { cwd: repoRoot },
  );

  if (result.status !== 0) {
    const details = result.stderr.trim() || result.stdout.trim();
    const suffix = details ? `: ${details}` : "";
    throw new Error(`Failed to push branch ${branchName}${suffix}`);
  }
}

export class PullRequestRunner {
  private readonly state: MarkdownState;
  private readonly creator: PullRequestCreator;

  constructor(
    state: MarkdownState,
    creator: PullRequestCreator = new GitHubCliPullRequestCreator(),
  ) {
    this.state = state;
    this.creator = creator;
  }

  async openWhenReady(options: OpenPullRequestOptions = {}): Promise<OpenPullRequestResult> {
    const branchMode = options.branchMode ?? "local";
    const existingLock = branchMode === "remote" ? await this.state.readPrLock() : null;
    if (existingLock) {
      return {
        action: "locked",
        planPath: options.planPath,
        lockPath: this.state.prLockPath,
        reason: "PR review lock is already active.",
      };
    }

    const selectedPlan = await this.selectPlan(options.planPath);
    const readiness = checkPlanReady(selectedPlan.planContent, selectedPlan.logContent);
    if (!readiness.ready) {
      return {
        action: "not_ready",
        planPath: selectedPlan.paths.plan,
        reason: readiness.reason,
      };
    }

    const branchName = branchNameFromPlan(selectedPlan.planContent);
    if (!branchName) {
      return {
        action: "not_ready",
        planPath: selectedPlan.paths.plan,
        reason: "Plan is missing a Branch line.",
      };
    }

    if (branchMode === "local") {
      const reason = "Plan is complete on a local branch; remote PR was not opened.";
      await this.state.appendPlanLog(
        selectedPlan.paths,
        [reason],
        options.receivedAt,
      );

      return {
        action: "local_branch",
        planPath: selectedPlan.paths.plan,
        branchName,
        reason,
      };
    }

    const title = pullRequestTitle(selectedPlan.planContent, branchName);
    const body = buildPullRequestBody({
      repoRoot: this.state.repoRoot,
      planPath: selectedPlan.paths.plan,
      planContent: selectedPlan.planContent,
      branchName,
    });
    const pullRequest = await this.creator.createDraft({
      repoRoot: this.state.repoRoot,
      branchName,
      title,
      body,
    });
    const lockPath = await this.state.setPrLock({
      branchName,
      prUrl: pullRequest.url,
      status: "reviewing",
      reason: "Draft PR is open for review; new requests should be queued in inbox.md.",
    });

    await this.state.appendPlanLog(
      selectedPlan.paths,
      [
        `Created draft PR ${pullRequest.url}.`,
        `Created PR lock \`${relativePath(this.state.repoRoot, lockPath)}\`.`,
      ],
      options.receivedAt,
    );

    return {
      action: "opened",
      planPath: selectedPlan.paths.plan,
      branchName,
      prUrl: pullRequest.url,
      title: pullRequest.title,
      lockPath,
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

export function parsePullRequestUrl(output: string): string | undefined {
  return output.match(/https:\/\/\S+/)?.[0];
}

async function readSelectedPlan(paths: PlanPaths): Promise<SelectedPlan> {
  if (!existsSync(paths.plan)) {
    throw new Error(`Plan does not exist: ${paths.plan}`);
  }

  const planContent = await readFile(paths.plan, "utf8");
  const logContent = existsSync(paths.log) ? await readFile(paths.log, "utf8") : "";

  return { paths, planContent, logContent };
}

function pullRequestTitle(planContent: string, branchName: string): string {
  const match = planContent.match(/^#\s+Plan:\s*(.+)\s*$/m);
  const title = match?.[1]?.trim();

  return title ? title.slice(0, 120) : branchName;
}

function buildPullRequestBody(options: {
  repoRoot: string;
  planPath: string;
  planContent: string;
  branchName: string;
}): string {
  const units = parseCommitUnits(options.planContent);

  return [
    "## Summary",
    "",
    "Draft PR opened after all planned commit units were completed.",
    "",
    `Plan: \`${relativePath(options.repoRoot, options.planPath)}\``,
    `Branch: \`${options.branchName}\``,
    "",
    "## Completed Commit Units",
    "",
    ...units.map((unit) => `- Commit ${unit.number}: ${unit.title}`),
    "",
  ].join("\n");
}

function relativePath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}
