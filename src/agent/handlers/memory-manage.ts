import type { MemoryEntry, MemoryResult, MemoryUsage } from "../../memory/agent-memory";

const VALID_ACTIONS = ["add", "replace", "remove", "consolidate", "status"] as const;
const VALID_TARGETS = ["memory", "user"] as const;
const MAX_SOURCE_KEYS = 20;

export interface MemoryManageResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

export interface MemoryStore {
  add(target: "memory" | "user", key: string, value: string): MemoryResult;
  replace(target: "memory" | "user", key: string, newValue: string): MemoryResult;
  remove(target: "memory" | "user", key: string): MemoryResult;
  consolidate(target: "memory" | "user", sourceKeys: string[], mergedKey: string, mergedValue: string): MemoryResult;
  getUsage(target: "memory" | "user"): MemoryUsage;
  getEntries(target: "memory" | "user"): MemoryEntry[];
  shouldConsolidate(target: "memory" | "user"): boolean;
}

export function createMemoryManageHandler(store: MemoryStore) {
  return async function handleMemoryManage(
    params: Record<string, unknown>,
  ): Promise<MemoryManageResult> {
    try {
      const action = typeof params.action === "string" ? params.action : "";
      const targetParam = typeof params.target === "string" ? params.target : "memory";
      const target: "memory" | "user" = targetParam === "user" ? "user" : "memory";

      if (!action) {
        return { success: false, error: "action is required (add, replace, remove, consolidate, status)" };
      }

      if (!VALID_ACTIONS.includes(action as typeof VALID_ACTIONS[number])) {
        return { success: false, error: `Unknown action '${action}'. Valid: add, replace, remove, consolidate, status` };
      }

      switch (action) {
        case "add": {
          const key = typeof params.key === "string" ? params.key : "";
          const value = typeof params.value === "string" ? params.value : "";
          if (!key || !value) {
            return { success: false, error: "key and value are required for add" };
          }
          const result = store.add(target, key, value);
          if (!result.success) {
            return { success: false, error: result.error, data: { entries: result.entries } };
          }
          return { success: true, data: { message: `Added '${key}' to ${target}` } };
        }
        case "replace": {
          const key = typeof params.key === "string" ? params.key : "";
          const value = typeof params.value === "string" ? params.value : "";
          if (!key || !value) {
            return { success: false, error: "key and value are required for replace" };
          }
          const result = store.replace(target, key, value);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: { message: `Replaced '${key}' in ${target}` } };
        }
        case "remove": {
          const key = typeof params.key === "string" ? params.key : "";
          if (!key) {
            return { success: false, error: "key is required for remove" };
          }
          const result = store.remove(target, key);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: { message: `Removed '${key}' from ${target}` } };
        }
        case "consolidate": {
          const sourceKeysStr = typeof params.source_keys === "string" ? params.source_keys : "";
          const mergedKey = typeof params.merged_key === "string" ? params.merged_key : "";
          const mergedValue = typeof params.merged_value === "string" ? params.merged_value : "";
          if (!sourceKeysStr || !mergedKey || !mergedValue) {
            return { success: false, error: "source_keys, merged_key, and merged_value are required for consolidate" };
          }
          const sourceKeys = sourceKeysStr.split(",").map((k) => k.trim()).filter(Boolean);
          if (sourceKeys.length === 0) {
            return { success: false, error: "source_keys must contain at least one key" };
          }
          if (sourceKeys.length > MAX_SOURCE_KEYS) {
            return { success: false, error: `source_keys must contain at most ${MAX_SOURCE_KEYS} keys (got ${sourceKeys.length})` };
          }
          const result = store.consolidate(target, sourceKeys, mergedKey, mergedValue);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: { message: `Consolidated ${sourceKeys.length} entries into '${mergedKey}' in ${target}` } };
        }
        case "status": {
          const usage = store.getUsage(target);
          const entries = store.getEntries(target);
          return {
            success: true,
            data: {
              target,
              usage,
              entries,
              shouldConsolidate: store.shouldConsolidate(target),
            },
          };
        }
        default:
          return { success: false, error: `Unknown action '${action}'. Valid: add, replace, remove, consolidate, status` };
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
