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

  describe("priority order (code_retrieval checked first)", () => {
    it("prefers code_retrieval when query contains both 'code' and 'who'", () => {
      expect(classifyQuery("who wrote this code?")).toBe("code_retrieval");
    });
    it("prefers entity_linking over staleness when 'who' and 'when' both present", () => {
      // 'who' comes before 'when' in check order — code_retrieval first, then entity_linking
      expect(classifyQuery("who changed it when?")).toBe("entity_linking");
    });
  });
});
