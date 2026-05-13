import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import {
  detectRemotePlatform,
  getGitLabProjectFromRemote,
  truncate,
  extractIssueKeyFromBranchName,
  authHeaders,
} from "../../../src/autonomous-loop/pr-creator";
import type { ServerConfig } from "../../../src/autonomous-loop/types";

let repoDir: string;

function initRepo(dir: string, remoteUrl?: string): void {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  if (remoteUrl) {
    execSync(`git remote add origin ${remoteUrl}`, { cwd: dir, stdio: "pipe" });
  }
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-creator-"));
});

afterEach(() => {
  if (repoDir && fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── detectRemotePlatform ──────────────────────────────────────────────────────

describe("detectRemotePlatform", () => {
  it("returns 'github' for a github.com remote", () => {
    initRepo(repoDir, "https://github.com/owner/repo.git");
    expect(detectRemotePlatform(repoDir)).toBe("github");
  });

  it("returns 'gitlab' for a gitlab remote", () => {
    initRepo(repoDir, "https://gitlab.example.com/group/project.git");
    expect(detectRemotePlatform(repoDir)).toBe("gitlab");
  });

  it("returns 'gitlab' for git@gitlab SSH remote", () => {
    initRepo(repoDir, "git@gitlab.com:group/project.git");
    expect(detectRemotePlatform(repoDir)).toBe("gitlab");
  });

  it("returns 'unknown' when no remote is set", () => {
    initRepo(repoDir);
    expect(detectRemotePlatform(repoDir)).toBe("unknown");
  });

  it("returns 'unknown' for an unrecognized remote host", () => {
    initRepo(repoDir, "https://bitbucket.org/owner/repo.git");
    expect(detectRemotePlatform(repoDir)).toBe("unknown");
  });
});

// ── getGitLabProjectFromRemote ────────────────────────────────────────────────

describe("getGitLabProjectFromRemote", () => {
  it("parses HTTPS URL: returns URL-encoded project path", () => {
    initRepo(repoDir, "https://gitlab.example.com/siem/hawk-soar.git");
    const result = getGitLabProjectFromRemote(repoDir);
    expect(result).toBe("siem%2Fhawk-soar");
  });

  it("parses HTTPS URL with subgroup", () => {
    initRepo(repoDir, "https://gitlab.example.com/group/subgroup/project.git");
    const result = getGitLabProjectFromRemote(repoDir);
    expect(result).toBe("group%2Fsubgroup%2Fproject");
  });

  it("parses SSH URL: git@gitlab.example.com:group/project.git", () => {
    initRepo(repoDir, "git@gitlab.example.com:group/project.git");
    const result = getGitLabProjectFromRemote(repoDir);
    expect(result).toBe("group%2Fproject");
  });

  it("returns null when no remote is configured", () => {
    initRepo(repoDir);
    expect(getGitLabProjectFromRemote(repoDir)).toBeNull();
  });

  it("handles URL without .git suffix", () => {
    initRepo(repoDir, "https://gitlab.example.com/group/project");
    const result = getGitLabProjectFromRemote(repoDir);
    expect(result).toBe("group%2Fproject");
  });
});

// ── truncate ──────────────────────────────────────────────────────────────────

describe("truncate", () => {
  it("returns the string unchanged if within maxLen", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and appends ellipsis when over maxLen", () => {
    const result = truncate("hello world", 6);
    expect(result).toHaveLength(6);
    expect(result.endsWith("…")).toBe(true);
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });
});

// ── extractIssueKeyFromBranchName ─────────────────────────────────────────────

describe("extractIssueKeyFromBranchName", () => {
  it("extracts a numeric issue number", () => {
    expect(extractIssueKeyFromBranchName("ai/issue-123-fix-bug")).toBe("123");
  });

  it("extracts a Jira-style key", () => {
    expect(extractIssueKeyFromBranchName("ai/issue-IR-82-fix-sql-injection")).toBe("IR-82");
  });

  it("returns null for branch names without an issue pattern", () => {
    expect(extractIssueKeyFromBranchName("feature/new-feature")).toBeNull();
    expect(extractIssueKeyFromBranchName("main")).toBeNull();
  });

  it("handles slash separator: issue/123-description", () => {
    expect(extractIssueKeyFromBranchName("ai/issue/456-some-fix")).toBe("456");
  });
});

// ── authHeaders ───────────────────────────────────────────────────────────────

describe("authHeaders", () => {
  it("returns Bearer authorization header from cfg.apiKey", () => {
    const cfg: ServerConfig = {
      owner: "owner",
      repo: "repo",
      source: "github",
      apiUrl: "https://example.com",
      apiKey: "test-token-123",
    };
    const headers = authHeaders(cfg);
    expect(headers).toEqual({ Authorization: "Bearer test-token-123" });
  });
});
