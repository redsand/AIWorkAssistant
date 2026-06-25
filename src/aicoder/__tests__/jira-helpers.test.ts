import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adfToText,
  extractJiraSprint,
  isDoneStatus,
  jiraDescriptionToText,
} from "../jira-helpers";

describe("isDoneStatus", () => {
  it.each([
    ["Done", true],
    ["DONE", true],
    ["Closed", true],
    ["Resolved", true],
    ["Completed", true],
    ["In Progress", false],
    ["To Do", false],
    ["", false],
    [undefined, false],
  ])("treats %s as done=%s", (input, expected) => {
    expect(isDoneStatus(input as string | undefined)).toBe(expected);
  });
});

describe("adfToText", () => {
  it("returns empty for falsy inputs", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
    expect(adfToText("")).toBe("");
  });

  it("passes plain strings through unchanged", () => {
    expect(adfToText("hello world")).toBe("hello world");
  });

  it("returns empty when content is missing or malformed", () => {
    expect(adfToText({})).toBe("");
    expect(adfToText({ content: "not-an-array" })).toBe("");
  });

  it("flattens paragraph content into newline-joined text", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First line" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
      ],
    };
    expect(adfToText(doc)).toBe("First line\nSecond line");
  });

  it("prefixes headings with markdown # markers matching their level", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Section" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "Body" }] },
      ],
    };
    expect(adfToText(doc)).toBe("## Section\nBody");
  });

  it("tolerates partially-shaped nodes", () => {
    expect(adfToText({ content: [{}, { content: [] }] })).toBe("\n");
  });
});

describe("jiraDescriptionToText", () => {
  it("returns empty for falsy", () => {
    expect(jiraDescriptionToText(null)).toBe("");
    expect(jiraDescriptionToText(undefined)).toBe("");
  });

  it("returns string inputs as-is", () => {
    expect(jiraDescriptionToText("hello")).toBe("hello");
  });

  it("recursively unwraps nested content and text fields", () => {
    const adf = {
      content: [
        { text: "outer" },
        { content: [{ text: "inner1" }, { text: "inner2" }] },
      ],
    };
    expect(jiraDescriptionToText(adf)).toBe("outer\ninner1\ninner2");
  });
});

describe("extractJiraSprint", () => {
  const origEnv = process.env.JIRA_SPRINT_FIELD;
  beforeEach(() => {
    delete process.env.JIRA_SPRINT_FIELD;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.JIRA_SPRINT_FIELD;
    else process.env.JIRA_SPRINT_FIELD = origEnv;
  });

  it("returns null for non-object inputs", () => {
    expect(extractJiraSprint(null)).toBeNull();
    expect(extractJiraSprint(undefined)).toBeNull();
    expect(extractJiraSprint("not an object")).toBeNull();
  });

  it("returns null when no customfield contains sprints", () => {
    expect(
      extractJiraSprint({ summary: "x", customfield_99999: "irrelevant" }),
    ).toBeNull();
  });

  it("returns the active sprint's name when present", () => {
    const fields = {
      customfield_10020: [
        { id: 1, name: "Sprint 11", state: "closed" },
        { id: 2, name: "Sprint 12", state: "active" },
      ],
    };
    expect(extractJiraSprint(fields)).toBe("Sprint 12");
  });

  it("falls back to the last named sprint when none are active", () => {
    const fields = {
      customfield_10020: [
        { id: 1, name: "Sprint 11", state: "closed" },
        { id: 2, name: "Sprint 12", state: "closed" },
      ],
    };
    expect(extractJiraSprint(fields)).toBe("Sprint 12");
  });

  it("parses legacy serialized-string sprint values", () => {
    const fields = {
      customfield_10010: [
        "com.atlassian.greenhopper.service.sprint.Sprint@abc[id=4,name=Legacy Sprint,state=ACTIVE]",
      ],
    };
    expect(extractJiraSprint(fields)).toBe("Legacy Sprint");
  });

  it("scans every customfield_* until it finds the sprint shape", () => {
    const fields = {
      customfield_10001: ["unrelated"],
      customfield_10005: [{ value: "Some option" }],
      customfield_10020: [{ id: 1, name: "Sprint 5", state: "active" }],
    };
    expect(extractJiraSprint(fields)).toBe("Sprint 5");
  });

  it("honors JIRA_SPRINT_FIELD override and skips the scan", () => {
    process.env.JIRA_SPRINT_FIELD = "customfield_99999";
    const fields = {
      customfield_99999: [{ id: 1, name: "Override Sprint", state: "active" }],
      // This one would match the shape too, but the override pins us to 99999.
      customfield_10020: [{ id: 2, name: "Default Sprint", state: "active" }],
    };
    expect(extractJiraSprint(fields)).toBe("Override Sprint");
  });
});
