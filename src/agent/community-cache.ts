import type { KnowledgeGraph } from "./knowledge-graph";

const REGENERATION_DEBOUNCE_MS = 60_000;
const REGENERATION_MAX_PENDING = 5;

export class CommunityCache {
  private kg: KnowledgeGraph;
  private regenerationInProgress = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges = 0;

  constructor(kg: KnowledgeGraph) {
    this.kg = kg;
  }

  async regenerateStaleCommunities(maxPerRun: number = 10): Promise<void> {
    if (this.regenerationInProgress) return;
    this.regenerationInProgress = true;

    try {
      const stale = this.kg.getStaleCommunities(maxPerRun);
      for (const community of stale) {
        const nodes = community.nodeIds
          .map(id => this.kg.getNode(id))
          .filter((n): n is NonNullable<typeof n> => n !== null);

        const summary = await this.kg.generateCommunitySummary(nodes);
        this.kg.updateCommunitySummary(community.id, summary);
      }
    } finally {
      this.regenerationInProgress = false;
    }
  }

  notifyChange(): void {
    this.pendingChanges++;

    if (this.pendingChanges >= REGENERATION_MAX_PENDING) {
      this.flush();
      return;
    }

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), REGENERATION_DEBOUNCE_MS);
  }

  private flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingChanges = 0;
    this.regenerateStaleCommunities().catch(err =>
      console.warn("[CommunityCache] Background regeneration failed:", err),
    );
  }
}
