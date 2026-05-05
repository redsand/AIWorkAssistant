import { describe, it, expect } from "vitest";
import { validatePlatformAlignment } from "../../../src/policy/platform-alignment";
import type { PlatformIntent } from "../../../src/policy/types";

describe("validatePlatformAlignment", () => {
  const explicitGithub: PlatformIntent = {
    platform: "github",
    source: "explicit",
    evidence: 'User mentioned "github"',
  };

  const explicitJira: PlatformIntent = {
    platform: "jira",
    source: "explicit",
    evidence: 'User mentioned "jira"',
  };

  const noIntent: PlatformIntent = {
    platform: null,
    source: "none",
    evidence: "No platform intent detected",
  };

  it("allows cross-platform tools regardless of intent", () => {
    const result = validatePlatformAlignment("todo.create_list", explicitGithub);
    expect(result.result).toBe("allowed");
    expect(result.toolPlatform).toBe("cross-platform");
  });

  it("allows when platforms match", () => {
    const result = validatePlatformAlignment("github.list_repos", explicitGithub);
    expect(result.result).toBe("allowed");
    expect(result.toolPlatform).toBe("github");
    expect(result.intentPlatform).toBe("github");
  });

  it("allows when no intent is detected", () => {
    const result = validatePlatformAlignment("gitlab.list_merge_requests", noIntent);
    expect(result.result).toBe("allowed");
  });

  it("allows cross-platform access (e.g., GitLab from Jira context)", () => {
    const result = validatePlatformAlignment("github.create_issue", explicitJira);
    expect(result.result).toBe("allowed");
    expect(result.toolPlatform).toBe("github");
    expect(result.intentPlatform).toBe("jira");
  });

  it("allows cross-platform access even without alternatives", () => {
    const result = validatePlatformAlignment("github.list_repos", explicitJira);
    expect(result.result).toBe("allowed");
    expect(result.toolPlatform).toBe("github");
    expect(result.intentPlatform).toBe("jira");
  });

  it("allows system/discover tools (cross-platform)", () => {
    const result = validatePlatformAlignment("discover_tools", explicitGithub);
    expect(result.result).toBe("allowed");
  });

  it("allows productivity tools (cross-platform)", () => {
    const result = validatePlatformAlignment("productivity.generate_daily_plan", explicitJira);
    expect(result.result).toBe("allowed");
  });

  it("maps unknown tool prefixes to cross-platform", () => {
    const result = validatePlatformAlignment("foobar.something", explicitGithub);
    expect(result.result).toBe("allowed");
    expect(result.toolPlatform).toBe("cross-platform");
  });
});