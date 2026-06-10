import { describe, it, expect } from "vitest";
import { classifyQuery } from "../../../src/comparison-runs/auto-capture";

describe("classifyQuery", () => {
  describe("code_retrieval", () => {
    it("matches 'code' keyword", () => {
      expect(classifyQuery("where is the code for auth?")).toBe("code_retrieval");
    });
    it("matches 'file' keyword", () => {
      expect(classifyQuery("which file handles login?")).toBe("code_retrieval");
    });
    it("matches 'function' keyword", () => {
      expect(classifyQuery("what does this function return?")).toBe("code_retrieval");
    });
    it("matches 'class' keyword", () => {
      expect(classifyQuery("find the class definition")).toBe("code_retrieval");
    });
  });

  describe("entity_linking", () => {
    it("matches 'who' keyword", () => {
      expect(classifyQuery("who owns this module?")).toBe("entity_linking");
    });
    it("matches 'person' keyword", () => {
      expect(classifyQuery("which person is responsible?")).toBe("entity_linking");
    });
    it("matches 'owner' keyword", () => {
      expect(classifyQuery("what is the owner of this service?")).toBe("entity_linking");
    });
    it("matches 'author' keyword", () => {
      expect(classifyQuery("who is the author of this change?")).toBe("entity_linking");
    });
  });

  describe("staleness", () => {
    it("matches 'when' keyword", () => {
      expect(classifyQuery("when was this last deployed?")).toBe("staleness");
    });
    it("matches 'date' keyword", () => {
      expect(classifyQuery("what is the release date?")).toBe("staleness");
    });
    it("matches 'last' keyword", () => {
      expect(classifyQuery("what was the last change?")).toBe("staleness");
    });
    it("matches 'recent' keyword", () => {
      expect(classifyQuery("show me recent activity")).toBe("staleness");
    });
    it("matches 'latest' keyword", () => {
      expect(classifyQuery("what is the latest version?")).toBe("staleness");
    });
  });

  describe("citation_laundering", () => {
    it("matches 'cite' keyword", () => {
      expect(classifyQuery("can you cite the source for this?")).toBe("citation_laundering");
    });
    it("matches 'source' keyword", () => {
      expect(classifyQuery("what is the source of this claim?")).toBe("citation_laundering");
    });
    it("matches 'reference' keyword", () => {
      expect(classifyQuery("provide a reference for this")).toBe("citation_laundering");
    });
    it("matches 'citation' keyword", () => {
      expect(classifyQuery("I need a citation")).toBe("citation_laundering");
    });
  });

  describe("direct_fact (default)", () => {
    it("returns direct_fact for generic queries", () => {
      expect(classifyQuery("is this correct?")).toBe("direct_fact");
    });
    it("returns direct_fact for queries with no matching keywords", () => {
      expect(classifyQuery("explain the architecture")).toBe("direct_fact");
    });
    it("returns direct_fact for empty-ish queries", () => {
      expect(classifyQuery("yes")).toBe("direct_fact");
    });
  });

  describe("case insensitivity", () => {
    it("matches uppercase keywords", () => {
      expect(classifyQuery("WHO wrote this?")).toBe("entity_linking");
    });
    it("matches mixed-case keywords", () => {
      expect(classifyQuery("What FILE is this in?")).toBe("code_retrieval");
    });
  });

  describe("planning_synthesis", () => {
    it("matches 'build' keyword", () => {
      expect(classifyQuery("how do we build a process?")).toBe("planning_synthesis");
    });
    it("matches 'workflow' keyword", () => {
      expect(classifyQuery("what is the workflow for onboarding?")).toBe("planning_synthesis");
    });
    it("matches 'assessment' keyword", () => {
      expect(classifyQuery("what is the risk assessment?")).toBe("planning_synthesis");
    });
    it("matches 'feasibility' keyword", () => {
      expect(classifyQuery("what is the feasibility of this roadmap?")).toBe("planning_synthesis");
    });
    it("matches 'strategy' keyword", () => {
      expect(classifyQuery("what is the strategy for Q3?")).toBe("planning_synthesis");
    });
    it("matches 'calculate' keyword", () => {
      expect(classifyQuery("how do we calculate MTTR?")).toBe("planning_synthesis");
    });
    it("matches 'design' keyword", () => {
      expect(classifyQuery("how do we design this system?")).toBe("planning_synthesis");
    });
    it("matches 'framework' keyword", () => {
      expect(classifyQuery("what framework should we use?")).toBe("planning_synthesis");
    });
    it("matches 'roadmap' keyword", () => {
      expect(classifyQuery("what is the roadmap for this?")).toBe("planning_synthesis");
    });
    it("is checked before code_retrieval", () => {
      expect(classifyQuery("how do we build a code review process?")).toBe("planning_synthesis");
    });
  });

  describe("priority order (planning_synthesis checked first)", () => {
    it("prefers planning_synthesis when query contains both 'build' and 'code'", () => {
      expect(classifyQuery("how do we build this code?")).toBe("planning_synthesis");
    });
    it("prefers planning_synthesis when query contains both 'process' and 'who'", () => {
      expect(classifyQuery("who owns this process?")).toBe("planning_synthesis");
    });
    it("prefers code_retrieval over entity_linking when 'code' and 'who' both present", () => {
      expect(classifyQuery("who wrote this code?")).toBe("code_retrieval");
    });
    it("prefers entity_linking over staleness when 'who' and 'when' both present", () => {
      expect(classifyQuery("who changed it when?")).toBe("entity_linking");
    });
  });
});
