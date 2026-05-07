/**
 * Source resolver — determines which integration (GitHub, GitLab, Jira, Jitbit)
 * to use for fetching work items.
 *
 * Two modes:
 *   memory  — check .aicoder/source-cache.json first; if not cached, do a one-time
 *             LLM lookup and cache the result.
 *   llm     — call the LLM every poll cycle to classify the source.
 *   auto    — alias for "memory" (default)
 */

import * as fs from "fs";
import * as path from "path";
import axios from "axios";

export type TicketSourceType = "github" | "gitlab" | "jira" | "jitbit";
export type LookupMode = "memory" | "llm" | "auto";

interface SourceCache {
  /** repo/key → source type mapping */
  entries: Record<string, TicketSourceType>;
}

const CACHE_FILE = "source-cache.json";

export class SourceResolver {
  private cache: SourceCache;
  private cachePath: string;
  private cacheDirty = false;

  constructor(
    workspace: string,
    private mode: LookupMode,
    private apiUrl: string,
    private apiKey: string,
  ) {
    this.cachePath = path.join(workspace, ".aicoder", CACHE_FILE);
    this.cache = { entries: {} };
    this.loadCache();
  }

  /** Resolve the source type for a given issue identifier. */
  async resolve(identifier: string, title: string, url?: string): Promise<TicketSourceType> {
    // For "auto" mode, use memory strategy
    const effectiveMode = this.mode === "auto" ? "memory" : this.mode;

    if (effectiveMode === "memory") {
      const cached = this.cache.entries[identifier];
      if (cached) return cached;
    }

    // LLM lookup
    const source = await this.llmClassify(identifier, title, url);

    // Always cache the result
    this.cache.entries[identifier] = source;
    this.cacheDirty = true;
    this.saveCache();

    return source;
  }

  /** Pre-seed a known mapping (e.g. from env config). */
  setKnown(identifier: string, source: TicketSourceType): void {
    this.cache.entries[identifier] = source;
    this.cacheDirty = true;
    this.saveCache();
  }

  private async llmClassify(
    identifier: string,
    title: string,
    url?: string,
  ): Promise<TicketSourceType> {
    const prompt = `Classify the following issue into its source system. Respond with ONLY one word: github, gitlab, jira, or jitbit.

Issue: ${identifier}
Title: ${title}${url ? `\nURL: ${url}` : ""}

Consider:
- URLs containing "github.com" → github
- URLs containing "gitlab.com" or internal GitLab domains → gitlab
- Keys matching [A-Z]+-[0-9]+ pattern (e.g. IR-63, PROJ-123) → jira
- Otherwise, consider the context clues

Source:`;

    try {
      const resp = await axios.post(
        `${this.apiUrl}/api/chat`,
        {
          messages: [{ role: "user", content: prompt }],
          max_tokens: 10,
          temperature: 0,
        },
        {
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          timeout: 10000,
        },
      );

      const text: string = (resp.data?.choices?.[0]?.message?.content ?? resp.data?.content ?? "").trim().toLowerCase();

      if (text.includes("gitlab")) return "gitlab";
      if (text.includes("jira")) return "jira";
      if (text.includes("jitbit")) return "jitbit";
      // Default to github
      return "github";
    } catch {
      // If LLM fails, fall back to heuristic or github
      return this.heuristicClassify(identifier, url);
    }
  }

  private heuristicClassify(identifier: string, url?: string): TicketSourceType {
    // URL-based detection
    if (url) {
      if (url.includes("github.com")) return "github";
      if (url.includes("gitlab")) return "gitlab";
    }
    // Jira key pattern: PROJECT-123
    if (/^[A-Z]+-\d+$/.test(identifier)) return "jira";
    // Default
    return "github";
  }

  private loadCache(): void {
    try {
      if (fs.existsSync(this.cachePath)) {
        const data = fs.readFileSync(this.cachePath, "utf-8");
        this.cache = JSON.parse(data);
      }
    } catch {
      this.cache = { entries: {} };
    }
  }

  private saveCache(): void {
    if (!this.cacheDirty) return;
    try {
      const dir = path.dirname(this.cachePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), "utf-8");
      this.cacheDirty = false;
    } catch {
      // Non-fatal — cache is best-effort
    }
  }
}