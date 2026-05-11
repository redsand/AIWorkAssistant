import { aiClient } from "../agent/opencode-client";
import { githubClient } from "../integrations/github/github-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { workItemDatabase } from "../work-items/database";
import type { WorkItem } from "../work-items/types";
import type {
  ChangeSet,
  ChangedFile,
  CodeReview,
  GitHubPRReviewInput,
  GitLabMRReviewInput,
  ReleaseGoNoGo,
  ReleaseReadinessInput,
  ReleaseReadinessReport,
  ReviewRecommendation,
  ReviewRiskLevel,
} from "./types";

const MIGRATION_PATTERNS = [
  /migration/i,
  /\.sql$/i,
  /alembic/i,
  /flyway/i,
  /liquibase/i,
  /schema/i,
  /seeds?\//i,
];
const CONFIG_PATTERNS = [
  /\.(env|toml|yaml|yml|json|ini|conf)$/i,
  /config\//i,
  /settings/i,
  /infrastructure\//i,
  /terraform/i,
  /k8s\//i,
  /helm\//i,
  /docker/i,
];
const SECURITY_PATTERNS = [/auth/i, /secret/i, /password/i, /token/i, /crypt/i, /jwt/i, /oauth/i, /permission/i, /role/i, /acl/i];
const TEST_PATTERNS = [/\.test\./i, /\.spec\./i, /tests?\//i, /__tests__\//i];

const REVIEW_SYSTEM_PROMPT = `You are a senior staff engineer performing a thorough code review. Given a PR/MR changeset, produce a JSON review object with these exact fields:
- whatChanged (string): 2-4 sentence plain-English summary of what this PR does
- riskLevel (string): one of: low, medium, high, critical
- recommendation (string): one of: ready_for_human_review, needs_changes, low_risk, high_risk_hold
- mustFix (string[]): blocking issues that must be resolved before merge. Empty array if none.
- shouldFix (string[]): non-blocking improvements worth fixing. Empty array if none.
- testGaps (string[]): specific missing tests or coverage gaps. Empty array if none.
- securityConcerns (string[]): security issues or risks. Empty array if none.
- observabilityConcerns (string[]): logging, metrics, alerting gaps. Empty array if none.
- migrationRisks (string[]): schema/data migration risks. Empty array if none.
- rollbackConsiderations (string[]): what is needed to roll back safely. At least one item.
- suggestedReviewComment (string): a markdown review comment Tim can post verbatim. Start with a brief summary, then bullet key points.

Consider the original issue/ticket requirements alongside the code changes. If previous review comments exist, assess whether earlier feedback was addressed. The review should be holistic — does the code actually solve the stated problem? Are there gaps between what the issue asked for and what the code delivers?

Be specific and actionable. Respond with ONLY the JSON object, no markdown fences.`;

const RELEASE_SYSTEM_PROMPT = `You are a senior staff engineer preparing a release readiness assessment. Given a PR/MR changeset, produce a JSON object with these exact fields:
- recommendation (string): one of: go, no_go, conditional_go
- summary (string): 2-3 sentence assessment
- includedChanges (string[]): list of what is included in this release
- knownRisks (string[]): risks that exist at release time
- testStatus (string): plain-English summary of test coverage and CI status
- deploymentNotes (string[]): steps or considerations needed during deployment
- rollbackPlan (string): concise rollback procedure
- customerImpact (string): plain-English customer-facing impact description
- internalCommsDraft (string): a draft internal Slack/email announcement Tim can send

Be specific and actionable. Respond with ONLY the JSON object, no markdown fences.`;

class ReviewAssistant {
  assessRisk(changeSet: ChangeSet): ReviewRiskLevel {
    let score = 0;

    if (changeSet.hasMigration) score += 3;
    if (changeSet.hasConfigChange) score += 2;
    if (!changeSet.hasTests && changeSet.linesAdded > 50) score += 2;
    if (changeSet.ciStatus === "failed") score += 3;
    if (changeSet.files.length > 25) score += 1;
    if (changeSet.linesAdded + changeSet.linesRemoved > 500) score += 1;

    for (const file of changeSet.files) {
      if (SECURITY_PATTERNS.some((p) => p.test(file.filename))) score += 2;
      if (CONFIG_PATTERNS.some((p) => p.test(file.filename))) score += 1;
    }

    if (score >= 8) return "critical";
    if (score >= 5) return "high";
    if (score >= 2) return "medium";
    return "low";
  }

  summarizeDiff(changeSet: ChangeSet): string {
    const MAX_PATCH_LINES = 40;
    const MAX_TOTAL_CHARS = 8000;

    const lines: string[] = [
      `Title: ${changeSet.title}`,
      `Author: ${changeSet.author}`,
      `${changeSet.sourceBranch} → ${changeSet.targetBranch}`,
      `Files: ${changeSet.files.length} (+${changeSet.linesAdded} -${changeSet.linesRemoved})`,
      `CI: ${changeSet.ciStatus}`,
      "",
    ];

    if (changeSet.description?.trim()) {
      lines.push("Description:", changeSet.description.trim().slice(0, 500), "");
    }

    if (changeSet.issueDescription?.trim()) {
      lines.push("Original Issue:", changeSet.issueDescription.trim().slice(0, 800), "");
    }

    if (changeSet.existingComments.length > 0) {
      lines.push("Previous review comments:");
      for (const c of changeSet.existingComments.slice(0, 10)) {
        lines.push(`  - ${c.slice(0, 200)}`);
      }
      lines.push("");
    }

    lines.push("Changed files:");
    for (const file of changeSet.files) {
      lines.push(`  ${file.status} ${file.filename} (+${file.additions} -${file.deletions})`);
      if (file.patch) {
        const patchLines = file.patch.split("\n").slice(0, MAX_PATCH_LINES);
        lines.push(...patchLines.map((l) => "    " + l));
        if (file.patch.split("\n").length > MAX_PATCH_LINES) {
          lines.push("    ...(truncated)");
        }
      }
      lines.push("");
    }

    const result = lines.join("\n");
    return result.length > MAX_TOTAL_CHARS
      ? result.slice(0, MAX_TOTAL_CHARS) + "\n...(truncated)"
      : result;
  }

  generateReviewComment(review: CodeReview): string {
    const riskEmoji =
      review.riskLevel === "critical" ? "🔴"
      : review.riskLevel === "high" ? "🟠"
      : review.riskLevel === "medium" ? "🟡"
      : "🟢";

    const lines: string[] = [
      `# Review Summary`,
      "",
      `**${review.title}**`,
      `${review.author} · ${review.platform} · CI: ${review.ciStatus} · ${review.filesChanged} files (+${review.linesAdded} -${review.linesRemoved})`,
      `PR: ${review.prUrl}`,
      "",
      `## Risk Level`,
      `${riskEmoji} **${review.riskLevel.toUpperCase()}**`,
      "",
      `## Recommendation`,
      `\`${review.recommendation}\``,
      "",
      `## What Changed`,
      review.whatChanged,
      "",
    ];

    if (review.mustFix.length > 0) {
      lines.push("## Must Fix");
      review.mustFix.forEach((item) => lines.push(`- ${item}`));
      lines.push("");
    }

    if (review.shouldFix.length > 0) {
      lines.push("## Should Fix");
      review.shouldFix.forEach((item) => lines.push(`- ${item}`));
      lines.push("");
    }

    if (review.testGaps.length > 0) {
      lines.push("## Test Gaps");
      review.testGaps.forEach((item) => lines.push(`- ${item}`));
      lines.push("");
    }

    if (review.securityConcerns.length > 0) {
      lines.push("## Security Concerns");
      review.securityConcerns.forEach((item) => lines.push(`- ${item}`));
      lines.push("");
    }

    if (review.observabilityConcerns.length > 0) {
      lines.push("## Observability Concerns");
      review.observabilityConcerns.forEach((item) => lines.push(`- ${item}`));
      lines.push("");
    }

    if (review.migrationRisks.length > 0) {
      lines.push("## Migration / Compatibility Risks");
      review.migrationRisks.forEach((item) => lines.push(`- ${item}`));
      lines.push("");
    }

    if (review.rollbackConsiderations.length > 0) {
      lines.push("## Rollback Considerations");
      review.rollbackConsiderations.forEach((item) => lines.push(`- ${item}`));
      lines.push("");
    }

    lines.push("## Suggested Review Comment");
    lines.push("");
    lines.push("> Copy and post this comment to the PR/MR:");
    lines.push("");
    lines.push("```markdown");
    lines.push(review.suggestedReviewComment || "(no comment generated)");
    lines.push("```");
    lines.push("");
    lines.push(`---`);
    lines.push(`*Generated by AI Assistant — ${review.generatedAt}*`);

    return lines.join("\n");
  }

  private compactFallbackComment(review: CodeReview): string {
    const riskEmoji =
      review.riskLevel === "critical" ? "🔴"
      : review.riskLevel === "high" ? "🟠"
      : review.riskLevel === "medium" ? "🟡"
      : "🟢";

    const lines: string[] = [
      `${riskEmoji} **${review.riskLevel.toUpperCase()} Risk** — \`${review.recommendation}\``,
      "",
      review.whatChanged,
    ];

    if (review.mustFix.length > 0) {
      lines.push("", "**Must Fix:**");
      review.mustFix.forEach((item) => lines.push(`- ${item}`));
    }

    if (review.shouldFix.length > 0) {
      lines.push("", "**Should Fix:**");
      review.shouldFix.forEach((item) => lines.push(`- ${item}`));
    }

    if (review.migrationRisks.length > 0) {
      lines.push("", "**Migration Risks:**");
      review.migrationRisks.forEach((item) => lines.push(`- ${item}`));
    }

    return lines.join("\n");
  }

  async reviewGitHubPullRequest(input: GitHubPRReviewInput): Promise<CodeReview> {
    const [pr, filesRaw, checksRaw, commentsRaw] = await Promise.all([
      githubClient.getPullRequest(input.prNumber, input.owner, input.repo),
      githubClient.getPullRequestFiles(input.prNumber, input.owner, input.repo),
      githubClient.listPullRequestChecks(input.prNumber, input.owner, input.repo).catch(() => []),
      githubClient.listPullRequestComments(input.prNumber, input.owner, input.repo).catch(() => []),
    ]);

    const files: ChangedFile[] = (filesRaw || []).map((f: any) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch: f.patch,
    }));

    const linesAdded = files.reduce((s, f) => s + f.additions, 0);
    const linesRemoved = files.reduce((s, f) => s + f.deletions, 0);

    const checkStatuses: string[] = (checksRaw || []).map((c: any) => c.conclusion || c.status);
    const ciStatus = checkStatuses.some((s) => s === "failure" || s === "failed")
      ? "failed"
      : checkStatuses.every((s) => s === "success")
      ? "success"
      : checkStatuses.length > 0
      ? "pending"
      : "unknown";

    const issueDescription = await this.fetchLinkedIssueDescription(pr.body || "", pr.head?.ref || "", "github", input.owner, input.repo);

    const changeSet: ChangeSet = {
      platform: "github",
      title: pr.title || "",
      description: pr.body || "",
      author: pr.user?.login || pr.user?.name || "unknown",
      sourceBranch: pr.head?.ref || "",
      targetBranch: pr.base?.ref || "",
      url: pr.html_url || "",
      files,
      linesAdded,
      linesRemoved,
      ciStatus,
      existingComments: (commentsRaw || []).map((c: any) => c.body).filter(Boolean).slice(0, 10),
      issueDescription,
      hasMigration: files.some((f) => MIGRATION_PATTERNS.some((p) => p.test(f.filename))),
      hasTests: files.some((f) => TEST_PATTERNS.some((p) => p.test(f.filename))),
      hasConfigChange: files.some((f) => CONFIG_PATTERNS.some((p) => p.test(f.filename))),
    };

    return this.buildReview(changeSet);
  }

  async reviewGitLabMergeRequest(input: GitLabMRReviewInput): Promise<CodeReview> {
    const [mr, changes, pipelines, notesRaw] = await Promise.all([
      gitlabClient.getMergeRequest(input.projectId, input.mrIid),
      gitlabClient.getMergeRequestChanges(input.projectId, input.mrIid),
      gitlabClient.listPipelines(input.projectId, undefined).catch(() => []),
      gitlabClient.listMergeRequestNotes(input.projectId, input.mrIid).catch(() => []),
    ]);

    const files: ChangedFile[] = (changes.changes || []).map((c: any) => ({
      filename: c.new_path || c.old_path,
      status: c.new_file ? "added" : c.deleted_file ? "removed" : c.renamed_file ? "renamed" : "modified",
      additions: (c.diff?.match(/^\+[^+]/gm) || []).length,
      deletions: (c.diff?.match(/^-[^-]/gm) || []).length,
      patch: c.diff,
    }));

    const linesAdded = files.reduce((s, f) => s + f.additions, 0);
    const linesRemoved = files.reduce((s, f) => s + f.deletions, 0);

    const latestPipeline = (pipelines || []).find(
      (p: any) => p.ref === mr.source_branch,
    );
    const ciStatus: ChangeSet["ciStatus"] =
      latestPipeline?.status === "success"
        ? "success"
        : latestPipeline?.status === "failed"
        ? "failed"
        : latestPipeline
        ? "pending"
        : "unknown";

    const issueDescription = await this.fetchLinkedIssueDescription(mr.description || "", mr.source_branch || "", "gitlab");

    const changeSet: ChangeSet = {
      platform: "gitlab",
      title: mr.title || "",
      description: mr.description || "",
      author: mr.author?.username || mr.author?.name || "unknown",
      sourceBranch: mr.source_branch || "",
      targetBranch: mr.target_branch || "",
      url: mr.web_url || "",
      files,
      linesAdded,
      linesRemoved,
      ciStatus,
      existingComments: (notesRaw || []).filter((n: any) => !n.system).map((n: any) => n.body).filter(Boolean).slice(0, 10),
      issueDescription,
      hasMigration: files.some((f) => MIGRATION_PATTERNS.some((p) => p.test(f.filename))),
      hasTests: files.some((f) => TEST_PATTERNS.some((p) => p.test(f.filename))),
      hasConfigChange: files.some((f) => CONFIG_PATTERNS.some((p) => p.test(f.filename))),
    };

    return this.buildReview(changeSet);
  }

  async generateReleaseReadinessReport(
    input: ReleaseReadinessInput,
  ): Promise<ReleaseReadinessReport> {
    let changeSet: ChangeSet;

    if (input.platform === "github" && input.owner && input.repo && input.prNumber) {
      const review = await this.reviewGitHubPullRequest({
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
      });
      changeSet = await this.fetchGitHubChangeSet(input.owner, input.repo, input.prNumber);
      return this.buildReleaseReport(changeSet, review, input.notes);
    }

    if (input.platform === "gitlab" && input.projectId && input.mrIid) {
      const review = await this.reviewGitLabMergeRequest({
        projectId: input.projectId,
        mrIid: input.mrIid,
      });
      changeSet = await this.fetchGitLabChangeSet(input.projectId, input.mrIid);
      return this.buildReleaseReport(changeSet, review, input.notes);
    }

    throw new Error("Invalid release readiness input: missing required fields for platform");
  }

  private async fetchGitHubChangeSet(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ChangeSet> {
    const [pr, filesRaw] = await Promise.all([
      githubClient.getPullRequest(prNumber, owner, repo),
      githubClient.getPullRequestFiles(prNumber, owner, repo),
    ]);
    const files: ChangedFile[] = (filesRaw || []).map((f: any) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch: f.patch,
    }));
    return {
      platform: "github",
      title: pr.title || "",
      description: pr.body || "",
      author: pr.user?.login || "unknown",
      sourceBranch: pr.head?.ref || "",
      targetBranch: pr.base?.ref || "",
      url: pr.html_url || "",
      files,
      linesAdded: files.reduce((s, f) => s + f.additions, 0),
      linesRemoved: files.reduce((s, f) => s + f.deletions, 0),
      ciStatus: "unknown",
      existingComments: [],
      hasMigration: files.some((f) => MIGRATION_PATTERNS.some((p) => p.test(f.filename))),
      hasTests: files.some((f) => TEST_PATTERNS.some((p) => p.test(f.filename))),
      hasConfigChange: files.some((f) => CONFIG_PATTERNS.some((p) => p.test(f.filename))),
    };
  }

  private async fetchGitLabChangeSet(
    projectId: string | number,
    mrIid: number,
  ): Promise<ChangeSet> {
    const [mr, changes] = await Promise.all([
      gitlabClient.getMergeRequest(projectId, mrIid),
      gitlabClient.getMergeRequestChanges(projectId, mrIid),
    ]);
    const files: ChangedFile[] = (changes.changes || []).map((c: any) => ({
      filename: c.new_path || c.old_path,
      status: c.new_file ? "added" : c.deleted_file ? "removed" : c.renamed_file ? "renamed" : "modified",
      additions: (c.diff?.match(/^\+[^+]/gm) || []).length,
      deletions: (c.diff?.match(/^-[^-]/gm) || []).length,
      patch: c.diff,
    }));
    return {
      platform: "gitlab",
      title: mr.title || "",
      description: mr.description || "",
      author: mr.author?.username || "unknown",
      sourceBranch: mr.source_branch || "",
      targetBranch: mr.target_branch || "",
      url: mr.web_url || "",
      files,
      linesAdded: files.reduce((s, f) => s + f.additions, 0),
      linesRemoved: files.reduce((s, f) => s + f.deletions, 0),
      ciStatus: "unknown",
      existingComments: [],
      hasMigration: files.some((f) => MIGRATION_PATTERNS.some((p) => p.test(f.filename))),
      hasTests: files.some((f) => TEST_PATTERNS.some((p) => p.test(f.filename))),
      hasConfigChange: files.some((f) => CONFIG_PATTERNS.some((p) => p.test(f.filename))),
    };
  }

  private async fetchLinkedIssueDescription(
    mrBody: string,
    branchName: string,
    platform: "github" | "gitlab",
    owner?: string,
    repo?: string,
  ): Promise<string | undefined> {
    try {
      if (platform === "gitlab") {
        // Try Jira key from description or branch
        const jiraKey = this.extractJiraKey(mrBody) || this.extractJiraKeyFromBranch(branchName);
        if (jiraKey && jiraClient.isConfigured()) {
          const issue = await jiraClient.getIssue(jiraKey);
          const fields = issue.fields as any;
          return fields?.description ? `[${jiraKey}] ${fields.summary}: ${fields.description}`.slice(0, 800) : undefined;
        }
      } else {
        // Try GitHub issue from PR body
        const issueNum = (mrBody.match(/(?:closes|fixes|resolves)\s+#(\d+)/i) || [])[1]
          || (branchName.match(/issue-(\d+)/i) || [])[1];
        if (issueNum && owner && repo) {
          const issue = await githubClient.getIssue(parseInt(issueNum, 10), owner, repo).catch(() => null);
          if (issue) {
            return `[#${issueNum}] ${issue.title}: ${issue.body || ""}`.slice(0, 800);
          }
        }
      }
    } catch {
      // Non-fatal: issue fetch is best-effort context enrichment
    }
    return undefined;
  }

  private extractJiraKey(text: string): string | null {
    const match = text.match(/\b([A-Z]+-\d+)\b/);
    return match ? match[1] : null;
  }

  private extractJiraKeyFromBranch(branch: string): string | null {
    const match = branch.match(/issue-([a-z]+-\d+)/i);
    return match ? match[1].toUpperCase() : null;
  }

  private async buildReview(changeSet: ChangeSet): Promise<CodeReview> {
    const riskLevel = this.assessRisk(changeSet);
    const diffSummary = this.summarizeDiff(changeSet);

    let parsed: Partial<CodeReview> = {};
    let aiSucceeded = false;

    if (aiClient.isConfigured()) {
      try {
        const response = await aiClient.chat({
          messages: [
            { role: "system", content: REVIEW_SYSTEM_PROMPT },
            { role: "user", content: diffSummary },
          ],
          temperature: 0.3,
        });
        const content = response.content.trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
          aiSucceeded = true;
        }
      } catch (err) {
        console.error("[CodeReview] AI generation failed, using fallback:", (err as Error).message);
      }
    }

    if (!aiSucceeded) {
      parsed = this.fallbackReview(changeSet, riskLevel);
    }

    const review: CodeReview = {
      prUrl: changeSet.url,
      title: changeSet.title,
      author: changeSet.author,
      platform: changeSet.platform,
      riskLevel: (parsed.riskLevel as ReviewRiskLevel) || riskLevel,
      recommendation: (parsed.recommendation as ReviewRecommendation) || this.fallbackRecommendation(riskLevel),
      whatChanged: parsed.whatChanged || changeSet.title,
      mustFix: parsed.mustFix || [],
      shouldFix: parsed.shouldFix || [],
      testGaps: parsed.testGaps || (!changeSet.hasTests ? ["No test files detected in this PR"] : []),
      securityConcerns: parsed.securityConcerns || [],
      observabilityConcerns: parsed.observabilityConcerns || [],
      migrationRisks: parsed.migrationRisks || (changeSet.hasMigration ? ["This PR contains migration files — review rollback strategy"] : []),
      rollbackConsiderations: parsed.rollbackConsiderations || ["Review migration scripts before merge", "Ensure database backups are current"],
      suggestedReviewComment: parsed.suggestedReviewComment || "",
      filesChanged: changeSet.files.length,
      linesAdded: changeSet.linesAdded,
      linesRemoved: changeSet.linesRemoved,
      ciStatus: changeSet.ciStatus,
      generatedAt: new Date().toISOString(),
    };

    if (!review.suggestedReviewComment) {
      review.suggestedReviewComment = this.compactFallbackComment(review);
    }

    return review;
  }

  private async buildReleaseReport(
    changeSet: ChangeSet,
    review: CodeReview,
    notes?: string,
  ): Promise<ReleaseReadinessReport> {
    const diffSummary = this.summarizeDiff(changeSet);
    const reviewJson = JSON.stringify({
      riskLevel: review.riskLevel,
      recommendation: review.recommendation,
      mustFix: review.mustFix,
      migrationRisks: review.migrationRisks,
      ciStatus: review.ciStatus,
    });

    const userContent = [
      "Changeset:",
      diffSummary,
      "",
      "Review summary:",
      reviewJson,
      notes ? `\nAdditional context:\n${notes}` : "",
    ].join("\n");

    let parsed: Partial<ReleaseReadinessReport> = {};

    if (aiClient.isConfigured()) {
      try {
        const response = await aiClient.chat({
          messages: [
            { role: "system", content: RELEASE_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          temperature: 0.3,
        });
        const content = response.content.trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        }
      } catch (err) {
        console.error("[ReleaseReadiness] AI generation failed, using fallback:", (err as Error).message);
      }
    }

    const goNoGo: ReleaseGoNoGo =
      (parsed.recommendation as ReleaseGoNoGo) ||
      (review.mustFix.length > 0 || changeSet.ciStatus === "failed"
        ? "no_go"
        : review.riskLevel === "high" || review.riskLevel === "critical"
        ? "conditional_go"
        : "go");

    return {
      title: changeSet.title,
      platform: changeSet.platform,
      prUrl: changeSet.url,
      recommendation: goNoGo,
      summary: parsed.summary || `${changeSet.files.length} files changed (+${changeSet.linesAdded} -${changeSet.linesRemoved}). Risk: ${review.riskLevel}. CI: ${changeSet.ciStatus}.`,
      includedChanges: parsed.includedChanges || changeSet.files.map((f) => `${f.status}: ${f.filename}`),
      knownRisks: parsed.knownRisks || [...review.mustFix, ...review.migrationRisks],
      testStatus: parsed.testStatus || (changeSet.hasTests ? "Test files detected in PR" : "No test files detected in PR"),
      deploymentNotes: parsed.deploymentNotes || (changeSet.hasMigration ? ["Run database migrations before/after deployment as appropriate"] : ["Standard deployment"]),
      rollbackPlan: parsed.rollbackPlan || "Revert PR and redeploy previous version. If migration ran, restore database backup.",
      customerImpact: parsed.customerImpact || "Review PR description for customer-facing impact.",
      internalCommsDraft: parsed.internalCommsDraft || `We are deploying: ${changeSet.title}. Risk level: ${review.riskLevel}. Monitoring is in place.`,
      generatedAt: new Date().toISOString(),
    };
  }

  private fallbackReview(changeSet: ChangeSet, riskLevel: ReviewRiskLevel): Partial<CodeReview> {
    const mustFix: string[] = [];
    if (changeSet.ciStatus === "failed") mustFix.push("CI checks are failing — must pass before merge");
    if (changeSet.hasMigration && !changeSet.hasTests) mustFix.push("Migration changes detected but no test files found");

    const shouldFix: string[] = [];
    if (!changeSet.hasTests && changeSet.linesAdded > 30) shouldFix.push("Consider adding tests for new code");
    if (changeSet.files.length > 15) shouldFix.push("Large PR — consider breaking into smaller changes");

    return {
      whatChanged: `${changeSet.title}. ${changeSet.files.length} files changed (+${changeSet.linesAdded} -${changeSet.linesRemoved}).`,
      riskLevel,
      recommendation: this.fallbackRecommendation(riskLevel),
      mustFix,
      shouldFix,
      testGaps: !changeSet.hasTests ? ["No test files detected in this PR"] : [],
      securityConcerns: changeSet.files.some((f) => SECURITY_PATTERNS.some((p) => p.test(f.filename)))
        ? ["Security-related files detected — review auth/credential changes carefully"]
        : [],
      observabilityConcerns: [],
      migrationRisks: changeSet.hasMigration ? ["Database migration files detected — verify rollback path"] : [],
      rollbackConsiderations: ["Revert PR and redeploy previous build"],
    };
  }

  private fallbackRecommendation(riskLevel: ReviewRiskLevel): ReviewRecommendation {
    if (riskLevel === "critical") return "high_risk_hold";
    if (riskLevel === "high") return "needs_changes";
    if (riskLevel === "medium") return "ready_for_human_review";
    return "low_risk";
  }

  createReviewWorkItem(params: {
    title: string;
    type: "code_review" | "release";
    prUrl?: string;
    riskLevel?: string;
    recommendation?: string;
    description?: string;
    priority?: "low" | "medium" | "high" | "critical";
  }): WorkItem {
    const priority: "low" | "medium" | "high" | "critical" =
      params.priority ||
      (params.riskLevel === "critical" || params.riskLevel === "high"
        ? "high"
        : params.riskLevel === "medium"
        ? "medium"
        : "low");

    return workItemDatabase.createWorkItem({
      type: params.type,
      title: params.title,
      description: params.description,
      status: "proposed",
      priority,
      source: "github",
      sourceUrl: params.prUrl,
      metadata: {
        riskLevel: params.riskLevel,
        recommendation: params.recommendation,
        prUrl: params.prUrl,
      },
    });
  }
}

export const reviewAssistant = new ReviewAssistant();
