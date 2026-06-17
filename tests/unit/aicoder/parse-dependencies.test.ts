import { describe, it, expect } from "vitest";
import { parseDependencies } from "../../../src/autonomous-loop/dependency-parser";

describe("parseDependencies", () => {
  it("extracts a GitHub-style dependency from prose", () => {
    expect(parseDependencies("This depends on #42 before we can start")).toEqual(["42"]);
  });

  it("extracts a JIRA-style dependency from prose", () => {
    expect(parseDependencies("Blocked by FOO-12 right now")).toEqual(["FOO-12"]);
  });

  it("extracts a 'do not start until' dependency from prose", () => {
    expect(parseDependencies("Do not start until BAR-9 is merged")).toEqual(["BAR-9"]);
  });

  it("does NOT extract a dependency inside a fenced code block", () => {
    const body = [
      "Here is an example of the syntax:",
      "```",
      "depends on #99",
      "```",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([]);
  });

  it("does NOT extract a dependency inside an inline code span", () => {
    expect(parseDependencies("Use the marker `blocked by #7` in the body")).toEqual([]);
  });

  it("extracts the real prose dependency while ignoring the one in a code block", () => {
    const body = [
      "This actually depends on #10.",
      "",
      "Documentation example:",
      "```md",
      "depends on #999",
      "```",
    ].join("\n");
    expect(parseDependencies(body)).toEqual(["10"]);
  });

  it("ignores dependencies across multiple code blocks with different patterns", () => {
    const body = [
      "```",
      "depends on #100",
      "```",
      "Some prose.",
      "```ts",
      "// blocked by ABC-5",
      "```",
      "```",
      "do not start until DEF-6",
      "```",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([]);
  });

  it("distinguishes JIRA-style dependencies in code blocks from prose", () => {
    const body = [
      "Real dependency: blocked by LIVE-1",
      "```",
      "blocked by EXAMPLE-2",
      "```",
      "Inline example: `requires SAMPLE-3`",
    ].join("\n");
    expect(parseDependencies(body)).toEqual(["LIVE-1"]);
  });

  it("distinguishes 'do not start until' patterns in code blocks from prose", () => {
    const body = [
      "Do not start until REAL-1 ships.",
      "```",
      "do not start until DOC-2 ships",
      "```",
    ].join("\n");
    expect(parseDependencies(body)).toEqual(["REAL-1"]);
  });

  it("extracts multiple comma-separated JIRA dependencies from prose", () => {
    const refs = parseDependencies("Depends on FOO-1, FOO-2 before release");
    expect(refs.sort()).toEqual(["FOO-1", "FOO-2"]);
  });

  it("returns an empty array when there are no dependencies", () => {
    expect(parseDependencies("No dependencies here, just plain text.")).toEqual([]);
  });
});
