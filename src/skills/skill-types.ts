export interface SkillFrontmatter {
  name: string;
  description: string; // max 60 chars
  version: string;
  category: string;
  tags: string[];
  requires_toolsets?: string[];
  fallback_for_toolsets?: string[];
  created_at: string;
  updated_at: string;
  use_count: number;
  patch_count: number;
  last_used_at?: string;
  status: "active" | "stale" | "archived";
}

export interface Skill {
  frontmatter: SkillFrontmatter;
  body: string;
  filePath: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  category: string;
  tags: string[];
  status: SkillFrontmatter["status"];
  filePath: string;
}

export interface SkillCreateParams {
  name: string;
  description: string;
  category: string;
  tags: string[];
  body: string;
  requires_toolsets?: string[];
}

export interface SkillPatchParams {
  skillPath: string;
  section: string;
  newContent: string;
}

export type SkillAction =
  | "create"
  | "patch"
  | "edit"
  | "delete"
  | "list"
  | "search"
  | "load";

export interface SkillManageResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

export const SKILL_BODY_SECTIONS = [
  "When to Use",
  "Prerequisites",
  "How to Run",
  "Quick Reference",
  "Procedure",
  "Pitfalls",
  "Verification",
] as const;

export type SkillBodySection = (typeof SKILL_BODY_SECTIONS)[number];
