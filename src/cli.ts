#!/usr/bin/env node

import { Router } from "./router";
import { ImplementerRunner } from "./implementer";
import type { RunNextResult } from "./implementer";
import { InboxDrainer } from "./inbox";
import type { DrainInboxResult } from "./inbox";
import { PrCheckRunner } from "./pr-check";
import type { PrCheckResult } from "./pr-check";
import { PullRequestRunner } from "./pr";
import type { BranchPublicationMode, OpenPullRequestResult } from "./pr";
import { MergeRunner } from "./merge";
import type { LocalMergeResult, RemoteMergeResult } from "./merge";
import { findRepoRoot, MarkdownState } from "./state";
import { RunAllRunner } from "./run-all";
import type { RunAllResult } from "./run-all";
import {
  parseDashboardWatchInterval,
  readDashboardSnapshot,
  renderDashboard,
  watchDashboard,
} from "./dashboard";

type CommandResult = {
  status: number;
  message?: string;
};

type ParsedArgs = {
  command?: string;
  values: string[];
  flags: Map<string, string | boolean>;
};

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const result = await run(argv);
    if (result.message) {
      console.log(result.message);
    }

    return result.status;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function run(argv: string[]): Promise<CommandResult> {
  const args = parseArgs(argv);

  if (!args.command || args.flags.has("help") || args.flags.has("h")) {
    return { status: 0, message: helpText() };
  }

  const root = stringFlag(args, "root") ?? findRepoRoot();
  const state = new MarkdownState(root);

  if (args.command === "init") {
    await state.initialize();
    return { status: 0, message: `initialized ${state.crackDir}` };
  }

  if (args.command === "route" || args.command === "submit") {
    const prompt = args.values.join(" ").trim();
    if (!prompt) {
      throw new Error(`${args.command} requires a prompt`);
    }

    const decision = await new Router(state).route(prompt, {
      planPath: stringFlag(args, "plan"),
      branchName: stringFlag(args, "branch"),
      planTitle: stringFlag(args, "title"),
      reason: stringFlag(args, "reason"),
    });

    return { status: 0, message: `${decision.action}: ${decision.target}` };
  }

  if (args.command === "set-pr-lock") {
    const branchName = requiredStringFlag(args, "branch");
    const prUrl = requiredStringFlag(args, "pr-url");
    const reason = requiredStringFlag(args, "reason");
    const status = stringFlag(args, "status");
    const target = await state.setPrLock({ branchName, prUrl, reason, status });

    return { status: 0, message: `set_pr_lock: ${target}` };
  }

  if (args.command === "clear-pr-lock") {
    const removed = await state.clearPrLock();
    return { status: 0, message: removed ? "clear_pr_lock: removed" : "clear_pr_lock: no lock" };
  }

  if (args.command === "run-next") {
    const branchMode = parseBranchMode(args);
    const result = await new ImplementerRunner(state).runNext({
      planPath: stringFlag(args, "plan"),
    });

    if (result.action === "committed" || result.action === "skipped") {
      const pullRequest = await new PullRequestRunner(state).openWhenReady({
        planPath: result.planPath,
        branchMode,
      });
      const message = formatRunNextResult(result);

      if (pullRequest.action === "not_ready") {
        return { status: 0, message };
      }

      return {
        status: pullRequest.action === "opened" || pullRequest.action === "local_branch" ? 0 : 1,
        message: [message, formatOpenPullRequestResult(pullRequest)].join("\n"),
      };
    }

    if (result.action === "complete") {
      const pullRequest = await new PullRequestRunner(state).openWhenReady({
        planPath: result.planPath,
        branchMode,
      });

      return {
        status: pullRequest.action === "opened" || pullRequest.action === "local_branch" ? 0 : 1,
        message: formatOpenPullRequestResult(pullRequest),
      };
    }

    return { status: result.action === "needs_work" ? 1 : 0, message: formatRunNextResult(result) };
  }

  if (args.command === "run-all") {
    const result = await new RunAllRunner(state).runAll({
      planPath: stringFlag(args, "plan"),
      branchMode: parseBranchMode(args),
      merge: args.flags.has("merge"),
      targetBranch: stringFlag(args, "target"),
    });

    return {
      status: runAllSucceeded(result) ? 0 : 1,
      message: formatRunAllResult(result),
    };
  }

  if (args.command === "merge") {
    const branchMode = parseBranchMode(args);
    const mergeRunner = new MergeRunner(state);
    const options = {
      planPath: stringFlag(args, "plan"),
      targetBranch: stringFlag(args, "target"),
    };
    const result = branchMode === "remote"
      ? await mergeRunner.mergeRemote(options)
      : await mergeRunner.mergeLocal(options);

    return {
      status: result.action === "needs_work" ? 1 : 0,
      message: formatMergeResult(result),
    };
  }

  if (args.command === "dashboard") {
    if (args.flags.has("watch")) {
      await watchDashboard(state, {
        intervalSeconds: parseDashboardWatchInterval(args.flags.get("interval")),
      });
    }

    if (args.flags.has("interval")) {
      throw new Error("--interval can only be used with --watch");
    }

    const snapshot = await readDashboardSnapshot(state);
    return { status: 0, message: renderDashboard(snapshot) };
  }

  if (args.command === "open-pr") {
    const result = await new PullRequestRunner(state).openWhenReady({
      planPath: stringFlag(args, "plan"),
      branchMode: parseBranchMode(args, "remote"),
    });

    return {
      status: result.action === "opened" || result.action === "local_branch" ? 0 : 1,
      message: formatOpenPullRequestResult(result),
    };
  }

  if (args.command === "pr-check") {
    const result = await new PrCheckRunner(state).check();

    return { status: 0, message: formatPrCheckResult(result) };
  }

  if (args.command === "drain") {
    const result = await new InboxDrainer(state).drain();

    return {
      status: result.action === "locked" ? 1 : 0,
      message: formatDrainInboxResult(result),
    };
  }

  throw new Error(`Unknown command: ${args.command}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  const values: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("-")) {
      if (!command) {
        command = token;
        continue;
      }

      values.push(token);
      continue;
    }

    const flag = token.replace(/^-+/, "");
    const next = argv[index + 1];

    if (!next || !isFlagValue(next)) {
      flags.set(flag, true);
      continue;
    }

    flags.set(flag, next);
    index += 1;
  }

  return { command, values, flags };
}

function isFlagValue(value: string): boolean {
  return !value.startsWith("-") || /^-\d/.test(value);
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function requiredStringFlag(args: ParsedArgs, name: string): string {
  const value = stringFlag(args, name);
  if (!value) {
    throw new Error(`--${name} is required`);
  }

  return value;
}

function parseBranchMode(args: ParsedArgs, defaultMode: BranchPublicationMode = "local"): BranchPublicationMode {
  if (args.flags.has("remote")) {
    return "remote";
  }

  const value = stringFlag(args, "branch-mode");
  if (!value) {
    return defaultMode;
  }

  if (value === "local" || value === "remote") {
    return value;
  }

  throw new Error("--branch-mode must be local or remote");
}

function helpText(): string {
  return [
    "Usage: crack <command> [options]",
    "",
    "Commands:",
    "  init",
    "  submit <prompt> [--plan <path>] [--branch <name>] [--title <title>] [--reason <text>]",
    "  route <prompt> [--plan <path>] [--branch <name>] [--title <title>] [--reason <text>]",
    "  run-next [--plan <path>] [--branch-mode local|remote] [--remote]",
    "  run-all [--plan <path>] [--merge] [--target <branch>] [--branch-mode local|remote] [--remote]",
    "  merge [--plan <path>] [--target <branch>] [--branch-mode local|remote] [--remote]",
    "  dashboard [--root <path>] [--watch] [--interval <seconds>]",
    "  open-pr [--plan <path>] [--branch-mode local|remote] [--remote]",
    "  pr-check",
    "  drain",
    "  set-pr-lock --branch <name> --pr-url <url> --reason <text> [--status <status>]",
    "  clear-pr-lock",
    "",
    "Global options:",
    "  --root <path>    Repository root. Defaults to the nearest parent containing .git.",
  ].join("\n");
}

function formatRunNextResult(result: RunNextResult): string {
  if (result.action === "committed") {
    return `committed unit ${result.unitNumber}: ${result.commitHash} ${result.message}`;
  }

  if (result.action === "complete") {
    return `complete: ${result.message}`;
  }

  if (result.action === "skipped") {
    return `skipped unit ${result.unitNumber}: ${result.message}`;
  }

  return `needs_work unit ${result.unitNumber}: ${result.reason}`;
}

function formatRunAllResult(result: RunAllResult): string {
  const messages = result.steps
    .filter((step) => step.action !== "complete")
    .map(formatRunNextResult);

  if ("pullRequest" in result) {
    messages.push(formatOpenPullRequestResult(result.pullRequest));
  }

  if ("merge" in result) {
    messages.push(formatMergeResult(result.merge));
  }

  return messages.join("\n");
}

function runAllSucceeded(result: RunAllResult): boolean {
  return [
    "opened",
    "local_branch",
    "merged_local",
    "merged_remote",
  ].includes(result.action);
}

function formatOpenPullRequestResult(result: OpenPullRequestResult): string {
  if (result.action === "opened") {
    return `opened_pr: ${result.prUrl} (${result.title})`;
  }

  if (result.action === "local_branch") {
    return `local_branch: ${result.branchName}; ${result.reason}`;
  }

  if (result.action === "locked") {
    return `pr_locked: ${result.reason}`;
  }

  return `pr_not_ready: ${result.reason}`;
}

function formatMergeResult(result: LocalMergeResult | RemoteMergeResult): string {
  if (result.action === "merged_local") {
    return `merged_local: ${result.sourceBranch} -> ${result.targetBranch}`;
  }

  if (result.action === "merged_remote") {
    return `merged_remote: ${result.prUrl}`;
  }

  return `merge_needs_work: ${result.reason}`;
}

function formatPrCheckResult(result: PrCheckResult): string {
  if (result.action === "no_lock") {
    return "pr_check: no active PR lock";
  }

  if (result.action === "reviewing") {
    return `pr_check: ${result.prUrl} is ${result.state}; lock kept`;
  }

  return [
    `pr_check: ${result.prUrl} merged; lock cleared`,
    formatDrainInboxResult(result.drain),
  ].join("\n");
}

function formatDrainInboxResult(result: DrainInboxResult): string {
  if (result.action === "empty") {
    return "drain: inbox empty";
  }

  if (result.action === "locked") {
    return `drain: locked with ${result.remaining} request(s) remaining`;
  }

  return `drain: routed ${result.drained} request(s)`;
}

if (require.main === module) {
  void main().then((status) => {
    process.exitCode = status;
  });
}
