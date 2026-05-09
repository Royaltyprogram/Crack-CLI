import { runProcess } from "./process";

export interface BranchManager {
  prepareBranch(branchName: string): Promise<void>;
}

export type GitStatusEntry = {
  status: string;
  path: string;
  raw: string;
};

export type GitStatusSnapshot = {
  raw: string;
  entries: GitStatusEntry[];
};

export interface Committer {
  status(): Promise<GitStatusSnapshot>;
  headSummary(): Promise<string | null>;
  commit(paths: string[], message: string): Promise<string>;
}

export class GitCliBranchManager implements BranchManager {
  constructor(private readonly repoRoot: string) {}

  async prepareBranch(branchName: string): Promise<void> {
    const trimmedBranchName = branchName.trim();
    if (!trimmedBranchName) {
      throw new Error("branchName is required");
    }

    const existingBranch = await runProcess(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${trimmedBranchName}`],
      { cwd: this.repoRoot },
    );

    if (existingBranch.status === 0) {
      await this.runGit(["switch", trimmedBranchName], `switch to ${trimmedBranchName}`);
      return;
    }

    await this.runGit(["switch", "-c", trimmedBranchName], `create branch ${trimmedBranchName}`);
  }

  private async runGit(args: string[], action: string): Promise<void> {
    const result = await runProcess("git", args, { cwd: this.repoRoot });

    if (result.status !== 0) {
      const details = result.stderr.trim() || result.stdout.trim();
      const suffix = details ? `: ${details}` : "";
      throw new Error(`Failed to ${action}${suffix}`);
    }
  }
}

export class GitCliCommitter implements Committer {
  constructor(private readonly repoRoot: string) {}

  async status(): Promise<GitStatusSnapshot> {
    const result = await runProcess(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: this.repoRoot },
    );

    if (result.status !== 0) {
      const details = result.stderr.trim() || result.stdout.trim();
      const suffix = details ? `: ${details}` : "";
      throw new Error(`Failed to read git status${suffix}`);
    }

    return parseGitStatus(result.stdout);
  }

  async headSummary(): Promise<string | null> {
    const result = await runProcess(
      "git",
      ["log", "-1", "--format=%h %s"],
      { cwd: this.repoRoot },
    );

    if (result.status !== 0) {
      return null;
    }

    return result.stdout.trim() || null;
  }

  async commit(paths: string[], message: string): Promise<string> {
    if (paths.length === 0) {
      throw new Error("No paths to commit");
    }

    await this.runGit(["add", "--", ...paths], "stage implementation changes");
    await this.runGit(["commit", "-m", message], "commit implementation changes");

    const result = await runProcess("git", ["rev-parse", "--short", "HEAD"], { cwd: this.repoRoot });
    if (result.status !== 0) {
      const details = result.stderr.trim() || result.stdout.trim();
      const suffix = details ? `: ${details}` : "";
      throw new Error(`Failed to read commit hash${suffix}`);
    }

    return result.stdout.trim();
  }

  private async runGit(args: string[], action: string): Promise<void> {
    const result = await runProcess("git", args, { cwd: this.repoRoot });

    if (result.status !== 0) {
      const details = result.stderr.trim() || result.stdout.trim();
      const suffix = details ? `: ${details}` : "";
      throw new Error(`Failed to ${action}${suffix}`);
    }
  }
}

export function changedPathsSince(before: GitStatusSnapshot, after: GitStatusSnapshot): string[] {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry.raw]));

  return after.entries
    .filter((entry) => beforeByPath.get(entry.path) !== entry.raw)
    .map((entry) => entry.path);
}

export function stagedPaths(snapshot: GitStatusSnapshot): string[] {
  return snapshot.entries
    .filter((entry) => entry.status[0] !== " " && entry.status[0] !== "?")
    .map((entry) => entry.path);
}

export function parseGitStatus(raw: string): GitStatusSnapshot {
  const entries = raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.length > 3 ? line.slice(3) : "";
      const renameSeparator = rawPath.lastIndexOf(" -> ");
      const path = unquoteStatusPath(renameSeparator >= 0 ? rawPath.slice(renameSeparator + 4) : rawPath);

      return { status, path, raw: line };
    });

  return { raw, entries };
}

function unquoteStatusPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }

  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}
