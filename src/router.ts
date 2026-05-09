import { CodexRouterAgent } from "./router-agent";
import type { RouterAgent, RouterAgentDecision } from "./router-agent";
import { MarkdownState, slugify, titleFromPrompt } from "./state";

export type RouteAction = "pause_for_pr_review" | "route_to_existing_plan" | "create_new_plan";

export type RouteDecision = {
  action: RouteAction;
  target: string;
  reason: string;
};

export type RouteOptions = {
  planPath?: string;
  branchName?: string;
  planTitle?: string;
  reason?: string;
  receivedAt?: string;
};

export class Router {
  constructor(
    private readonly state: MarkdownState,
    private readonly agent: RouterAgent = new CodexRouterAgent(),
  ) {}

  async route(prompt: string, options: RouteOptions = {}): Promise<RouteDecision> {
    await this.state.initialize();

    const prLock = await this.state.readPrLock();
    if (prLock) {
      const reason = options.reason ?? "PR review lock is active, so new requests are paused.";
      const target = await this.state.appendInbox(prompt, reason, options.receivedAt);
      return { action: "pause_for_pr_review", target, reason };
    }

    if (options.planPath) {
      const reason = options.reason ?? "Caller selected an existing active plan.";
      const target = await this.state.appendQueue(options.planPath, prompt, reason, options.receivedAt);
      return { action: "route_to_existing_plan", target, reason };
    }

    if (!options.branchName && !options.planTitle) {
      const activePlans = await this.state.listActivePlans();

      if (activePlans.length > 0) {
        const decision = await this.agent.decide({
          repoRoot: this.state.repoRoot,
          prompt,
          prLock,
          activePlans,
        });

        return this.applyAgentDecision(prompt, decision, options.receivedAt);
      }
    }

    const title = options.planTitle ?? titleFromPrompt(prompt);
    const branchName = options.branchName ?? `codex/${slugify(title).toLowerCase()}`;
    const reason = options.reason ?? "No PR lock or selected active plan; created a new plan.";
    const paths = await this.state.createPlan({
      branchName,
      planTitle: title,
      prompt,
      reason,
      receivedAt: options.receivedAt,
    });

    return { action: "create_new_plan", target: paths.plan, reason };
  }

  private async applyAgentDecision(
    prompt: string,
    decision: RouterAgentDecision,
    receivedAt: string | undefined,
  ): Promise<RouteDecision> {
    if (decision.action === "pause_for_pr_review") {
      const target = await this.state.appendInbox(prompt, decision.reason, receivedAt);
      return { action: "pause_for_pr_review", target, reason: decision.reason };
    }

    if (decision.action === "existing_plan") {
      const target = await this.state.appendQueue(decision.planPath, prompt, decision.reason, receivedAt);
      return { action: "route_to_existing_plan", target, reason: decision.reason };
    }

    const title = decision.planTitle ?? titleFromPrompt(prompt);
    const branchName = decision.branchName ?? `codex/${slugify(title).toLowerCase()}`;
    const paths = await this.state.createPlan({
      branchName,
      planTitle: title,
      prompt,
      reason: decision.reason,
      receivedAt,
    });

    return { action: "create_new_plan", target: paths.plan, reason: decision.reason };
  }
}
