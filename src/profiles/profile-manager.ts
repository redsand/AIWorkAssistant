/**
 * Profile Manager — Multi-personality agent instances
 *
 * Each profile has its own SOUL.md, MEMORY.md, and skill set stored under
 * data/profiles/{profileId}/. Profile switching hot-swaps the system prompt,
 * memory namespace, and tool set without a server restart.
 *
 * Profile selection is per-session, not global, so concurrent users can
 * operate under different profiles without interfering with each other.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { env } from "../config/env";
import { auditLogger } from "../audit/logger";
import type { AgentProfile, ProfileConfig } from "./types";

const DEFAULT_PROFILE_NAME = "Default";
const DEFAULT_PROFILE_DESC = "Default profile using the existing system prompt and all tools";

const DEFAULT_SOUL_CONTENT = `# Default Profile
You are a helpful AI assistant.
`;

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateProfileId(id: string): void {
  if (!PROFILE_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid profile ID '${id}': must contain only letters, numbers, underscores, and hyphens`,
    );
  }
}

export class ProfileManager {
  private profilesPath: string;
  private profiles: Map<string, AgentProfile> = new Map();
  /** Per-session active profile. Key = sessionId, value = profileId */
  private sessionProfiles: Map<string, string> = new Map();
  private defaultProfileId: string;

  constructor(profilesPath?: string) {
    this.profilesPath = profilesPath ?? this.resolveProfilesPath();
    this.defaultProfileId = env.DEFAULT_PROFILE;

    if (!fs.existsSync(this.profilesPath)) {
      fs.mkdirSync(this.profilesPath, { recursive: true });
    }

    this.loadAllProfiles();

    if (!this.profiles.has(this.defaultProfileId)) {
      this.createDefaultProfile();
    }
  }

  private resolveProfilesPath(): string {
    if (process.env.VITEST) {
      return path.join(
        os.tmpdir(),
        "ai-assist-tim-vitest-profiles",
        `${process.env.VITEST_WORKER_ID || "worker"}-${process.pid}`,
      );
    }

    return env.PROFILES_PATH;
  }

  private loadAllProfiles(): void {
    if (!fs.existsSync(this.profilesPath)) return;

    const entries = fs.readdirSync(this.profilesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!PROFILE_ID_PATTERN.test(entry.name)) continue;

      const configPath = path.join(this.profilesPath, entry.name, "config.json");
      if (!fs.existsSync(configPath)) continue;

      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const profile: AgentProfile = JSON.parse(raw);

        if (profile.id !== entry.name) {
          console.warn(
            `[ProfileManager] Skipping profile with mismatched ID: config has '${profile.id}' but directory is '${entry.name}'`,
          );
          continue;
        }

        this.profiles.set(profile.id, profile);
      } catch {
        console.warn(`[ProfileManager] Skipping invalid profile config: ${configPath}`);
      }
    }
  }

  private createDefaultProfile(): void {
    const profileDir = path.join(this.profilesPath, this.defaultProfileId);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    const soulPath = path.join(profileDir, "SOUL.md");
    if (!fs.existsSync(soulPath)) {
      fs.writeFileSync(soulPath, DEFAULT_SOUL_CONTENT, "utf-8");
    }

    const now = new Date().toISOString();
    const profile: AgentProfile = {
      id: this.defaultProfileId,
      name: DEFAULT_PROFILE_NAME,
      description: DEFAULT_PROFILE_DESC,
      systemPromptPath: soulPath,
      memoryPath: path.join(profileDir, "MEMORY.md"),
      skillsPath: path.join(profileDir, "skills"),
      allowedTools: [],
      blockedTools: [],
      maxToolCalls: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.saveProfile(profile);
    this.profiles.set(profile.id, profile);
  }

  private saveProfile(profile: AgentProfile): void {
    const profileDir = path.join(this.profilesPath, profile.id);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    const configPath = path.join(profileDir, "config.json");
    const tmpPath = configPath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(profile, null, 2), "utf-8");
    fs.renameSync(tmpPath, configPath);
  }

  createProfile(config: ProfileConfig): AgentProfile {
    validateProfileId(config.id);

    if (this.profiles.has(config.id)) {
      throw new Error(`Profile '${config.id}' already exists`);
    }

    const profileDir = path.join(this.profilesPath, config.id);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    const now = new Date().toISOString();
    const profile: AgentProfile = {
      id: config.id,
      name: config.name,
      description: config.description,
      systemPromptPath: path.join(profileDir, "SOUL.md"),
      memoryPath: path.join(profileDir, "MEMORY.md"),
      skillsPath: path.join(profileDir, "skills"),
      allowedTools: config.allowedTools ?? [],
      blockedTools: config.blockedTools ?? [],
      maxToolCalls: config.maxToolCalls ?? 0,
      createdAt: now,
      updatedAt: now,
    };

    if (!fs.existsSync(profile.systemPromptPath)) {
      fs.writeFileSync(
        profile.systemPromptPath,
        `# ${config.name}\n\n${config.description}\n`,
        "utf-8",
      );
    }

    this.saveProfile(profile);
    this.profiles.set(profile.id, profile);

    void auditLogger.log({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      action: "profile.create",
      actor: "system",
      details: { profileId: config.id, profileName: config.name },
      severity: "info",
    });

    return profile;
  }

  deleteProfile(id: string): boolean {
    validateProfileId(id);

    if (id === this.defaultProfileId) {
      throw new Error("Cannot delete the default profile");
    }

    const profile = this.profiles.get(id);
    if (!profile) return false;

    const profileDir = path.join(this.profilesPath, id);
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }

    this.profiles.delete(id);

    // Clear any sessions using this profile
    for (const [sessionId, pId] of this.sessionProfiles) {
      if (pId === id) {
        this.sessionProfiles.set(sessionId, this.defaultProfileId);
      }
    }

    void auditLogger.log({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      action: "profile.delete",
      actor: "system",
      details: { profileId: id },
      severity: "info",
    });

    return true;
  }

  loadProfile(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  /**
   * Switch profile for a specific session. Does not affect other sessions.
   */
  switchProfile(id: string, sessionId: string = "default"): AgentProfile {
    validateProfileId(id);

    const profile = this.profiles.get(id);
    if (!profile) {
      throw new Error(`Profile '${id}' not found`);
    }

    const previousId = this.sessionProfiles.get(sessionId) ?? this.defaultProfileId;
    this.sessionProfiles.set(sessionId, id);

    void auditLogger.log({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      action: "profile.switch",
      actor: sessionId,
      details: { from: previousId, to: id, profileName: profile.name },
      severity: "info",
    });

    return profile;
  }

  /**
   * Get the active profile for a specific session.
   * Falls back to the default profile if the session has no explicit profile.
   */
  getActiveProfile(sessionId: string = "default"): AgentProfile {
    const profileId = this.sessionProfiles.get(sessionId) ?? this.defaultProfileId;
    const profile = this.profiles.get(profileId);
    if (!profile) {
      // Fall back to whatever default exists
      const fallback = this.profiles.get(this.defaultProfileId);
      if (fallback) return fallback;
      throw new Error(`No profiles available`);
    }
    return profile;
  }

  /**
   * Get the active profile ID for a specific session.
   */
  getActiveProfileId(sessionId: string = "default"): string {
    return this.sessionProfiles.get(sessionId) ?? this.defaultProfileId;
  }

  /**
   * Legacy global active profile ID — returns default profile ID.
   * Prefer getActiveProfileId(sessionId) for session-scoped lookups.
   */
  getGlobalActiveProfileId(): string {
    return this.defaultProfileId;
  }

  listProfiles(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  getSystemPrompt(sessionId: string = "default"): string {
    const profile = this.getActiveProfile(sessionId);
    if (!fs.existsSync(profile.systemPromptPath)) {
      return DEFAULT_SOUL_CONTENT;
    }

    const content = fs.readFileSync(profile.systemPromptPath, "utf-8").trim();
    return content || DEFAULT_SOUL_CONTENT;
  }

  getAllowedTools(allRegisteredTools: string[], sessionId: string = "default"): string[] {
    const profile = this.getActiveProfile(sessionId);
    let tools = allRegisteredTools;

    if (profile.allowedTools.length > 0) {
      tools = tools.filter((t) => profile.allowedTools.includes(t));
    }

    if (profile.blockedTools.length > 0) {
      tools = tools.filter((t) => !profile.blockedTools.includes(t));
    }

    return tools;
  }

  getMaxToolCalls(sessionId: string = "default"): number {
    return this.getActiveProfile(sessionId).maxToolCalls;
  }

  getDefaultProfileId(): string {
    return this.defaultProfileId;
  }
}

let _profileManager: ProfileManager | null = null;

export function getProfileManager(): ProfileManager {
  if (!_profileManager) {
    _profileManager = new ProfileManager();
  }
  return _profileManager;
}

export function resetProfileManager(): void {
  _profileManager = null;
}
