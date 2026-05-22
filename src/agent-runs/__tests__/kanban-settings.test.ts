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

  describe('getAllKanbanSettings', () => {
    it('should return empty object when no settings', () => {
      expect(db.getAllKanbanSettings()).toEqual({});
    });

    it('should return all settings as key-value pairs', () => {
      db.setKanbanSetting('autoCommit', 'true');
      db.setKanbanSetting('autoPR', 'false');
      db.setKanbanSetting('autoCleanupHours', '48');

      const all = db.getAllKanbanSettings();
      expect(all).toEqual({
        autoCommit: 'true',
        autoPR: 'false',
        autoCleanupHours: '48',
      });
    });

    it('should include per-repo settings', () => {
      db.setKanbanSetting('defaultAgent:github:owner/repo', 'claude');
      db.setKanbanSetting('defaultModel:github:owner/repo', 'opus');

      const all = db.getAllKanbanSettings();
      expect(all['defaultAgent:github:owner/repo']).toBe('claude');
      expect(all['defaultModel:github:owner/repo']).toBe('opus');
    });

    it('should reflect updates', () => {
      db.setKanbanSetting('autoCommit', 'false');
      db.setKanbanSetting('autoCommit', 'true');
      expect(db.getAllKanbanSettings().autoCommit).toBe('true');
    });
  });
});
