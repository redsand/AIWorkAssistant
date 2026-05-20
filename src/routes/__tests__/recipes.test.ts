import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { recipeRoutes } from '../recipes';

describe('Recipe Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(recipeRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/recipes', () => {
    it('should return 200 with recipe list', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/recipes' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.recipes)).toBe(true);
      expect(body.recipes.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/recipes/:id', () => {
    it('should return 200 with recipe for known ID', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/recipes/triage-new-ticket' });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe('triage-new-ticket');
    });

    it('should return 404 for unknown recipe ID', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/recipes/does-not-exist' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBeDefined();
    });
  });

  describe('POST /api/recipes/:id/execute', () => {
    it('should return 200 with execution for valid request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/recipes/triage-new-ticket/execute',
        payload: { ticketId: 123 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.recipeId).toBe('triage-new-ticket');
      expect(body.status).toBe('running');
    });

    it('should return 404 for unknown recipe', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/recipes/does-not-exist/execute',
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/Recipe not found/i);
    });

    it('should return 400 for missing required variable', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/recipes/triage-new-ticket/execute',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('ticketId');
    });

    it('should return 400 for invalid variable type (string for number)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/recipes/triage-new-ticket/execute',
        payload: { ticketId: 'abc' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('ticketId');
    });
  });

  describe('GET /api/recipes/executions/:executionId', () => {
    it('should return 200 with execution for known ID', async () => {
      const execRes = await app.inject({
        method: 'POST',
        url: '/api/recipes/triage-new-ticket/execute',
        payload: { ticketId: 1 },
      });
      const { id } = execRes.json();

      const res = await app.inject({
        method: 'GET',
        url: `/api/recipes/executions/${id}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(id);
    });

    it('should return 404 for unknown execution ID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/recipes/executions/does-not-exist',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBeDefined();
    });
  });
});
