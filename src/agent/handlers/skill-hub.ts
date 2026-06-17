import crypto from "crypto";
import type {
  HubSearchResult,
  InstallResult,
  PublishResult,
  SkillManifest,
} from "../../skills/skill-types";
import { errorLog } from "../../observability/error-log";
import { auditLogger } from "../../audit/logger";

/** Records a security-sensitive hub operation. Injectable for tests. */
export type SkillHubAudit = (event: {
  action: string;
  outcome: "success" | "failure";
  details: Record<string, unknown>;
}) => void;

const defaultAudit: SkillHubAudit = (event) => {
  void auditLogger.log({
    id: crypto.randomUUID(),
    timestamp: new Date(),
    action: `skill_hub.${event.action}`,
    actor: "agent",
    details: { outcome: event.outcome, ...event.details },
    severity: event.outcome === "success" ? "info" : "warn",
  });
};

// Write operations that mutate local skills or the shared registry. These are
// audited on success, not just failure, so the security-sensitive surface has a
// complete trail.
const AUDITED_ACTIONS = new Set(["install", "promote", "publish", "remove"]);

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

export function createSkillHubHandler(
  hub: SkillHubStore,
  audit: SkillHubAudit = defaultAudit,
) {
  return async function handleSkillHub(
    params: Record<string, unknown>,
  ): Promise<SkillHubResult> {
    const action = typeof params.action === "string" ? params.action : "";
    try {
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

      const result = await dispatch(hub, action, params);
      if (AUDITED_ACTIONS.has(action)) {
        audit({
          action,
          outcome: result.success ? "success" : "failure",
          details: {
            name: typeof params.name === "string" ? params.name : undefined,
            localPath:
              typeof params.local_path === "string"
                ? params.local_path
                : undefined,
            error: result.success ? undefined : result.error,
          },
        });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorLog.log({
        source: "SkillHub",
        category: "handler_error",
        message,
        error,
        severity: "error",
      });
      if (AUDITED_ACTIONS.has(action)) {
        audit({ action, outcome: "failure", details: { error: message } });
      }
      return { success: false, error: message };
    }
  };
}

async function dispatch(
  hub: SkillHubStore,
  action: string,
  params: Record<string, unknown>,
): Promise<SkillHubResult> {
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
  }
  // Unreachable: the handler validates `action` against VALID_ACTIONS before
  // dispatch, so every value here is a known case above.
  return {
    success: false,
    error: `Unknown action '${action}'`,
  };
}
