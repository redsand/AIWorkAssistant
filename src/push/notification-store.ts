export interface NotifiedItem {
  id: string;
  source: "hawk-ir" | "jitbit";
  externalId: string;
  riskLevel: string;
  notifiedAt: string;
  acknowledgedAt?: string;
  escalationLevel: number;
  lastPushedAt?: string;
}

export interface NotificationStore {
  hasBeenNotified(source: string, externalId: string): Promise<boolean>;
  markNotified(item: NotifiedItem): Promise<void>;
  markAcknowledged(source: string, externalId: string): Promise<void>;
  getUnacknowledgedPastThreshold(minutes: number): Promise<NotifiedItem[]>;
  markEscalated(source: string, externalId: string, level: number): Promise<void>;
  shouldSendPush(source: string, externalId: string, cooldownMs: number): Promise<boolean>;
  markPushed(source: string, externalId: string): Promise<void>;
  cleanup(retentionDays: number): Promise<number>;
}

const PUSH_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export class MemoryNotificationStore implements NotificationStore {
  private store = new Map<string, NotifiedItem>();

  async hasBeenNotified(source: string, externalId: string): Promise<boolean> {
    return this.store.has(`${source}:${externalId}`);
  }

  async markNotified(item: NotifiedItem): Promise<void> {
    const key = `${item.source}:${item.externalId}`;
    const existing = this.store.get(key);
    if (existing) {
      // Preserve push cooldown and acknowledgment state
      existing.riskLevel = item.riskLevel;
      existing.escalationLevel = Math.max(existing.escalationLevel, item.escalationLevel);
    } else {
      this.store.set(key, { ...item, lastPushedAt: item.notifiedAt });
    }
  }

  async markAcknowledged(source: string, externalId: string): Promise<void> {
    const key = `${source}:${externalId}`;
    const item = this.store.get(key);
    if (item) {
      item.acknowledgedAt = new Date().toISOString();
      this.store.set(key, item);
    }
  }

  async getUnacknowledgedPastThreshold(minutes: number): Promise<NotifiedItem[]> {
    const threshold = Date.now() - minutes * 60 * 1000;
    return Array.from(this.store.values()).filter(
      (item) => !item.acknowledgedAt && new Date(item.notifiedAt).getTime() < threshold
    );
  }

  async markEscalated(source: string, externalId: string, level: number): Promise<void> {
    const key = `${source}:${externalId}`;
    const item = this.store.get(key);
    if (item) {
      item.escalationLevel = level;
      this.store.set(key, item);
    }
  }

  async shouldSendPush(source: string, externalId: string, cooldownMs: number = PUSH_COOLDOWN_MS): Promise<boolean> {
    const key = `${source}:${externalId}`;
    const item = this.store.get(key);
    if (!item) return true;
    if (item.acknowledgedAt) return false;
    if (!item.lastPushedAt) return true;
    return Date.now() - new Date(item.lastPushedAt).getTime() >= cooldownMs;
  }

  async markPushed(source: string, externalId: string): Promise<void> {
    const key = `${source}:${externalId}`;
    const item = this.store.get(key);
    if (item) {
      item.lastPushedAt = new Date().toISOString();
      this.store.set(key, item);
    }
  }

  async cleanup(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const [key, item] of this.store) {
      if (new Date(item.notifiedAt).getTime() < cutoff) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

export const notificationStore = new MemoryNotificationStore();
