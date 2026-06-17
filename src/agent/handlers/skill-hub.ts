import type {
  HubSearchResult,
  InstallResult,
  PublishResult,
  SkillManifest,
} from "../../skills/skill-types";
import { errorLog } from "../../observability/error-log";

const VALID_ACTIONS = [
  "search",
  "install",
  "promote",
  "publish",
  "list",
  "remove",
] as const;

export interface SkillHubStore {
  search(query: string): Promise<HubSearchResult[]>;
  install(name: string): Promise<InstallResult>;
  promote(name: string): Promise<void>;
  publish(localPath: string): Promise<PublishResult>;
  listInstalled(): Promise<SkillManifest[]>;
  remove(name: string): Promise<void>;
}

export interface SkillHubResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

export function createSkillHubHandler(hub: SkillHubStore) {
  return async function handleSkillHub(
    params: Record<string, unknown>,
  ): Promise<SkillHubResult> {
    try {
      const action = typeof params.action === "string" ? params.action : "";

      if (!action) {
        return {
          success: false,
          error:
            "action is required (search, install, promote, publish, list, remove)",
        };
      }

      if (!VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])) {
        return {
          success: false,
          error: `Unknown action '${action}'. Valid: search, install, promote, publish, list, remove`,
        };
      }

      switch (action) {
        case "search": {
          const query = typeof params.query === "string" ? params.query : "";
          if (!query) {
            return { success: false, error: "query is required for search" };
          }
          const results = await hub.search(query);
          return {
            success: true,
            data: { results },
            message: `Found ${results.length} skill(s) in hub matching '${query}'`,
          };
        }
        case "install": {
          const name = typeof params.name === "string" ? params.name : "";
          if (!name) {
            return { success: false, error: "name is required for install" };
          }
          const result = await hub.install(name);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return {
            success: true,
            data: result,
            message: `Quarantined '${name}'. Review the preview, then promote it with action 'promote'.`,
          };
        }
        case "promote": {
          const name = typeof params.name === "string" ? params.name : "";
          if (!name) {
            return { success: false, error: "name is required for promote" };
          }
          await hub.promote(name);
          return {
            success: true,
            message: `Promoted '${name}' to active skills`,
          };
        }
        case "publish": {
          const localPath =
            typeof params.local_path === "string" ? params.local_path : "";
          if (!localPath) {
            return { success: false, error: "local_path is required for publish" };
          }
          const result = await hub.publish(localPath);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return {
            success: true,
            data: result,
            message: `Published '${result.name}' to hub`,
          };
        }
        case "list": {
          const skills = await hub.listInstalled();
          return {
            success: true,
            data: { skills },
            message: `Found ${skills.length} hub-installed skill(s)`,
          };
        }
        case "remove": {
          const name = typeof params.name === "string" ? params.name : "";
          if (!name) {
            return { success: false, error: "name is required for remove" };
          }
          await hub.remove(name);
          return { success: true, message: `Removed hub skill '${name}'` };
        }
        default:
          return {
            success: false,
            error: `Unknown action '${action}'. Valid: search, install, promote, publish, list, remove`,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorLog.log({
        source: "SkillHub",
        category: "handler_error",
        message,
        error,
        severity: "error",
      });
      return { success: false, error: message };
    }
  };
}
