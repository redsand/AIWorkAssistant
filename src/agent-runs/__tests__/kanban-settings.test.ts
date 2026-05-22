import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRunDatabase } from '../database';

describe('Kanban Settings', () => {
  let db: AgentRunDatabase;

  beforeEach(() => {
    db = new AgentRunDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('getKanbanSetting', () => {
    it('should return null for unset key', () => {
      expect(db.getKanbanSetting('autoCleanupHours')).toBeNull();
    });

    it('should return stored value', () => {
      db.setKanbanSetting('autoCleanupHours', '48');
      expect(db.getKanbanSetting('autoCleanupHours')).toBe('48');
    });
  });

  describe('setKanbanSetting', () => {
    it('should insert new setting', () => {
      db.setKanbanSetting('autoCleanupHours', '24');
      expect(db.getKanbanSetting('autoCleanupHours')).toBe('24');
    });

    it('should update existing setting', () => {
      db.setKanbanSetting('autoCleanupHours', '24');
      db.setKanbanSetting('autoCleanupHours', '48');
      expect(db.getKanbanSetting('autoCleanupHours')).toBe('48');
    });

    it('should handle multiple keys independently', () => {
      db.setKanbanSetting('autoCleanupHours', '24');
      db.setKanbanSetting('otherSetting', 'value');
      expect(db.getKanbanSetting('autoCleanupHours')).toBe('24');
      expect(db.getKanbanSetting('otherSetting')).toBe('value');
    });
  });
});
