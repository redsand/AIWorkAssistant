import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockChat = vi.fn();
const mockFallbackExtractClaims = vi.fn();
const mockFallbackGenerateAnswer = vi.fn();
const mockFallbackDetectContradictions = vi.fn();
const mockFallbackVerifyClaims = vi.fn();

vi.mock("../../../src/agent/providers/factory", () => ({
  getProvider: () => mockProvider,
  resetProvider: vi.fn(),
}));

vi.mock("@redsand/claimkit", () => ({
  MemoryLLMAdapter: vi.fn(function (this: any) {
    this.extractClaims = mockFallbackExtractClaims;
    this.generateAnswer = mockFallbackGenerateAnswer;
    this.detectContradictions = mockFallbackDetectContradictions;
    this.verifyClaims = mockFallbackVerifyClaims;
  }),
}));

const mockProvider = {
  chat: mockChat,
  name: "test-provider",
};

import { AIProviderLLMAdapter, stripJsonFromLlmResponse } from "../../../src/context-engine/adapters/claimkit-llm-adapter";

describe("AIProviderLLMAdapter", () => {
  let adapter: AIProviderLLMAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AIProviderLLMAdapter(mockProvider as any, "test-model");
  });

  // ── generateText ──────────────────────────────────────────────────────────────

  describe("generateText", () => {
    it("converts LLMMessage[] to ChatMessage[] and calls provider.chat()", async () => {
      mockChat.mockResolvedValue({
        content: "Hello world",
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      const result = await adapter.generateText([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Say hello" },
      ]);

      expect(result.text).toBe("Hello world");
      expect(result.model).toBe("test-model");
      expect(result.finishReason).toBe("stop");
      expect(result.usage?.promptTokens).toBe(10);
      expect(result.usage?.completionTokens).toBe(5);
      expect(result.usage?.totalTokens).toBe(15);

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Say hello" },
          ],
          model: "test-model",
        }),
      );
    });

    it("passes through options as ChatRequest fields", async () => {
      mockChat.mockResolvedValue({
        content: "ok",
        model: "m",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });

      await adapter.generateText([{ role: "user", content: "test" }], {
        temperature: 0.5,
        maxTokens: 100,
        topP: 0.9,
      });

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.5,
          maxTokens: 100,
          top_p: 0.9,
        }),
      );
    });
  });

  // ── generateJson ──────────────────────────────────────────────────────────────

  describe("generateJson", () => {
    it("calls chat with jsonMode: true and parses response as JSON", async () => {
      const jsonPayload = { claims: [{ text: "foo", confidence: 0.9 }] };
      mockChat.mockResolvedValue({
        content: JSON.stringify(jsonPayload),
        model: "test-model",
      });

      const result = await adapter.generateJson(
        [{ role: "user", content: "extract" }],
        {},
      );

      expect(result).toEqual(jsonPayload);
      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({ jsonMode: true }),
      );
    });

    it("throws if response is not valid JSON", async () => {
      mockChat.mockResolvedValue({
        content: "not json at all",
        model: "test-model",
      });

      await expect(
        adapter.generateJson([{ role: "user", content: "test" }], {}),
      ).rejects.toThrow();
    });

    it("strips markdown code fences with json label before parsing", async () => {
      const payload = { answer: "yes" };
      mockChat.mockResolvedValue({
        content: "```json\n" + JSON.stringify(payload, null, 2) + "\n```",
        model: "test-model",
      });

      const result = await adapter.generateJson([{ role: "user", content: "test" }], {});
      expect(result).toEqual(payload);
    });

    it("strips markdown code fences without language label before parsing", async () => {
      const payload = { answer: "no" };
      mockChat.mockResolvedValue({
        content: "```\n" + JSON.stringify(payload) + "\n```",
        model: "test-model",
      });

      const result = await adapter.generateJson([{ role: "user", content: "test" }], {});
      expect(result).toEqual(payload);
    });

    it("extracts JSON from surrounding text", async () => {
      const payload = { claims: [] };
      mockChat.mockResolvedValue({
        content: "Here is the result:\n" + JSON.stringify(payload) + "\nDone.",
        model: "test-model",
      });

      const result = await adapter.generateJson([{ role: "user", content: "test" }], {});
      expect(result).toEqual(payload);
    });

    it("extracts JSON array from surrounding text", async () => {
      const payload = [1, 2, 3];
      mockChat.mockResolvedValue({
        content: "Results: " + JSON.stringify(payload) + " End",
        model: "test-model",
      });

      const result = await adapter.generateJson([{ role: "user", content: "test" }], {});
      expect(result).toEqual(payload);
    });
  });

  // ── extractClaims ─────────────────────────────────────────────────────────────

  describe("extractClaims", () => {
    it("builds a structured prompt with evidence delimiters and returns claims", async () => {
      const claims = [
        {
          text: "Paris is the capital of France",
          subject: "Paris",
          predicate: "is capital of",
          object: "France",
          evidenceText: "Paris is the capital of France",
          startOffset: 0,
          endOffset: 30,
          entities: ["Paris", "France"],
          confidence: 0.95,
        },
      ];
      mockChat.mockResolvedValue({
        content: JSON.stringify({ claims }),
        model: "test-model",
      });

      const result = await adapter.extractClaims(
        "Paris is the capital of France",
        "src-1",
        "chunk-1",
      );

      expect(result).toHaveLength(1);
      expect(result[0].subject).toBe("Paris");
      expect(result[0].confidence).toBe(0.95);

      // Verify evidence delimiters in the prompt
      const callArgs = mockChat.mock.calls[0][0];
      const userMsg = callArgs.messages.find(
        (m: any) => m.role === "user",
      );
      expect(userMsg.content).toContain("<evidence>");
      expect(userMsg.content).toContain("</evidence>");
      expect(userMsg.content).toContain("Paris is the capital of France");
    });

    it("filters claims below minConfidence", async () => {
      const claims = [
        {
          text: "Maybe something",
          subject: "X",
          predicate: "might be",
          object: "Y",
          evidenceText: "Maybe something",
          startOffset: 0,
          endOffset: 14,
          entities: [],
          confidence: 0.1,
        },
      ];
      mockChat.mockResolvedValue({
        content: JSON.stringify({ claims }),
        model: "test-model",
      });

      const result = await adapter.extractClaims("Maybe something", "s1", "c1", {
        minConfidence: 0.3,
      });

      expect(result).toHaveLength(0);
    });

    it("falls back to MemoryLLMAdapter when LLM call fails", async () => {
      mockChat.mockRejectedValue(new Error("LLM unavailable"));
      const fallbackClaims = [
        {
          text: "fallback claim",
          subject: "A",
          predicate: "is",
          object: "B",
          evidenceText: "fallback claim",
          startOffset: 0,
          endOffset: 13,
          entities: [],
          confidence: 0.5,
        },
      ];
      mockFallbackExtractClaims.mockResolvedValue(fallbackClaims);

      const result = await adapter.extractClaims("some text", "s1", "c1");

      expect(mockFallbackExtractClaims).toHaveBeenCalledWith(
        "some text",
        "s1",
        "c1",
        undefined,
      );
      expect(result).toEqual(fallbackClaims);
    });

    it("returns empty array for empty chunkText", async () => {
      const result = await adapter.extractClaims("", "s1", "c1");
      expect(result).toEqual([]);
      expect(mockChat).not.toHaveBeenCalled();
    });

    it("returns empty array for whitespace-only chunkText", async () => {
      const result = await adapter.extractClaims("   \n\t  ", "s1", "c1");
      expect(result).toEqual([]);
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  // ── generateAnswer ────────────────────────────────────────────────────────────

  describe("generateAnswer", () => {
    const mockPacket = {
      claims: [
        {
          claim: {
            id: "claim-1",
            subject: "Paris",
            predicate: "is capital of",
            object: "France",
            confidence: 0.95,
          },
          relevanceScore: 0.9,
          combinedScore: 0.92,
        },
      ],
    } as any;

    it("formats claims with id and confidence in the prompt", async () => {
      const answer = {
        answer: "Paris is the capital of France.",
        citationClaimIds: ["claim-1"],
        confidence: 0.9,
        missingEvidence: [],
      };
      mockChat.mockResolvedValue({
        content: JSON.stringify(answer),
        model: "test-model",
      });

      const result = await adapter.generateAnswer(mockPacket, "What is the capital of France?");

      expect(result.answer).toBe("Paris is the capital of France.");
      expect(result.citationClaimIds).toContain("claim-1");

      const callArgs = mockChat.mock.calls[0][0];
      const userMsg = callArgs.messages.find(
        (m: any) => m.role === "user",
      );
      expect(userMsg.content).toContain("[id: claim-1]");
      expect(userMsg.content).toContain("[confidence: 0.95]");
    });

    it("falls back to MemoryLLMAdapter when LLM call fails", async () => {
      mockChat.mockRejectedValue(new Error("timeout"));
      const fallbackResult = {
        answer: "fallback answer",
        citationClaimIds: [],
        confidence: 0.5,
        missingEvidence: [],
      };
      mockFallbackGenerateAnswer.mockResolvedValue(fallbackResult);

      const result = await adapter.generateAnswer(mockPacket, "test question");

      expect(mockFallbackGenerateAnswer).toHaveBeenCalledWith(
        mockPacket,
        "test question",
      );
      expect(result.answer).toBe("fallback answer");
    });
  });

  // ── detectContradictions ─────────────────────────────────────────────────────

  describe("detectContradictions", () => {
    const mockClaims = [
      {
        id: "c1",
        subject: "X",
        predicate: "is",
        object: "A",
        text: "X is A",
      },
      {
        id: "c2",
        subject: "X",
        predicate: "is",
        object: "B",
        text: "X is B",
      },
    ] as any;

    it("formats claims and returns contradictions with detectedBy=llm", async () => {
      const contradictions = [
        {
          claimId1: "c1",
          claimId2: "c2",
          claimText1: "X is A",
          claimText2: "X is B",
          explanation: "X cannot be both A and B",
          severity: "high",
        },
      ];
      mockChat.mockResolvedValue({
        content: JSON.stringify({ contradictions }),
        model: "test-model",
      });

      const result = await adapter.detectContradictions(mockClaims);

      expect(result).toHaveLength(1);
      expect(result[0].detectedBy).toBe("llm");
      expect(result[0].severity).toBe("high");
    });

    it("falls back to MemoryLLMAdapter when LLM call fails", async () => {
      mockChat.mockRejectedValue(new Error("fail"));
      mockFallbackDetectContradictions.mockResolvedValue([]);

      const result = await adapter.detectContradictions(mockClaims);

      expect(mockFallbackDetectContradictions).toHaveBeenCalledWith(mockClaims);
      expect(result).toEqual([]);
    });
  });

  // ── verifyClaims ──────────────────────────────────────────────────────────────

  describe("verifyClaims", () => {
    const mockPacket = {
      claims: [
        {
          claim: {
            id: "claim-1",
            subject: "Paris",
            predicate: "is capital of",
            object: "France",
          },
        },
      ],
    } as any;

    it("returns ClaimVerificationResult from LLM response", async () => {
      const verification = {
        verified: true,
        overallConfidence: 0.9,
        assertions: [
          {
            text: "Paris is the capital of France",
            supported: true,
            supportingClaimIds: ["claim-1"],
            confidence: 0.9,
          },
        ],
        supportedAssertionCount: 1,
        unsupportedAssertionCount: 0,
        unsupportedPhrases: [],
      };
      mockChat.mockResolvedValue({
        content: JSON.stringify(verification),
        model: "test-model",
      });

      const result = await adapter.verifyClaims(
        "Paris is the capital of France.",
        mockPacket,
      );

      expect(result.verified).toBe(true);
      expect(result.overallConfidence).toBe(0.9);
      expect(result.assertions).toHaveLength(1);
    });

    it("falls back to MemoryLLMAdapter when LLM call fails", async () => {
      mockChat.mockRejectedValue(new Error("fail"));
      const fallbackResult = {
        verified: false,
        overallConfidence: 0,
        assertions: [],
        supportedAssertionCount: 0,
        unsupportedAssertionCount: 0,
        unsupportedPhrases: [],
      };
      mockFallbackVerifyClaims.mockResolvedValue(fallbackResult);

      const result = await adapter.verifyClaims("answer", mockPacket);

      expect(mockFallbackVerifyClaims).toHaveBeenCalledWith(
        "answer",
        mockPacket,
      );
      expect(result.verified).toBe(false);
    });
  });

  // ── constructor defaults ─────────────────────────────────────────────────────

  describe("constructor", () => {
    it("uses the provided provider and model", () => {
      const a = new AIProviderLLMAdapter(mockProvider as any, "my-model");
      expect(a).toBeDefined();
    });

    it("defaults model to undefined when not provided", () => {
      const a = new AIProviderLLMAdapter(mockProvider as any);
      expect(a).toBeDefined();
    });
  });
});

// ── stripJsonFromLlmResponse ───────────────────────────────────────────────────

describe("stripJsonFromLlmResponse", () => {
  it("returns content unchanged when it is plain JSON", () => {
    const json = '{"a":1}';
    expect(stripJsonFromLlmResponse(json)).toBe(json);
  });

  it("strips ```json code fences", () => {
    const inner = '{"a":1}';
    expect(stripJsonFromLlmResponse("```json\n" + inner + "\n```")).toBe(inner);
  });

  it("strips ``` code fences without language label", () => {
    const inner = '{"b":2}';
    expect(stripJsonFromLlmResponse("```\n" + inner + "\n```")).toBe(inner);
  });

  it("extracts JSON object from surrounding text", () => {
    const json = '{"result":true}';
    expect(stripJsonFromLlmResponse("Here:\n" + json + "\nEnd.")).toBe(json);
  });

  it("extracts JSON array from surrounding text", () => {
    const json = '[1,2,3]';
    expect(stripJsonFromLlmResponse("prefix " + json + " suffix")).toBe(json);
  });

  it("returns original content when no JSON found", () => {
    expect(stripJsonFromLlmResponse("no json here")).toBe("no json here");
  });
});
