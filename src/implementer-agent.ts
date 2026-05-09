import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProcess } from "./process";

export type ImplementerAgentInput = {
  repoRoot: string;
  planPath: string;
  planContent: string;
  unitNumber: number;
  unitTitle: string;
  unitContent: string;
  previousCommit: string | null;
  gitStatus: string;
};

export type CommitUnitReview =
  | {
      status: "ready";
      title: string;
      summary: string;
    }
  | {
      status: "needs_work";
      reason: string;
    };

export type ImplementerAgentResult = {
  sessionId: string;
  implementationMessage: string;
  reviewMessage: string;
  review: CommitUnitReview;
};

export interface ImplementerAgent {
  implement(input: ImplementerAgentInput): Promise<ImplementerAgentResult>;
}

export type CodexImplementerAgentOptions = {
  command?: string;
  extraArgs?: string[];
};

export class CodexImplementerAgent implements ImplementerAgent {
  private readonly command: string;
  private readonly extraArgs: string[];

  constructor(options: CodexImplementerAgentOptions = {}) {
    this.command = options.command ?? "codex";
    this.extraArgs = options.extraArgs ?? [];
  }

  async implement(input: ImplementerAgentInput): Promise<ImplementerAgentResult> {
    const implementation = await this.runCodex(
      [
        "exec",
        "--json",
        "--cd",
        input.repoRoot,
        "--sandbox",
        "workspace-write",
        "--output-last-message",
      ],
      buildImplementationPrompt(input),
      input.repoRoot,
    );
    const sessionId = parseSessionId(implementation.stdout);

    if (!sessionId) {
      throw new Error("Codex implementer did not report a session id");
    }

    const review = await this.runCodex(
      [
        "exec",
        "resume",
        "--json",
        "--output-last-message",
      ],
      buildReviewPrompt(input),
      input.repoRoot,
      sessionId,
    );

    return {
      sessionId,
      implementationMessage: implementation.finalMessage,
      reviewMessage: review.finalMessage,
      review: parseCommitUnitReview(review.finalMessage),
    };
  }

  private async runCodex(
    argsBeforeOutputPath: string[],
    prompt: string,
    repoRoot: string,
    sessionId?: string,
  ): Promise<{ stdout: string; finalMessage: string }> {
    const tempDir = await mkdtemp(path.join(tmpdir(), "crack-implementer-"));
    const outputPath = path.join(tempDir, "last-message.txt");

    try {
      const args = [
        ...argsBeforeOutputPath,
        outputPath,
        ...this.extraArgs,
        ...(sessionId ? [sessionId] : []),
        "-",
      ];
      const result = await runProcess(this.command, args, { cwd: repoRoot, input: prompt });

      if (result.status !== 0) {
        const details = result.stderr.trim() || result.stdout.trim();
        const suffix = details ? `: ${details}` : "";
        throw new Error(`Codex implementer failed with exit code ${result.status}${suffix}`);
      }

      const finalMessage = await readFile(outputPath, "utf8").catch(() => "");
      return {
        stdout: result.stdout,
        finalMessage: finalMessage.trim() || result.stdout.trim(),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function buildImplementationPrompt(input: ImplementerAgentInput): string {
  const planPath = relativePath(input.repoRoot, input.planPath);

  return [
    `docs/workflow-design.md와 ${planPath}를 읽고 ${input.unitNumber}번째 커밋 단위까지만 구현해줘.`,
    "",
    "You are Agent 2: Implementer for the Codex workflow orchestrator.",
    "Implement only the selected commit unit. Do not create a git commit.",
    "",
    "Selected commit unit:",
    fence(input.unitContent),
    "",
    "Previous commit:",
    input.previousCommit ?? "None",
    "",
    "Git status before this unit:",
    input.gitStatus.trim() ? fence(input.gitStatus) : "Clean",
    "",
    "Full plan.md:",
    fence(input.planContent),
  ].join("\n");
}

export function buildReviewPrompt(input: ImplementerAgentInput): string {
  return [
    "검토 후 커밋",
    "",
    "Review the implementation for the current commit unit and make focused fixes if needed.",
    "Do not create a git commit; the orchestrator will commit after your review.",
    "",
    "Return exactly one final line in one of these forms:",
    `COMMIT_UNIT_READY title="${input.unitTitle}" summary="..."`,
    'COMMIT_UNIT_NEEDS_WORK reason="..."',
  ].join("\n");
}

export function parseCommitUnitReview(text: string): CommitUnitReview {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith("COMMIT_UNIT_"));

  if (!line) {
    throw new Error(`Implementer response did not contain a commit unit decision: ${text.trim()}`);
  }

  if (line.startsWith("COMMIT_UNIT_READY ")) {
    const values = parseKeyValues(line.slice("COMMIT_UNIT_READY ".length));
    return {
      status: "ready",
      title: values.get("title") ?? "Commit unit ready",
      summary: values.get("summary") ?? "Ready to commit.",
    };
  }

  if (line.startsWith("COMMIT_UNIT_NEEDS_WORK ")) {
    const values = parseKeyValues(line.slice("COMMIT_UNIT_NEEDS_WORK ".length));
    return {
      status: "needs_work",
      reason: values.get("reason") ?? "Implementer requested more work.",
    };
  }

  throw new Error(`Unknown implementer decision: ${line}`);
}

export function parseSessionId(jsonl: string): string | undefined {
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = parseJsonObject(trimmed);
    const sessionId = parsed ? findSessionId(parsed) : undefined;
    if (sessionId) {
      return sessionId;
    }
  }

  return jsonl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
}

function findSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["session_id", "sessionId", "thread_id", "threadId", "conversation_id", "conversationId"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  for (const child of Object.values(record)) {
    if (typeof child === "string") {
      const match = child.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (match) {
        return match[0];
      }
      continue;
    }

    const nested = findSessionId(child);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
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

function fence(value: string): string {
  return ["```text", value.trim(), "```"].join("\n");
}

function relativePath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}
