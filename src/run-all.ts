import type { RunNextOptions, RunNextResult } from "./implementer";
import { ImplementerRunner } from "./implementer";
import type { OpenPullRequestOptions, OpenPullRequestResult } from "./pr";
import { PullRequestRunner } from "./pr";
import type { MarkdownState } from "./state";

export type RunAllOptions = {
  planPath?: string;
  receivedAt?: string;
  branchMode?: OpenPullRequestOptions["branchMode"];
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
    };

export interface NextUnitRunner {
  runNext(options?: RunNextOptions): Promise<RunNextResult>;
}

export interface ReadyPullRequestOpener {
  openWhenReady(options?: OpenPullRequestOptions): Promise<OpenPullRequestResult>;
}

export class RunAllRunner {
  private readonly implementer: NextUnitRunner;
  private readonly pullRequests: ReadyPullRequestOpener;

  constructor(
    state: MarkdownState,
    implementer: NextUnitRunner = new ImplementerRunner(state),
    pullRequests: ReadyPullRequestOpener = new PullRequestRunner(state),
  ) {
    this.implementer = implementer;
    this.pullRequests = pullRequests;
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

      if (result.action === "committed") {
        continue;
      }

      if (result.action === "needs_work") {
        return { action: "needs_work", steps };
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
}
