import * as fs from "fs";
import * as path from "path";
import { jiraClient } from "../jira/jira-client";
import { roadmapDatabase } from "../../roadmap/database";
import type { Roadmap, Milestone, RoadmapItem } from "../../roadmap/database";
import { codebaseIndexer } from "../../agent/codebase-indexer";
import {
  ticketToTaskGenerator,
  MissingCodingPromptError,
} from "../../engineering/ticket-to-task";

export type TicketSourceType = "github" | "jira" | "roadmap";

export interface TicketSource {
  type: TicketSourceType;
  id: string;
}

export interface PromptContext {
  includeCodebaseIndex: boolean;
  includeArchitecture: boolean;
  includeRelatedTickets: boolean;
  includeAcceptanceCriteria: boolean;
  maxFiles: number;
  maxTokens: number;
  skipMissingCodingPrompt: boolean;
}

export interface GeneratedPrompt {
  prompt: string;
  title: string;
  source: TicketSource;
  filesReferenced: string[];
  tokensEstimate: number;
  hasCodingPrompt: boolean;
  codingPrompt: string | null;
  skipped: boolean;
  skipReason: string | null;
}

const DEFAULT_CONTEXT: PromptContext = {
  includeCodebaseIndex: true,
  includeArchitecture: true,
  includeRelatedTickets: true,
  includeAcceptanceCriteria: true,
  maxFiles: 10,
  maxTokens: 8000,
  skipMissingCodingPrompt: true,
};

class TicketBridge {
  async generatePrompt(
    source: TicketSource,
    context: Partial<PromptContext> = {},
  ): Promise<GeneratedPrompt> {
    const ctx = { ...DEFAULT_CONTEXT, ...context };

    switch (source.type) {
      case "github":
        return this.generateFromGitHub(source, ctx);
      case "jira":
        return this.generateFromJira(source, ctx);
      case "roadmap":
        return this.generateFromRoadmap(source, ctx);
    }
  }

  async generateBatch(
    roadmapId: string,
    milestoneName: string | undefined,
    outputDir: string,
    context: Partial<PromptContext> = {},
  ): Promise<{ file: string; source: TicketSource; title: string }[]> {
    const milestones = roadmapDatabase.getMilestones(roadmapId);
    if (milestones.length === 0) {
      throw new Error(`No milestones found for roadmap: ${roadmapId}`);
    }

    const filtered = milestoneName
      ? milestones.filter((m) =>
          m.name.toLowerCase().includes(milestoneName.toLowerCase()),
        )
      : milestones;

    if (filtered.length === 0) {
      throw new Error(
        `No milestones matching "${milestoneName}" in roadmap ${roadmapId}`,
      );
    }

    const allItems: { item: RoadmapItem; milestone: Milestone }[] = [];
    for (const milestone of filtered) {
      const items = roadmapDatabase.getItems(milestone.id);
      for (const item of items) {
        allItems.push({ item, milestone });
      }
    }

    if (allItems.length === 0) {
      throw new Error(`No items found in the selected milestone(s)`);
    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const results: { file: string; source: TicketSource; title: string }[] = [];

    for (let i = 0; i < allItems.length; i++) {
      const { item } = allItems[i];
      const source: TicketSource = { type: "roadmap", id: item.id };
      const generated = await this.generatePrompt(source, context);

      const slug = item.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50);
      const fileName = `${String(i + 1).padStart(3, "0")}-${slug}.md`;
      const filePath = path.join(outputDir, fileName);

      fs.writeFileSync(filePath, generated.prompt, "utf-8");
      results.push({ file: filePath, source, title: item.title });
    }

    return results;
  }

  parseGitHubSourceId(
    repoSpec: string,
    issueNumber?: string,
  ): { owner: string; repo: string; issueNumber: number } {
    if (issueNumber) {
      const num = Number(issueNumber);
      if (!Number.isInteger(num) || num <= 0) {
        throw new Error(`Invalid issue number: ${issueNumber}`);
      }
      const parts = repoSpec.split("/");
      if (parts.length < 2) {
        throw new Error(
          `Invalid repo spec "${repoSpec}". Expected "owner/repo".`,
        );
      }
      return { owner: parts[0], repo: parts[1], issueNumber: num };
    }

    const hashMatch = repoSpec.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (hashMatch) {
      return {
        owner: hashMatch[1],
        repo: hashMatch[2],
        issueNumber: Number(hashMatch[3]),
      };
    }

    const spaceMatch = repoSpec.match(/^([^/]+)\/([^\s]+)\s+(\d+)$/);
    if (spaceMatch) {
      return {
        owner: spaceMatch[1],
        repo: spaceMatch[2],
        issueNumber: Number(spaceMatch[3]),
      };
    }

    throw new Error(
      `Invalid GitHub source "${repoSpec}". Use "owner/repo#25" or "owner/repo 25".`,
    );
  }

  private async generateFromGitHub(
    source: TicketSource,
    ctx: PromptContext,
  ): Promise<GeneratedPrompt> {
    const parsed = this.parseGitHubSourceId(source.id);

    let result;
    try {
      result = await ticketToTaskGenerator.generate({
        owner: parsed.owner,
        repo: parsed.repo,
        issueNumber: parsed.issueNumber,
        agent: "generic",
        includeComments: true,
        includeRoadmap: ctx.includeRelatedTickets,
        includeCodebase: ctx.includeCodebaseIndex,
        maxCodebaseFiles: ctx.maxFiles,
        skipIfMissingPrompt: ctx.skipMissingCodingPrompt,
      });
    } catch (err) {
      if (err instanceof MissingCodingPromptError) {
        return {
          prompt: "",
          title: `Issue #${parsed.issueNumber}`,
          source,
          filesReferenced: [],
          tokensEstimate: 0,
          hasCodingPrompt: false,
          codingPrompt: null,
          skipped: true,
          skipReason: "missing-coding-prompt",
        };
      }
      throw err;
    }

    return {
      prompt: result.body,
      title: result.title.replace(/^Implementation Task:\s*/i, ""),
      source,
      filesReferenced: result.metadata.relevantFiles,
      tokensEstimate: Math.ceil(result.body.length / 4),
      hasCodingPrompt: result.metadata.hasCodingPrompt,
      codingPrompt: result.metadata.codingPrompt,
      skipped: false,
      skipReason: null,
    };
  }

  private async generateFromJira(
    source: TicketSource,
    ctx: PromptContext,
  ): Promise<GeneratedPrompt> {
    const issue = await jiraClient.getIssue(source.id);

    const jiraLabels: string[] = (issue.fields as any).labels || [];
    if (
      ctx.skipMissingCodingPrompt &&
      jiraLabels.includes("missing-coding-prompt")
    ) {
      return {
        prompt: "",
        title: (issue.fields?.summary as string) || source.id,
        source,
        filesReferenced: [],
        tokensEstimate: 0,
        hasCodingPrompt: false,
        codingPrompt: null,
        skipped: true,
        skipReason: "missing-coding-prompt",
      };
    }

    const comments = await jiraClient.getComments(source.id);

    const body = this.extractJiraBody(issue);
    const codingPrompt = this.extractCodingPromptSection(body);
    const acceptanceCriteria = ctx.includeAcceptanceCriteria
      ? this.extractAcceptanceCriteria(body)
      : [];

    let filesReferenced: string[] = [];
    if (ctx.includeCodebaseIndex) {
      filesReferenced = await this.findRelevantFiles(
        `${issue.fields.summary} ${body}`,
        ctx.maxFiles,
      );
    }

    const prompt = this.buildJiraPrompt({
      issue,
      comments,
      body,
      acceptanceCriteria,
      relevantFiles: filesReferenced,
      codingPrompt,
      ctx,
    });

    return {
      prompt,
      title: (issue.fields?.summary as string) || source.id,
      source,
      filesReferenced,
      tokensEstimate: Math.ceil(prompt.length / 4),
      hasCodingPrompt: codingPrompt !== null,
      codingPrompt,
      skipped: false,
      skipReason: null,
    };
  }

  private async generateFromRoadmap(
    source: TicketSource,
    ctx: PromptContext,
  ): Promise<GeneratedPrompt> {
    const found = this.findRoadmapItemById(source.id);
    if (!found) {
      throw new Error(`Roadmap item not found: ${source.id}`);
    }
    const { item, milestone, roadmap } = found;

    const description = item.description || "";
    const acceptanceCriteria = ctx.includeAcceptanceCriteria
      ? this.extractAcceptanceCriteria(description)
      : [];

    let filesReferenced: string[] = [];
    if (ctx.includeCodebaseIndex) {
      filesReferenced = await this.findRelevantFiles(
        `${item.title} ${description}`,
        ctx.maxFiles,
      );
    }

    const prompt = this.buildRoadmapPrompt({
      item,
      milestone,
      roadmap,
      acceptanceCriteria,
      relevantFiles: filesReferenced,
    });

    return {
      prompt,
      title: item.title,
      source,
      filesReferenced,
      tokensEstimate: Math.ceil(prompt.length / 4),
      hasCodingPrompt: false,
      codingPrompt: null,
      skipped: false,
      skipReason: null,
    };
  }

  private findRoadmapItemById(
    id: string,
  ): { item: RoadmapItem; milestone: Milestone; roadmap: Roadmap } | null {
    const roadmaps = roadmapDatabase.listRoadmaps();
    for (const roadmap of roadmaps) {
      const milestones = roadmapDatabase.getMilestones(roadmap.id);
      for (const milestone of milestones) {
        const items = roadmapDatabase.getItems(milestone.id);
        const item = items.find((i) => i.id === id);
        if (item) return { item, milestone, roadmap };
      }
    }
    return null;
  }

  private extractJiraBody(issue: any): string {
    const desc = issue.fields?.description;
    if (!desc) return "";
    if (typeof desc === "string") return desc;
    if (desc.content) return this.extractAdfText(desc);
    return String(desc);
  }

  private extractAdfText(node: any): string {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (node.type === "text") return node.text || "";
    if (node.content) {
      return (node.content as any[])
        .map((child) => this.extractAdfText(child))
        .join("\n");
    }
    return "";
  }

  private extractCodingPromptSection(body: string): string | null {
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

  private extractAcceptanceCriteria(body: string): string[] {
    const criteria = body
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/)?.[1])
      .filter((line): line is string => Boolean(line));
    return [...new Set(criteria)];
  }

  private async findRelevantFiles(
    text: string,
    limit: number,
  ): Promise<string[]> {
    const stats = codebaseIndexer.getStats();
    if (stats.totalChunks === 0) {
      await codebaseIndexer.indexCodebase();
    }

    const words = text
      .split(/[^A-Za-z0-9_-]+/)
      .filter((w) => w.length >= 4)
      .slice(0, 8);

    const scores = new Map<string, number>();
    for (const word of words) {
      const results = codebaseIndexer.search(word, { limit: 5 });
      for (const result of results) {
        scores.set(
          result.filePath,
          (scores.get(result.filePath) || 0) + result.score,
        );
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([file]) => file);
  }

  private buildJiraPrompt(input: {
    issue: any;
    comments: any[];
    body: string;
    acceptanceCriteria: string[];
    relevantFiles: string[];
    codingPrompt: string | null;
    ctx: PromptContext;
  }): string {
    const { issue, comments, body, acceptanceCriteria, relevantFiles, codingPrompt } = input;
    const key = issue.key as string;
    const summary = (issue.fields?.summary as string) || key;
    const status = (issue.fields?.status?.name as string) || "Unknown";
    const priority = (issue.fields?.priority?.name as string) || "Unknown";
    const assignee =
      (issue.fields?.assignee?.displayName as string) || "Unassigned";
    const project = (issue.fields?.project?.key as string) || "";
    const issueType = (issue.fields?.issuetype?.name as string) || "Issue";

    const acceptance =
      acceptanceCriteria.length > 0
        ? acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")
        : "- No checkbox acceptance criteria found. Derive tests from the full spec below.";

    const files =
      relevantFiles.length > 0
        ? relevantFiles.map((f) => `- \`${f}\``).join("\n")
        : "- No strong matches found. Start with repository search and the issue spec.";

    const commentText =
      comments.length > 0
        ? comments
            .map((c: any) => {
              const author =
                (c.author?.displayName as string) || "unknown";
              const cbody =
                typeof c.body === "string"
                  ? c.body
                  : this.extractAdfText(c.body);
              return `### ${author} at ${c.created as string}\n${cbody}`;
            })
            .join("\n\n")
        : "No comments.";

    const codingPromptSection = codingPrompt
      ? `\n## ⚡ Coding Prompt (Authoritative — Follow Exactly)\n\n${codingPrompt}\n`
      : `\n## ⚠️ Coding Prompt Missing\n\nNo \`## Coding Prompt\` section found. Derive implementation intent from the full spec.\n`;

    return `# Implementation Task: ${summary}

## Source
- **Jira Issue**: ${key}
- **Type**: ${issueType}
- **Status**: ${status}
- **Priority**: ${priority}
- **Assignee**: ${assignee}
- **Project**: ${project}
${codingPromptSection}
## Objective
Implement the behavior described by Jira issue ${key}: ${summary}

## Full Issue Spec
${body || "_No description provided._"}

## Acceptance Criteria
${acceptance}

## Relevant Codebase Files
${files}

## Issue Comments
${commentText}

${this.architectureSection()}

## Important
- Read the FULL ticket before starting. Every detail matters.
- Follow the acceptance criteria exactly. Do not skip any item.
- Do NOT add features or changes not specified in the ticket.
- If you find ambiguities, prefer the simplest interpretation.
- Run \`npm run build\` and \`npm test\` before finishing.
`;
  }

  private buildRoadmapPrompt(input: {
    item: RoadmapItem;
    milestone: Milestone;
    roadmap: Roadmap;
    acceptanceCriteria: string[];
    relevantFiles: string[];
  }): string {
    const { item, milestone, roadmap, acceptanceCriteria, relevantFiles } =
      input;

    const acceptance =
      acceptanceCriteria.length > 0
        ? acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")
        : "- No checkbox acceptance criteria found. Derive tests from the full spec below.";

    const files =
      relevantFiles.length > 0
        ? relevantFiles.map((f) => `- \`${f}\``).join("\n")
        : "- No strong matches found. Start with repository search and the item spec.";

    return `# Implementation Task: ${item.title}

## Source
- **Roadmap Item ID**: ${item.id}
- **Roadmap**: ${roadmap.name}
- **Milestone**: ${milestone.name}${milestone.targetDate ? ` (target: ${milestone.targetDate})` : ""}
- **Priority**: ${item.priority}
- **Status**: ${item.status}

## Objective
Implement the roadmap item: ${item.title}

## Full Item Spec
${item.description || "_No description provided._"}

## Acceptance Criteria
${acceptance}

## Relevant Codebase Files
${files}

${this.architectureSection()}

## Important
- Read the FULL spec before starting. Every detail matters.
- Follow the acceptance criteria exactly. Do not skip any item.
- Do NOT add features or changes not specified in the item.
- If you find ambiguities, prefer the simplest interpretation.
- Run \`npm run build\` and \`npm test\` before finishing.
`;
  }

  private architectureSection(): string {
    return `## Architecture Constraints
- TypeScript strict mode (noUnusedLocals, noUnusedParameters, noImplicitReturns)
- ES2022 modules with import/export
- Singleton exports: \`export const foo = new Foo()\`
- Policy-gated services: business logic in \`*-service.ts\` wraps client calls
- SQLite via better-sqlite3 for persistence
- Zod for validation
- No comments unless explicitly requested

## Commands
- \`npm run dev\` — tsx watch with hot-reload
- \`npm run build\` — tsc compilation
- \`npm test\` — Vitest run
- \`npm run lint\` — ESLint on src/**/*.{ts,tsx}\``;
  }
}

export const ticketBridge = new TicketBridge();
