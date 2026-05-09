import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ActivePlan } from "./state";

export type RouterAgentInput = {
  repoRoot: string;
  prompt: string;
  prLock: string | null;
  activePlans: ActivePlan[];
};

export type RouterAgentDecision =
  | {
      action: "existing_plan";
      planPath: string;
      reason: string;
    }
  | {
      action: "new_plan";
      branchName?: string;
      planTitle?: string;
      reason: string;
    }
  | {
      action: "pause_for_pr_review";
      reason: string;
    };

export interface RouterAgent {
  decide(input: RouterAgentInput): Promise<RouterAgentDecision>;
}

export type CodexRouterAgentOptions = {
  command?: string;
  extraArgs?: string[];
};

export class CodexRouterAgent implements RouterAgent {
  private readonly command: string;
  private readonly extraArgs: string[];

  constructor(options: CodexRouterAgentOptions = {}) {
    this.command = options.command ?? "codex";
    this.extraArgs = options.extraArgs ?? [];
  }

  async decide(input: RouterAgentInput): Promise<RouterAgentDecision> {
    const prompt = buildRouterPrompt(input);
    const finalMessage = await this.runCodex(prompt, input.repoRoot);

    return parseRouteDecision(finalMessage);
  }

  private async runCodex(prompt: string, repoRoot: string): Promise<string> {
    const tempDir = await mkdtemp(path.join(tmpdir(), "crack-router-"));
    const outputPath = path.join(tempDir, "last-message.txt");

    try {
      const result = await runProcess(
        this.command,
        [
          "exec",
          "--json",
          "--cd",
          repoRoot,
          "--sandbox",
          "read-only",
          "--output-last-message",
          outputPath,
          ...this.extraArgs,
          "-",
        ],
        prompt,
        repoRoot,
      );

      if (result.status !== 0) {
        const details = result.stderr.trim() || result.stdout.trim();
        const suffix = details ? `: ${details}` : "";
        throw new Error(`Codex router failed with exit code ${result.status}${suffix}`);
      }

      const finalMessage = await readFile(outputPath, "utf8").catch(() => "");
      return finalMessage.trim() || result.stdout.trim();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function parseRouteDecision(text: string): RouterAgentDecision {
  const line = routeLine(text);
  const match = line.match(/^ROUTE\s+(\S+)(?:\s+(.*))?$/);

  if (!match) {
    throw new Error(`Invalid router decision: ${text.trim()}`);
  }

  const action = match[1];
  const values = parseKeyValues(match[2] ?? "");
  const reason = values.get("reason") ?? "Router selected this route.";

  if (action === "existing_plan") {
    const planPath = values.get("planPath");
    if (!planPath) {
      throw new Error("Router decision missing planPath for existing_plan route");
    }

    return { action, planPath, reason };
  }

  if (action === "new_plan") {
    return {
      action,
      branchName: values.get("branchName"),
      planTitle: values.get("planTitle"),
      reason,
    };
  }

  if (action === "pause_for_pr_review") {
    return { action, reason };
  }

  throw new Error(`Unknown router action: ${action}`);
}

export function buildRouterPrompt(input: RouterAgentInput): string {
  return [
    "You are Agent 0: Router for the Codex workflow orchestrator.",
    "Decide where the new user request should go. Do not edit files.",
    "",
    "Routing rules:",
    "- If a PR lock is active, pause new planning.",
    "- If the request strongly depends on an active plan, route it to that plan.",
    "- Otherwise create a new plan.",
    "",
    "Return exactly one line in one of these forms:",
    'ROUTE existing_plan planPath=".crack/plans/<name>/plan.md" reason="..."',
    'ROUTE new_plan branchName="codex/<name>" planTitle="..." reason="..."',
    'ROUTE pause_for_pr_review reason="..."',
    "",
    "User request:",
    fence(input.prompt),
    "",
    "PR lock:",
    input.prLock?.trim() ? fence(input.prLock) : "None",
    "",
    "Active plans:",
    input.activePlans.length > 0
      ? input.activePlans.map((plan) => formatActivePlan(input.repoRoot, plan)).join("\n\n")
      : "None",
  ].join("\n");
}

function routeLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith("ROUTE "));

  if (!line) {
    throw new Error(`Router decision did not contain a ROUTE line: ${text.trim()}`);
  }

  return line;
}

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const pattern = /([A-Za-z][A-Za-z0-9]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    values.set(match[1], match[2] ?? match[3] ?? match[4] ?? "");
  }

  return values;
}

function formatActivePlan(repoRoot: string, plan: ActivePlan): string {
  return [
    `Path: ${relativePath(repoRoot, plan.plan)}`,
    `Branch: ${plan.branchName}`,
    "",
    "plan.md:",
    fence(plan.planContent),
    "",
    "queue.md:",
    plan.queueContent.trim() ? fence(plan.queueContent) : "None",
  ].join("\n");
}

function fence(value: string): string {
  return ["```text", value.trim(), "```"].join("\n");
}

function relativePath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function runProcess(
  command: string,
  args: string[],
  input: string,
  cwd: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status: status ?? 1, stdout, stderr });
    });

    child.stdin.end(input);
  });
}
