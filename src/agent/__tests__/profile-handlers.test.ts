import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSwitchProfile = vi.fn();
const mockListProfiles = vi.fn();
const mockGetActiveProfileId = vi.fn();

vi.mock("../../profiles/profile-manager", () => ({
  getProfileManager: () => ({
    switchProfile: mockSwitchProfile,
    listProfiles: mockListProfiles,
    getActiveProfileId: mockGetActiveProfileId,
  }),
}));

vi.mock("../../audit/logger", () => ({
  auditLogger: { log: vi.fn() },
}));

import { dispatchToolCall } from "../tool-dispatcher";

describe("profile.switch tool handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("switches profile and returns profile info", async () => {
    mockSwitchProfile.mockReturnValue({
      id: "work",
      name: "Work",
      description: "Work profile",
    });

    const result = await dispatchToolCall("profile.switch", {
      profile_id: "work",
      _sessionId: "sess-1",
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: "work",
      name: "Work",
      description: "Work profile",
    });
    expect(result.message).toContain("Switched to profile");
    expect(mockSwitchProfile).toHaveBeenCalledWith("work", "sess-1");
  });

  it("returns error when profile_id is missing", async () => {
    const result = await dispatchToolCall("profile.switch", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
    expect(mockSwitchProfile).not.toHaveBeenCalled();
  });

  it("returns error when profile_id is empty string", async () => {
    const result = await dispatchToolCall("profile.switch", {
      profile_id: "  ",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });

  it("rejects invalid profile IDs with path traversal characters", async () => {
    const result = await dispatchToolCall("profile.switch", {
      profile_id: "../etc/passwd",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid profile_id");
    expect(mockSwitchProfile).not.toHaveBeenCalled();
  });

  it("rejects profile IDs with special characters", async () => {
    const result = await dispatchToolCall("profile.switch", {
      profile_id: "test;rm -rf",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid profile_id");
  });

  it("returns error when profile does not exist", async () => {
    mockSwitchProfile.mockImplementation(() => {
      throw new Error("Profile 'nonexistent' not found");
    });

    const result = await dispatchToolCall("profile.switch", {
      profile_id: "nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("profile.list tool handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists all profiles with active flag", async () => {
    mockListProfiles.mockReturnValue([
      { id: "default", name: "Default", description: "Default profile" },
      { id: "work", name: "Work", description: "Work profile" },
    ]);
    mockGetActiveProfileId.mockReturnValue("work");

    const result = await dispatchToolCall("profile.list", {
      _sessionId: "sess-1",
    });

    expect(result.success).toBe(true);
    const data = result.data as { activeProfileId: string; profiles: Array<{ id: string; isActive: boolean }> };
    expect(data.activeProfileId).toBe("work");
    expect(data.profiles).toHaveLength(2);
    expect(data.profiles[1].isActive).toBe(true);
    expect(data.profiles[0].isActive).toBe(false);
    expect(mockGetActiveProfileId).toHaveBeenCalledWith("sess-1");
  });

  it("returns default profile when only default exists", async () => {
    mockListProfiles.mockReturnValue([
      { id: "default", name: "Default", description: "Default profile" },
    ]);
    mockGetActiveProfileId.mockReturnValue("default");

    const result = await dispatchToolCall("profile.list", {});

    expect(result.success).toBe(true);
    const data = result.data as { profiles: Array<{ id: string; isActive: boolean }> };
    expect(data.profiles).toHaveLength(1);
    expect(data.profiles[0].isActive).toBe(true);
  });
});
