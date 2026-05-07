import * as fs from "fs";
import * as path from "path";
import { githubClient } from "../integrations/github/github-client";
import { roadmapDatabase, Roadmap, Milestone, RoadmapItem } from "../roadmap/database";
import { codebaseIndexer } from "../agent/codebase-indexer";

export type TicketToTaskAgent = "codex" | "cursor" | "claude" | "generic";

export class MissingCodingPromptError extends Error {
  readonly issueNumber: number;
  readonly labels: string[];
  constructor(issueNumber: number, labels: string[]) {
    super(
      `Issue #${issueNumber} is tagged missing-coding-prompt. Add a ## Coding Prompt section before handing to an agent.`,
    );
    this.name = "MissingCodingPromptError";
    this.issueNumber = issueNumber;
    this.labels = labels;
  }
}

export interface TicketToTaskOptions {
  owner: string;
  repo: string;
  issueNumber: number;
  agent?: TicketToTaskAgent;
  includeComments?: boolean;
  includeRoadmap?: boolean;
  includeCodebase?: boolean;
  maxCodebaseFiles?: number;
  skipIfMissingPrompt?: boolean;
}

export interface ImplementationPrompt {
  title: string;
  body: string;
  metadata: {
    issueNumber: number;
    issueUrl: string;
    labels: string[];
    milestone: string | null;
    assignee: string | null;
    createdAt: string;
    updatedAt: string;
    relatedIssues: number[];
    relevantFiles: string[];
    roadmapItemId: string | null;
    hasCodingPrompt: boolean;
    codingPrompt: string | null;
  };
}

interface CachedIssue {
  issue: any;
  comments: any[];
  fetchedComments: boolean;
  fetchedAt: number;
}

interface RoadmapMatch {
  roadmap: Roadmap;
  milestone: Milestone;
  item: RoadmapItem;
  score: number;
}

interface RelevantFile {
  file: string;
  reason: string;
  score: number;
}

const issueCache = new Map<string, CachedIssue>();
const pendingIssueFetches = new Map<string, Promise<CachedIssue>>();
const RATE_LIMIT_MS = 60_000;

class TicketToTaskGenerator {
  async generate(options: TicketToTaskOptions): Promise<ImplementationPrompt> {
    const resolved = githubClient.resolveRepo(options.owner, options.repo);
    const agent = this.normalizeAgent(options.agent);
    const includeComments = options.includeComments ?? true;
    const includeRoadmap = options.includeRoadmap ?? true;
    const includeCodebase = options.includeCodebase ?? true;
    const maxCodebaseFiles = options.maxCodebaseFiles ?? 10;
    const skipIfMissingPrompt = options.skipIfMissingPrompt ?? true;

    const { issue, comments } = await this.fetchIssue({
      owner: resolved.owner,
      repo: resolved.repo,
      issueNumber: options.issueNumber,
      includeComments,
    });

    const labels = this.labelNames(issue);
    if (skipIfMissingPrompt && labels.includes("missing-coding-prompt")) {
      throw new MissingCodingPromptError(options.issueNumber, labels);
    }

    const body = issue.body || "";
    const codingPrompt = this.extractCodingPrompt(body);
    const relatedIssues = this.extractRelatedIssues(body, comments, options.issueNumber);
    const acceptanceCriteria = this.extractAcceptanceCriteria(body);
    const roadmapMatch = includeRoadmap ? this.findRoadmapMatch(issue, relatedIssues) : null;
    const relevantFiles = includeCodebase
      ? await this.findRelevantFiles(issue, comments, resolved.owner, resolved.repo, maxCodebaseFiles)
      : [];

    const promptBody = this.buildPrompt({
      owner: resolved.owner,
      repo: resolved.repo,
      issue,
      comments: includeComments ? comments : [],
      acceptanceCriteria,
      relatedIssues,
      roadmapMatch,
      relevantFiles,
      agent,
      codingPrompt,
    });

    const prompt: ImplementationPrompt = {
      title: `Implementation Task: ${issue.title}`,
      body: promptBody,
      metadata: {
        issueNumber: issue.number,
        issueUrl: issue.html_url,
        labels,
        milestone: issue.milestone?.title || null,
        assignee: issue.assignee?.login || null,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        relatedIssues,
        relevantFiles: relevantFiles.map((f) => f.file),
        roadmapItemId: roadmapMatch?.item.id || null,
        hasCodingPrompt: codingPrompt !== null,
        codingPrompt,
      },
    };

    if (agent === "codex") {
      fs.writeFileSync(path.join(process.cwd(), "CODEX.md"), this.buildCodexFile(prompt), "utf-8");
    }
    if (agent === "cursor") {
      fs.writeFileSync(path.join(process.cwd(), ".cursorrules"), this.buildCursorFile(prompt), "utf-8");
    }

    return prompt;
  }

  private async fetchIssue(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    includeComments: boolean;
  }): Promise<CachedIssue> {
    const key = `${input.owner}/${input.repo}#${input.issueNumber}`;
    const cached = issueCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < RATE_LIMIT_MS) {
      return cached;
    }

    const pending = pendingIssueFetches.get(key);
    if (pending) return pending;

    const fetchPromise = (async () => {
      const issue = await githubClient.getIssue(input.issueNumber, input.owner, input.repo);
      const comments = input.includeComments
        ? await githubClient.listIssueComments(input.issueNumber, input.owner, input.repo)
        : [];
      const value = {
        issue,
        comments,
        fetchedComments: input.includeComments,
        fetchedAt: Date.now(),
      };
      issueCache.set(key, value);
      pendingIssueFetches.delete(key);
      return value;
    })().catch((error) => {
      pendingIssueFetches.delete(key);
      throw error;
    });

    pendingIssueFetches.set(key, fetchPromise);
    return fetchPromise;
  }

  private extractCodingPrompt(body: string): string | null {
    const headingPattern = /^#{1,3}\s+coding\s+prompt\b/im;
    const match = headingPattern.exec(body);
    if (!match) return null;

    const start = match.index;
    const afterHeading = body.slice(start);
    const nextH2 = afterHeading.slice(match[0].length).search(/\n#{1,2}\s+\S/);
    const section =
      nextH2 === -1
        ? afterHeading
        : afterHeading.slice(0, match[0].length + nextH2);

    return section.trim() || null;
  }

  hasCodingPromptContent(body: string): boolean {
    return (
      /^#{1,3}\s+coding\s+prompt\b/im.test(body) ||
      /^#{1,3}\s+current\s+code\b/im.test(body) ||
      /^#{1,3}\s+replacement\s+code\b/im.test(body) ||
      /^#{1,3}\s+file:/im.test(body)
    );
  }

  private extractAcceptanceCriteria(body: string): string[] {
    const criteria = body
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/)?.[1])
      .filter((line): line is string => Boolean(line));
    return [...new Set(criteria)];
  }

  private extractRelatedIssues(body: string, comments: any[], currentIssue: number): number[] {
    const text = [body, ...comments.map((c) => c.body || "")].join("\n");
    const numbers = [...text.matchAll(/(?<![\w/-])#(\d+)\b/g)]
      .map((match) => Number(match[1]))
      .filter((n) => Number.isInteger(n) && n !== currentIssue);
    return [...new Set(numbers)].sort((a, b) => a - b);
  }

  private findRoadmapMatch(issue: any, relatedIssues: number[]): RoadmapMatch | null {
    const roadmaps = roadmapDatabase.listRoadmaps({ status: "active" });
    const fallbackRoadmaps = roadmaps.length > 0 ? roadmaps : roadmapDatabase.listRoadmaps();
    const title = issue.title || "";
    const body = issue.body || "";
    const labels = this.labelNames(issue).join(" ");
    const candidates: RoadmapMatch[] = [];

    for (const roadmap of fallbackRoadmaps) {
      const milestones = roadmapDatabase.getMilestones(roadmap.id);
      for (const milestone of milestones) {
        const items = roadmapDatabase.getItems(milestone.id);
        for (const item of items) {
          const haystack = [
            roadmap.name,
            roadmap.description,
            milestone.name,
            milestone.description,
            item.title,
            item.description,
            item.jiraKey,
          ]
            .filter(Boolean)
            .join(" ");
          const score =
            this.similarity(title, item.title) * 8 +
            this.similarity(`${title} ${body} ${labels}`, haystack) * 4 +
            (relatedIssues.some((n) => haystack.includes(`#${n}`)) ? 3 : 0) +
            (haystack.includes(`#${issue.number}`) ? 10 : 0);
          if (score > 1) candidates.push({ roadmap, milestone, item, score });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  private async findRelevantFiles(
    issue: any,
    comments: any[],
    owner: string,
    repo: string,
    limit: number,
  ): Promise<RelevantFile[]> {
    const text = [issue.title, issue.body || "", ...comments.map((c) => c.body || "")].join("\n");
    const files = new Map<string, RelevantFile>();

    for (const filePath of this.extractFilePaths(text)) {
      if (fs.existsSync(path.join(process.cwd(), filePath))) {
        this.addRelevantFile(files, filePath, "Explicitly mentioned in the issue", 100);
      }
    }

    const stats = codebaseIndexer.getStats();
    if (stats.totalChunks === 0) {
      await codebaseIndexer.indexCodebase();
    }

    const searchTerms = this.extractSearchTerms(text).slice(0, 8);
    for (const term of searchTerms) {
      const results = codebaseIndexer.search(term, { limit: 5 });
      for (const result of results) {
        this.addRelevantFile(
          files,
          result.filePath,
          `${result.matchType} match for "${term}"`,
          result.score,
        );
      }
    }

    for (const symbol of this.extractSymbols(text).slice(0, 8)) {
      try {
        const results = await githubClient.searchCode(symbol, owner, repo);
        for (const result of results.slice(0, 3)) {
          this.addRelevantFile(files, result.path, `GitHub code search match for "${symbol}"`, 12);
        }
      } catch {}
    }

    return [...files.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private extractFilePaths(text: string): string[] {
    const matches = text.match(/\b(?:src|tests|web|docs|scripts|\.github)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+\b/g) || [];
    return [...new Set(matches.map((m) => m.replace(/\\/g, "/")))];
  }

  private extractSearchTerms(text: string): string[] {
    const words = text
      .replace(/`[^`]+`/g, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .split(/[^A-Za-z0-9_-]+/)
      .filter((word) => word.length >= 4 && !/^\d+$/.test(word));
    const counts = new Map<string, number>();
    const stop = new Set([
      "with",
      "that",
      "this",
      "from",
      "have",
      "issue",
      "task",
      "will",
      "should",
      "when",
      "where",
      "into",
      "file",
      "code",
      "context",
      "github",
    ]);
    for (const word of words) {
      const key = word.toLowerCase();
      if (stop.has(key)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([word]) => word);
  }

  private extractSymbols(text: string): string[] {
    const matches = text.match(/\b[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g) || [];
    return [...new Set(matches)];
  }

  private addRelevantFile(files: Map<string, RelevantFile>, file: string, reason: string, score: number) {
    const existing = files.get(file);
    if (!existing) {
      files.set(file, { file, reason, score });
      return;
    }
    existing.score += score;
    if (!existing.reason.includes(reason)) {
      existing.reason = `${existing.reason}; ${reason}`;
    }
  }

  private buildPrompt(input: {
    owner: string;
    repo: string;
    issue: any;
    comments: any[];
    acceptanceCriteria: string[];
    relatedIssues: number[];
    roadmapMatch: RoadmapMatch | null;
    relevantFiles: RelevantFile[];
    agent: TicketToTaskAgent;
    codingPrompt: string | null;
  }): string {
    const labels = this.labelNames(input.issue);
    const milestone = input.issue.milestone;
    const roadmap = input.roadmapMatch;
    const objective = this.objective(input.issue);
    const agentInstructions = this.agentInstructions(input.agent);
    const acceptance = input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")
      : "- No checkbox acceptance criteria were found in the issue body. Derive tests and completion checks from the full issue spec.";
    const files = input.relevantFiles.length > 0
      ? input.relevantFiles.map((f) => `| \`${f.file}\` | ${f.reason} |`).join("\n")
      : "| No strong matches found | Start with repository search and the issue spec |";
    const related = input.relatedIssues.length > 0
      ? input.relatedIssues.map((n) => `- #${n}`).join("\n")
      : "- None detected";
    const comments = input.comments.length > 0
      ? input.comments
          .map((c) => `### ${c.user?.login || "unknown"} at ${c.created_at}\n${c.body || ""}`)
          .join("\n\n")
      : "No comments included.";

    const codingPromptSection = input.codingPrompt
      ? `\n## ⚡ Coding Prompt (Authoritative — Follow Exactly)\n\n${input.codingPrompt}\n`
      : `\n## ⚠️ Coding Prompt Missing\n\nNo \`## Coding Prompt\` section was found in this issue. The agent should derive implementation intent from the full spec above, but precision may be reduced.\n`;

    return `# Implementation Task: ${input.issue.title}

## Source
- **GitHub Issue**: ${input.owner}/${input.repo}#${input.issue.number}
- **URL**: ${input.issue.html_url}
- **Labels**: ${labels.length > 0 ? labels.join(", ") : "None"}
- **Milestone**: ${milestone ? `${milestone.title}${milestone.due_on ? ` (target: ${milestone.due_on})` : ""}` : "None"}
- **Assignee**: ${input.issue.assignee?.login || "Unassigned"}
- **Roadmap Item**: ${roadmap ? `${roadmap.item.title} (priority: ${roadmap.item.priority}, status: ${roadmap.item.status})` : "No roadmap match found"}
- **Issue Updated**: ${input.issue.updated_at}
${codingPromptSection}
## Objective
${objective}

## Full Issue Spec
${input.issue.body || "_No issue body provided._"}

## Acceptance Criteria
${acceptance}

## Relevant Codebase Files
| File | Why It's Relevant |
|------|-------------------|
${files}

## Related Issues
${related}

## Roadmap Context
${roadmap ? this.roadmapText(roadmap) : "No matching roadmap item was found. Continue using the issue spec as the source of truth."}

## Issue Comments
${comments}

## Implementation Notes
- Preserve existing repository patterns and TypeScript strictness.
- Use configured GitHub defaults when owner/repo are omitted.
- Handle missing roadmap matches and missing acceptance criteria gracefully.
- Keep the implementation scoped to the issue and verify with focused tests plus \`npx tsc --noEmit\`.

## Agent-Specific Instructions
${agentInstructions}
`;
  }

  private buildCodexFile(prompt: ImplementationPrompt): string {
    return `# Codex Implementation Context

Use this file as the active implementation brief for Codex CLI work in this repository.

- GitHub Issue: ${prompt.metadata.issueUrl}
- Issue Number: #${prompt.metadata.issueNumber}
- Updated At: ${prompt.metadata.updatedAt}
- Relevant Files: ${prompt.metadata.relevantFiles.length > 0 ? prompt.metadata.relevantFiles.map((f) => `\`${f}\``).join(", ") : "None detected"}

The full generated prompt is below.

${prompt.body}
`;
  }

  private buildCursorFile(prompt: ImplementationPrompt): string {
    return `You are working from GitHub issue #${prompt.metadata.issueNumber}: ${prompt.metadata.issueUrl}

Use the generated implementation prompt below as the source of truth.
Prioritize the relevant files first: ${prompt.metadata.relevantFiles.length > 0 ? prompt.metadata.relevantFiles.join(", ") : "none detected"}.
Keep edits scoped, preserve existing repository style, and update nearby tests for changed behavior.

${prompt.body}
`;
  }

  private roadmapText(match: RoadmapMatch): string {
    return [
      `- **Roadmap**: ${match.roadmap.name} (${match.roadmap.status})`,
      `- **Milestone**: ${match.milestone.name} (target: ${match.milestone.targetDate}, status: ${match.milestone.status})`,
      `- **Item**: ${match.item.title}`,
      `- **Priority**: ${match.item.priority}`,
      `- **Status**: ${match.item.status}`,
      match.item.description ? `- **Item Description**: ${match.item.description}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private objective(issue: any): string {
    const body = issue.body || "";
    const firstParagraph = body
      .split(/\n\s*\n/)
      .map((p: string) => p.trim())
      .find((p: string) => p && !p.startsWith("#"));
    return firstParagraph
      ? `${issue.title}\n\n${firstParagraph.slice(0, 600)}`
      : `Implement the behavior described by GitHub issue #${issue.number}: ${issue.title}.`;
  }

  private agentInstructions(agent: TicketToTaskAgent): string {
    switch (agent) {
      case "codex":
        return "Codex reads AGENTS.md automatically. Make the requested code changes directly, keep edits scoped, avoid unrelated refactors, and run the relevant verification commands before reporting completion.";
      case "cursor":
        return "Use the file table as the first navigation map. Prefer small file-level edits, preserve existing style, and update tests close to the changed behavior.";
      case "claude":
        return "Use the complete issue, comments, roadmap context, and file map as the implementation source. State assumptions before coding if a requirement is ambiguous.";
      default:
        return "Use the full issue spec, acceptance criteria, roadmap context, and file map to implement the task with focused tests.";
    }
  }

  private normalizeAgent(agent: unknown): TicketToTaskAgent {
    return agent === "codex" || agent === "cursor" || agent === "claude" || agent === "generic"
      ? agent
      : "generic";
  }

  private labelNames(issue: any): string[] {
    return (issue.labels || []).map((label: any) => (typeof label === "string" ? label : label.name)).filter(Boolean);
  }

  private similarity(a: string, b: string | null): number {
    if (!a || !b) return 0;
    const left = new Set(this.tokens(a));
    const right = new Set(this.tokens(b));
    if (left.size === 0 || right.size === 0) return 0;
    const intersection = [...left].filter((token) => right.has(token)).length;
    const union = new Set([...left, ...right]).size;
    return intersection / union;
  }

  private tokens(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2);
  }
}

export const ticketToTaskGenerator = new TicketToTaskGenerator();
