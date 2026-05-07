import { readFileSync } from "fs";
import { resolve } from "path";
import { githubClient } from "../integrations/github/github-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { jitbitService } from "../integrations/jitbit/jitbit-service";
import { roadmapDatabase } from "../roadmap/database";
import { workItemDatabase } from "../work-items/database";
import { agentRunDatabase } from "../agent-runs/database";
import type { WorkItem, WorkItemCreateParams } from "../work-items/types";
import type { ProjectAssessmentParams, ProjectAssessmentResult } from "./types";

type SourceStatus = ProjectAssessmentResult["sources"];

interface AssessmentData {
  workItems: WorkItem[];
  roadmaps: Array<{
    id: string;
    name: string;
    status: string;
    endDate?: string;
    milestones?: Array<{
      id: string;
      name: string;
      status: string;
      items?: Array<{ title: string; status: string }>;
    }>;
  }>;
  github: {
    pullRequests: any[];
    commits: any[];
  };
  gitlab: {
    mergeRequests: any[];
    commits: any[];
  };
  jira: any[];
  jitbit: {
    openTickets: any[];
    highPriority: any[];
  };
  agentRunStats: {
    totalRuns: number;
    completedRuns: number;
    failedRuns: number;
    runningRuns: number;
    runsLast24h: number;
    avgToolLoopCount: number;
  } | null;
  packageJson: {
    hasTestScript: boolean;
    hasBuildScript: boolean;
    hasLintScript: boolean;
    scriptCount: number;
    dependencyCount: number;
    devDependencyCount: number;
  } | null;
}

class ProjectAssessor {
  async assessProgress(
    params: ProjectAssessmentParams = {},
  ): Promise<ProjectAssessmentResult> {
    const include = this.resolveIncludes(params);
    const sources: SourceStatus = {};
    const data: AssessmentData = {
      workItems: [],
      roadmaps: [],
      github: { pullRequests: [], commits: [] },
      gitlab: { mergeRequests: [], commits: [] },
      jira: [],
      jitbit: { openTickets: [], highPriority: [] },
      agentRunStats: null,
      packageJson: null,
    };

    if (include.workItems) {
      await this.collect("workItems", sources, async () => {
        const result = workItemDatabase.listWorkItems({
          includeArchived: false,
          limit: 200,
        });
        data.workItems = result.items;
      });
    } else {
      sources.workItems = { enabled: false, available: false };
    }

    if (include.roadmap) {
      await this.collect("roadmap", sources, async () => {
        const roadmaps = roadmapDatabase.listRoadmaps({ status: "active" }).slice(0, 10);
        data.roadmaps = roadmaps.map((roadmap) => ({
          id: roadmap.id,
          name: roadmap.name,
          status: roadmap.status,
          endDate: roadmap.endDate ?? undefined,
          milestones: roadmapDatabase.getMilestones(roadmap.id).map((milestone) => ({
            id: milestone.id,
            name: milestone.name,
            status: milestone.status,
            items: roadmapDatabase.getItems(milestone.id).map((item) => ({
              title: item.title,
              status: item.status,
            })),
          })),
        }));
      });
    } else {
      sources.roadmap = { enabled: false, available: false };
    }

    if (include.gitHub) {
      await this.collect("github", sources, async () => {
        if (!githubClient.isConfigured()) throw new Error("GitHub client not configured");
        const [pullRequests, commits] = await Promise.all([
          githubClient.listPullRequests("open").catch(() => []),
          githubClient.listCommits(undefined, undefined, 20).catch(() => []),
        ]);
        data.github = { pullRequests, commits };
      });
    } else {
      sources.github = { enabled: false, available: false };
    }

    if (include.gitLab) {
      await this.collect("gitlab", sources, async () => {
        if (!gitlabClient.isConfigured()) throw new Error("GitLab client not configured");
        const defaultProject = gitlabClient.getDefaultProject() || undefined;
        const [mergeRequests, commits] = await Promise.all([
          gitlabClient.getMergeRequests(defaultProject, "opened").catch(() => []),
          gitlabClient.getCommits(defaultProject, "main").catch(() => []),
        ]);
        data.gitlab = { mergeRequests, commits };
      });
    } else {
      sources.gitlab = { enabled: false, available: false };
    }

    if (include.jira) {
      await this.collect("jira", sources, async () => {
        if (!jiraClient.isConfigured()) throw new Error("Jira client not configured");
        data.jira = await jiraClient.searchIssues(
          "resolution = Unresolved ORDER BY updated DESC",
          25,
        );
      });
    } else {
      sources.jira = { enabled: false, available: false };
    }

    if (include.jitbit) {
      await this.collect("jitbit", sources, async () => {
        if (!jitbitService.isConfigured()) throw new Error("Jitbit client not configured");
        const [openTickets, highPriority] = await Promise.all([
          jitbitService.getOpenSupportRequests({ limit: 25 }).catch(() => []),
          jitbitService.findHighPriorityOpenTickets(10).catch(() => []),
        ]);
        data.jitbit = { openTickets, highPriority };
      });
    } else {
      sources.jitbit = { enabled: false, available: false };
    }

    if (include.agentRuns) {
      await this.collect("agentRuns", sources, async () => {
        data.agentRunStats = agentRunDatabase.getStats();
      });
    } else {
      sources.agentRuns = { enabled: false, available: false };
    }

    // Always collect package.json info (local, no external dependency)
    await this.collect("packageJson", sources, async () => {
      data.packageJson = this.readPackageJson();
    });

    const stats = this.computeStats(data, sources);
    const suggestedWorkItems = this.buildSuggestedWorkItems(data);
    const markdown = this.renderMarkdown(data, sources, stats, suggestedWorkItems);

    return { markdown, suggestedWorkItems, sources, stats };
  }

  createSuggestedWorkItems(items: WorkItemCreateParams[]): WorkItem[] {
    return items.map((item) =>
      workItemDatabase.createWorkItem({
        ...item,
        status: item.status ?? "proposed",
        source: item.source ?? "chat",
        tags: Array.from(new Set([...(item.tags ?? []), "project-assessment"])),
      }),
    );
  }

  private async collect(
    name: string,
    sources: SourceStatus,
    fn: () => Promise<void> | void,
  ): Promise<void> {
    try {
      await fn();
      sources[name] = { enabled: true, available: true };
    } catch (error) {
      sources[name] = {
        enabled: true,
        available: false,
        error: error instanceof Error ? error.message : "Unavailable",
      };
    }
  }

  private resolveIncludes(params: ProjectAssessmentParams) {
    return {
      gitHub: params.includeGitHub !== false,
      gitLab: params.includeGitLab !== false,
      jira: params.includeJira !== false,
      jitbit: params.includeJitbit !== false,
      roadmap: params.includeRoadmap !== false,
      workItems: params.includeWorkItems !== false,
      agentRuns: params.includeAgentRuns !== false,
    };
  }

  private readPackageJson(): AssessmentData["packageJson"] {
    try {
      const pkgPath = resolve(process.cwd(), "package.json");
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      const scripts = pkg.scripts ?? {};
      const dependencies = pkg.dependencies ?? {};
      const devDependencies = pkg.devDependencies ?? {};
      return {
        hasTestScript: "test" in scripts,
        hasBuildScript: "build" in scripts,
        hasLintScript: "lint" in scripts,
        scriptCount: Object.keys(scripts).length,
        dependencyCount: Object.keys(dependencies).length,
        devDependencyCount: Object.keys(devDependencies).length,
      };
    } catch {
      return null;
    }
  }

  private computeStats(data: AssessmentData, sources: SourceStatus): ProjectAssessmentResult["stats"] {
    const today = new Date().toISOString().slice(0, 10);
    const completedWorkItems = data.workItems.filter((item) => item.status === "done").length;
    const blockedWorkItems = data.workItems.filter((item) => item.status === "blocked").length;
    const overdueWorkItems = data.workItems.filter(
      (item) => item.dueAt && item.dueAt.slice(0, 10) < today && item.status !== "done" && item.status !== "archived",
    ).length;

    const activeRoadmaps = data.roadmaps.length;

    const openJiraTickets = sources.jira?.available ? data.jira.length : 0;
    const openPRs = sources.github?.available ? data.github.pullRequests.length : 0;
    const openMRs = sources.gitlab?.available ? data.gitlab.mergeRequests.length : 0;
    const recentCommits =
      (sources.github?.available ? data.github.commits.length : 0) +
      (sources.gitlab?.available ? data.gitlab.commits.length : 0);

    const totalRuns = data.agentRunStats?.totalRuns ?? 0;
    const completedRuns = data.agentRunStats?.completedRuns ?? 0;
    const agentRunSuccessRate = totalRuns > 0 ? completedRuns / totalRuns : 1;

    return {
      totalWorkItems: data.workItems.length,
      completedWorkItems,
      blockedWorkItems,
      overdueWorkItems,
      activeRoadmaps,
      openJiraTickets,
      openPRs,
      openMRs,
      recentCommits,
      agentRunSuccessRate,
    };
  }

  private renderMarkdown(
    data: AssessmentData,
    sources: SourceStatus,
    stats: ProjectAssessmentResult["stats"],
    suggestedWorkItems: WorkItemCreateParams[],
  ): string {
    const lines = [
      "# Project Assessment",
      "",
      ...this.currentStatus(data, stats),
      "",
      "## What Works",
      ...this.whatWorks(data, stats),
      "",
      "## What Looks Incomplete",
      ...this.whatLooksIncomplete(data, stats),
      "",
      "## Test / Build Health",
      ...this.testBuildHealth(data, stats),
      "",
      "## Architecture Risks",
      ...this.architectureRisks(data, stats),
      "",
      "## Product Gaps",
      ...this.productGaps(data, sources),
      "",
      "## Recommended Next Milestones",
      ...this.recommendedNextMilestones(data, stats),
      "",
      "## Suggested Work Items",
      ...this.renderSuggestedWorkItems(suggestedWorkItems),
      "",
    ];

    const unavailable = Object.entries(sources)
      .filter(([, status]) => status.enabled && !status.available)
      .map(([name, status]) => `${name}: ${status.error || "unavailable"}`);

    if (unavailable.length > 0) {
      lines.push(`Unavailable sources: ${unavailable.join("; ")}.`);
    } else {
      lines.push("All requested sources responded.");
    }

    return lines.join("\n");
  }

  private currentStatus(_data: AssessmentData, stats: ProjectAssessmentResult["stats"]): string[] {
    const completionRate = stats.totalWorkItems > 0
      ? Math.round((stats.completedWorkItems / stats.totalWorkItems) * 100)
      : 0;

    const lines = [
      "## Current Status",
      `- **${stats.totalWorkItems}** work items total, **${stats.completedWorkItems}** completed (${completionRate}% done)`,
      `- **${stats.blockedWorkItems}** blocked, **${stats.overdueWorkItems}** overdue`,
      `- **${stats.activeRoadmaps}** active roadmap(s)`,
      `- **${stats.openPRs}** open GitHub PR(s), **${stats.openMRs}** open GitLab MR(s)`,
      `- **${stats.recentCommits}** recent commit(s) across GitHub and GitLab`,
      `- Agent run success rate: **${Math.round(stats.agentRunSuccessRate * 100)}%**`,
    ];

    if (stats.blockedWorkItems > 0 || stats.overdueWorkItems > 0) {
      lines.push("- Attention: blocked and/or overdue items need review");
    }

    return lines;
  }

  private whatWorks(data: AssessmentData, stats: ProjectAssessmentResult["stats"]): string[] {
    const items: string[] = [];

    if (stats.completedWorkItems > 0) {
      items.push(`- **${stats.completedWorkItems}** work item(s) completed`);
    }
    if (data.packageJson) {
      if (data.packageJson.hasTestScript) items.push("- Test script configured in package.json");
      if (data.packageJson.hasBuildScript) items.push("- Build script configured in package.json");
      if (data.packageJson.hasLintScript) items.push("- Lint script configured in package.json");
    }
    if (stats.agentRunSuccessRate >= 0.8 && stats.totalWorkItems > 0) {
      items.push(`- Agent run success rate is healthy at ${Math.round(stats.agentRunSuccessRate * 100)}%`);
    }
    if (data.roadmaps.length > 0) {
      const completedMilestones = data.roadmaps.flatMap((r) =>
        (r.milestones ?? []).filter((m) => m.status === "done" || m.status === "completed"),
      );
      if (completedMilestones.length > 0) {
        items.push(`- **${completedMilestones.length}** milestone(s) completed`);
      }
    }
    if (stats.recentCommits > 0) {
      items.push(`- **${stats.recentCommits}** recent commit(s) showing active development`);
    }

    return this.listOrFallback(items, "- No completed items or active integrations detected.");
  }

  private whatLooksIncomplete(data: AssessmentData, stats: ProjectAssessmentResult["stats"]): string[] {
    const items: string[] = [];

    if (stats.blockedWorkItems > 0) {
      items.push(`- **${stats.blockedWorkItems}** blocked work item(s)`);
    }
    if (stats.overdueWorkItems > 0) {
      items.push(`- **${stats.overdueWorkItems}** overdue work item(s)`);
    }
    const inProgress = data.workItems.filter(
      (item) => item.status === "active" || item.status === "planned",
    );
    if (inProgress.length > 0) {
      items.push(`- **${inProgress.length}** in-progress/planned work item(s)`);
    }
    const proposed = data.workItems.filter((item) => item.status === "proposed");
    if (proposed.length > 0) {
      items.push(`- **${proposed.length}** proposed work item(s) awaiting triage`);
    }
    if (stats.openJiraTickets > 0) {
      items.push(`- **${stats.openJiraTickets}** open Jira ticket(s)`);
    }
    if (stats.openPRs > 0) {
      items.push(`- **${stats.openPRs}** open GitHub PR(s) needing review`);
    }
    if (stats.openMRs > 0) {
      items.push(`- **${stats.openMRs}** open GitLab MR(s) needing review`);
    }
    if (data.jitbit.highPriority.length > 0) {
      items.push(`- **${data.jitbit.highPriority.length}** high-priority support ticket(s)`);
    }

    return this.listOrFallback(items, "- No obvious incompleteness detected in available sources.");
  }

  private testBuildHealth(data: AssessmentData, stats: ProjectAssessmentResult["stats"]): string[] {
    const items: string[] = [];
    const pkg = data.packageJson;

    if (!pkg) {
      return ["- Could not read package.json to assess build/test health."];
    }

    items.push(`- **${pkg.scriptCount}** scripts configured in package.json`);
    items.push(`- **${pkg.dependencyCount}** production dependencies, **${pkg.devDependencyCount}** dev dependencies`);

    if (pkg.hasTestScript) {
      items.push("- Test script is available (`npm test`)");
    } else {
      items.push("- No test script found in package.json");
    }

    if (pkg.hasBuildScript) {
      items.push("- Build script is available (`npm run build`)");
    } else {
      items.push("- No build script found in package.json");
    }

    if (pkg.hasLintScript) {
      items.push("- Lint script is available (`npm run lint`)");
    } else {
      items.push("- No lint script found in package.json");
    }

    if (stats.agentRunSuccessRate < 0.5 && stats.totalWorkItems > 0) {
      items.push(`- Agent run success rate is low at ${Math.round(stats.agentRunSuccessRate * 100)}% — investigate failures`);
    }

    return items;
  }

  private architectureRisks(data: AssessmentData, stats: ProjectAssessmentResult["stats"]): string[] {
    const items: string[] = [];
    const pkg = data.packageJson;

    if (pkg) {
      const totalDeps = pkg.dependencyCount + pkg.devDependencyCount;
      if (totalDeps > 100) {
        items.push(`- **${totalDeps}** total dependencies — consider auditing for unused or stale packages`);
      } else if (totalDeps > 50) {
        items.push(`- **${totalDeps}** total dependencies — moderate dependency count, periodic audits recommended`);
      }

      if (!pkg.hasTestScript) {
        items.push("- No test script configured — test coverage cannot be verified");
      }
      if (!pkg.hasLintScript) {
        items.push("- No lint script configured — code quality checks may be missing");
      }
    }

    const waiting = data.workItems.filter((item) => item.status === "waiting");
    if (waiting.length > 3) {
      items.push(`- **${waiting.length}** work items in "waiting" status — potential bottleneck`);
    }

    if (stats.openPRs + stats.openMRs > 10) {
      items.push(`- **${stats.openPRs + stats.openMRs}** open PR(s)/MR(s) total — review backlog may be growing`);
    }

    if (stats.agentRunSuccessRate < 0.8 && stats.totalWorkItems > 0) {
      items.push(`- Agent success rate at ${Math.round(stats.agentRunSuccessRate * 100)}% — some automation may be flaky`);
    }

    return this.listOrFallback(items, "- No significant architecture risks detected from available data.");
  }

  private productGaps(data: AssessmentData, sources: SourceStatus): string[] {
    const items: string[] = [];

    if (data.roadmaps.length === 0) {
      if (sources.roadmap?.available) {
        items.push("- No active roadmaps found — product direction may not be documented");
      }
    } else {
      for (const roadmap of data.roadmaps) {
        const allItems = (roadmap.milestones ?? []).flatMap((m) => m.items ?? []);
        const doneItems = allItems.filter((item) => item.status === "done" || item.status === "completed");
        const blockedItems = allItems.filter((item) => item.status === "blocked");
        const notStartedItems = allItems.filter((item) => item.status === "planned" || item.status === "proposed");

        if (allItems.length > 0) {
          const completionPct = Math.round((doneItems.length / allItems.length) * 100);
          items.push(`- **${roadmap.name}**: ${completionPct}% complete (${doneItems.length}/${allItems.length} items done)`);

          if (blockedItems.length > 0) {
            items.push(`  - **${blockedItems.length}** blocked item(s) in ${roadmap.name}`);
          }
          if (notStartedItems.length > 0) {
            items.push(`  - **${notStartedItems.length}** not-yet-started item(s) in ${roadmap.name}`);
          }
        } else {
          items.push(`- **${roadmap.name}**: no milestone items tracked`);
        }
      }
    }

    if (!sources.jira?.available && !sources.jitbit?.available) {
      items.push("- No external issue tracking data available — product gaps may be underrepresented");
    }

    return this.listOrFallback(items, "- No product gaps identified from available data.");
  }

  private recommendedNextMilestones(data: AssessmentData, stats: ProjectAssessmentResult["stats"]): string[] {
    const recommendations: string[] = [];

    // Prioritize blocked items
    if (stats.blockedWorkItems > 0) {
      recommendations.push(`- Unblock **${stats.blockedWorkItems}** blocked work item(s) to restore flow`);
    }

    // Prioritize overdue
    if (stats.overdueWorkItems > 0) {
      recommendations.push(`- Resolve **${stats.overdueWorkItems}** overdue work item(s)`);
    }

    // Review open PRs/MRs
    if (stats.openPRs + stats.openMRs > 0) {
      recommendations.push(`- Review **${stats.openPRs + stats.openMRs}** open PR(s)/MR(s)`);
    }

    // Advance roadmap milestones that are in-progress
    for (const roadmap of data.roadmaps) {
      const inProgressMilestones = (roadmap.milestones ?? []).filter(
        (m) => m.status === "in_progress" || m.status === "active",
      );
      if (inProgressMilestones.length > 0) {
        recommendations.push(`- Advance milestone(s) in **${roadmap.name}**: ${inProgressMilestones.map((m) => m.name).join(", ")}`);
      }
    }

    // High-priority support tickets
    if (data.jitbit.highPriority.length > 0) {
      recommendations.push(`- Address **${data.jitbit.highPriority.length}** high-priority support ticket(s)`);
    }

    // Low agent success rate
    if (stats.agentRunSuccessRate < 0.8 && stats.agentRunSuccessRate > 0) {
      recommendations.push(`- Investigate agent run failures (success rate: ${Math.round(stats.agentRunSuccessRate * 100)}%)`);
    }

    // Triage proposed items
    const proposed = data.workItems.filter((item) => item.status === "proposed");
    if (proposed.length > 0) {
      recommendations.push(`- Triage **${proposed.length}** proposed work item(s)`);
    }

    return this.listOrFallback(recommendations, "- Continue working on current active items.");
  }

  private buildSuggestedWorkItems(data: AssessmentData): WorkItemCreateParams[] {
    const suggestions: WorkItemCreateParams[] = [];
    const today = new Date().toISOString().slice(0, 10);

    // Overdue work items
    for (const item of data.workItems.filter(
      (wi) => wi.dueAt && wi.dueAt.slice(0, 10) < today && wi.status !== "done" && wi.status !== "archived",
    ).slice(0, 5)) {
      suggestions.push({
        type: item.type,
        title: `Resolve overdue: ${item.title}`,
        description: `Work item "${item.title}" was due ${item.dueAt?.slice(0, 10)} and is still ${item.status}.`,
        priority: item.priority === "critical" ? "critical" : "high",
        source: "chat",
        sourceExternalId: item.id,
        dueAt: today,
        tags: ["project-assessment", "overdue"],
      });
    }

    // Blocked work items
    for (const item of data.workItems.filter((wi) => wi.status === "blocked").slice(0, 3)) {
      suggestions.push({
        type: item.type,
        title: `Unblock: ${item.title}`,
        description: `Work item "${item.title}" is blocked and needs attention to restore progress.`,
        priority: "high",
        source: "chat",
        sourceExternalId: item.id,
        dueAt: today,
        tags: ["project-assessment", "blocked"],
      });
    }

    // High-priority support tickets
    for (const ticket of data.jitbit.highPriority.slice(0, 3)) {
      const id = ticket.TicketID || ticket.IssueID || ticket.id || "?";
      const subject = ticket.Subject || ticket.Title || ticket.summary || "(no subject)";
      suggestions.push({
        type: "customer_followup",
        title: `Follow up on high-priority ticket: ${subject}`,
        description: `Support ticket #${id} needs attention.`,
        priority: "high",
        source: "jitbit",
        sourceExternalId: String(id),
        dueAt: today,
        tags: ["project-assessment", "customer"],
      });
    }

    // Open PR/MR reviews
    for (const pr of data.github.pullRequests.slice(0, 3)) {
      suggestions.push({
        type: "code_review",
        title: `Review GitHub PR #${pr.number || "?"}: ${pr.title || "(untitled)"}`,
        priority: "medium",
        source: "github",
        sourceUrl: pr.html_url,
        dueAt: today,
        tags: ["project-assessment", "code-review"],
      });
    }
    for (const mr of data.gitlab.mergeRequests.slice(0, 3)) {
      suggestions.push({
        type: "code_review",
        title: `Review GitLab MR !${mr.iid || "?"}: ${mr.title || "(untitled)"}`,
        priority: "medium",
        source: "gitlab",
        sourceUrl: mr.web_url,
        dueAt: today,
        tags: ["project-assessment", "code-review"],
      });
    }

    return suggestions.slice(0, 15);
  }

  private renderSuggestedWorkItems(items: WorkItemCreateParams[]): string[] {
    if (items.length === 0) {
      return ["- No suggested work items at this time."];
    }
    return items.map((item, i) => `${i + 1}. **${item.title}** (priority: ${item.priority ?? "medium"}, type: ${item.type})`);
  }

  private listOrFallback(items: string[], fallback: string): string[] {
    return items.length > 0 ? items : [fallback];
  }
}

export const projectAssessor = new ProjectAssessor();