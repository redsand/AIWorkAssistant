/**
 * Profile Manager — Multi-personality agent instances
 *
 * Each profile has its own SOUL.md, MEMORY.md, and skill set stored under
 * data/profiles/{profileId}/. Profile switching hot-swaps the system prompt,
 * memory namespace, and tool set without a server restart.
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { AgentProfile, ProfileConfig } from "./types";

const DEFAULT_PROFILE_ID = "default";
const DEFAULT_PROFILE_NAME = "Default";
const DEFAULT_PROFILE_DESC = "Default profile using the existing system prompt and all tools";

const DEFAULT_SOUL_CONTENT = `# Default Profile
You are a helpful AI assistant.
`;

export class ProfileManager {
  private profilesPath: string;
  private profiles: Map<string, AgentProfile> = new Map();
  private activeProfileId: string;

  constructor(profilesPath?: string) {
    this.profilesPath = profilesPath ?? this.resolveProfilesPath();
    this.activeProfileId = DEFAULT_PROFILE_ID;

    if (!fs.existsSync(this.profilesPath)) {
      fs.mkdirSync(this.profilesPath, { recursive: true });
    }

    this.loadAllProfiles();

    if (!this.profiles.has(DEFAULT_PROFILE_ID)) {
      this.createDefaultProfile();
    }
  }

  private resolveProfilesPath(): string {
    if (process.env.PROFILES_PATH) {
      return process.env.PROFILES_PATH;
    }

    if (process.env.VITEST) {
      return path.join(
        os.tmpdir(),
        "ai-assist-tim-vitest-profiles",
        `${process.env.VITEST_WORKER_ID || "worker"}-${process.pid}`,
      );
    }

    return path.join(process.cwd(), "data", "profiles");
  }

  private loadAllProfiles(): void {
    if (!fs.existsSync(this.profilesPath)) return;

    const entries = fs.readdirSync(this.profilesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const configPath = path.join(this.profilesPath, entry.name, "config.json");
      if (!fs.existsSync(configPath)) continue;

      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const profile: AgentProfile = JSON.parse(raw);
        this.profiles.set(profile.id, profile);
      } catch {
        console.warn(`[ProfileManager] Skipping invalid profile config: ${configPath}`);
      }
    }
  }

  private createDefaultProfile(): void {
    const profileDir = path.join(this.profilesPath, DEFAULT_PROFILE_ID);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    const soulPath = path.join(profileDir, "SOUL.md");
    if (!fs.existsSync(soulPath)) {
      fs.writeFileSync(soulPath, DEFAULT_SOUL_CONTENT, "utf-8");
    }

    const now = new Date().toISOString();
    const profile: AgentProfile = {
      id: DEFAULT_PROFILE_ID,
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

    console.log(`[ProfileManager] Created profile '${config.id}' (${config.name})`);
    return profile;
  }

  deleteProfile(id: string): boolean {
    if (id === DEFAULT_PROFILE_ID) {
      throw new Error("Cannot delete the default profile");
    }

    const profile = this.profiles.get(id);
    if (!profile) return false;

    const profileDir = path.join(this.profilesPath, id);
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }

    this.profiles.delete(id);

    if (this.activeProfileId === id) {
      this.activeProfileId = DEFAULT_PROFILE_ID;
    }

    console.log(`[ProfileManager] Deleted profile '${id}'`);
    return true;
  }

  loadProfile(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  switchProfile(id: string): AgentProfile {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new Error(`Profile '${id}' not found`);
    }

    this.activeProfileId = id;
    console.log(`[ProfileManager] Switched to profile '${id}' (${profile.name})`);
    return profile;
  }

  listProfiles(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  getActiveProfile(): AgentProfile {
    const profile = this.profiles.get(this.activeProfileId);
    if (!profile) {
      throw new Error(`Active profile '${this.activeProfileId}' not found`);
    }
    return profile;
  }

  getActiveProfileId(): string {
    return this.activeProfileId;
  }

  getSystemPrompt(): string {
    const profile = this.getActiveProfile();
    if (!fs.existsSync(profile.systemPromptPath)) {
      return DEFAULT_SOUL_CONTENT;
    }

    const content = fs.readFileSync(profile.systemPromptPath, "utf-8").trim();
    return content || DEFAULT_SOUL_CONTENT;
  }

  getAllowedTools(allRegisteredTools: string[]): string[] {
    const profile = this.getActiveProfile();
    let tools = allRegisteredTools;

    if (profile.allowedTools.length > 0) {
      tools = tools.filter((t) => profile.allowedTools.includes(t));
    }

    if (profile.blockedTools.length > 0) {
      tools = tools.filter((t) => !profile.blockedTools.includes(t));
    }

    return tools;
  }

  getMaxToolCalls(): number {
    return this.getActiveProfile().maxToolCalls;
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
