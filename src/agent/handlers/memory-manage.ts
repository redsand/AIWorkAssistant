import type { MemoryEntry, MemoryResult, MemoryUsage } from "../../memory/agent-memory";

const VALID_ACTIONS = ["add", "replace", "remove", "consolidate", "status"] as const;
const VALID_TARGETS = ["memory", "user"] as const;
const MAX_SOURCE_KEYS = 20;
const MAX_KEY_LENGTH = 120;
const MAX_VALUE_LENGTH = 2000;

/** Strip control characters and normalize whitespace to prevent injection into persistent markdown */
function sanitize(input: string): string {
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

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
      const targetParam = typeof params.target === "string" ? params.target : "";

      if (!action) {
        return { success: false, error: "action is required (add, replace, remove, consolidate, status)" };
      }

      if (!VALID_ACTIONS.includes(action as typeof VALID_ACTIONS[number])) {
        return { success: false, error: `Unknown action '${action}'. Valid: add, replace, remove, consolidate, status` };
      }

      let target: "memory" | "user" = "memory";
      if (targetParam && !VALID_TARGETS.includes(targetParam as typeof VALID_TARGETS[number])) {
        return { success: false, error: `Unknown target '${targetParam}'. Valid: memory, user` };
      }
      if (targetParam === "user") target = "user";

      switch (action) {
        case "add": {
          const rawKey = typeof params.key === "string" ? params.key : "";
          const rawValue = typeof params.value === "string" ? params.value : "";
          if (!rawKey || !rawValue) {
            return { success: false, error: "key and value are required for add" };
          }
          const key = sanitize(rawKey);
          const value = sanitize(rawValue);
          if (key.length > MAX_KEY_LENGTH) {
            return { success: false, error: `key exceeds max length of ${MAX_KEY_LENGTH} chars (got ${rawKey.length})` };
          }
          if (value.length > MAX_VALUE_LENGTH) {
            return { success: false, error: `value exceeds max length of ${MAX_VALUE_LENGTH} chars (got ${rawValue.length})` };
          }
          const result = store.add(target, key, value);
          if (!result.success) {
            console.log(`[AgentMemory] add failed for '${key}' in ${target}: ${result.error}`);
            return { success: false, error: result.error, data: { entries: result.entries } };
          }
          console.log(`[AgentMemory] added '${key}' to ${target}`);
          return { success: true, data: { message: `Added '${key}' to ${target}` } };
        }
        case "replace": {
          const rawKey = typeof params.key === "string" ? params.key : "";
          const rawValue = typeof params.value === "string" ? params.value : "";
          if (!rawKey || !rawValue) {
            return { success: false, error: "key and value are required for replace" };
          }
          const key = sanitize(rawKey);
          const value = sanitize(rawValue);
          if (key.length > MAX_KEY_LENGTH) {
            return { success: false, error: `key exceeds max length of ${MAX_KEY_LENGTH} chars (got ${rawKey.length})` };
          }
          if (value.length > MAX_VALUE_LENGTH) {
            return { success: false, error: `value exceeds max length of ${MAX_VALUE_LENGTH} chars (got ${rawValue.length})` };
          }
          const result = store.replace(target, key, value);
          if (!result.success) {
            console.log(`[AgentMemory] replace failed for '${key}' in ${target}: ${result.error}`);
            return { success: false, error: result.error };
          }
          console.log(`[AgentMemory] replaced '${key}' in ${target}`);
          return { success: true, data: { message: `Replaced '${key}' in ${target}` } };
        }
        case "remove": {
          const rawKey = typeof params.key === "string" ? params.key : "";
          if (!rawKey) {
            return { success: false, error: "key is required for remove" };
          }
          const key = sanitize(rawKey);
          const result = store.remove(target, key);
          if (!result.success) {
            console.log(`[AgentMemory] remove failed for '${key}' in ${target}: ${result.error}`);
            return { success: false, error: result.error };
          }
          console.log(`[AgentMemory] removed '${key}' from ${target}`);
          return { success: true, data: { message: `Removed '${key}' from ${target}` } };
        }
        case "consolidate": {
          const sourceKeysStr = typeof params.source_keys === "string" ? params.source_keys : "";
          const rawMergedKey = typeof params.merged_key === "string" ? params.merged_key : "";
          const rawMergedValue = typeof params.merged_value === "string" ? params.merged_value : "";
          if (!sourceKeysStr || !rawMergedKey || !rawMergedValue) {
            return { success: false, error: "source_keys, merged_key, and merged_value are required for consolidate" };
          }
          const sourceKeys = sourceKeysStr.split(",").map((k) => sanitize(k)).filter(Boolean);
          const mergedKey = sanitize(rawMergedKey);
          const mergedValue = sanitize(rawMergedValue);
          if (sourceKeys.length === 0) {
            return { success: false, error: "source_keys must contain at least one key" };
          }
          if (sourceKeys.length > MAX_SOURCE_KEYS) {
            return { success: false, error: `source_keys must contain at most ${MAX_SOURCE_KEYS} keys (got ${sourceKeys.length})` };
          }
          if (mergedKey.length > MAX_KEY_LENGTH) {
            return { success: false, error: `merged_key exceeds max length of ${MAX_KEY_LENGTH} chars` };
          }
          if (mergedValue.length > MAX_VALUE_LENGTH) {
            return { success: false, error: `merged_value exceeds max length of ${MAX_VALUE_LENGTH} chars` };
          }
          const result = store.consolidate(target, sourceKeys, mergedKey, mergedValue);
          if (!result.success) {
            console.log(`[AgentMemory] consolidate failed in ${target}: ${result.error}`);
            return { success: false, error: result.error };
          }
          console.log(`[AgentMemory] consolidated ${sourceKeys.length} entries into '${mergedKey}' in ${target}`);
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
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[AgentMemory] unexpected error: ${message}`);
      return { success: false, error: message };
    }
  };
}
