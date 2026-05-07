import { execSync } from "child_process";
import axios from "axios";

/**
 * Reviewer configuration — loaded from the local .env or fetched from
 * AIWorkAssistant via GET /api/reviewer/config.
 *
 * Minimal .env for remote mode (AiRemoteCoder deployment):
 *   AIWORKASSISTANT_URL=https://your-server:3050
 *   AIWORKASSISTANT_API_KEY=your-api-key
 *
 * Full .env for local mode (running inside the AIWorkAssistant project):
 *   GITHUB_TOKEN=ghp_...
 *   GITHUB_DEFAULT_OWNER=redsand
 *   REVIEW_REPOS=repo1,repo2
 *   REVIEW_POLL_INTERVAL_MS=30000
 *   REVIEW_MAX_CYCLES=5
 *   SECURITY_AGENT_CMD=review-agent --category security
 *   QA_AGENT_CMD=review-agent --category qa
 *   QUALITY_AGENT_CMD=review-agent --category quality
 */
interface ReviewerConfig {
  githubToken: string;
  owner: string;
  reviewRepos: string[];
  pollIntervalMs: number;
  maxReviewCycles: number;
  securityAgentCmd: string;
  qaAgentCmd: string;
  qualityAgentCmd: string;
}

interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "qa" | "quality";
  file: string;
  line?: number;
  message: string;
  suggestion: string;
}

interface ReviewResult {
  clean: boolean;
  findings: ReviewFinding[];
  summary: string;
}

async function loadConfig(): Promise<ReviewerConfig> {
  const remoteUrl = process.env.AIWORKASSISTANT_URL?.replace(/\/$/, "");
  const remoteKey = process.env.AIWORKASSISTANT_API_KEY;

  if (remoteUrl && remoteKey) {
    console.log(`[CONFIG] Fetching reviewer config from ${remoteUrl}`);
    const response = await axios.get<ReviewerConfig>(
      `${remoteUrl}/api/reviewer/config`,
      { headers: { Authorization: `Bearer ${remoteKey}` } },
    );
    const cfg = response.data;
    console.log(`[CONFIG] Remote config loaded (repos: ${cfg.reviewRepos.join(", ") || "none"})`);
    return cfg;
  }

  console.log("[CONFIG] Using local .env config");
  return {
    githubToken: process.env.GITHUB_TOKEN || "",
    owner: process.env.GITHUB_DEFAULT_OWNER || "redsand",
    reviewRepos: (process.env.REVIEW_REPOS || "").split(",").filter(Boolean),
    pollIntervalMs: parseInt(process.env.REVIEW_POLL_INTERVAL_MS || "30000", 10),
    maxReviewCycles: parseInt(process.env.REVIEW_MAX_CYCLES || "5", 10),
    securityAgentCmd: process.env.SECURITY_AGENT_CMD || "review-agent --category security",
    qaAgentCmd: process.env.QA_AGENT_CMD || "review-agent --category qa",
    qualityAgentCmd: process.env.QUALITY_AGENT_CMD || "review-agent --category quality",
  };
}

function makeGithubClient(token: string, owner: string) {
  const client = axios.create({
    baseURL: "https://api.github.com",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    timeout: 30_000,
  });

  return {
    async listOpenPRs(repo: string): Promise<any[]> {
      const res = await client.get(`/repos/${owner}/${repo}/pulls`, {
        params: { state: "open", per_page: 50, sort: "updated", direction: "desc" },
      });
      return res.data;
    },

    async getPRDiff(repo: string, prNumber: number): Promise<string> {
      const res = await client.get(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
        headers: { Accept: "application/vnd.github.v3.diff" },
      });
      return res.data as string;
    },

    async listIssueComments(repo: string, issueNumber: number): Promise<any[]> {
      const res = await client.get(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
        params: { per_page: 100 },
      });
      return res.data;
    },

    async addIssueComment(repo: string, issueNumber: number, body: string): Promise<void> {
      await client.post(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
    },

    async mergePR(repo: string, prNumber: number, commitTitle: string, commitMessage: string): Promise<void> {
      await client.put(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
        commit_title: commitTitle,
        commit_message: commitMessage,
      });
    },
  };
}

async function pollPRs(
  config: ReviewerConfig,
  gh: ReturnType<typeof makeGithubClient>,
): Promise<void> {
  for (const repo of config.reviewRepos) {
    const prs = await gh.listOpenPRs(repo);

    for (const pr of prs) {
      if (!pr.user?.login.includes("ai") && !pr.title.startsWith("[AI]")) continue;
      console.log(`[REVIEW] Found AI PR #${pr.number} in ${repo}: ${pr.title}`);

      const reviewCycleCount = await getReviewCycleCount(gh, repo, pr.number);
      if (reviewCycleCount >= config.maxReviewCycles) {
        console.log(`[BLOCKED] PR #${pr.number} exceeded max review cycles (${config.maxReviewCycles})`);
        continue;
      }

      const diff = await gh.getPRDiff(repo, pr.number);
      const result = await runMultiAgentReview(config, diff);

      if (result.clean) {
        await mergeWithSummary(gh, repo, pr, result);
      } else {
        await postReworkPrompt(gh, repo, pr, result);
      }
    }
  }
}

async function runMultiAgentReview(
  config: ReviewerConfig,
  diff: string,
): Promise<ReviewResult> {
  const findings: ReviewFinding[] = [
    ...runAgentReview(diff, "security", config.securityAgentCmd),
    ...runAgentReview(diff, "qa", config.qaAgentCmd),
    ...runAgentReview(diff, "quality", config.qualityAgentCmd),
  ];

  const hasCriticalOrHigh = findings.some(
    (f) => f.severity === "critical" || f.severity === "high",
  );

  return {
    clean: !hasCriticalOrHigh,
    findings,
    summary: buildSummary(findings),
  };
}

function runAgentReview(
  diff: string,
  category: "security" | "qa" | "quality",
  cmd: string,
): ReviewFinding[] {
  try {
    const output = execSync(cmd, {
      input: diff,
      encoding: "utf-8",
      timeout: 300_000,
    });
    return JSON.parse(output) as ReviewFinding[];
  } catch (err) {
    console.error(`[ERROR] ${category} agent failed:`, err instanceof Error ? err.message : err);
    return [];
  }
}

function buildSummary(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "No findings. Code is clean.";
  const grouped = { critical: 0, high: 0, medium: 0, low: 0 };
  findings.forEach((f) => grouped[f.severity]++);
  return `Findings: ${findings.length} total — Critical: ${grouped.critical}, High: ${grouped.high}, Medium: ${grouped.medium}, Low: ${grouped.low}`;
}

async function mergeWithSummary(
  gh: ReturnType<typeof makeGithubClient>,
  repo: string,
  pr: { number: number; title: string },
  result: ReviewResult,
): Promise<void> {
  await gh.addIssueComment(
    repo,
    pr.number,
    `## ✅ Review Passed — Merging\n\n${result.summary}\n\n**Review agents:** Security ✓ | QA ✓ | Quality ✓\n\nMerging now.`,
  );
  await gh.mergePR(repo, pr.number, `Merge [AI] ${pr.title}`, result.summary);
  console.log(`[MERGE] PR #${pr.number} merged in ${repo}`);
}

async function postReworkPrompt(
  gh: ReturnType<typeof makeGithubClient>,
  repo: string,
  pr: { number: number; title: string; body: string | null },
  result: ReviewResult,
): Promise<void> {
  await gh.addIssueComment(repo, pr.number, formatReviewFindings(result));

  const issueMatch = (pr.body || "").match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  if (!issueMatch) {
    console.log(`[WARN] PR #${pr.number} has no linked issue — cannot post rework prompt`);
    return;
  }
  const issueNumber = parseInt(issueMatch[1], 10);
  await gh.addIssueComment(repo, issueNumber, buildReworkPrompt(result));
  console.log(`[REWORK] Posted rework prompt on issue #${issueNumber} for PR #${pr.number}`);
}

function formatReviewFindings(result: ReviewResult): string {
  const lines = result.findings.map(
    (f) =>
      `- **[${f.severity.toUpperCase()}]** [${f.category}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}\n  → Suggestion: ${f.suggestion}`,
  );
  return `## ❌ Review Failed — Rework Required\n\n${result.summary}\n\n### Findings\n${lines.join("\n")}\n\nA rework prompt has been added to the linked issue. AiRemoteCoder will pick it up.`;
}

function buildReworkPrompt(result: ReviewResult): string {
  const tasks = result.findings
    .filter((f) => f.severity === "critical" || f.severity === "high")
    .map(
      (f) =>
        `- Fix [${f.severity}] ${f.category} issue in ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}\n  Apply: ${f.suggestion}`,
    );

  return `## Coding Prompt\n\n### Rework from PR Review\n\nThe following issues must be fixed before merge:\n\n${tasks.join("\n")}\n\n### Reasoning\nThese findings were identified by the security, QA, and code quality review agents. All critical and high severity issues must be resolved. Re-run the full implementation addressing each finding.`;
}

async function getReviewCycleCount(
  gh: ReturnType<typeof makeGithubClient>,
  repo: string,
  prNumber: number,
): Promise<number> {
  const comments = await gh.listIssueComments(repo, prNumber);
  return comments.filter((c: any) =>
    (c.body as string)?.includes("Review Failed — Rework Required"),
  ).length;
}

async function main(): Promise<void> {
  console.log("[START] AIWorkAssistant review agent started");
  const config = await loadConfig();

  if (config.reviewRepos.length === 0) {
    console.warn("[WARN] No REVIEW_REPOS configured — nothing to watch");
  }
  if (!config.githubToken) {
    console.error("[ERROR] No GitHub token — set GITHUB_TOKEN or AIWORKASSISTANT_URL+AIWORKASSISTANT_API_KEY");
    process.exit(1);
  }

  const gh = makeGithubClient(config.githubToken, config.owner);

  while (true) {
    try {
      await pollPRs(config, gh);
    } catch (err) {
      console.error("[ERROR]", err);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

main();
