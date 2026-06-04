import { getPreset, getPresetNames } from "../../memory/personality-presets";
import { errorLog } from "../../observability/error-log";

const VALID_ACTIONS = ["view", "edit", "reset", "personality"] as const;

export interface SoulManageResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

export interface SoulStore {
  load(): string;
  view(): { success: boolean; content?: string; data?: unknown; error?: string };
  edit(section: string, patch: string): { success: boolean; content?: string; error?: string };
  reset(): { success: boolean; content?: string; error?: string };
  setPersonality(name: string, content: string): void;
  clearPersonality(): void;
  getActivePersonality(): string | null;
}

export function createSoulManageHandler(store: SoulStore) {
  return async function handleSoulManage(
    params: Record<string, unknown>,
  ): Promise<SoulManageResult> {
    try {
      const action = typeof params.action === "string" ? params.action : "";

      if (!action) {
        return { success: false, error: "action is required (view, edit, reset, personality)" };
      }

      if (!VALID_ACTIONS.includes(action as typeof VALID_ACTIONS[number])) {
        return { success: false, error: `Unknown action '${action}'. Valid: view, edit, reset, personality` };
      }

      switch (action) {
        case "view": {
          const result = store.view();
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return {
            success: true,
            data: result.data,
            message: "Current SOUL.md loaded",
          };
        }
        case "edit": {
          const section = typeof params.section === "string" ? params.section : "";
          const patch = typeof params.patch === "string" ? params.patch : "";

          if (!section || !patch) {
            return { success: false, error: "section and patch are required for edit" };
          }

          const result = store.edit(section, patch);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          errorLog.log({ source: "SoulManage", category: "edit", message: `Edited section '${section}'`, severity: "info" });
          return {
            success: true,
            data: { section, content: result.content },
            message: `Updated section '${section}' in SOUL.md`,
          };
        }
        case "reset": {
          const result = store.reset();
          if (!result.success) {
            return { success: false, error: result.error };
          }
          errorLog.log({ source: "SoulManage", category: "reset", message: "Reset SOUL.md to default identity", severity: "info" });
          return {
            success: true,
            data: { content: result.content },
            message: "SOUL.md reset to default identity",
          };
        }
        case "personality": {
          const presetName = typeof params.preset === "string" ? params.preset : "";
          const clearMode = typeof params.clear === "boolean" ? params.clear : false;

          if (clearMode) {
            store.clearPersonality();
            return {
              success: true,
              message: "Personality overlay cleared. Using SOUL.md identity.",
            };
          }

          if (!presetName) {
            return {
              success: true,
              data: {
                activePersonality: store.getActivePersonality(),
                availablePresets: getPresetNames(),
              },
              message: `Available presets: ${getPresetNames().join(", ")}`,
            };
          }

          const preset = getPreset(presetName);
          if (!preset) {
            return {
              success: false,
              error: `Unknown personality '${presetName}'. Available: ${getPresetNames().join(", ")}`,
            };
          }

          store.setPersonality(preset.name, preset.content);
          errorLog.log({ source: "SoulManage", category: "personality", message: `Personality set to '${preset.name}'`, severity: "info" });
          return {
            success: true,
            data: {
              activePersonality: preset.name,
              description: preset.description,
            },
            message: `Personality set to '${preset.name}' for this session. ${preset.description}`,
          };
        }
        default:
          return { success: false, error: `Unknown action '${action}'. Valid: view, edit, reset, personality` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorLog.log({
        source: "SoulManage",
        category: "handler_error",
        message,
        error,
        severity: "error",
      });
      return { success: false, error: message };
    }
  };
}
