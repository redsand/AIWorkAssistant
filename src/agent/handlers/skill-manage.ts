import type { SkillManageResult, SkillFrontmatter } from "../../skills/skill-types";

const VALID_ACTIONS = [
  "create",
  "patch",
  "edit",
  "delete",
  "list",
  "search",
  "load",
] as const;

export interface SkillStore {
  create(params: {
    name: string;
    description: string;
    category: string;
    tags: string[];
    body: string;
    requires_toolsets?: string[];
  }): SkillManageResult;
  patch(skillPath: string, section: string, newContent: string): SkillManageResult;
  edit(skillPath: string, newBody: string): SkillManageResult;
  delete(skillPath: string): SkillManageResult;
  list(category?: string): Array<{
    name: string;
    description: string;
    category: string;
    tags: string[];
    status: "active" | "stale" | "archived";
    filePath: string;
  }>;
  search(query: string): Array<{
    name: string;
    description: string;
    category: string;
    tags: string[];
    status: "active" | "stale" | "archived";
    filePath: string;
  }>;
  loadFull(skillPath: string): {
    frontmatter: SkillFrontmatter;
    body: string;
    filePath: string;
  } | null;
}

export function createSkillManageHandler(store: SkillStore) {
  return async function handleSkillManage(
    params: Record<string, unknown>,
  ): Promise<SkillManageResult> {
    try {
      const action = typeof params.action === "string" ? params.action : "";

      if (!action) {
        return {
          success: false,
          error:
            "action is required (create, patch, edit, delete, list, search, load)",
        };
      }

      if (
        !VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])
      ) {
        return {
          success: false,
          error: `Unknown action '${action}'. Valid: create, patch, edit, delete, list, search, load`,
        };
      }

      switch (action) {
        case "create": {
          const name = typeof params.name === "string" ? params.name : "";
          const description =
            typeof params.description === "string" ? params.description : "";
          const category =
            typeof params.category === "string" ? params.category : "";
          const tags = Array.isArray(params.tags)
            ? params.tags.map(String)
            : [];
          const body = typeof params.body === "string" ? params.body : "";
          const requires_toolsets = Array.isArray(params.requires_toolsets)
            ? params.requires_toolsets.map(String)
            : undefined;

          if (!name || !description || !category) {
            return {
              success: false,
              error: "name, description, and category are required for create",
            };
          }
          if (!body) {
            return {
              success: false,
              error: "body is required for create",
            };
          }

          return store.create({
            name,
            description,
            category,
            tags,
            body,
            requires_toolsets,
          });
        }
        case "patch": {
          const skillPath =
            typeof params.skill_path === "string" ? params.skill_path : "";
          const section =
            typeof params.section === "string" ? params.section : "";
          const newContent =
            typeof params.new_content === "string"
              ? params.new_content
              : typeof params.body === "string"
                ? params.body
                : "";

          if (!skillPath || !section || !newContent) {
            return {
              success: false,
              error:
                "skill_path, section, and new_content (or body) are required for patch",
            };
          }

          return store.patch(skillPath, section, newContent);
        }
        case "edit": {
          const skillPath =
            typeof params.skill_path === "string" ? params.skill_path : "";
          const newBody = typeof params.body === "string" ? params.body : "";

          if (!skillPath || !newBody) {
            return {
              success: false,
              error: "skill_path and body are required for edit",
            };
          }

          return store.edit(skillPath, newBody);
        }
        case "delete": {
          const skillPath =
            typeof params.skill_path === "string" ? params.skill_path : "";

          if (!skillPath) {
            return {
              success: false,
              error: "skill_path is required for delete",
            };
          }

          return store.delete(skillPath);
        }
        case "list": {
          const category =
            typeof params.category === "string" ? params.category : undefined;
          const skills = store.list(category);
          return {
            success: true,
            data: { skills },
            message: `Found ${skills.length} skill(s)${category ? ` in category '${category}'` : ""}`,
          };
        }
        case "search": {
          const query =
            typeof params.query === "string" ? params.query : "";

          if (!query) {
            return {
              success: false,
              error: "query is required for search",
            };
          }

          const results = store.search(query);
          return {
            success: true,
            data: { skills: results },
            message: `Found ${results.length} skill(s) matching '${query}'`,
          };
        }
        case "load": {
          const skillPath =
            typeof params.skill_path === "string" ? params.skill_path : "";

          if (!skillPath) {
            return {
              success: false,
              error: "skill_path is required for load",
            };
          }

          const skill = store.loadFull(skillPath);
          if (!skill) {
            return {
              success: false,
              error: `Skill not found: ${skillPath}`,
            };
          }

          return {
            success: true,
            data: { skill },
            message: `Loaded skill '${skill.frontmatter.name}'`,
          };
        }
        default:
          return {
            success: false,
            error: `Unknown action '${action}'. Valid: create, patch, edit, delete, list, search, load`,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SkillManage] handler error: ${message}`);
      return {
        success: false,
        error: message,
      };
    }
  };
}
