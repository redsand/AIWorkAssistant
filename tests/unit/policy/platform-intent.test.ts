import { describe, it, expect } from "vitest";
import { detectPlatformIntent } from "../../../src/policy/platform-intent";
import type { ChatMessage } from "../../../src/agent/providers/types";

describe("detectPlatformIntent", () => {
  const makeMessage = (role: ChatMessage["role"], content: string): ChatMessage => ({
    role,
    content,
  });

  describe("explicit platform mentions", () => {
    it("detects GitHub from explicit mention", () => {
      const messages = [makeMessage("user", "Show me my PRs on GitHub")];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("github");
      expect(result.source).toBe("explicit");
    });

    it("detects Jira from explicit mention", () => {
      const messages = [makeMessage("user", "Create a ticket in Jira for this bug")];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("jira");
      expect(result.source).toBe("explicit");
    });

    it("detects GitLab from explicit mention", () => {
      const messages = [makeMessage("user", "Check GitLab MR !142")];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("gitlab");
      expect(result.source).toBe("explicit");
    });

    it("detects Calendar from explicit mention", () => {
      const messages = [makeMessage("user", "Show my calendar events")];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("calendar");
      expect(result.source).toBe("explicit");
    });

    it("uses most recent explicit mention when multiple exist", () => {
      const messages = [
        makeMessage("user", "Check GitHub for the PR"),
        makeMessage("assistant", "Found it."),
        makeMessage("user", "Now update the Jira ticket"),
      ];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("jira");
      expect(result.source).toBe("explicit");
    });
  });

  describe("inferred platform from terminology", () => {
    it("infers GitHub from 'pull request'", () => {
      const messages = [makeMessage("user", "Review my pull request")];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("github");
      expect(result.source).toBe("inferred");
    });

    it("infers GitHub from 'PR'", () => {
      const messages = [makeMessage("user", "What's the status of PR #42?")];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("github");
      expect(result.source).toBe("inferred");
    });

    it("infers GitLab from 'merge request'", () => {
      const messages = [makeMessage("user", "What's the status of merge request !50")];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("gitlab");
      expect(result.source).toBe("inferred");
    });

    it("infers GitLab from 'MR'", () => {
      const messages = [makeMessage("user", "Approve the MR")];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("gitlab");
      expect(result.source).toBe("inferred");
    });

    it("infers Jira from Jira key pattern PROJECT-123", () => {
      const messages = [makeMessage("user", "Look at SIEM-1234")];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("jira");
      expect(result.source).toBe("inferred");
    });

    it("infers Jira from 'jira ticket'", () => {
      const messages = [makeMessage("user", "Create a jira ticket for this")];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("jira");
      // "jira" matches the explicit pattern, so source is 'explicit'
      expect(result.source).toBe("explicit");
    });
  });

  describe("sticky context from prior tool calls", () => {
    it("infers platform from recent tool calls", () => {
      const messages: ChatMessage[] = [
        makeMessage("user", "List my issues"),
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "tc1", type: "function", function: { name: "github.list_issues", arguments: "{}" } },
          ],
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "tc2", type: "function", function: { name: "github.get_issue", arguments: "{}" } },
          ],
        },
        makeMessage("user", "Now add a comment"),
      ];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("github");
      expect(result.source).toBe("sticky");
    });

    it("picks the dominant platform from mixed tool calls", () => {
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "tc1", type: "function", function: { name: "jira.get_issue", arguments: "{}" } },
            { id: "tc2", type: "function", function: { name: "jira.list_assigned", arguments: "{}" } },
            { id: "tc3", type: "function", function: { name: "github.list_repos", arguments: "{}" } },
          ],
        },
      ];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("jira");
      expect(result.source).toBe("sticky");
    });
  });

  describe("no intent detected", () => {
    it("returns none for unrelated messages", () => {
      const messages = [makeMessage("user", "What's the weather like?")];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBeNull();
      expect(result.source).toBe("none");
    });

    it("returns none for empty messages", () => {
      const result = detectPlatformIntent([]);
      expect(result.platform).toBeNull();
      expect(result.source).toBe("none");
    });
  });

  describe("priority ordering", () => {
    it("explicit overrides inferred", () => {
      const messages: ChatMessage[] = [
        makeMessage("user", "Review the PR"),
        makeMessage("assistant", "Here's the PR."),
        makeMessage("user", "Actually, check this in Jira"),
      ];
      const result = detectPlatformIntent(messages);
      expect(result.platform).toBe("jira");
      expect(result.source).toBe("explicit");
    });
  });
});