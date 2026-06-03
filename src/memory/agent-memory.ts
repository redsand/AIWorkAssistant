import fs from "fs";
import path from "path";
import os from "os";

export interface MemoryEntry {
  key: string;
  value: string;
  timestamp: string;
  accessCount: number;
}

export interface MemoryResult {
  success: boolean;
  error?: string;
  entries?: MemoryEntry[];
}

export interface MemoryUsage {
  used: number;
  total: number;
  percent: number;
}

const MEMORY_CHAR_LIMIT = 2200;
const USER_CHAR_LIMIT = 1375;
const CONSOLIDATION_THRESHOLD = 0.8;

export class AgentMemory {
  private basePath: string;
  private memoryPath: string;
  private userPath: string;
  private memoryEntries: Map<string, MemoryEntry> = new Map();
  private userEntries: Map<string, MemoryEntry> = new Map();

  constructor(basePath?: string) {
    this.basePath = basePath ?? this.resolveBasePath();
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }

    this.memoryPath = path.join(this.basePath, "MEMORY.md");
    this.userPath = path.join(this.basePath, "USER.md");

    this.loadFile(this.memoryPath, this.memoryEntries, MEMORY_CHAR_LIMIT);
    this.loadFile(this.userPath, this.userEntries, USER_CHAR_LIMIT);

    console.log("[AgentMemory] Initialized");
  }

  private resolveBasePath(): string {
    if (process.env.AGENT_MEMORY_PATH) {
      return process.env.AGENT_MEMORY_PATH;
    }

    if (process.env.VITEST) {
      return path.join(
        os.tmpdir(),
        "ai-assist-tim-vitest-agent-memory",
        `${process.env.VITEST_WORKER_ID || "worker"}-${process.pid}`,
      );
    }

    return path.join(process.cwd(), "data", "memories");
  }

  private loadFile(
    filePath: string,
    entries: Map<string, MemoryEntry>,
    charLimit: number,
  ): void {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "", "utf-8");
      return;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.trim()) return;

    const parsed = this.parseEntries(content);
    for (const entry of parsed) {
      entries.set(entry.key, entry);
    }

    if (content.length > charLimit) {
      console.log(
        `[AgentMemory] WARNING: ${path.basename(filePath)} is ${content.length} chars, exceeding limit of ${charLimit}. Consider consolidating.`,
      );
    }
  }

  private parseEntries(content: string): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    const lines = content.split("\n");
    let currentKey: string | null = null;
    let currentValue: string[] = [];
    let currentTimestamp = "";
    let currentAccessCount = 1;

    for (const line of lines) {
      const keyMatch = line.match(/^§ (.+)/);
      if (keyMatch) {
        if (currentKey !== null) {
          entries.push({
            key: currentKey,
            value: currentValue.join("\n").trim(),
            timestamp: currentTimestamp,
            accessCount: currentAccessCount,
          });
        }
        currentKey = keyMatch[1].trim();
        currentValue = [];
        currentTimestamp = new Date().toISOString();
        currentAccessCount = 1;
      } else if (currentKey !== null) {
        const tsMatch = line.match(/^_added: (.+)$/);
        const acMatch = line.match(/^_accessed: (\d+)$/);
        if (tsMatch) {
          currentTimestamp = tsMatch[1];
        } else if (acMatch) {
          currentAccessCount = parseInt(acMatch[1], 10);
        } else {
          currentValue.push(line);
        }
      }
    }

    if (currentKey !== null) {
      entries.push({
        key: currentKey,
        value: currentValue.join("\n").trim(),
        timestamp: currentTimestamp,
        accessCount: currentAccessCount,
      });
    }

    return entries;
  }

  private serializeEntries(entries: Map<string, MemoryEntry>): string {
    if (entries.size === 0) return "";

    const parts: string[] = [];
    for (const entry of entries.values()) {
      parts.push(`§ ${entry.key}`);
      parts.push(`_added: ${entry.timestamp}`);
      parts.push(`_accessed: ${entry.accessCount}`);
      if (entry.value) {
        parts.push(entry.value);
      }
      parts.push("");
    }

    return parts.join("\n").trim() + "\n";
  }

  private saveFile(
    filePath: string,
    entries: Map<string, MemoryEntry>,
  ): void {
    const content = this.serializeEntries(entries);
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  private getEntriesMap(target: "memory" | "user"): Map<string, MemoryEntry> {
    return target === "memory" ? this.memoryEntries : this.userEntries;
  }

  private getCharLimit(target: "memory" | "user"): number {
    return target === "memory" ? MEMORY_CHAR_LIMIT : USER_CHAR_LIMIT;
  }

  add(target: "memory" | "user", key: string, value: string): MemoryResult {
    const entries = this.getEntriesMap(target);
    const limit = this.getCharLimit(target);

    const existing = this.serializeEntries(entries);
    const newEntry = this.formatEntry(key, value);
    const projected = existing.length + newEntry.length;

    if (projected > limit) {
      return {
        success: false,
        error: `Adding this entry would exceed the ${limit} char limit (${projected} projected). Current entries: ${Array.from(entries.values()).map((e) => `§ ${e.key}`).join(", ")}. Use consolidate to merge related entries first.`,
        entries: Array.from(entries.values()),
      };
    }

    entries.set(key, {
      key,
      value,
      timestamp: new Date().toISOString(),
      accessCount: 1,
    });

    const filePath = target === "memory" ? this.memoryPath : this.userPath;
    this.saveFile(filePath, entries);

    return { success: true };
  }

  private formatEntry(key: string, value: string): string {
    return `§ ${key}\n_added: ${new Date().toISOString()}\n_accessed: 1\n${value}\n\n`;
  }

  replace(
    target: "memory" | "user",
    key: string,
    newValue: string,
  ): MemoryResult {
    const entries = this.getEntriesMap(target);
    const existing = entries.get(key);

    if (!existing) {
      return {
        success: false,
        error: `Entry '${key}' not found. Use add to create new entries.`,
      };
    }

    existing.value = newValue;
    existing.timestamp = new Date().toISOString();
    existing.accessCount++;

    entries.set(key, existing);

    const filePath = target === "memory" ? this.memoryPath : this.userPath;
    this.saveFile(filePath, entries);

    return { success: true };
  }

  remove(target: "memory" | "user", key: string): MemoryResult {
    const entries = this.getEntriesMap(target);

    if (!entries.has(key)) {
      return {
        success: false,
        error: `Entry '${key}' not found.`,
      };
    }

    entries.delete(key);

    const filePath = target === "memory" ? this.memoryPath : this.userPath;
    this.saveFile(filePath, entries);

    return { success: true };
  }

  consolidate(
    target: "memory" | "user",
    sourceKeys: string[],
    mergedKey: string,
    mergedValue: string,
  ): MemoryResult {
    const entries = this.getEntriesMap(target);

    for (const key of sourceKeys) {
      if (!entries.has(key)) {
        return {
          success: false,
          error: `Source entry '${key}' not found. Cannot consolidate.`,
        };
      }
    }

    const limit = this.getCharLimit(target);
    const currentSize = this.serializeEntries(entries).length;
    let removedSize = 0;
    for (const key of sourceKeys) {
      const entry = entries.get(key)!;
      removedSize += this.formatEntry(entry.key, entry.value).length;
    }
    const newSize = this.formatEntry(mergedKey, mergedValue).length;
    const projected = currentSize - removedSize + newSize;

    if (projected > limit) {
      return {
        success: false,
        error: `Consolidating would exceed the ${limit} char limit (${projected} projected). Try a shorter merged value.`,
        entries: Array.from(entries.values()),
      };
    }

    for (const key of sourceKeys) {
      entries.delete(key);
    }

    entries.set(mergedKey, {
      key: mergedKey,
      value: mergedValue,
      timestamp: new Date().toISOString(),
      accessCount: 1,
    });

    const filePath = target === "memory" ? this.memoryPath : this.userPath;
    this.saveFile(filePath, entries);

    return { success: true };
  }

  getMemorySnapshot(): string {
    const content = this.serializeEntries(this.memoryEntries);
    return content.trim();
  }

  getUserSnapshot(): string {
    const content = this.serializeEntries(this.userEntries);
    return content.trim();
  }

  getUsage(target: "memory" | "user"): MemoryUsage {
    const entries = this.getEntriesMap(target);
    const limit = this.getCharLimit(target);
    const used = this.serializeEntries(entries).length;

    return {
      used,
      total: limit,
      percent: limit > 0 ? Math.round((used / limit) * 100) : 0,
    };
  }

  getEntries(target: "memory" | "user"): MemoryEntry[] {
    return Array.from(this.getEntriesMap(target).values());
  }

  shouldConsolidate(target: "memory" | "user"): boolean {
    const usage = this.getUsage(target);
    return usage.percent >= CONSOLIDATION_THRESHOLD * 100;
  }

  close(): void {
    this.saveFile(this.memoryPath, this.memoryEntries);
    this.saveFile(this.userPath, this.userEntries);
  }
}

export const agentMemory = new AgentMemory();
