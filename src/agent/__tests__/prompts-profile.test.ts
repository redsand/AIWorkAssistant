import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the ProfileManager to control profile behavior
const mockGetActiveProfile = vi.fn();
const mockGetSystemPrompt = vi.fn();
const mockGetDefaultProfileId = vi.fn();

vi.mock("../../profiles/profile-manager", () => ({
  getProfileManager: () => ({
    getActiveProfile: mockGetActiveProfile,
    getSystemPrompt: mockGetSystemPrompt,
    getDefaultProfileId: mockGetDefaultProfileId,
  }),
}));

// Must import after mocks are set up
import { getSystemPrompt } from "../prompts";

describe("getSystemPrompt — profile personality injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultProfileId.mockReturnValue("default");
  });

  it("does not inject profile section for default profile", () => {
    mockGetActiveProfile.mockReturnValue({ id: "default", name: "Default" });
    mockGetSystemPrompt.mockReturnValue("Default SOUL content");

    const prompt = getSystemPrompt("productivity", "test query", "engine");

    expect(prompt).not.toContain("PROFILE PERSONALITY");
  });

  it("injects profile personality section for non-default profile", () => {
    mockGetActiveProfile.mockReturnValue({
      id: "work",
      name: "Work Assistant",
    });
    mockGetSystemPrompt.mockReturnValue("You are a professional work assistant.");
    mockGetDefaultProfileId.mockReturnValue("default");

    const prompt = getSystemPrompt("productivity", "test query", "engine");

    expect(prompt).toContain("PROFILE PERSONALITY (Work Assistant)");
    expect(prompt).toContain("You are a professional work assistant.");
  });

  it("injects profile section for engineering mode", () => {
    mockGetActiveProfile.mockReturnValue({
      id: "security",
      name: "Security Analyst",
    });
    mockGetSystemPrompt.mockReturnValue("You are a security-focused analyst.");
    mockGetDefaultProfileId.mockReturnValue("default");

    const prompt = getSystemPrompt("engineering", "security query", "engine");

    expect(prompt).toContain("PROFILE PERSONALITY (Security Analyst)");
    expect(prompt).toContain("You are a security-focused analyst.");
  });

  it("gracefully handles ProfileManager not being initialized", () => {
    mockGetActiveProfile.mockImplementation(() => {
      throw new Error("Not initialized");
    });

    // Should not throw
    const prompt = getSystemPrompt("productivity", "test", "engine");
    expect(prompt).not.toContain("PROFILE PERSONALITY");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("injects profile in RAG mode via getSystemPromptRAG", () => {
    mockGetActiveProfile.mockReturnValue({
      id: "personal",
      name: "Personal Assistant",
    });
    mockGetSystemPrompt.mockReturnValue("You are a casual personal helper.");
    mockGetDefaultProfileId.mockReturnValue("default");

    // No contextMode → RAG mode
    const prompt = getSystemPrompt("productivity", "test query");

    expect(prompt).toContain("PROFILE PERSONALITY (Personal Assistant)");
    expect(prompt).toContain("You are a casual personal helper.");
  });

  it("uses sessionId to scope profile lookup", () => {
    mockGetActiveProfile.mockReturnValue({
      id: "work",
      name: "Work",
    });
    mockGetSystemPrompt.mockReturnValue("Work personality");
    mockGetDefaultProfileId.mockReturnValue("default");

    getSystemPrompt("productivity", "query", "engine", "sess-123");

    expect(mockGetActiveProfile).toHaveBeenCalledWith("sess-123");
    expect(mockGetSystemPrompt).toHaveBeenCalledWith("sess-123");
  });
});
