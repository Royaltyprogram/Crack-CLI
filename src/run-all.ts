import type { RunNextOptions, RunNextResult } from "./implementer";
import { ImplementerRunner } from "./implementer";
import { MergeRunner } from "./merge";
import type {
  LocalMergeOptions,
  LocalMergeResult,
  RemoteMergeOptions,
  RemoteMergeResult,
} from "./merge";
import type { OpenPullRequestOptions, OpenPullRequestResult } from "./pr";
import { PullRequestRunner } from "./pr";
import type { MarkdownState } from "./state";

export type RunAllOptions = {
  planPath?: string;
  receivedAt?: string;
  branchMode?: OpenPullRequestOptions["branchMode"];
  merge?: boolean;
  targetBranch?: string;
};

export type RunAllResult =
  | {
      action: "opened";
      steps: RunNextResult[];
      pullRequest: Extract<OpenPullRequestResult, { action: "opened" }>;
    }
  | {
      action: "needs_work";
      steps: RunNextResult[];
    }
  | {
      action: "pr_not_ready";
      steps: RunNextResult[];
      pullRequest: Extract<OpenPullRequestResult, { action: "not_ready" }>;
    }
  | {
      action: "local_branch";
      steps: RunNextResult[];
      pullRequest: Extract<OpenPullRequestResult, { action: "local_branch" }>;
    }
  | {
      action: "pr_locked";
      steps: RunNextResult[];
      pullRequest: Extract<OpenPullRequestResult, { action: "locked" }>;
    }
  | {
      action: "merged_local";
      steps: RunNextResult[];
      merge: Extract<LocalMergeResult, { action: "merged_local" }>;
    }
  | {
      action: "merged_remote";
      steps: RunNextResult[];
      merge: Extract<RemoteMergeResult, { action: "merged_remote" }>;
    }
  | {
      action: "merge_needs_work";
      steps: RunNextResult[];
      merge: Extract<LocalMergeResult | RemoteMergeResult, { action: "needs_work" }>;
    };

export interface NextUnitRunner {
  runNext(options?: RunNextOptions): Promise<RunNextResult>;
}

export interface ReadyPullRequestOpener {
  openWhenReady(options?: OpenPullRequestOptions): Promise<OpenPullRequestResult>;
}

export interface ReadyPlanMerger {
  mergeLocal(options?: LocalMergeOptions): Promise<LocalMergeResult>;
  mergeRemote(options?: RemoteMergeOptions): Promise<RemoteMergeResult>;
}

type MergePlanOptions = {
  planPath: string;
  steps: RunNextResult[];
  receivedAt?: string;
  branchMode?: RunAllOptions["branchMode"];
  targetBranch?: string;
};

export class RunAllRunner {
  private readonly implementer: NextUnitRunner;
  private readonly pullRequests: ReadyPullRequestOpener;
  private readonly merger: ReadyPlanMerger;

  constructor(
    state: MarkdownState,
    implementer: NextUnitRunner = new ImplementerRunner(state),
    pullRequests: ReadyPullRequestOpener = new PullRequestRunner(state),
    merger: ReadyPlanMerger = new MergeRunner(state),
  ) {
    this.implementer = implementer;
    this.pullRequests = pullRequests;
    this.merger = merger;
  }

  async runAll(options: RunAllOptions = {}): Promise<RunAllResult> {
    const steps: RunNextResult[] = [];
    let planPath = options.planPath;

    while (true) {
      const result = await this.implementer.runNext({
        planPath,
        receivedAt: options.receivedAt,
      });
      steps.push(result);
      planPath = result.planPath;

      if (result.action === "committed" || result.action === "skipped") {
        continue;
      }

      if (result.action === "needs_work") {
        return { action: "needs_work", steps };
      }

      if (options.merge) {
        return this.mergePlan({
          planPath: result.planPath,
          receivedAt: options.receivedAt,
          branchMode: options.branchMode,
          targetBranch: options.targetBranch,
          steps,
        });
      }

      const pullRequest = await this.pullRequests.openWhenReady({
        planPath: result.planPath,
        receivedAt: options.receivedAt,
        branchMode: options.branchMode,
      });

      if (pullRequest.action === "opened") {
        return { action: "opened", steps, pullRequest };
      }

      if (pullRequest.action === "locked") {
        return { action: "pr_locked", steps, pullRequest };
      }

      if (pullRequest.action === "local_branch") {
        return { action: "local_branch", steps, pullRequest };
      }

      return { action: "pr_not_ready", steps, pullRequest };
    }
  }

  private async mergePlan(options: MergePlanOptions): Promise<RunAllResult> {
    const mergeOptions = {
      planPath: options.planPath,
      receivedAt: options.receivedAt,
      targetBranch: options.targetBranch,
    };
    const result = options.branchMode === "remote"
      ? await this.merger.mergeRemote(mergeOptions)
      : await this.merger.mergeLocal(mergeOptions);

    if (result.action === "merged_local") {
      return { action: "merged_local", steps: options.steps, merge: result };
    }

    if (result.action === "merged_remote") {
      return { action: "merged_remote", steps: options.steps, merge: result };
    }

    return { action: "merge_needs_work", steps: options.steps, merge: result };
  }
}
