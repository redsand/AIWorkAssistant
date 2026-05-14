import { aiClient } from "../agent/opencode-client";
import { githubClient } from "../integrations/github/github-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { workItemDatabase } from "../work-items/database";

// ── Streaming event type for review progress ─────────────────────────────────
export interface ReviewStreamEvent {
  type: "progress" | "stream";
  message?: string;
  chunk?: string;
}
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

const MAX_REVIEW_RETRIES = 3;

/**
 * Recovers review fields from a truncated JSON string using field-level regex.
 * The model consistently gets cut off in `suggestedReviewComment` (the last verbose field)
 * but all critical fields (riskLevel, mustFix, securityConcerns, etc.) appear before it.
 * Returns null if not enough meaningful data is present.
 */
function extractPartialReview(content: string): Partial<CodeReview> | null {
  // Extract a simple quoted string value for a named field
  const strField = (field: string): string | undefined => {
    const m = content.match(new RegExp(String.raw`"${field}"\s*:\s*"((?:[^"\\]|\\.)*)"`));
    return m ? m[1].replace(/\\n/g, " ").replace(/\\"/g, '"').trim() : undefined;
  };

  // Extract array items that appear completely before truncation
  const arrField = (field: string): string[] => {
    const fieldIdx = content.indexOf(`"${field}"`);
    if (fieldIdx === -1) return [];
    const bracketIdx = content.indexOf("[", fieldIdx + field.length + 2);
    if (bracketIdx === -1) return [];
    const segment = content.slice(bracketIdx + 1);
    const items: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(segment)) !== null) {
      // String followed by ":" is a JSON key — we've left this array
      const tail = segment.slice(m.index + m[0].length).trimStart();
      if (tail.startsWith(":")) break;
      items.push(m[1].replace(/\\n/g, " ").replace(/\\"/g, '"').trim().slice(0, 200));
      if (items.length >= 5) break;
    }
    return items;
  };

  const result: Partial<CodeReview> = {
    riskLevel: strField("riskLevel") as ReviewRiskLevel | undefined,
    recommendation: strField("recommendation") as ReviewRecommendation | undefined,
    whatChanged: strField("whatChanged"),
    suggestedReviewComment: strField("suggestedReviewComment"),
    mustFix: arrField("mustFix"),
    shouldFix: arrField("shouldFix"),
    testGaps: arrField("testGaps"),
    securityConcerns: arrField("securityConcerns"),
    observabilityConcerns: arrField("observabilityConcerns"),
    migrationRisks: arrField("migrationRisks"),
    rollbackConsiderations: arrField("rollbackConsiderations"),
  };

  // Accept the partial if we recovered any structured field — riskLevel alone is enough,
  // or any array with at least one item. The caller has fallbacks for missing fields.
  const anyArray = [
    result.mustFix, result.shouldFix, result.testGaps,
    result.securityConcerns, result.observabilityConcerns,
    result.migrationRisks, result.rollbackConsiderations,
  ].some((a) => a && a.length > 0);

  const meaningful = !!result.riskLevel || !!result.recommendation || anyArray;

  return meaningful ? result : null;
}

const REVIEW_SYSTEM_PROMPT = `OUTPUT FORMAT: Respond with ONLY a valid JSON object. No markdown fences (\`\`\`json). No text before or after the JSON. Stop writing immediately after the closing \`}\`. Exceeding the output budget causes the review to be discarded.

OUTPUT BUDGET: The entire JSON response MUST be under 1500 tokens. Each string value: max 120 characters (hard cut). Each array: max 5 items. suggestedReviewComment: max 80 words. Be extremely concise — omit all explanation beyond the specific finding.

You are a senior staff engineer performing a code review. Given a PR/MR changeset, produce a JSON review object with these exact fields:
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
- suggestedReviewComment (string): a markdown review comment to post on the PR/MR. Keep it under 150 words. One short paragraph summary then bullet points — no sub-bullets, no lengthy explanations.

Consider the original issue/ticket requirements alongside the code changes. If previous review comments exist, assess whether earlier feedback was addressed. The review should be holistic — does the code actually solve the stated problem? Are there gaps between what the issue asked for and what the code delivers?

CRITICAL RULES:
1. ONLY flag issues you can verify from the code shown in the diff. Do NOT claim code is missing unless you have verified it is not present in ANY file shown.
2. Each finding MUST include the specific file name and line reference. Use format: "filename.ext:line_number — description". Never use "unknown" as a filename.
3. If a diff is truncated, do NOT assume the truncated portion is missing or broken. Truncated code exists — you just can't see all of it.
4. For new/added files (status: "added"), the entire file content is the diff — you can see the full implementation. Do not claim an added file is empty or missing content you can see in the diff.
5. When checking if requirements from the issue are met, verify against the ACTUAL code shown, not assumptions about what might be missing.

Respond with ONLY the JSON object. No markdown fences. No text after the closing brace.`;

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
    const MAX_PATCH_LINES = 200;
    const MAX_TOTAL_CHARS = 32000;
    const NEW_FILE_MAX_LINES = 500;

    const lines: string[] = [
      `Title: ${changeSet.title}`,
      `Author: ${changeSet.author}`,
      `${changeSet.sourceBranch} → ${changeSet.targetBranch}`,
      `Files: ${changeSet.files.length} (+${changeSet.linesAdded} -${changeSet.linesRemoved})`,
      `CI: ${changeSet.ciStatus}`,
      "",
    ];

    if (changeSet.description?.trim()) {
      lines.push("Description:", changeSet.description.trim().slice(0, 1000), "");
    }

    if (changeSet.issueDescription?.trim()) {
      lines.push("Original Issue:", changeSet.issueDescription.trim().slice(0, 1500), "");
    }

    if (changeSet.existingComments.length > 0) {
      lines.push("Previous review comments:");
      for (const c of changeSet.existingComments.slice(0, 20)) {
        lines.push(`  - ${c.slice(0, 500)}`);
      }
      lines.push("");
    }

    lines.push("Changed files:");
    for (const file of changeSet.files) {
      lines.push(`  ${file.status} ${file.filename} (+${file.additions} -${file.deletions})`);
      if (file.patch) {
        const isNew = file.status === "added";
        const limit = isNew ? NEW_FILE_MAX_LINES : MAX_PATCH_LINES;
        const patchLines = file.patch.split("\n");
        const totalLines = patchLines.length;
        const shownLines = patchLines.slice(0, limit);
        lines.push(...shownLines.map((l) => "    " + l));
        if (totalLines > limit) {
          lines.push(`    ...(truncated: ${totalLines} total lines, showing ${limit})`);
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

  /**
   * Streaming review — same as reviewGitHubPullRequest/reviewGitLabMergeRequest
   * but uses buildReviewStreaming for real-time progress output.
   */
  async reviewWithStreaming(
    input: GitHubPRReviewInput | GitLabMRReviewInput,
    onProgress?: (event: ReviewStreamEvent) => void,
  ): Promise<CodeReview> {
    if ("projectId" in input) {
      const mr = await gitlabClient.getMergeRequest(input.projectId, input.mrIid);
      const changes = await gitlabClient.getMergeRequestChanges(input.projectId, input.mrIid);
      const pipelines = await gitlabClient.listPipelines(input.projectId, undefined).catch(() => []);
      const notesRaw = await gitlabClient.listMergeRequestNotes(input.projectId, input.mrIid).catch(() => []);

      const files: ChangedFile[] = (changes.changes || []).map((c: any) => ({
        filename: c.new_path || c.old_path,
        status: c.new_file ? "added" : c.deleted_file ? "removed" : c.renamed_file ? "renamed" : "modified",
        additions: (c.diff?.match(/^\+[^+]/gm) || []).length,
        deletions: (c.diff?.match(/^-[^-]/gm) || []).length,
        patch: c.diff,
      }));

      const linesAdded = files.reduce((s, f) => s + f.additions, 0);
      const linesRemoved = files.reduce((s, f) => s + f.deletions, 0);

      const latestPipeline = (pipelines || []).find((p: any) => p.ref === mr.source_branch);
      const ciStatus: ChangeSet["ciStatus"] =
        latestPipeline?.status === "success" ? "success"
        : latestPipeline?.status === "failed" ? "failed"
        : latestPipeline ? "pending"
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

      return this.buildReviewStreaming(changeSet, onProgress);
    } else {
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

      return this.buildReviewStreaming(changeSet, onProgress);
    }
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
      for (let attempt = 1; attempt <= MAX_REVIEW_RETRIES && !aiSucceeded; attempt++) {
        if (attempt > 1) {
          console.warn(`[CodeReview] Retry ${attempt}/${MAX_REVIEW_RETRIES} — previous attempt did not return valid JSON`);
        }
        try {
          const response = await aiClient.chat({
            messages: [
              { role: "system", content: REVIEW_SYSTEM_PROMPT },
              { role: "user", content: diffSummary },
            ],
            temperature: 0.3,
            maxTokens: 4096,
            jsonMode: true,
          });
          const content = response.content.trim();
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              parsed = JSON.parse(jsonMatch[0]);
              aiSucceeded = true;
            } catch {
              // JSON.parse threw — model returned markdown/prose with curly-brace fragments
              console.warn(`[CodeReview] Attempt ${attempt}: JSON.parse failed (model returned non-JSON). First 200 chars:`, content.slice(0, 200));
            }
          } else {
            // No closing brace — response is truncated; escalate immediately (no retry)
            console.warn(`[CodeReview] Attempt ${attempt}: response contained no JSON object — likely truncated. Length: ${content.length}, last 200 chars:`, content.slice(-200));
            parsed = {
              riskLevel: "high" as const,
              recommendation: "needs_changes" as const,
              whatChanged: changeSet.title,
              mustFix: ["AI review response was truncated — manual review required"],
              shouldFix: ["The AI review could not complete. Review the changes manually."],
              testGaps: [],
              securityConcerns: ["AI review was unavailable — security review could not be completed"],
              observabilityConcerns: [],
              migrationRisks: [],
            };
            aiSucceeded = true;
            break;
          }
        } catch (err) {
          console.error(`[CodeReview] Attempt ${attempt} AI call failed:`, (err as Error).message);
        }
      }

      // All retries exhausted (JSON.parse kept throwing or AI kept throwing) — escalate
      if (!aiSucceeded) {
        console.warn("[CodeReview] All retries exhausted — escalating to needs_changes");
        parsed = {
          riskLevel: "high" as const,
          recommendation: "needs_changes" as const,
          whatChanged: changeSet.title,
          mustFix: ["AI review was unavailable after retries — manual review required"],
          shouldFix: ["Review the changes manually. The AI could not complete its assessment."],
          testGaps: [],
          securityConcerns: ["AI review was unavailable — security review could not be completed"],
          observabilityConcerns: [],
          migrationRisks: [],
        };
        aiSucceeded = true;
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

  /**
   * Streaming version of buildReview — yields progress events as the AI review
   * proceeds, then returns the final CodeReview result.
   */
  async buildReviewStreaming(
    changeSet: ChangeSet,
    onProgress?: (event: ReviewStreamEvent) => void,
  ): Promise<CodeReview> {
    const riskLevel = this.assessRisk(changeSet);
    const diffSummary = this.summarizeDiff(changeSet);

    onProgress?.({ type: "progress", message: `Assessing risk: ${riskLevel} — ${changeSet.files.length} files changed` });

    let parsed: Partial<CodeReview> = {};
    let aiSucceeded = false;
    let lastStreamContent = "";

    if (aiClient.isConfigured()) {
      for (let attempt = 1; attempt <= MAX_REVIEW_RETRIES && !aiSucceeded; attempt++) {
        if (attempt > 1) {
          console.warn(`[CodeReview] Stream retry ${attempt}/${MAX_REVIEW_RETRIES} — previous attempt did not return valid JSON`);
        }
        try {
          onProgress?.({ type: "progress", message: "Running AI code review..." });

          let fullContent = "";
          let pendingChunk = "";
          let lastStreamTime = Date.now();

          for await (const chunk of aiClient.chatStream({
            messages: [
              { role: "system", content: REVIEW_SYSTEM_PROMPT },
              { role: "user", content: diffSummary },
            ],
            temperature: 0.3,
            maxTokens: 4096,
            jsonMode: true,
          })) {
            fullContent += chunk;
            pendingChunk += chunk;

            // Throttle stream events — emit accumulated chunk every 500ms or 200 chars
            const now = Date.now();
            if (now - lastStreamTime > 500 || pendingChunk.length >= 200) {
              onProgress?.({ type: "stream", chunk: pendingChunk });
              pendingChunk = "";
              lastStreamTime = now;
            }
          }

          // Flush any remaining buffered chunk
          if (pendingChunk) {
            onProgress?.({ type: "stream", chunk: pendingChunk });
          }

          onProgress?.({ type: "progress", message: "AI review complete — parsing results..." });

          // Strip markdown code fences the model sometimes adds despite the instruction
          const stripped = fullContent.trim().replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "");
          const content = stripped.trim();
          lastStreamContent = content; // save for partial extraction if all retries fail

          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              parsed = JSON.parse(jsonMatch[0]);
              aiSucceeded = true;
            } catch {
              // JSON.parse threw — model returned markdown/prose with curly-brace fragments
              console.warn(`[CodeReview] Stream attempt ${attempt}: JSON.parse failed (model returned non-JSON). First 200 chars:`, content.slice(0, 200));
            }
          } else {
            // No closing brace — response is likely truncated; retry may produce complete JSON
            console.warn(`[CodeReview] Stream attempt ${attempt}: response has no complete JSON object — likely truncated. Length: ${content.length}, last 200 chars:`, content.slice(-200));
            onProgress?.({ type: "progress", message: `AI review response truncated on attempt ${attempt} — retrying...` });
          }
        } catch (err) {
          console.error(`[CodeReview] Stream attempt ${attempt} failed:`, (err as Error).message);
        }
      }

      if (!aiSucceeded) {
        // Try to salvage real findings from the last (best) truncated response
        // The model consistently completes riskLevel/mustFix/securityConcerns before
        // getting cut off in the verbose suggestedReviewComment field
        const partial = extractPartialReview(lastStreamContent);
        if (partial) {
          console.warn("[CodeReview] All stream retries truncated — recovered partial review from last response");
          onProgress?.({ type: "progress", message: "AI review truncated — recovered partial findings" });
          parsed = partial;
          aiSucceeded = true;
        } else {
          console.warn("[CodeReview] All stream retries exhausted and no partial data extractable — escalating to needs_changes");
          onProgress?.({ type: "progress", message: "AI review failed after retries — escalating to needs_changes" });
          parsed = {
            riskLevel: "high" as const,
            recommendation: "needs_changes" as const,
            whatChanged: changeSet.title,
            mustFix: ["AI review response was truncated after retries — manual review required"],
            shouldFix: ["Review the changes manually. The AI could not complete its assessment."],
            testGaps: [],
            securityConcerns: ["AI review was unavailable — security review could not be completed"],
            observabilityConcerns: [],
            migrationRisks: [],
          };
          aiSucceeded = true;
        }
      }
    }

    if (!aiSucceeded) {
      onProgress?.({ type: "progress", message: "AI review unavailable — using heuristic fallback" });
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

    const findingCount = review.mustFix.length + review.shouldFix.length + review.securityConcerns.length;
    onProgress?.({ type: "progress", message: `Review complete: ${findingCount} findings, risk=${review.riskLevel}, rec=${review.recommendation}` });

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
    if (changeSet.files.length === 0 || changeSet.linesAdded + changeSet.linesRemoved === 0) {
      mustFix.push("Empty MR — no changes to review. Do not merge without substantive changes.");
    }
    if (changeSet.ciStatus === "failed") mustFix.push("CI checks are failing — must pass before merge");
    if (changeSet.hasMigration && !changeSet.hasTests) mustFix.push("Migration changes detected but no test files found");
    // Heuristic review cannot analyze code for security vulnerabilities or correctness.
    // Always require explicit human sign-off when AI review was unavailable.
    mustFix.push("AI review was unavailable — heuristic review only. Manual review required for security-sensitive changes.");

    const shouldFix: string[] = [];
    if (!changeSet.hasTests && changeSet.linesAdded > 30) shouldFix.push("Consider adding tests for new code");
    if (changeSet.files.length > 15) shouldFix.push("Large PR — consider breaking into smaller changes");
    if (changeSet.files.some((f) => SECURITY_PATTERNS.some((p) => p.test(f.filename)))) {
      shouldFix.push("Security-related files detected — human review recommended for auth/credential changes");
    }

    const hasSecurityFiles = changeSet.files.some((f) => SECURITY_PATTERNS.some((p) => p.test(f.filename)));

    return {
      whatChanged: `${changeSet.title}. ${changeSet.files.length} files changed (+${changeSet.linesAdded} -${changeSet.linesRemoved}).`,
      riskLevel: mustFix.length > 0 ? "high" : changeSet.hasMigration || hasSecurityFiles ? "high" : "medium",
      recommendation: mustFix.length > 0 ? "needs_changes" : hasSecurityFiles ? "needs_changes" : "ready_for_human_review",
      mustFix,
      shouldFix,
      testGaps: !changeSet.hasTests ? ["No test files detected in this PR"] : [],
      securityConcerns: [],
      observabilityConcerns: [],
      migrationRisks: changeSet.hasMigration ? ["Database migration files detected — verify rollback path"] : [],
      rollbackConsiderations: ["Revert PR and redeploy previous build"],
    };
  }

  private fallbackRecommendation(riskLevel: ReviewRiskLevel): ReviewRecommendation {
    // When using fallback (AI unavailable), always recommend at least human review
    // Never auto-approve from a heuristic — the AI review was unavailable
    if (riskLevel === "critical") return "high_risk_hold";
    if (riskLevel === "high") return "needs_changes";
    return "ready_for_human_review";
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
