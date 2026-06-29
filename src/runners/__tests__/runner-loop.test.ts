import { describe, expect, it } from "vitest";

import { splitGithubRepoSlug } from "../runner-loop";

describe("splitGithubRepoSlug", () => {
  it("splits an owner/name slug for github runners", () => {
    expect(splitGithubRepoSlug("github", null, "redsand/AIWorkAssistant"))
      .toEqual({ owner: "redsand", repo: "AIWorkAssistant" });
  });

  it("preserves an explicit owner over the slug's owner", () => {
    expect(splitGithubRepoSlug("github", "tim-org", "redsand/AIWorkAssistant"))
      .toEqual({ owner: "tim-org", repo: "AIWorkAssistant" });
  });

  it("passes a bare repo name through untouched", () => {
    expect(splitGithubRepoSlug("github", "redsand", "AIWorkAssistant"))
      .toEqual({ owner: "redsand", repo: "AIWorkAssistant" });
  });

  it("leaves gitlab path-with-namespace alone (CLI accepts that form)", () => {
    expect(splitGithubRepoSlug("gitlab", null, "group/subgroup/project"))
      .toEqual({ owner: null, repo: "group/subgroup/project" });
  });

  it("handles null/undefined repo without throwing", () => {
    expect(splitGithubRepoSlug("github", "redsand", null))
      .toEqual({ owner: "redsand", repo: null });
    expect(splitGithubRepoSlug("github", "redsand", undefined))
      .toEqual({ owner: "redsand", repo: undefined });
  });

  it("falls back to original slug when name half is empty", () => {
    expect(splitGithubRepoSlug("github", null, "redsand/"))
      .toEqual({ owner: "redsand", repo: "redsand/" });
  });
});
