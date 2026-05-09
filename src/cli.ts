#!/usr/bin/env node

import { Router } from "./router";
import { ImplementerRunner } from "./implementer";
import type { RunNextResult } from "./implementer";
import { findRepoRoot, MarkdownState } from "./state";

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
    const result = await new ImplementerRunner(state).runNext({
      planPath: stringFlag(args, "plan"),
    });

    return { status: result.action === "needs_work" ? 1 : 0, message: formatRunNextResult(result) };
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

    if (!next || next.startsWith("-")) {
      flags.set(flag, true);
      continue;
    }

    flags.set(flag, next);
    index += 1;
  }

  return { command, values, flags };
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

function helpText(): string {
  return [
    "Usage: crack <command> [options]",
    "",
    "Commands:",
    "  init",
    "  submit <prompt> [--plan <path>] [--branch <name>] [--title <title>] [--reason <text>]",
    "  route <prompt> [--plan <path>] [--branch <name>] [--title <title>] [--reason <text>]",
    "  run-next [--plan <path>]",
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

  return `needs_work unit ${result.unitNumber}: ${result.reason}`;
}

if (require.main === module) {
  void main().then((status) => {
    process.exitCode = status;
  });
}
