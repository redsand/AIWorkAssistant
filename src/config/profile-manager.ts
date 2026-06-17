/**
 * Profile isolation — multiple agent instances with separate SOUL.md,
 * MEMORY.md, skills, and sessions.
 *
 * Each profile is a self-contained directory under `${HERMES_HOME}/profiles/`:
 *
 *   data/profiles/
 *     active                 ← file containing the active profile name
 *     default/
 *       memories/            ← MEMORY.md, USER.md, SOUL.md
 *       skills/
 *       sessions/
 *       config.yaml
 *
 * Profiles share nothing by default: separate memory, separate skills,
 * separate sessions. `resolvePath()` in config/env.ts reads the active
 * profile so every subsystem resolves into the right directory.
 */

import fs from "fs";
import path from "path";
import { env } from "./env";
import { auditLogger } from "../audit/logger";

export interface Profile {
  name: string;
  createdAt: string;
  lastUsedAt: string;
  path: string; // data/profiles/<name>/
  hasCustomSoul: boolean;
  hasCustomMemory: boolean;
  skillCount: number;
}

const DEFAULT_PROFILE_NAME = "default";
const ACTIVE_FILE = "active";
const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function validateProfileName(name: string): void {
  if (!name || !PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid profile name '${name}': must start with an alphanumeric character and contain only letters, numbers, underscores, and hyphens`,
    );
  }
}

export class ProfileManager {
  private profilesRoot: string;

  constructor(profilesRoot?: string) {
    this.profilesRoot = profilesRoot ?? this.resolveProfilesRoot();
    if (!fs.existsSync(this.profilesRoot)) {
      fs.mkdirSync(this.profilesRoot, { recursive: true });
    }
  }

  private resolveProfilesRoot(): string {
    // Mirror resolvePath() in config/env.ts exactly: runtime override first,
    // then the zod-validated env default, then the literal "data". Diverging
    // here would let ProfileManager scaffold profiles under a different root
    // than the one resolvePath() reads from, silently splitting state.
    const home = process.env.HERMES_HOME || env.HERMES_HOME || "data";
    return path.join(home, "profiles");
  }

  private audit(action: string, name: string): void {
    void auditLogger.log({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      action,
      actor: "system",
      details: { profile: name, profilesRoot: this.profilesRoot },
      severity: "info",
    });
  }

  /** Absolute path to a profile's directory. */
  profilePath(name: string): string {
    validateProfileName(name);
    return path.join(this.profilesRoot, name);
  }

  private scaffold(dir: string): void {
    for (const sub of ["memories", "skills", "sessions"]) {
      const target = path.join(dir, sub);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true });
      }
    }
    const configPath = path.join(dir, "config.yaml");
    if (!fs.existsSync(configPath)) {
      const now = new Date().toISOString();
      fs.writeFileSync(
        configPath,
        `name: ${path.basename(dir)}\ncreatedAt: ${now}\nlastUsedAt: ${now}\n`,
        "utf-8",
      );
    }
  }

  /**
   * One-time migration of pre-profile-isolation data into the default profile.
   *
   * Before profiles existed, state lived directly under HERMES_HOME:
   * `data/memories/` (MEMORY.md, USER.md, SOUL.md) and `data/skills/`. With
   * isolation those paths became `data/profiles/default/...`, which would
   * orphan an existing install's data on upgrade. When the default profile is
   * first scaffolded, copy any legacy directories in so nothing is lost.
   *
   * Copies (never moves) and never overwrites a file that already exists in the
   * destination, so it is safe to re-run and leaves the originals untouched.
   */
  private migrateLegacyData(defaultDir: string): void {
    const legacyRoot = path.dirname(this.profilesRoot); // HERMES_HOME
    for (const sub of ["memories", "skills"]) {
      const src = path.join(legacyRoot, sub);
      const dest = path.join(defaultDir, sub);
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue;
      try {
        fs.cpSync(src, dest, {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
        this.audit("profile.migrate", `default:${sub}`);
        console.log(
          `[ProfileManager] Migrated legacy ${src} → ${dest} (originals left in place)`,
        );
      } catch (err) {
        console.warn(
          `[ProfileManager] Failed to migrate legacy ${src}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private readMeta(dir: string): { createdAt: string; lastUsedAt: string } {
    const configPath = path.join(dir, "config.yaml");
    const fallback = new Date().toISOString();
    const meta = { createdAt: fallback, lastUsedAt: fallback };
    if (!fs.existsSync(configPath)) return meta;
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      for (const line of content.split("\n")) {
        // Split on the FIRST colon only so ISO timestamps (which contain
        // colons, e.g. 2026-06-17T10:22:53Z) survive the value side intact.
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key === "createdAt" || key === "lastUsedAt") {
          (meta as Record<string, string>)[key] = value;
        }
      }
    } catch {
      // Leave fallback values.
    }
    return meta;
  }

  private touch(dir: string): string {
    const configPath = path.join(dir, "config.yaml");
    const now = new Date().toISOString();
    const meta = this.readMeta(dir);
    fs.writeFileSync(
      configPath,
      `name: ${path.basename(dir)}\ncreatedAt: ${meta.createdAt}\nlastUsedAt: ${now}\n`,
      "utf-8",
    );
    return now;
  }

  private hasContent(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    try {
      return fs.readFileSync(filePath, "utf-8").trim().length > 0;
    } catch {
      return false;
    }
  }

  private countSkills(skillsDir: string): number {
    if (!fs.existsSync(skillsDir)) return 0;
    let count = 0;
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name === "SKILL.md") {
          count++;
        }
      }
    };
    walk(skillsDir);
    return count;
  }

  private toProfile(name: string): Profile {
    const dir = path.join(this.profilesRoot, name);
    const meta = this.readMeta(dir);
    return {
      name,
      path: dir,
      createdAt: meta.createdAt,
      lastUsedAt: meta.lastUsedAt,
      hasCustomSoul: this.hasContent(path.join(dir, "memories", "SOUL.md")),
      hasCustomMemory: this.hasContent(path.join(dir, "memories", "MEMORY.md")),
      skillCount: this.countSkills(path.join(dir, "skills")),
    };
  }

  /** Create a new profile directory structure. */
  create(name: string, options?: { clone?: string }): Profile {
    validateProfileName(name);
    const dir = this.profilePath(name);
    if (fs.existsSync(dir)) {
      throw new Error(`Profile '${name}' already exists`);
    }

    if (options?.clone) {
      return this.clone(options.clone, name);
    }

    fs.mkdirSync(dir, { recursive: true });
    this.scaffold(dir);
    this.audit("profile.create", name);
    return this.toProfile(name);
  }

  /** List all profiles with metadata. */
  list(): Profile[] {
    if (!fs.existsSync(this.profilesRoot)) return [];
    return fs
      .readdirSync(this.profilesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && PROFILE_NAME_PATTERN.test(e.name))
      .map((e) => this.toProfile(e.name));
  }

  private activeFilePath(): string {
    return path.join(this.profilesRoot, ACTIVE_FILE);
  }

  private readActiveName(): string {
    const file = this.activeFilePath();
    if (!fs.existsSync(file)) return DEFAULT_PROFILE_NAME;
    try {
      const name = fs.readFileSync(file, "utf-8").trim();
      return name || DEFAULT_PROFILE_NAME;
    } catch {
      return DEFAULT_PROFILE_NAME;
    }
  }

  private writeActiveName(name: string): void {
    const tmp = this.activeFilePath() + ".tmp";
    fs.writeFileSync(tmp, name + "\n", "utf-8");
    fs.renameSync(tmp, this.activeFilePath());
  }

  /** Set the active profile, updating data/profiles/active. */
  switch(name: string): void {
    validateProfileName(name);
    const dir = this.profilePath(name);
    if (!fs.existsSync(dir)) {
      throw new Error(`Profile '${name}' not found`);
    }
    this.writeActiveName(name);
    // lastUsedAt is bumped here (on an explicit switch) rather than on every
    // getActive() read, so a hot read path does not rewrite config.yaml.
    this.touch(dir);
    this.audit("profile.switch", name);
  }

  /**
   * Return the currently active profile. Auto-creates the default profile
   * if the active profile's directory does not exist.
   */
  getActive(): Profile {
    const name = this.readActiveName();
    // The name comes off disk (the `active` marker) and is untrusted: a
    // tampered marker like "../escape" would otherwise reach path.join and
    // fs.mkdirSync below. Validate before any filesystem operation.
    validateProfileName(name);
    const dir = path.join(this.profilesRoot, name);

    if (!fs.existsSync(dir)) {
      // Auto-create the requested profile (default on a fresh install).
      fs.mkdirSync(dir, { recursive: true });
      this.scaffold(dir);
      // Pull a pre-isolation install's data into the default profile so an
      // upgrade does not strand existing memories/skills.
      if (name === DEFAULT_PROFILE_NAME) {
        this.migrateLegacyData(dir);
      }
      this.writeActiveName(name);
    } else if (!fs.existsSync(this.activeFilePath())) {
      this.writeActiveName(name);
    }

    return this.toProfile(name);
  }

  /** Remove a profile. The active profile cannot be deleted. */
  delete(name: string): void {
    validateProfileName(name);
    const dir = this.profilePath(name);
    if (!fs.existsSync(dir)) {
      throw new Error(`Profile '${name}' not found`);
    }
    if (this.readActiveName() === name) {
      throw new Error(
        `Cannot delete the active profile '${name}'. Switch to another profile first.`,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
    this.audit("profile.delete", name);
  }

  /** Copy config.yaml and .env from a source profile into a new profile. */
  clone(fromName: string, toName: string): Profile {
    validateProfileName(fromName);
    validateProfileName(toName);

    const fromDir = this.profilePath(fromName);
    if (!fs.existsSync(fromDir)) {
      throw new Error(`Source profile '${fromName}' not found`);
    }
    const toDir = this.profilePath(toName);
    if (fs.existsSync(toDir)) {
      throw new Error(`Profile '${toName}' already exists`);
    }

    fs.mkdirSync(toDir, { recursive: true });
    this.scaffold(toDir);

    for (const file of ["config.yaml", ".env"]) {
      const src = path.join(fromDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(toDir, file));
        if (file === ".env") {
          // The source .env can hold API keys/tokens. Cloning duplicates them
          // verbatim into the new profile — make that copy visible rather than
          // silent so the operator knows secrets were propagated.
          console.warn(
            `[ProfileManager] Copied .env (may contain secrets) from '${fromName}' to '${toName}'. Review and rotate credentials if the profiles should not share them.`,
          );
        }
      }
    }

    this.audit("profile.clone", `${fromName}->${toName}`);
    return this.toProfile(toName);
  }
}

let _profileManager: ProfileManager | null = null;

export function getConfigProfileManager(): ProfileManager {
  if (!_profileManager) {
    _profileManager = new ProfileManager();
  }
  return _profileManager;
}

export function resetConfigProfileManager(): void {
  _profileManager = null;
}
