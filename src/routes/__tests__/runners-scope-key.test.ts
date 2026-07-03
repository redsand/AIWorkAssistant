import { describe, expect, it } from "vitest";

import { runnerScopeKey } from "../runners";

describe("runnerScopeKey — normalize (source, owner, repo) for uniqueness checks", () => {
  it("returns an empty key when repo is missing — no uniqueness scope to enforce", () => {
    expect(runnerScopeKey("github", "redsand", null)).toBe("");
    expect(runnerScopeKey("github", "redsand", "")).toBe("");
    expect(runnerScopeKey("github", "redsand", undefined)).toBe("");
  });

  it("treats GitHub slug 'owner/name' as already-qualified — owner field is irrelevant", () => {
    // Two configs filled in differently but pointing at the same project
    // must collapse to the same key so the duplicate check catches them.
    const a = runnerScopeKey("github", null, "redsand/AIWorkAssistant");
    const b = runnerScopeKey("github", "anyone-else", "redsand/AIWorkAssistant");
    expect(a).toBe(b);
    expect(a).toBe("github::redsand/aiworkassistant");
  });

  it("composes (owner, name) into the slug form when GitHub repo is bare", () => {
    expect(runnerScopeKey("github", "redsand", "AIWorkAssistant"))
      .toBe("github::redsand/aiworkassistant");
  });

  it("distinguishes two repos with the same name under different owners", () => {
    const a = runnerScopeKey("github", "redsand", "AIWorkAssistant");
    const b = runnerScopeKey("github", "someone-else", "AIWorkAssistant");
    expect(a).not.toBe(b);
  });

  it("treats GitLab path-with-namespace as identifying — owner field unused", () => {
    expect(runnerScopeKey("gitlab", null, "group/sub/project"))
      .toBe("gitlab::group/sub/project");
  });

  it("scopes Jira (and other ticketing sources) by the target repoUrl, not the project key — one Jira project can span many repos", () => {
    // No repoUrl supplied — nothing to enforce against.
    expect(runnerScopeKey("jira", "IR", "IR")).toBe("");
    expect(runnerScopeKey("jira", null, "IR")).toBe("");

    // Same Jira project, different target repos — must NOT collide.
    const a = runnerScopeKey("jira", "IR", "IR", "https://github.com/redsand/service-a.git");
    const b = runnerScopeKey("jira", "IR", "IR", "https://github.com/redsand/service-b.git");
    expect(a).not.toBe(b);

    // Same Jira project AND same repoUrl — still one aicoder per actual repo.
    const c = runnerScopeKey("jira", "IR", "IR", "https://github.com/redsand/service-a.git");
    expect(a).toBe(c);
  });

  it("is case-insensitive — same repo in mixed case still collides", () => {
    const a = runnerScopeKey("github", "RedSand", "AIWorkAssistant");
    const b = runnerScopeKey("github", "redsand", "aiworkassistant");
    expect(a).toBe(b);
  });

  it("trims whitespace around the repo field", () => {
    expect(runnerScopeKey("github", "redsand", "  AIWorkAssistant  "))
      .toBe("github::redsand/aiworkassistant");
  });

  it("different sources never collide even when repo matches", () => {
    const gh = runnerScopeKey("github", "redsand", "IR");
    const jira = runnerScopeKey("jira", "redsand", "IR");
    expect(gh).not.toBe(jira);
  });
});
