import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { resolvePath } from "../config/env";
import type {
  Skill,
  SkillFrontmatter,
  SkillSummary,
  SkillCreateParams,
  SkillManageResult,
} from "./skill-types";

const VALID_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function sanitizePathSegment(segment: string, label: string): string {
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    !VALID_SEGMENT_RE.test(segment)
  ) {
    throw new Error(
      `Invalid ${label}: must start with alphanumeric and contain only alphanumeric, dash, underscore, or dot characters`,
    );
  }
  return segment;
}

function resolveUnderBase(basePath: string, relativePath: string): string {
  const resolved = path.resolve(basePath, relativePath);
  if (!resolved.startsWith(path.resolve(basePath) + path.sep) && resolved !== path.resolve(basePath)) {
    throw new Error("Path escapes the skills directory");
  }
  return resolved;
}

export class SkillManager {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? this.resolveBasePath();
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
  }

  private resolveBasePath(): string {
    if (process.env.SKILLS_PATH) {
      return process.env.SKILLS_PATH;
    }

    if (process.env.VITEST) {
      return path.join(
        os.tmpdir(),
        "ai-assist-tim-vitest-skills",
        `${process.env.VITEST_WORKER_ID || "worker"}-${process.pid}`,
      );
    }

    return resolvePath("skills");
  }

  create(params: SkillCreateParams): SkillManageResult {
    const { name, description, category, tags, body, requires_toolsets } =
      params;

    if (!name || !description || !category) {
      return {
        success: false,
        error: "name, description, and category are required",
      };
    }

    if (description.length > 60) {
      return {
        success: false,
        error: `description must be 60 chars or fewer (got ${description.length})`,
      };
    }

    try {
      sanitizePathSegment(category, "category");
      sanitizePathSegment(name, "name");
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }

    const now = new Date().toISOString();
    const frontmatter: SkillFrontmatter = {
      name,
      description,
      version: "1.0.0",
      category,
      tags: tags ?? [],
      requires_toolsets: requires_toolsets ?? [],
      created_at: now,
      updated_at: now,
      use_count: 0,
      patch_count: 0,
      status: "active",
    };

    const skillDir = path.join(this.basePath, category, name);
    const filePath = path.join(skillDir, "SKILL.md");

    if (fs.existsSync(filePath)) {
      return {
        success: false,
        error: `Skill already exists at ${category}/${name}`,
      };
    }

    fs.mkdirSync(skillDir, { recursive: true });
    const content = serializeSkill(frontmatter, body);
    const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);

    return {
      success: true,
      data: { filePath: `${category}/${name}/SKILL.md` },
      message: `Created skill '${name}' in category '${category}'`,
    };
  }

  patch(
    skillPath: string,
    section: string,
    newContent: string,
  ): SkillManageResult {
    const skill = this.loadFull(skillPath);
    if (!skill) {
      return { success: false, error: `Skill not found: ${skillPath}` };
    }

    const updated = patchSection(skill.body, section, newContent);
    if (updated === null) {
      return {
        success: false,
        error: `Section '${section}' not found in skill. Use one of: When to Use, Prerequisites, How to Run, Quick Reference, Procedure, Pitfalls, Verification`,
      };
    }

    skill.frontmatter.updated_at = new Date().toISOString();
    skill.frontmatter.patch_count++;

    const content = serializeSkill(skill.frontmatter, updated);
    const tmpPath = `${skill.filePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, skill.filePath);

    return {
      success: true,
      message: `Patched section '${section}' in skill '${skill.frontmatter.name}'`,
    };
  }

  edit(skillPath: string, newBody: string): SkillManageResult {
    const skill = this.loadFull(skillPath);
    if (!skill) {
      return { success: false, error: `Skill not found: ${skillPath}` };
    }

    skill.frontmatter.updated_at = new Date().toISOString();
    skill.frontmatter.patch_count++;

    const content = serializeSkill(skill.frontmatter, newBody);
    const tmpPath = `${skill.filePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, skill.filePath);

    return {
      success: true,
      message: `Edited body of skill '${skill.frontmatter.name}'`,
    };
  }

  delete(skillPath: string): SkillManageResult {
    const skill = this.loadFull(skillPath);
    if (!skill) {
      return { success: false, error: `Skill not found: ${skillPath}` };
    }

    if (skill.frontmatter.status === "archived") {
      return {
        success: false,
        error: `Skill '${skill.frontmatter.name}' is already archived`,
      };
    }

    skill.frontmatter.status = "archived";
    skill.frontmatter.updated_at = new Date().toISOString();

    const content = serializeSkill(skill.frontmatter, skill.body);
    const tmpPath = `${skill.filePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, skill.filePath);

    return {
      success: true,
      message: `Archived skill '${skill.frontmatter.name}'`,
    };
  }

  list(category?: string): SkillSummary[] {
    const summaries: SkillSummary[] = [];

    if (!fs.existsSync(this.basePath)) return summaries;

    const categories = category
      ? (() => { try { return [sanitizePathSegment(category, "category")]; } catch { return []; } })()
      : fs.readdirSync(this.basePath, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

    for (const cat of categories) {
      const catDir = path.join(this.basePath, cat);
      if (!fs.existsSync(catDir) || !fs.statSync(catDir).isDirectory()) continue;

      const entries = fs.readdirSync(catDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(catDir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;

        try {
          const fm = parseFrontmatter(
            fs.readFileSync(skillFile, "utf-8"),
          );
          if (fm) {
            summaries.push({
              name: fm.name,
              description: fm.description,
              category: fm.category,
              tags: fm.tags,
              status: fm.status,
              filePath: `${cat}/${entry.name}/SKILL.md`,
            });
          }
        } catch {
          // Skip malformed skills
        }
      }
    }

    return summaries;
  }

  search(query: string): SkillSummary[] {
    const lower = query.toLowerCase();
    return this.list().filter(
      (s) =>
        s.name.toLowerCase().includes(lower) ||
        s.description.toLowerCase().includes(lower) ||
        s.tags.some((t) => t.toLowerCase().includes(lower)),
    );
  }

  loadFull(skillPath: string): Skill | null {
    if (path.isAbsolute(skillPath)) {
      return null;
    }
    let filePath: string;
    try {
      filePath = resolveUnderBase(this.basePath, skillPath);
    } catch {
      return null;
    }

    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm) return null;

    const body = extractBody(content);

    return {
      frontmatter: fm,
      body,
      filePath,
    };
  }

  incrementUse(skillPath: string): SkillManageResult {
    const skill = this.loadFull(skillPath);
    if (!skill) {
      return { success: false, error: `Skill not found: ${skillPath}` };
    }

    skill.frontmatter.use_count++;
    skill.frontmatter.last_used_at = new Date().toISOString();

    const content = serializeSkill(skill.frontmatter, skill.body);
    const tmpPath = `${skill.filePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, skill.filePath);

    return { success: true, message: `Incremented use count for '${skill.frontmatter.name}'` };
  }

  incrementPatch(skillPath: string): SkillManageResult {
    const skill = this.loadFull(skillPath);
    if (!skill) {
      return { success: false, error: `Skill not found: ${skillPath}` };
    }

    skill.frontmatter.patch_count++;
    skill.frontmatter.updated_at = new Date().toISOString();

    const content = serializeSkill(skill.frontmatter, skill.body);
    const tmpPath = `${skill.filePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, skill.filePath);

    return { success: true, message: `Incremented patch count for '${skill.frontmatter.name}'` };
  }

  updateStatus(
    skillPath: string,
    newStatus: SkillFrontmatter["status"],
  ): SkillManageResult {
    const skill = this.loadFull(skillPath);
    if (!skill) {
      return { success: false, error: `Skill not found: ${skillPath}` };
    }

    skill.frontmatter.status = newStatus;
    skill.frontmatter.updated_at = new Date().toISOString();

    const content = serializeSkill(skill.frontmatter, skill.body);
    const tmpPath = `${skill.filePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, skill.filePath);

    return { success: true, message: `Updated status to '${newStatus}' for '${skill.frontmatter.name}'` };
  }

  getSkillsBasePath(): string {
    return this.basePath;
  }

  getSummariesText(): string {
    const summaries = this.list();
    if (summaries.length === 0) return "";

    const lines = summaries
      .filter((s) => s.status === "active")
      .map(
        (s) =>
          `- [${s.category}/${s.name}] ${s.description} (tags: ${s.tags.join(", ") || "none"})`,
      );

    if (lines.length === 0) return "";

    return `=== AVAILABLE SKILLS ===\n${lines.join("\n")}`;
  }
}

// ── Serialization helpers ─────────────────────────────────────────

function serializeSkill(frontmatter: SkillFrontmatter, body: string): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${frontmatter.name}`);
  lines.push(`description: "${frontmatter.description}"`);
  lines.push(`version: ${frontmatter.version}`);
  lines.push(`category: ${frontmatter.category}`);
  lines.push(`tags:`);
  for (const tag of frontmatter.tags) {
    lines.push(`  - ${tag}`);
  }
  if (
    frontmatter.requires_toolsets &&
    frontmatter.requires_toolsets.length > 0
  ) {
    lines.push(`requires_toolsets:`);
    for (const t of frontmatter.requires_toolsets) {
      lines.push(`  - ${t}`);
    }
  }
  if (
    frontmatter.fallback_for_toolsets &&
    frontmatter.fallback_for_toolsets.length > 0
  ) {
    lines.push(`fallback_for_toolsets:`);
    for (const t of frontmatter.fallback_for_toolsets) {
      lines.push(`  - ${t}`);
    }
  }
  lines.push(`created_at: ${frontmatter.created_at}`);
  lines.push(`updated_at: ${frontmatter.updated_at}`);
  lines.push(`use_count: ${frontmatter.use_count}`);
  lines.push(`patch_count: ${frontmatter.patch_count}`);
  if (frontmatter.last_used_at) {
    lines.push(`last_used_at: ${frontmatter.last_used_at}`);
  }
  lines.push(`status: ${frontmatter.status}`);
  lines.push("---");
  lines.push("");
  lines.push(body.trim());

  return lines.join("\n") + "\n";
}

function parseFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const fm: Partial<SkillFrontmatter> = {};

  // Simple YAML parser for flat key-value + arrays
  const lines = yaml.split("\n");
  let currentArrayKey: string | null = null;

  for (const line of lines) {
    // Array item
    const arrayMatch = line.match(/^  - (.+)$/);
    if (arrayMatch && currentArrayKey) {
      const arr = (fm as Record<string, unknown>)[currentArrayKey];
      if (Array.isArray(arr)) {
        arr.push(arrayMatch[1]);
      }
      continue;
    }

    // Key: value
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();

      currentArrayKey = null;

      if (value === "") {
        // Start of an array
        (fm as Record<string, unknown>)[key] = [];
        currentArrayKey = key;
      } else {
        // Strip surrounding quotes
        const cleaned = value.replace(/^["']|["']$/g, "");
        if (key === "use_count" || key === "patch_count") {
          (fm as Record<string, unknown>)[key] = parseInt(cleaned, 10) || 0;
        } else {
          (fm as Record<string, unknown>)[key] = cleaned;
        }
      }
    }
  }

  if (!fm.name || !fm.category) return null;

  return {
    name: fm.name ?? "",
    description: fm.description ?? "",
    version: fm.version ?? "1.0.0",
    category: fm.category,
    tags: (fm.tags as string[]) ?? [],
    requires_toolsets: (fm.requires_toolsets as string[]) ?? [],
    fallback_for_toolsets: (fm.fallback_for_toolsets as string[]) ?? [],
    created_at: fm.created_at ?? new Date().toISOString(),
    updated_at: fm.updated_at ?? new Date().toISOString(),
    use_count: fm.use_count ?? 0,
    patch_count: fm.patch_count ?? 0,
    last_used_at: fm.last_used_at as string | undefined,
    status: (fm.status as SkillFrontmatter["status"]) ?? "active",
  };
}

function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n\n([\s\S]*)$/);
  return match ? match[1].trim() : "";
}

function patchSection(
  body: string,
  section: string,
  newContent: string,
): string | null {
  const headerPattern = new RegExp(
    `^## ${escapeRegex(section)}$`,
    "m",
  );
  const match = body.match(headerPattern);
  if (!match) return null;

  const headerIndex = match.index!;
  const nextHeaderMatch = body
    .substring(headerIndex + match[0].length)
    .match(/^## /m);

  const endIndex = nextHeaderMatch
    ? headerIndex + match[0].length + nextHeaderMatch.index!
    : body.length;

  const before = body.substring(0, headerIndex + match[0].length);
  const after = body.substring(endIndex);

  return `${before}\n\n${newContent.trim()}\n${after}`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


export const skillManager = new SkillManager();
