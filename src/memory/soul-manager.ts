import fs from "fs";
import path from "path";
import os from "os";
import { resolvePath } from "../config/env";

export interface SoulManagerResult {
  success: boolean;
  error?: string;
  content?: string;
  data?: unknown;
}

const SOUL_CHAR_LIMIT = 2000;

const DEFAULT_SOUL_CONTENT = `# Identity
You are a pragmatic senior engineer with strong taste.
You optimize for truth, clarity, and usefulness over politeness theater.

# Style
Concise responses. Direct answers. No filler phrases.
When uncertain, say so rather than guessing.

# Avoid
Never suggest cloud-based solutions when self-hosted alternatives exist.
Never use emojis in code comments or commit messages.

# Defaults
When ambiguous, choose the simpler option.
When in doubt, ask rather than assume.
`;

// NOTE: This denylist is a first-layer defense, not exhaustive. It catches common prompt-injection
// phrases but can be bypassed via obfuscation, encoding, or novel phrasing. Do not rely on it as
// the sole security boundary — SOUL.md content is also sanitized before injection into system messages.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+(instructions?|prompts?|rules?)/i,
  /you\s+are\s+now\s+/i,
  /disregard\s+(all\s+)?previous/i,
  /forget\s+(all\s+)?previous/i,
  /new\s+(system\s+)?instructions?\s*:/i,
  /override\s+(all\s+)?(previous|existing|current)/i,
  /system\s*:\s*/i,
  /<\|system\|>/i,
  /\[system\]/i,
  /pretend\s+you\s+(are|were)\s+/i,
  /act\s+as\s+if\s+you\s+(are|were)\s+/i,
  /role\s*:\s*assistant/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

export class SoulManager {
  private basePath: string;
  private soulPath: string;
  private activePersonality: string | null = null;
  private personalityContent: string | null = null;

  constructor(basePath?: string) {
    this.basePath = basePath ?? this.resolveBasePath();
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }

    this.soulPath = path.join(this.basePath, "SOUL.md");

    if (!fs.existsSync(this.soulPath)) {
      this.saveDefault();
    }
  }

  private resolveBasePath(): string {
    if (process.env.AGENT_MEMORY_PATH) {
      return process.env.AGENT_MEMORY_PATH;
    }

    if (process.env.VITEST) {
      return path.join(
        os.tmpdir(),
        "ai-assist-tim-vitest-soul-manager",
        `${process.env.VITEST_WORKER_ID || "worker"}-${process.pid}`,
      );
    }

    if (process.env.SOUL_PATH) {
      return process.env.SOUL_PATH;
    }

    return resolvePath("memories");
  }

  private saveDefault(): void {
    const content = process.env.DEFAULT_SOUL || DEFAULT_SOUL_CONTENT;
    const tmpPath = this.soulPath + ".tmp";
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, this.soulPath);
  }

  getDefaultSoul(): string {
    return process.env.DEFAULT_SOUL || DEFAULT_SOUL_CONTENT;
  }

  scanForInjection(content: string): string[] {
    const found: string[] = [];
    for (const pattern of INJECTION_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        found.push(match[0]);
      }
    }
    return found;
  }

  load(): string {
    const content = this.activePersonality
      ? (this.personalityContent ?? this.readSoulFile())
      : this.readSoulFile();

    const injections = this.scanForInjection(content);
    if (injections.length > 0) {
      console.warn(
        `[SoulManager] Injection patterns detected in SOUL.md, falling back to default: ${injections.join(", ")}`,
      );
      return this.getDefaultSoul();
    }

    return content;
  }

  private readSoulFile(): string {
    if (!fs.existsSync(this.soulPath)) {
      return this.getDefaultSoul();
    }

    const content = fs.readFileSync(this.soulPath, "utf-8").trim();
    if (!content) {
      return this.getDefaultSoul();
    }

    return content;
  }

  save(content: string): SoulManagerResult {
    if (fs.existsSync(this.soulPath)) {
      const existing = fs.readFileSync(this.soulPath, "utf-8").trim();
      if (existing) {
        return {
          success: false,
          error: "SOUL.md already exists. Use edit() to modify or reset() to restore defaults.",
        };
      }
    }

    const sanitized = content
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replace(/\r\n?/g, "\n")
      .trim();

    if (sanitized.length > SOUL_CHAR_LIMIT) {
      return {
        success: false,
        error: `SOUL.md content exceeds ${SOUL_CHAR_LIMIT} char limit (${sanitized.length} chars)`,
      };
    }

    const injections = this.scanForInjection(sanitized);
    if (injections.length > 0) {
      return {
        success: false,
        error: `Content contains injection patterns: ${injections.join(", ")}`,
      };
    }

    const tmpPath = this.soulPath + ".tmp";
    fs.writeFileSync(tmpPath, sanitized + "\n", "utf-8");
    fs.renameSync(tmpPath, this.soulPath);

    return { success: true };
  }

  view(): SoulManagerResult {
    const content = this.readSoulFile();
    return {
      success: true,
      content,
      data: {
        content,
        activePersonality: this.activePersonality,
        charCount: content.length,
        charLimit: SOUL_CHAR_LIMIT,
      },
    };
  }

  edit(section: string, patch: string): SoulManagerResult {
    if (!section) {
      return { success: false, error: "section is required for edit" };
    }
    if (!patch) {
      return { success: false, error: "patch content is required for edit" };
    }

    const sanitized = patch
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replace(/\r\n?/g, "\n")
      .trim();

    const injections = this.scanForInjection(sanitized);
    if (injections.length > 0) {
      return {
        success: false,
        error: `Patch contains injection patterns: ${injections.join(", ")}`,
      };
    }

    let content = this.readSoulFile();
    const sectionHeader = `# ${section}`;
    const lines = content.split("\n");
    const sectionStart = lines.findIndex((line) => line.trim() === sectionHeader);

    if (sectionStart === -1) {
      content = content.trimEnd() + `\n\n${sectionHeader}\n${sanitized}\n`;
    } else {
      let sectionEnd = lines.length;
      for (let i = sectionStart + 1; i < lines.length; i++) {
        if (lines[i].startsWith("# ")) {
          sectionEnd = i;
          break;
        }
      }

      lines.splice(sectionStart + 1, sectionEnd - sectionStart - 1, sanitized);
      content = lines.join("\n");
    }

    if (content.length > SOUL_CHAR_LIMIT) {
      return {
        success: false,
        error: `Resulting SOUL.md would exceed ${SOUL_CHAR_LIMIT} char limit (${content.length} chars)`,
      };
    }

    const tmpPath = this.soulPath + ".tmp";
    fs.writeFileSync(tmpPath, content.trim() + "\n", "utf-8");
    fs.renameSync(tmpPath, this.soulPath);

    return { success: true, content };
  }

  reset(): SoulManagerResult {
    const defaultContent = this.getDefaultSoul();
    const tmpPath = this.soulPath + ".tmp";
    fs.writeFileSync(tmpPath, defaultContent, "utf-8");
    fs.renameSync(tmpPath, this.soulPath);

    return { success: true, content: defaultContent };
  }

  setPersonality(name: string, content: string): void {
    this.activePersonality = name;
    this.personalityContent = content;
  }

  clearPersonality(): void {
    this.activePersonality = null;
    this.personalityContent = null;
  }

  getActivePersonality(): string | null {
    return this.activePersonality;
  }
}

let _soulManager: SoulManager | null = null;

export function getSoulManager(): SoulManager {
  if (!_soulManager) {
    _soulManager = new SoulManager();
  }
  return _soulManager;
}

/** @deprecated Use getSoulManager() for lazy initialization */
export const soulManager = new Proxy({} as SoulManager, {
  get(_target, prop) {
    return (getSoulManager() as any)[prop];
  },
});
