import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/context-engine/context-packet', () => ({
  assembleContextPacket: vi.fn(),
}));

vi.mock('../../../../src/context-engine/adapters/claimkit-adapter', () => ({
  claimKitAdapter: {
    initialize: vi.fn(),
    query: vi.fn(),
    ground: vi.fn(),
  },
}));

vi.mock('../../../../src/agent/opencode-client', () => ({
  aiClient: {
    isConfigured: vi.fn(),
    chat: vi.fn(),
  },
}));

import { runClaimKitComparison } from '../../../../src/eval/comparison/claimkit-comparison';
import { assembleContextPacket } from '../../../../src/context-engine/context-packet';
import { claimKitAdapter } from '../../../../src/context-engine/adapters/claimkit-adapter';
import { aiClient } from '../../../../src/agent/opencode-client';

function makeRagPacket(overrides: Record<string, unknown> = {}) {
  return {
    totalTokens: 1000,
    sections: [{ name: 'system', content: 'system context' }, { name: 'documents', content: 'doc content' }],
    messages: [],
    budgetBreakdown: [],
    diagnostics: {
      mode: 'engineering',
      originalMessageCount: 0,
      finalMessageCount: 1,
      documentsRetrieved: 3,
      documentsCompressed: 2,
      compressionRatio: 1.5,
      budgetUtilization: {},
      createdAt: new Date(),
    },
    ...overrides,
  };
}

function makeCkResult(overrides: Record<string, unknown> = {}) {
  return {
    answer: 'The answer',
    citations: [],
    confidence: 0.8,
    contradictions: [],
    missingEvidence: [],
    answerability: 'answerable' as const,
    metadata: {
      sourceIds: ['s1'],
      claimCount: 5,
      processingTimeMs: 120,
      retrievalScore: 0.9,
    },
    ...overrides,
  };
}

const ALL_CATEGORIES = [
  'code_retrieval',
  'entity_linking',
  'staleness',
  'citation_laundering',
  'direct_fact',
  'planning_synthesis',
] as const;

describe('runClaimKitComparison', () => {
  beforeEach(() => {
    vi.mocked(claimKitAdapter.initialize).mockResolvedValue(true);
    vi.mocked(assembleContextPacket).mockResolvedValue(makeRagPacket() as never);
    vi.mocked(claimKitAdapter.query).mockResolvedValue(makeCkResult() as never);
    vi.mocked(claimKitAdapter.ground).mockResolvedValue({
      grounded: true,
      hallucinationRate: 0,
      sentenceResults: [],
      evidenceClaimCount: 3,
      sourceIds: ['s1'],
      processingTimeMs: 50,
    } as never);
    vi.mocked(aiClient.isConfigured).mockReturnValue(false);
  });

  describe('winner determination', () => {
    it('returns claimkit winner when confidence > 0.5 and answerable', async () => {
      vi.mocked(claimKitAdapter.query).mockResolvedValue(
        makeCkResult({ confidence: 0.9, answerability: 'answerable' }) as never,
      );
      const result = await runClaimKitComparison({
        queries: ['test query'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].overallWinner).toBe('claimkit');
      expect(result.aggregate.wins.claimkit).toBe(1);
      expect(result.aggregate.wins.rag).toBe(0);
    });

    it('returns tie when ClaimKit is unavailable and RAG not measured', async () => {
      vi.mocked(claimKitAdapter.initialize).mockResolvedValue(false);
      const result = await runClaimKitComparison({
        queries: ['test query'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].overallWinner).toBe('tie');
      expect(result.cases[0].claimkit).toBeNull();
    });

    it('returns tie when ClaimKit query throws', async () => {
      vi.mocked(claimKitAdapter.query).mockRejectedValue(new Error('network error'));
      const result = await runClaimKitComparison({
        queries: ['test query'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].overallWinner).toBe('tie');
      expect(result.cases[0].claimkit).toBeNull();
    });

    it('returns tie when confidence < 0.3 and RAG not measured', async () => {
      vi.mocked(claimKitAdapter.query).mockResolvedValue(
        makeCkResult({ confidence: 0.2, answerability: 'answerable' }) as never,
      );
      const result = await runClaimKitComparison({
        queries: ['test query'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].overallWinner).toBe('tie');
    });

    it('returns claimkit when answerability is not_answerable (honest abstention)', async () => {
      vi.mocked(claimKitAdapter.query).mockResolvedValue(
        makeCkResult({ confidence: 0.8, answerability: 'not_answerable' }) as never,
      );
      const result = await runClaimKitComparison({
        queries: ['test query'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].overallWinner).toBe('claimkit');
    });

    it('returns tie when confidence is between 0.3 and 0.5', async () => {
      vi.mocked(claimKitAdapter.query).mockResolvedValue(
        makeCkResult({ confidence: 0.4, answerability: 'partially_answerable' }) as never,
      );
      const result = await runClaimKitComparison({
        queries: ['test query'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].overallWinner).toBe('tie');
      expect(result.aggregate.wins.tie).toBe(1);
    });

    it('returns tie when confidence is exactly 0.5 and answerable', async () => {
      vi.mocked(claimKitAdapter.query).mockResolvedValue(
        makeCkResult({ confidence: 0.5, answerability: 'answerable' }) as never,
      );
      const result = await runClaimKitComparison({
        queries: ['test query'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].overallWinner).toBe('tie');
    });

    it('returns claimkit when RAG hallucinates (hallucinationRate > 0)', async () => {
      vi.mocked(aiClient.isConfigured).mockReturnValue(true);
      vi.mocked(aiClient.chat).mockResolvedValue({ content: ' hallucinated answer ' } as never);
      vi.mocked(claimKitAdapter.ground).mockResolvedValue({
        grounded: false,
        hallucinationRate: 0.5,
        sentenceResults: [{ text: 'hallucinated', supported: false, supportingClaimIds: [], confidence: 0.3 }],
        evidenceClaimCount: 2,
        sourceIds: ['s1'],
        processingTimeMs: 60,
      } as never);

      vi.mocked(claimKitAdapter.query).mockResolvedValue(
        makeCkResult({ confidence: 0.2, answerability: 'not_answerable' }) as never,
      );

      const result = await runClaimKitComparison({
        queries: ['test query'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].rag.hallucinationRate).toBe(0.5);
      expect(result.cases[0].rag.grounded).toBe(false);
      expect(result.cases[0].overallWinner).toBe('claimkit');
    });

    it('returns tie when CK is unavailable (cannot measure RAG)', async () => {
      vi.mocked(claimKitAdapter.initialize).mockResolvedValue(false);
      const result = await runClaimKitComparison({
        queries: ['test query'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].overallWinner).toBe('tie');
      expect(result.cases[0].rag.grounded).toBeNull();
    });

    it('returns rag when CK query fails but RAG is fully grounded', async () => {
      vi.mocked(claimKitAdapter.initialize).mockResolvedValue(true);
      vi.mocked(claimKitAdapter.query).mockRejectedValue(new Error('query error'));
      vi.mocked(aiClient.isConfigured).mockReturnValue(true);
      vi.mocked(aiClient.chat).mockResolvedValue({ content: 'grounded answer' } as never);
      vi.mocked(claimKitAdapter.ground).mockResolvedValue({
        grounded: true,
        hallucinationRate: 0,
        sentenceResults: [],
        evidenceClaimCount: 3,
        sourceIds: ['s1'],
        processingTimeMs: 50,
      } as never);

      const result = await runClaimKitComparison({
        queries: ['test query'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].overallWinner).toBe('rag');
      expect(result.cases[0].rag.grounded).toBe(true);
    });

    it('returns tie when CK abstains and RAG is grounded', async () => {
      vi.mocked(aiClient.isConfigured).mockReturnValue(true);
      vi.mocked(aiClient.chat).mockResolvedValue({ content: 'grounded answer' } as never);
      vi.mocked(claimKitAdapter.ground).mockResolvedValue({
        grounded: true,
        hallucinationRate: 0,
        sentenceResults: [],
        evidenceClaimCount: 3,
        sourceIds: ['s1'],
        processingTimeMs: 50,
      } as never);

      vi.mocked(claimKitAdapter.query).mockResolvedValue(
        makeCkResult({ confidence: 0.1, answerability: 'not_answerable' }) as never,
      );

      const result = await runClaimKitComparison({
        queries: ['test query'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].overallWinner).toBe('tie');
    });
  });

  describe('query categorization', () => {
    it('categorizes code-related queries as code_retrieval', async () => {
      const result = await runClaimKitComparison({
        queries: ['where is the file for auth'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].category).toBe('code_retrieval');
    });

    it('categorizes function queries as code_retrieval', async () => {
      const result = await runClaimKitComparison({
        queries: ['what does this function do'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].category).toBe('code_retrieval');
    });

    it('categorizes person queries as entity_linking', async () => {
      const result = await runClaimKitComparison({
        queries: ['who owns this module'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].category).toBe('entity_linking');
    });

    it('categorizes date queries as staleness', async () => {
      const result = await runClaimKitComparison({
        queries: ['when was this last updated'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].category).toBe('staleness');
    });

    it('categorizes source queries as citation_laundering', async () => {
      const result = await runClaimKitComparison({
        queries: ['what is the source for this claim'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].category).toBe('citation_laundering');
    });

    it('categorizes planning queries as planning_synthesis', async () => {
      const result = await runClaimKitComparison({
        queries: ['how do we build a process for onboarding'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].category).toBe('planning_synthesis');
    });

    it('categorizes assessment queries as planning_synthesis', async () => {
      const result = await runClaimKitComparison({
        queries: ['what is the feasibility of this roadmap'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].category).toBe('planning_synthesis');
    });

    it('defaults to direct_fact for unrecognized queries', async () => {
      const result = await runClaimKitComparison({
        queries: ['is this correct'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.cases[0].category).toBe('direct_fact');
    });

    it('falls back to first allowed category if determined category not in list', async () => {
      const result = await runClaimKitComparison({
        queries: ['what does this function do'],
        categories: ['entity_linking', 'staleness'],
      });
      expect(result.cases[0].category).toBe('entity_linking');
    });
  });

  describe('aggregate stats', () => {
    it('aggregates wins across multiple queries', async () => {
      vi.mocked(claimKitAdapter.query)
        .mockResolvedValueOnce(makeCkResult({ confidence: 0.9, answerability: 'answerable' }) as never)
        .mockResolvedValueOnce(makeCkResult({ confidence: 0.1, answerability: 'answerable' }) as never)
        .mockResolvedValueOnce(makeCkResult({ confidence: 0.4, answerability: 'partially_answerable' }) as never);

      const result = await runClaimKitComparison({
        queries: ['query 1', 'query 2', 'query 3'],
        categories: [...ALL_CATEGORIES],
      });

      expect(result.totalCases).toBe(3);
      expect(result.aggregate.wins.claimkit).toBe(1);
      expect(result.aggregate.wins.rag).toBe(0);
      expect(result.aggregate.wins.tie).toBe(2);
    });

    it('computes correct mean confidence from claimkit results', async () => {
      vi.mocked(claimKitAdapter.query)
        .mockResolvedValueOnce(makeCkResult({ confidence: 0.6 }) as never)
        .mockResolvedValueOnce(makeCkResult({ confidence: 0.8 }) as never);

      const result = await runClaimKitComparison({
        queries: ['q1', 'q2'],
        categories: [...ALL_CATEGORIES],
      });

      expect(result.aggregate.claimkit.mean.confidence).toBeCloseTo(0.7, 5);
    });

    it('computes zero stats when ClaimKit unavailable', async () => {
      vi.mocked(claimKitAdapter.initialize).mockResolvedValue(false);

      const result = await runClaimKitComparison({
        queries: ['q1'],
        categories: [...ALL_CATEGORIES],
      });

      expect(result.aggregate.claimkit.mean.confidence).toBe(0);
      expect(result.aggregate.claimkit.mean.answerabilityRate).toBe(0);
      expect(result.aggregate.claimkit.mean.avgClaims).toBe(0);
    });

    it('computes rag stats from packet data', async () => {
      vi.mocked(assembleContextPacket)
        .mockResolvedValueOnce(makeRagPacket({ totalTokens: 500, sections: [{ name: 'a', content: 'a' }] }) as never)
        .mockResolvedValueOnce(makeRagPacket({ totalTokens: 1500, sections: [{ name: 'a', content: 'a' }, { name: 'b', content: 'b' }, { name: 'c', content: 'c' }] }) as never);

      const result = await runClaimKitComparison({
        queries: ['q1', 'q2'],
        categories: [...ALL_CATEGORIES],
      });

      expect(result.aggregate.rag.mean.avgTokens).toBe(1000);
      expect(result.aggregate.rag.mean.avgSections).toBe(2);
    });

    it('handles empty query list', async () => {
      const result = await runClaimKitComparison({
        queries: [],
        categories: [...ALL_CATEGORIES],
      });

      expect(result.totalCases).toBe(0);
      expect(result.cases).toHaveLength(0);
      expect(result.aggregate.wins.claimkit).toBe(0);
      expect(result.aggregate.rag.mean.avgTokens).toBe(0);
      expect(result.aggregate.claimkit.mean.confidence).toBe(0);
    });
  });

  describe('threshold evaluation', () => {
    it('includes thresholdEvaluation in result', async () => {
      vi.mocked(claimKitAdapter.query).mockResolvedValue(
        makeCkResult({ confidence: 0.9, answerability: 'answerable' }) as never,
      );
      const result = await runClaimKitComparison({
        queries: ['test'],
        categories: [...ALL_CATEGORIES],
      });
      expect(result.thresholdEvaluation).toBeDefined();
      expect(typeof result.thresholdEvaluation?.passed).toBe('boolean');
    });

    it('uses custom thresholds when provided', async () => {
      vi.mocked(claimKitAdapter.initialize).mockResolvedValue(false);

      const result = await runClaimKitComparison({
        queries: ['q1'],
        categories: [...ALL_CATEGORIES],
        thresholds: {
          minTruthfulAnswerRate: 0,
          minClaimKitConfidence: 0,
          minAnswerabilityRate: 0,
          maxAvgProcessingTimeMs: 999999,
          maxRagHallucinationRate: 1,
          minRagGroundedRate: 0,
        },
      });

      expect(result.thresholdEvaluation?.passed).toBe(true);
      expect(result.thresholdEvaluation?.failures).toHaveLength(0);
    });

    it('reports threshold failures when claimkit underperforms', async () => {
      vi.mocked(claimKitAdapter.initialize).mockResolvedValue(false);

      const result = await runClaimKitComparison({
        queries: ['q1', 'q2'],
        categories: [...ALL_CATEGORIES],
      });

      expect(result.thresholdEvaluation?.passed).toBe(false);
      expect(result.thresholdEvaluation?.failures.length).toBeGreaterThan(0);
    });
  });

  describe('case data population', () => {
    it('records contradictions count from claimkit result', async () => {
      vi.mocked(claimKitAdapter.query).mockResolvedValue(
        makeCkResult({
          confidence: 0.9,
          answerability: 'answerable',
          contradictions: [
            { claimA: 'a', claimB: 'b', reason: 'conflict' },
            { claimA: 'c', claimB: 'd', reason: 'mismatch' },
          ],
        }) as never,
      );

      const result = await runClaimKitComparison({
        queries: ['test'],
        categories: [...ALL_CATEGORIES],
      });

      expect(result.cases[0].claimkit?.contradictions).toBe(2);
    });

    it('records claimCount from metadata', async () => {
      vi.mocked(claimKitAdapter.query).mockResolvedValue(
        makeCkResult({ metadata: { sourceIds: [], claimCount: 12, processingTimeMs: 80, retrievalScore: 0.7 } }) as never,
      );

      const result = await runClaimKitComparison({
        queries: ['test'],
        categories: [...ALL_CATEGORIES],
      });

      expect(result.cases[0].claimkit?.claimCount).toBe(12);
    });

    it('records rag section count from packet sections', async () => {
      vi.mocked(assembleContextPacket).mockResolvedValue(
        makeRagPacket({ sections: [{ name: 'a', content: 'a' }, { name: 'b', content: 'b' }, { name: 'c', content: 'c' }, { name: 'd', content: 'd' }] }) as never,
      );

      const result = await runClaimKitComparison({
        queries: ['test'],
        categories: [...ALL_CATEGORIES],
      });

      expect(result.cases[0].rag.sections).toBe(4);
    });

    it('records hallucinationRate and grounded when RAG answer is measured', async () => {
      vi.mocked(aiClient.isConfigured).mockReturnValue(true);
      vi.mocked(aiClient.chat).mockResolvedValue({ content: 'some answer' } as never);
      vi.mocked(claimKitAdapter.ground).mockResolvedValue({
        grounded: false,
        hallucinationRate: 0.25,
        sentenceResults: [],
        evidenceClaimCount: 2,
        sourceIds: ['s1'],
        processingTimeMs: 60,
      } as never);

      const result = await runClaimKitComparison({
        queries: ['test'],
        categories: [...ALL_CATEGORIES],
      });

      expect(result.cases[0].rag.hallucinationRate).toBe(0.25);
      expect(result.cases[0].rag.grounded).toBe(false);
    });
  });
});
