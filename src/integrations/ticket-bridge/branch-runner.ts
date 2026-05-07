import { spawnSync } from "child_process";
import { githubClient } from "../github/github-client";
import { jiraClient } from "../jira/jira-client";
import { OllamaLauncher } from "../ollama-launcher";
import type { ProviderType } from "../ollama-launcher/types";
import type { TicketSource } from "./ticket-bridge";
import { resultPoster } from "./result-poster";
import { workItemLinker } from "./work-item-linker";

export type AgentType = ProviderType;

export interface BranchRunOptions {
  source: TicketSource;
  prompt: string;
  title: string;
  autoBranch: boolean;
  agent: AgentType | null;
  workspace?: string;
  dryRun?: boolean;
  postComment?: boolean;
  postResults?: boolean;
  createWorkItem?: boolean;
  ticketUrl?: string;
  sessionUrl?: string;
  model?: string;
  ollamaUrl?: string;
  codexApprovalMode?: "suggest" | "auto-edit" | "full-auto";
}

export interface BranchRunResult {
  branchName: string | null;
  branchCreated: boolean;
  previousBranch: string | null;
  agentStarted: boolean;
  agentExitCode: number | null;
  runDurationMs: number | null;
  commentPosted: boolean;
  resultComment: string | null;
  filesChanged: string[];
  commitMessages: string[];
  workItemId: string | null;
  workItemCreated: boolean;
  dryRunPreview?: string[];
}

class BranchRunner {
  private readonly launcher = new OllamaLauncher();

  makeBranchName(source: TicketSource, title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "");

    switch (source.type) {
      case "github": {
        const hashMatch = source.id.match(/#(\d+)$/);
        const num = hashMatch
          ? hashMatch[1]
          : source.id.replace(/[^0-9]/g, "").slice(0, 8) || "0";
        return slug ? `ticket-${num}-${slug}` : `ticket-${num}`;
      }
      case "jira": {
        const key = source.id.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        return slug ? `ticket-${key}-${slug}` : `ticket-${key}`;
      }
      case "roadmap":
        return slug ? `ticket-roadmap-${slug}` : `ticket-roadmap`;
    }
  }

  dryRun(options: BranchRunOptions): string[] {
    const workDir = options.workspace ?? process.cwd();
    const branchName = options.autoBranch
      ? this.makeBranchName(options.source, options.title)
      : null;
    const steps: string[] = [];

    steps.push(`[DRY RUN] Source: ${options.source.type} ${options.source.id}`);
    steps.push(`[DRY RUN] Working directory: ${workDir}`);

    if (options.autoBranch && branchName) {
      steps.push(
        `[DRY RUN] Would create git branch: ${branchName}`,
      );
      steps.push(`[DRY RUN]   git checkout -b ${branchName}`);
    }

    if (options.agent) {
      const tokenEst = Math.ceil(options.prompt.length / 4);
      steps.push(
        `[DRY RUN] Would run ${options.agent} with prompt (~${tokenEst} tokens) in ${workDir}`,
      );
    }

    if (options.postResults) {
      steps.push(
        `[DRY RUN] Would post structured results comment to ${options.source.type} ${options.source.id}`,
      );
    } else if (options.postComment !== false) {
      switch (options.source.type) {
        case "github":
          steps.push(
            `[DRY RUN] Would post comment to GitHub ${options.source.id}`,
          );
          break;
        case "jira":
          steps.push(
            `[DRY RUN] Would post comment to Jira ${options.source.id}`,
          );
          break;
        case "roadmap":
          steps.push(`[DRY RUN] Roadmap source — no external comment posted`);
          break;
      }
    }

    if (options.createWorkItem) {
      steps.push(
        `[DRY RUN] Would create/update Work Item for ${options.source.type} ${options.source.id}`,
      );
    }

    steps.push(`[DRY RUN] Safety: no git push, no merge, no ticket close`);
    return steps;
  }

  async run(options: BranchRunOptions): Promise<BranchRunResult> {
    if (options.dryRun) {
      return {
        branchName: options.autoBranch
          ? this.makeBranchName(options.source, options.title)
          : null,
        branchCreated: false,
        previousBranch: null,
        agentStarted: false,
        agentExitCode: null,
        runDurationMs: null,
        commentPosted: false,
        resultComment: null,
        filesChanged: [],
        commitMessages: [],
        workItemId: null,
        workItemCreated: false,
        dryRunPreview: this.dryRun(options),
      };
    }

    const workDir = options.workspace ?? process.cwd();
    let branchName: string | null = null;
    let branchCreated = false;
    let previousBranch: string | null = null;

    if (options.autoBranch) {
      branchName = this.makeBranchName(options.source, options.title);
      const result = this.createBranch(branchName, workDir);
      if (!result.success) {
        throw new Error(`Failed to create branch: ${result.error}`);
      }
      branchCreated = true;
      previousBranch = result.previousBranch;
    }

    let agentStarted = false;
    let agentExitCode: number | null = null;
    let runDurationMs: number | null = null;

    if (options.agent) {
      agentStarted = true;
      const agentStart = Date.now();
      try {
        const child = await this.launcher.launchStream({
          provider: options.agent,
          prompt: options.prompt,
          cwd: workDir,
          model: options.model,
          ollamaUrl: options.ollamaUrl,
          codexApprovalMode: options.codexApprovalMode,
        });
        agentExitCode = await this.launcher.waitForExit(child);
        runDurationMs = Date.now() - agentStart;
      } catch (err) {
        agentStarted = false;
        throw err;
      }
    }

    let commentPosted = false;
    let resultComment: string | null = null;
    let filesChanged: string[] = [];
    let commitMessages: string[] = [];

    if (options.postResults && options.postComment !== false) {
      const posted = await resultPoster.post({
        source: options.source,
        branchName,
        agent: options.agent,
        agentExitCode,
        workspace: workDir,
        runDurationMs: runDurationMs ?? undefined,
        sessionUrl: options.sessionUrl,
      });
      commentPosted = posted.commentPosted;
      resultComment = posted.comment;
      filesChanged = posted.filesChanged;
      commitMessages = posted.commitMessages;
    } else if (options.postComment !== false && (branchCreated || agentStarted)) {
      try {
        await this.postComment(
          options.source,
          branchName,
          options.agent,
          agentExitCode,
        );
        commentPosted = true;
      } catch {
        // comment posting failure is non-fatal
      }
    }

    let workItemId: string | null = null;
    let workItemCreated = false;

    if (options.createWorkItem) {
      try {
        const linkResult = workItemLinker.createOrUpdateHandoff({
          source: options.source,
          ticketTitle: options.title,
          ticketUrl: options.ticketUrl ?? null,
          branchName,
          agent: options.agent,
        });
        workItemId = linkResult.workItemId;
        workItemCreated = linkResult.created;

        if (agentExitCode !== null) {
          workItemLinker.completeHandoff({
            workItemId: linkResult.workItemId,
            agentExitCode,
            filesChanged,
            commitMessages,
            runDurationMs,
          });
        }
      } catch {
        // work item creation is non-fatal
      }
    }

    return {
      branchName,
      branchCreated,
      previousBranch,
      agentStarted,
      agentExitCode,
      runDurationMs,
      commentPosted,
      resultComment,
      filesChanged,
      commitMessages,
      workItemId,
      workItemCreated,
    };
  }

  private createBranch(
    branchName: string,
    workDir: string,
  ): { success: boolean; previousBranch: string; error?: string } {
    const headResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workDir,
      stdio: "pipe",
      encoding: "utf-8",
    });

    const previousBranch = (headResult.stdout || "").trim() || "unknown";

    const checkout = spawnSync("git", ["checkout", "-b", branchName], {
      cwd: workDir,
      stdio: "pipe",
      encoding: "utf-8",
    });

    if (checkout.status !== 0) {
      const stderr = (checkout.stderr || "").trim();
      return { success: false, previousBranch, error: stderr || "git checkout failed" };
    }

    return { success: true, previousBranch };
  }

  private async postComment(
    source: TicketSource,
    branchName: string | null,
    agent: AgentType | null,
    exitCode: number | null,
  ): Promise<void> {
    const body = this.buildCommentBody(branchName, agent, exitCode);

    switch (source.type) {
      case "github": {
        const match = source.id.match(/^([^/]+)\/([^#]+)#(\d+)$/);
        if (match) {
          await githubClient.addIssueComment(
            Number(match[3]),
            body,
            match[1],
            match[2],
          );
        }
        break;
      }
      case "jira":
        await jiraClient.addComment(source.id, body);
        break;
      case "roadmap":
        break;
    }
  }

  private buildCommentBody(
    branchName: string | null,
    agent: AgentType | null,
    exitCode: number | null,
  ): string {
    const lines: string[] = ["🤖 **Agent run initiated**", ""];
    if (branchName) {
      lines.push(`- Branch: \`${branchName}\``);
    }
    if (agent) {
      const status =
        exitCode === null
          ? "running"
          : exitCode === 0
            ? "completed (exit 0)"
            : `exited with code ${exitCode}`;
      lines.push(`- Agent: \`${agent}\` — ${status}`);
    }
    lines.push("");
    lines.push(
      "> No changes have been pushed. Review changes locally before merging.",
    );
    return lines.join("\n");
  }
}

export const branchRunner = new BranchRunner();
