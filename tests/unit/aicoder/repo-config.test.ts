import { describe, expect, it } from "vitest";
import { normalizeGithubRepoConfig } from "../../../src/aicoder/repo-config";

describe("normalizeGithubRepoConfig", () => {
  it("removes duplicate owner from GitHub repo arguments", () => {
    expect(
      normalizeGithubRepoConfig({
        source: "github",
        owner: "redsand",
        repo: "redsand/AIWorkAssistant",
      }),
    ).toEqual({ owner: "redsand", repo: "AIWorkAssistant" });
  });

  it("extracts owner from GitHub owner/repo input when owner is omitted", () => {
    expect(
      normalizeGithubRepoConfig({
        source: "github",
        owner: "",
        repo: "redsand/AIWorkAssistant",
      }),
    ).toEqual({ owner: "redsand", repo: "AIWorkAssistant" });
  });

  it("does not rewrite unrelated nested project paths", () => {
    expect(
      normalizeGithubRepoConfig({
        source: "gitlab",
        owner: "platform",
        repo: "group/subgroup/project",
      }),
    ).toEqual({ owner: "platform", repo: "group/subgroup/project" });
  });
});
