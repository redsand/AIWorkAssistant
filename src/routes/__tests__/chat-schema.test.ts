import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Test the schema in isolation to verify constraints
const AGENT_MODES = { PRODUCTIVITY: 'productivity', ENGINEERING: 'engineering' } as const;

const MAX_SYSTEM_PROMPT_LENGTH = 4000;

const ALLOWED_MODELS = new Set([
  'haiku',
  'sonnet',
  'opus',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-5.5',
  'gpt-4o',
]);

const chatRequestSchema = z.object({
  message: z.string(),
  mode: z
    .enum([AGENT_MODES.PRODUCTIVITY, AGENT_MODES.ENGINEERING])
    .default(AGENT_MODES.PRODUCTIVITY),
  userId: z.string().default('user'),
  sessionId: z.string().nullable().optional(),
  context: z.object({}).optional(),
  includeTools: z.boolean().default(true),
  includeMemory: z.boolean().default(true),
  systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_LENGTH).optional(),
  model: z.string().optional(),
});

describe('chatRequestSchema', () => {
  describe('systemPrompt', () => {
    it('should accept a valid systemPrompt', () => {
      const result = chatRequestSchema.parse({
        message: 'hello',
        systemPrompt: 'You are a helpful assistant.',
      });
      expect(result.systemPrompt).toBe('You are a helpful assistant.');
    });

    it('should accept systemPrompt at max length boundary', () => {
      const result = chatRequestSchema.parse({
        message: 'hello',
        systemPrompt: 'x'.repeat(MAX_SYSTEM_PROMPT_LENGTH),
      });
      expect(result.systemPrompt).toHaveLength(MAX_SYSTEM_PROMPT_LENGTH);
    });

    it('should reject systemPrompt exceeding max length', () => {
      expect(() =>
        chatRequestSchema.parse({
          message: 'hello',
          systemPrompt: 'x'.repeat(MAX_SYSTEM_PROMPT_LENGTH + 1),
        }),
      ).toThrow();
    });

    it('should accept undefined systemPrompt', () => {
      const result = chatRequestSchema.parse({
        message: 'hello',
      });
      expect(result.systemPrompt).toBeUndefined();
    });

    it('should accept empty string systemPrompt', () => {
      const result = chatRequestSchema.parse({
        message: 'hello',
        systemPrompt: '',
      });
      expect(result.systemPrompt).toBe('');
    });

    it('should reject non-string systemPrompt', () => {
      expect(() =>
        chatRequestSchema.parse({
          message: 'hello',
          systemPrompt: 123,
        } as any),
      ).toThrow();
    });
  });

  describe('model', () => {
    it('should accept undefined model', () => {
      const result = chatRequestSchema.parse({
        message: 'hello',
      });
      expect(result.model).toBeUndefined();
    });

    it('should accept a valid model string', () => {
      const result = chatRequestSchema.parse({
        message: 'hello',
        model: 'haiku',
      });
      expect(result.model).toBe('haiku');
    });

    it('should accept any string for model at schema level (allowlist enforced at route)', () => {
      // Schema only validates type; allowlist is enforced in the route handler
      const result = chatRequestSchema.parse({
        message: 'hello',
        model: 'fake-model-xyz',
      });
      expect(result.model).toBe('fake-model-xyz');
    });
  });

  describe('model allowlist enforcement', () => {
    it('ALLOWED_MODELS should contain known models', () => {
      expect(ALLOWED_MODELS.has('haiku')).toBe(true);
      expect(ALLOWED_MODELS.has('sonnet')).toBe(true);
      expect(ALLOWED_MODELS.has('opus')).toBe(true);
      expect(ALLOWED_MODELS.has('gpt-5.5')).toBe(true);
      expect(ALLOWED_MODELS.has('gpt-4o')).toBe(true);
    });

    it('ALLOWED_MODELS should reject unknown models', () => {
      expect(ALLOWED_MODELS.has('malicious-model')).toBe(false);
      expect(ALLOWED_MODELS.has('../../etc/passwd')).toBe(false);
      expect(ALLOWED_MODELS.has('')).toBe(false);
    });

    it('should have exactly 8 allowed models', () => {
      expect(ALLOWED_MODELS.size).toBe(8);
    });
  });

  describe('defaults', () => {
    it('should default mode to productivity', () => {
      const result = chatRequestSchema.parse({ message: 'hello' });
      expect(result.mode).toBe('productivity');
    });

    it('should default userId to "user"', () => {
      const result = chatRequestSchema.parse({ message: 'hello' });
      expect(result.userId).toBe('user');
    });

    it('should default includeTools to true', () => {
      const result = chatRequestSchema.parse({ message: 'hello' });
      expect(result.includeTools).toBe(true);
    });

    it('should default includeMemory to true', () => {
      const result = chatRequestSchema.parse({ message: 'hello' });
      expect(result.includeMemory).toBe(true);
    });
  });
});
