import type { EntityFact, EntityType, MemoryEntity } from "../../memory/entity-types";

/**
 * Handler factory for the `memory.get_entity_claims` agent tool.
 *
 * Follows the same DI-factory pattern as createMemoryManageHandler so the
 * handler can be unit-tested without spinning up the real SQLite-backed
 * EntityMemory singleton. The dispatcher binds it to the production store.
 *
 * Returns time-stamped (attribute, value) claims for a known entity, with
 * optional supersession history. Designed to be the agent's preferred
 * lookup path for "what is the CURRENT state of X?" queries — replaces a
 * round-trip to the upstream tool when the data is already in entity-memory.
 */

export interface MemoryGetEntityClaimsResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Subset of EntityMemory the handler depends on. Defining the interface
 * here keeps the test mock minimal — tests don't have to stub the entire
 * 30-method EntityMemory class.
 */
export interface EntityClaimsStore {
  getEntityByName(type: EntityType, name: string): MemoryEntity | null;
  getCurrentClaims(entityId: string): EntityFact[];
  getClaimHistory(entityId: string, attribute: string): EntityFact[];
}

export function createMemoryGetEntityClaimsHandler(store: EntityClaimsStore) {
  return async function handleMemoryGetEntityClaims(
    params: Record<string, unknown>,
  ): Promise<MemoryGetEntityClaimsResult> {
    try {
      const type = params.type as EntityType;
      const name = params.name as string;
      if (!type || !name) {
        return { success: false, error: "type and name are required" };
      }
      const entity = store.getEntityByName(type, name);
      if (!entity) {
        return {
          success: true,
          data: {
            found: false,
            message:
              `No entity of type '${type}' named '${name}' has been observed yet. ` +
              `Call the upstream tool (e.g. jira.get_issue) to populate it.`,
          },
        };
      }

      const includeHistory = params.includeHistory === true;
      const current = store.getCurrentClaims(entity.id);
      if (current.length === 0) {
        return {
          success: true,
          data: {
            found: true,
            entity: {
              id: entity.id,
              type: entity.type,
              name: entity.name,
              summary: entity.summary,
            },
            claims: [],
            note:
              "Entity is known but has no structured claims yet. Call the upstream " +
              "tool to record current state.",
          },
        };
      }

      const claims = current.map((c) => {
        const base: Record<string, unknown> = {
          attribute: c.attribute,
          value: c.value,
          source: c.source,
          observedAt: c.updatedAt,
          confidence: c.confidence,
        };
        if (includeHistory && c.attribute) {
          const history = store.getClaimHistory(entity.id, c.attribute);
          base.history = history.map((h) => ({
            value: h.value,
            source: h.source,
            observedAt: h.createdAt,
            supersededAt: h.supersededAt,
            supersededBy: h.supersededBy,
          }));
        }
        return base;
      });

      return {
        success: true,
        data: {
          found: true,
          entity: {
            id: entity.id,
            type: entity.type,
            name: entity.name,
            summary: entity.summary,
            sourceUrl: entity.sourceUrl,
          },
          claims,
          claimCount: claims.length,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  };
}
