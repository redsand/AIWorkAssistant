import { describe, expect, it } from "vitest";
import {
  AUTOREPAIR_BODY_MARKER,
  AUTOREPAIR_ORIGINAL_END_MARKER,
  AUTOREPAIR_ORIGINAL_MARKER,
  extractOriginalBody,
  isAutorepairedBody,
} from "../ticket-autorepair/ticket-rewriter";

describe("ticket-rewriter helpers", () => {
  describe("isAutorepairedBody", () => {
    it("detects a body that contains the autorepair marker", () => {
      const body = [
        AUTOREPAIR_BODY_MARKER,
        "## Problem statement",
        "Some clarified text.",
      ].join("\n");
      expect(isAutorepairedBody(body)).toBe(true);
    });

    it("returns false for plain bodies", () => {
      expect(isAutorepairedBody("Just a normal ticket description.")).toBe(false);
      expect(isAutorepairedBody("")).toBe(false);
    });
  });

  describe("extractOriginalBody", () => {
    it("recovers the original body from an autorepaired body", () => {
      const original = "User cannot log in when password contains a unicode character.\nReproduces 100%.";
      const repaired = [
        AUTOREPAIR_BODY_MARKER,
        "## Problem statement",
        "Login fails for unicode passwords.",
        "",
        AUTOREPAIR_ORIGINAL_MARKER,
        "<details><summary>Original ticket body</summary>",
        "",
        "```",
        original,
        "```",
        "",
        "</details>",
        AUTOREPAIR_ORIGINAL_END_MARKER,
      ].join("\n");
      expect(extractOriginalBody(repaired)).toBe(original);
    });

    it("returns undefined when no marker is present", () => {
      expect(extractOriginalBody("plain body without markers")).toBeUndefined();
    });

    it("returns undefined when the end marker comes before the start", () => {
      const malformed = `${AUTOREPAIR_ORIGINAL_END_MARKER}\nsome content\n${AUTOREPAIR_ORIGINAL_MARKER}`;
      expect(extractOriginalBody(malformed)).toBeUndefined();
    });

    it("falls back to raw slice if the inner code block isn't found", () => {
      // Markers present but no ```...``` block inside — extract what's between them.
      const body = [
        AUTOREPAIR_ORIGINAL_MARKER,
        "raw text with no code fences",
        AUTOREPAIR_ORIGINAL_END_MARKER,
      ].join("\n");
      const got = extractOriginalBody(body);
      expect(got).toContain("raw text with no code fences");
    });
  });
});
