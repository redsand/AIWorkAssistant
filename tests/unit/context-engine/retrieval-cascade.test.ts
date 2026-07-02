import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks for the default-wiring tests. The pure RetrievalCascade.run tests use
// hand-written fakes and don't touch these.
const mockChat = vi.fn();
const mockWebIsConfigured = vi.fn();
const mockWebSearch = vi.fn();

const mockEnv = {
  CASCADE_TEACHER_MODEL: "",
  CASCADE_BUDGET_TOKENS: 5000,
  CASCADE_STOP_CONFIDENCE: 0.8,
  CASCADE_TEACHER_COST_TOKENS: 1000,
  CASCADE_TOOL_COST_TOKENS: 2000,
  CLAIMKIT_LOW_CONFIDENCE_THRESHOLD: 0.5,
};

function installMocks() {
  vi.doMock("../../../src/config/env", () => ({ env: mockEnv }));
  vi.doMock("../../../src/agent/opencode-client", () => ({
    aiClient: { chat: mockChat },
  }));
  vi.doMock("../../../src/integrations/web/search-client", () => ({
    webSearchClient: { isConfigured: mockWebIsConfigured, search: mockWebSearch },
  }));
}

async function loadModule() {
  vi.resetModules();
  installMocks();
  return import("../../../src/context-engine/retrieval-cascade");
}

const baseConfig = {
  budgetTokens: 5000,
  stopConfidence: 0.8,
  lowThreshold: 0.5,
  teacherCostTokens: 1000,
  toolCostTokens: 2000,
};

function makeTeacher(verdict: { confirmed: boolean; confidence: number; tokensUsed?: number }) {
  return { verify: vi.fn(async () => ({ tokensUsed: 900, ...verdict })) };
}

function makeResearcher(result: {
  resolved: boolean;
  confidence: number;
  tokensUsed?: number;
  evidence?: string;
}) {
  return {
    research: vi.fn(async () => ({ evidence: "", tokensUsed: 1800, ...result })),
  };
}

const input = { query: "what is the deploy process", claimKitAnswer: "Run deploy.sh", confidence: 0 };

describe("RetrievalCascade.run", () => {
  it("resolves at CLAIMKIT when probe confidence is already high", async () => {
    const { RetrievalCascade, CascadeLevel } = await loadModule();
    const teacher = makeTeacher({ confirmed: false, confidence: 0 });
    const researcher = makeResearcher({ resolved: false, confidence: 0 });
    const cascade = new RetrievalCascade(teacher, researcher, baseConfig);

    const res = await cascade.run({ ...input, confidence: 0.9 });

    expect(res.level).toBe(CascadeLevel.CLAIMKIT);
    expect(res.outcome).toBe("ck_high_confidence");
    expect(res.tokensUsed).toBe(0);
    // The probe answer is already confident enough — it is the resolution.
    expect(res.resolution).toBe("Run deploy.sh");
    expect(teacher.verify).not.toHaveBeenCalled();
    expect(researcher.research).not.toHaveBeenCalled();
  });

  it("stops at TEACHER_VERIFY when the teacher confirms a medium-confidence answer", async () => {
    const { RetrievalCascade, CascadeLevel } = await loadModule();
    const teacher = makeTeacher({ confirmed: true, confidence: 0.9, tokensUsed: 950 });
    const researcher = makeResearcher({ resolved: true, confidence: 1 });
    const cascade = new RetrievalCascade(teacher, researcher, baseConfig);

    const res = await cascade.run({ ...input, confidence: 0.6 });

    expect(res.level).toBe(CascadeLevel.TEACHER_VERIFY);
    expect(res.outcome).toBe("teacher_confirmed");
    expect(res.confidence).toBe(0.9);
    expect(res.tokensUsed).toBe(950);
    // Teacher endorsed the candidate answer — that is the durable resolution,
    // now carrying the teacher's high confidence rather than the probe's.
    expect(res.resolution).toBe("Run deploy.sh");
    expect(teacher.verify).toHaveBeenCalledTimes(1);
    expect(researcher.research).not.toHaveBeenCalled();
  });

  it("escalates to TOOL_RESEARCH when the teacher rejects, and stops on strong evidence", async () => {
    const { RetrievalCascade, CascadeLevel } = await loadModule();
    const teacher = makeTeacher({ confirmed: false, confidence: 0.2, tokensUsed: 900 });
    const researcher = makeResearcher({
      resolved: true,
      confidence: 0.85,
      tokensUsed: 1700,
      evidence: "Web evidence: run deploy.sh to trigger the release pipeline.",
    });
    const cascade = new RetrievalCascade(teacher, researcher, baseConfig);

    const res = await cascade.run({ ...input, confidence: 0.6 });

    expect(res.level).toBe(CascadeLevel.TOOL_RESEARCH);
    expect(res.outcome).toBe("tool_confirmed");
    expect(res.confidence).toBe(0.85);
    expect(res.tokensUsed).toBe(900 + 1700);
    // The corroborating web evidence — not the probe answer — is the durable
    // resolution the tool step produced.
    expect(res.resolution).toBe(
      "Web evidence: run deploy.sh to trigger the release pipeline.",
    );
    expect(teacher.verify).toHaveBeenCalledTimes(1);
    expect(researcher.research).toHaveBeenCalledTimes(1);
  });

  it("skips the teacher for below-medium confidence and goes straight to research", async () => {
    const { RetrievalCascade, CascadeLevel } = await loadModule();
    const teacher = makeTeacher({ confirmed: true, confidence: 1 });
    const researcher = makeResearcher({ resolved: true, confidence: 0.9, tokensUsed: 1500 });
    const cascade = new RetrievalCascade(teacher, researcher, baseConfig);

    const res = await cascade.run({ ...input, confidence: 0.3 });

    expect(res.level).toBe(CascadeLevel.TOOL_RESEARCH);
    expect(teacher.verify).not.toHaveBeenCalled();
    expect(researcher.research).toHaveBeenCalledTimes(1);
    expect(res.tokensUsed).toBe(1500);
  });

  it("falls back to FULL_RAG when neither teacher nor research resolve the query", async () => {
    const { RetrievalCascade, CascadeLevel } = await loadModule();
    const teacher = makeTeacher({ confirmed: false, confidence: 0.1, tokensUsed: 800 });
    const researcher = makeResearcher({ resolved: false, confidence: 0.2, tokensUsed: 1600 });
    const cascade = new RetrievalCascade(teacher, researcher, baseConfig);

    const res = await cascade.run({ ...input, confidence: 0.6 });

    expect(res.level).toBe(CascadeLevel.FULL_RAG);
    expect(res.outcome).toBe("fell_back_to_rag");
    expect(res.tokensUsed).toBe(800 + 1600);
    // Nothing cheaper resolved the query — full RAG owns the answer, so the
    // cascade carries no durable resolution to persist.
    expect(res.resolution).toBe("");
  });

  it("falls back to FULL_RAG (budget_exhausted) when the teacher step can't be afforded", async () => {
    const { RetrievalCascade, CascadeLevel } = await loadModule();
    const teacher = makeTeacher({ confirmed: true, confidence: 1 });
    const researcher = makeResearcher({ resolved: true, confidence: 1 });
    const cascade = new RetrievalCascade(teacher, researcher, { ...baseConfig, budgetTokens: 500 });

    const res = await cascade.run({ ...input, confidence: 0.6 });

    expect(res.level).toBe(CascadeLevel.FULL_RAG);
    expect(res.outcome).toBe("budget_exhausted");
    expect(res.tokensUsed).toBe(0);
    expect(res.resolution).toBe("");
    expect(teacher.verify).not.toHaveBeenCalled();
  });

  it("stops before TOOL_RESEARCH when the teacher spend leaves no room in the budget", async () => {
    const { RetrievalCascade, CascadeLevel } = await loadModule();
    const teacher = makeTeacher({ confirmed: false, confidence: 0.1, tokensUsed: 900 });
    const researcher = makeResearcher({ resolved: true, confidence: 1 });
    // Budget fits the teacher (1000) but not teacher-spend + tool cost (2000).
    const cascade = new RetrievalCascade(teacher, researcher, { ...baseConfig, budgetTokens: 1500 });

    const res = await cascade.run({ ...input, confidence: 0.6 });

    expect(res.level).toBe(CascadeLevel.FULL_RAG);
    expect(res.outcome).toBe("budget_exhausted");
    expect(res.resolution).toBe("");
    expect(teacher.verify).toHaveBeenCalledTimes(1);
    expect(researcher.research).not.toHaveBeenCalled();
  });

  it("treats a confirmed-but-not-confident teacher verdict as a rejection", async () => {
    const { RetrievalCascade, CascadeLevel } = await loadModule();
    const teacher = makeTeacher({ confirmed: true, confidence: 0.5, tokensUsed: 900 });
    const researcher = makeResearcher({ resolved: true, confidence: 0.9, tokensUsed: 1500 });
    const cascade = new RetrievalCascade(teacher, researcher, baseConfig);

    const res = await cascade.run({ ...input, confidence: 0.6 });

    expect(res.level).toBe(CascadeLevel.TOOL_RESEARCH);
    expect(researcher.research).toHaveBeenCalledTimes(1);
  });
});

describe("parseTeacherVerdict", () => {
  it("parses a clean JSON confirm verdict", async () => {
    const { parseTeacherVerdict } = await loadModule();
    expect(parseTeacherVerdict('{"verdict":"confirm","confidence":0.9}')).toEqual({
      confirmed: true,
      confidence: 0.9,
    });
  });

  it("parses a reject verdict with surrounding prose", async () => {
    const { parseTeacherVerdict } = await loadModule();
    const out = parseTeacherVerdict('Here is my answer: {"verdict":"reject","confidence":0.2} done');
    expect(out.confirmed).toBe(false);
    expect(out.confidence).toBeCloseTo(0.2);
  });

  it("clamps out-of-range confidences", async () => {
    const { parseTeacherVerdict } = await loadModule();
    expect(parseTeacherVerdict('{"verdict":"confirm","confidence":5}').confidence).toBe(1);
  });

  it("falls back to a keyword heuristic for non-JSON output", async () => {
    const { parseTeacherVerdict } = await loadModule();
    expect(parseTeacherVerdict("I confirm this is correct").confirmed).toBe(true);
    expect(parseTeacherVerdict("this looks wrong").confirmed).toBe(false);
  });

  it("returns a safe default for empty input", async () => {
    const { parseTeacherVerdict } = await loadModule();
    expect(parseTeacherVerdict("")).toEqual({ confirmed: false, confidence: 0 });
  });
});

describe("scoreEvidenceSupport", () => {
  it("returns 0 when there is no evidence", async () => {
    const { scoreEvidenceSupport } = await loadModule();
    expect(scoreEvidenceSupport("anything", "", 0)).toBe(0);
  });

  it("scores by keyword overlap with the candidate answer", async () => {
    const { scoreEvidenceSupport } = await loadModule();
    const score = scoreEvidenceSupport(
      "deploy script runs migrations",
      "the deploy script runs database migrations nightly",
      3,
    );
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  it("uses a result-count signal when there is no candidate answer", async () => {
    const { scoreEvidenceSupport } = await loadModule();
    expect(scoreEvidenceSupport("", "some evidence text", 3)).toBeCloseTo(0.7);
    expect(scoreEvidenceSupport("", "some evidence text", 0)).toBe(0);
  });
});

describe("createDefaultTeacherVerifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.CASCADE_TEACHER_MODEL = "";
  });

  it("confirms via a JSON-mode chat call and reports usage tokens", async () => {
    const { createDefaultTeacherVerifier } = await loadModule();
    mockChat.mockResolvedValue({
      content: '{"verdict":"confirm","confidence":0.95}',
      usage: { totalTokens: 1234 },
    });

    const verifier = createDefaultTeacherVerifier();
    const verdict = await verifier.verify({ ...input, confidence: 0.6 });

    expect(verdict.confirmed).toBe(true);
    expect(verdict.confidence).toBe(0.95);
    expect(verdict.tokensUsed).toBe(1234);
    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({ jsonMode: true, temperature: 0 }),
    );
  });

  it("passes CASCADE_TEACHER_MODEL to the chat call when set", async () => {
    mockEnv.CASCADE_TEACHER_MODEL = "glm-5.1:cloud";
    const { createDefaultTeacherVerifier } = await loadModule();
    mockChat.mockResolvedValue({ content: '{"verdict":"reject","confidence":0.1}' });

    await createDefaultTeacherVerifier().verify({ ...input, confidence: 0.6 });

    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "glm-5.1:cloud" }),
    );
  });

  it("estimates tokens when the provider omits usage", async () => {
    const { createDefaultTeacherVerifier } = await loadModule();
    mockChat.mockResolvedValue({ content: '{"verdict":"confirm","confidence":0.9}' });

    const verdict = await createDefaultTeacherVerifier().verify({ ...input, confidence: 0.6 });
    expect(verdict.tokensUsed).toBeGreaterThan(0);
  });

  it("returns a safe rejection when the chat call throws", async () => {
    const { createDefaultTeacherVerifier } = await loadModule();
    mockChat.mockRejectedValue(new Error("provider down"));

    const verdict = await createDefaultTeacherVerifier().verify({ ...input, confidence: 0.6 });
    expect(verdict).toEqual({ confirmed: false, confidence: 0, tokensUsed: 0 });
  });
});

describe("createDefaultToolResearcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns unresolved when web search is not configured", async () => {
    const { createDefaultToolResearcher } = await loadModule();
    mockWebIsConfigured.mockReturnValue(false);

    const result = await createDefaultToolResearcher().research({ ...input, confidence: 0.3 });
    expect(result).toEqual({ resolved: false, confidence: 0, evidence: "", tokensUsed: 0 });
    expect(mockWebSearch).not.toHaveBeenCalled();
  });

  it("corroborates the answer from search snippets", async () => {
    const { createDefaultToolResearcher } = await loadModule();
    mockWebIsConfigured.mockReturnValue(true);
    mockWebSearch.mockResolvedValue({
      query: "q",
      answer: "Run deploy.sh to deploy",
      results: [{ title: "t", url: "u", snippet: "the deploy.sh script handles deploy" }],
      totalResults: 1,
      provider: "tavily",
    });

    const result = await createDefaultToolResearcher().research({
      query: "how to deploy",
      claimKitAnswer: "Run deploy.sh deploy",
      confidence: 0.3,
    });

    expect(result.resolved).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.evidence).toContain("deploy.sh");
  });

  it("returns a safe unresolved result when search throws", async () => {
    const { createDefaultToolResearcher } = await loadModule();
    mockWebIsConfigured.mockReturnValue(true);
    mockWebSearch.mockRejectedValue(new Error("network"));

    const result = await createDefaultToolResearcher().research({ ...input, confidence: 0.3 });
    expect(result).toEqual({ resolved: false, confidence: 0, evidence: "", tokensUsed: 0 });
  });
});

describe("createDefaultCascade", () => {
  it("builds a cascade configured from env with optional overrides", async () => {
    const { createDefaultCascade, RetrievalCascade } = await loadModule();
    const cascade = createDefaultCascade({ budgetTokens: 9999 });
    expect(cascade).toBeInstanceOf(RetrievalCascade);
  });
});
