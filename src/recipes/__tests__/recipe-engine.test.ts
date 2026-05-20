import { describe, it, expect, beforeEach } from 'vitest';
import { RecipeEngine } from '../recipe-engine';

describe('RecipeEngine', () => {
  let engine: RecipeEngine;

  beforeEach(() => {
    engine = new RecipeEngine();
  });

  describe('listRecipes', () => {
    it('should return all builtin recipes', () => {
      const result = engine.listRecipes();
      expect(result.recipes.length).toBeGreaterThan(0);
      expect(result.recipes[0].id).toBeDefined();
      expect(result.recipes[0].name).toBeDefined();
    });
  });

  describe('getRecipe', () => {
    it('should return recipe by ID', () => {
      const recipe = engine.getRecipe('triage-new-ticket');
      expect(recipe).toBeDefined();
      expect(recipe?.id).toBe('triage-new-ticket');
    });

    it('should return undefined for unknown ID', () => {
      expect(engine.getRecipe('does-not-exist')).toBeUndefined();
    });
  });

  describe('getExecution', () => {
    it('should return undefined for unknown execution ID', () => {
      expect(engine.getExecution('does-not-exist')).toBeUndefined();
    });
  });

  describe('execute', () => {
    it('should create execution with all steps in pending state', async () => {
      const execution = await engine.execute('triage-new-ticket', { ticketId: 123 });
      expect(execution.id).toBeDefined();
      expect(execution.recipeId).toBe('triage-new-ticket');
      expect(execution.status).toBe('running');
      expect(execution.steps.length).toBeGreaterThan(0);
      for (const step of execution.steps) {
        expect(step.status).toBe('pending');
      }
    });

    it('should store execution retrievable by ID', async () => {
      const execution = await engine.execute('triage-new-ticket', { ticketId: 123 });
      const retrieved = engine.getExecution(execution.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(execution.id);
      expect(retrieved?.recipeId).toBe('triage-new-ticket');
    });

    it('should record provided variables on the execution', async () => {
      const execution = await engine.execute('triage-new-ticket', { ticketId: 42, priority: 'high' });
      expect(execution.variables.ticketId).toBe(42);
      expect(execution.variables.priority).toBe('high');
    });

    it('should throw for unknown recipe ID', async () => {
      await expect(engine.execute('does-not-exist', {})).rejects.toThrow('Recipe not found');
    });

    it('should throw for missing required variable', async () => {
      await expect(engine.execute('triage-new-ticket', {})).rejects.toThrow('Missing required variable: ticketId');
    });

    it('should throw for invalid variable type: string passed for number field', async () => {
      await expect(
        engine.execute('triage-new-ticket', { ticketId: 'abc' }),
      ).rejects.toThrow('ticketId');
    });

    it('should throw for invalid variable type: number passed for string field', async () => {
      await expect(
        engine.execute('escalate-hawk-ir-case', { caseId: 99, escalationReason: 'critical' }),
      ).rejects.toThrow('caseId');
    });

    it('should accept optional variables that are omitted', async () => {
      const execution = await engine.execute('triage-new-ticket', { ticketId: 1 });
      expect(execution).toBeDefined();
      expect('priority' in execution.variables).toBe(false);
    });

    it('should accept recipe with only optional variables and no supplied values', async () => {
      const execution = await engine.execute('daily-standup-prep', {});
      expect(execution.status).toBe('running');
    });

    it('should set startedAt on the execution', async () => {
      const execution = await engine.execute('triage-new-ticket', { ticketId: 1 });
      expect(execution.startedAt).toBeDefined();
      expect(new Date(execution.startedAt).getTime()).not.toBeNaN();
    });
  });
});
