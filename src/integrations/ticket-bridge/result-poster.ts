import { spawnSync } from "child_process";
import { githubClient } from "../github/github-client";
import { jiraClient } from "../jira/jira-client";
import type { TicketSource, TicketSourceType } from "./ticket-bridge";
import type { AgentType } from "./branch-runner";

export interface PostResultsOptions {
  source: TicketSource;
  branchName: string | null;
  agent: AgentType | null;
  agentExitCode: number | null;
  workspace: string;
  runDurationMs?: number;
  sessionUrl?: string;
  dryRun?: boolean;
}

export interface PostedResult {
  commentPosted: boolean;
  comment: string;
  filesChanged: string[];
  commitMessages: string[];
}

interface GitSummary {
  filesChanged: string[];
  commitMessages: string[];
}

interface SourceAdapter {
  readonly type: TicketSourceType;
  post(id: string, body: string): Promise<void>;
}

class GitHubAdapter implements SourceAdapter {
  readonly type: TicketSourceType = "github";

  async post(id: string, body: string): Promise<void> {
    const match = id.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (!match) return;
    await githubClient.addIssueComment(Number(match[3]), body, match[1], match[2]);
  }
}

class JiraAdapter implements SourceAdapter {
  readonly type: TicketSourceType = "jira";

  async post(id: string, body: string): Promise<void> {
    await jiraClient.addComment(id, body);
  }
}

class RoadmapAdapter implements SourceAdapter {
  readonly type: TicketSourceType = "roadmap";

  async post(_id: string, _body: string): Promise<void> {
    // Roadmap items have no external comment system
  }
}

const ADAPTERS: ReadonlyMap<TicketSourceType, SourceAdapter> = new Map([
  ["github", new GitHubAdapter()],
  ["jira", new JiraAdapter()],
  ["roadmap", new RoadmapAdapter()],
]);

class ResultPoster {
  async post(options: PostResultsOptions): Promise<PostedResult> {
    const gitSummary = this.gatherGitSummary(options.workspace);
    const comment = this.buildComment({ ...options, gitSummary });

    if (options.dryRun) {
      return {
        commentPosted: false,
        comment,
        filesChanged: gitSummary.filesChanged,
        commitMessages: gitSummary.commitMessages,
      };
    }

    let commentPosted = false;
    try {
      const adapter = ADAPTERS.get(options.source.type);
      if (adapter) {
        await adapter.post(options.source.id, comment);
        commentPosted = true;
      }
    } catch {
      // comment posting failure is non-fatal
    }

    return {
      commentPosted,
      comment,
      filesChanged: gitSummary.filesChanged,
      commitMessages: gitSummary.commitMessages,
    };
  }

  private gatherGitSummary(workDir: string): GitSummary {
    const baseSha = this.runGit(["merge-base", "origin/HEAD", "HEAD"], workDir);

    let filesChanged: string[] = [];
    let commitMessages: string[] = [];

    if (baseSha) {
      filesChanged = this.runGit(["diff", "--name-only", baseSha, "HEAD"], workDir)
        .split("\n")
        .filter(Boolean);
      commitMessages = this.runGit(["log", "--oneline", `${baseSha}..HEAD`], workDir)
        .split("\n")
        .filter(Boolean);
    } else {
      filesChanged = this.runGit(["diff", "--name-only", "HEAD~1..HEAD"], workDir)
        .split("\n")
        .filter(Boolean);
      commitMessages = this.runGit(["log", "--oneline", "-5"], workDir)
        .split("\n")
        .filter(Boolean);
    }

    if (filesChanged.length === 0) {
      const staged = this.runGit(["diff", "--name-only", "--cached"], workDir)
        .split("\n")
        .filter(Boolean);
      filesChanged = staged;
    }

    if (filesChanged.length === 0) {
      const unstaged = this.runGit(["diff", "--name-only"], workDir)
        .split("\n")
        .filter(Boolean);
      filesChanged = unstaged;
    }

    return { filesChanged, commitMessages };
  }

  private runGit(args: string[], cwd: string): string {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return result.status === 0 ? (result.stdout || "").trim() : "";
  }

  private buildComment(
    input: PostResultsOptions & { gitSummary: GitSummary },
  ): string {
    const {
      branchName,
      agent,
      agentExitCode,
      gitSummary,
      runDurationMs,
      sessionUrl,
    } = input;
    const { filesChanged, commitMessages } = gitSummary;

    const succeeded = agentExitCode === 0;
    const statusIcon = agentExitCode === null ? "⬜" : succeeded ? "✅" : "❌";
    const statusText =
      agentExitCode === null
        ? "Agent not run"
        : succeeded
          ? "Agent exited cleanly"
          : `Agent exited with code ${agentExitCode}`;

    const lines: string[] = ["🤖 **Agent Run Complete**", ""];

    const tableRows: [string, string][] = [];
    if (branchName) tableRows.push(["Branch", `\`${branchName}\``]);
    if (agent) tableRows.push(["Agent", `\`${agent}\``]);
    if (runDurationMs != null) tableRows.push(["Duration", this.formatDuration(runDurationMs)]);
    if (sessionUrl) tableRows.push(["Session", `[View logs](${sessionUrl})`]);
    tableRows.push(["Status", `${statusIcon} ${statusText}`]);

    lines.push("| | |");
    lines.push("|---|---|");
    for (const [k, v] of tableRows) {
      lines.push(`| **${k}** | ${v} |`);
    }
    lines.push("");

    lines.push("## Files Changed");
    if (filesChanged.length > 0) {
      lines.push(...filesChanged.map((f) => `- \`${f}\``));
    } else {
      lines.push("- No file changes detected (check branch for uncommitted changes)");
    }
    lines.push("");

    lines.push("## Summary");
    if (commitMessages.length > 0) {
      lines.push(...commitMessages.map((c) => `- ${c}`));
    } else {
      lines.push("- No commits on this branch yet");
    }
    lines.push("");

    lines.push("## Test Status");
    if (agentExitCode === 0) {
      lines.push(
        "✅ Agent exited cleanly. Per AGENTS.md, the agent should have run `npm run build` and `npm test` before finishing.",
      );
    } else if (agentExitCode !== null) {
      lines.push(
        `❌ Agent exited with code ${agentExitCode}. Check branch for partial changes and run tests manually.`,
      );
    } else {
      lines.push("⬜ Agent was not run. Test status unknown.");
    }
    lines.push("");

    lines.push("## Next Steps");
    if (succeeded || agentExitCode === null) {
      if (branchName) {
        lines.push(`- Review changes on branch \`${branchName}\``);
      }
      lines.push("- Run tests locally: `npm test`");
      lines.push("- Create a pull request when ready");
    } else {
      lines.push("- Check agent output for error details");
      if (branchName) {
        lines.push(
          `- Inspect \`${branchName}\` for partial changes — some edits may be useful`,
        );
      }
      lines.push("- Fix issues manually or re-run the agent");
    }
    lines.push("");

    lines.push(
      "> No changes have been pushed. Review locally before creating a PR.",
    );

    return lines.join("\n");
  }

  private formatDuration(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
}

export const resultPoster = new ResultPoster();
