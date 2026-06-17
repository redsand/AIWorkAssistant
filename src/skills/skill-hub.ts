import fs from "fs";
import path from "path";
import crypto from "crypto";
import { env } from "../config/env";
import { resolveSkillsBasePath } from "./skill-manager";
import type {
  SkillManifest,
  HubSearchResult,
  InstallResult,
  PublishResult,
  HubIndex,
  HubIndexEntry,
} from "./skill-types";

// Registry GitHub repo backing the hub. The raw index/skills are read over
// HTTP via SKILLS_HUB_URL; publishing writes through the GitHub contents API.
const HUB_REPO_OWNER = "redsand";
const HUB_REPO_NAME = "aiworkassistant-skills";
const HUB_REPO_BRANCH = "main";
const DEFAULT_HUB_URL =
  "https://raw.githubusercontent.com/redsand/aiworkassistant-skills/main";

const VALID_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function sanitizeSegment(segment: string, label: string): string {
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    !VALID_SEGMENT_RE.test(segment)
  ) {
    throw new Error(
      `Invalid ${label}: must start with alphanumeric and contain only alphanumeric, dash, underscore, or dot characters`,
    );
  }
  return segment;
}

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Minimal subset of GithubClient used to publish skills to the registry. */
export interface HubPublisher {
  getFile(
    filePath: string,
    ref?: string,
    owner?: string,
    repo?: string,
  ): Promise<{ content: string; encoding: string; sha: string }>;
  createFile(
    filePath: string,
    content: string,
    commitMessage: string,
    branch: string,
    owner?: string,
    repo?: string,
  ): Promise<{ content?: { html_url?: string } }>;
  updateFile(
    filePath: string,
    content: string,
    commitMessage: string,
    branch: string,
    sha: string,
    owner?: string,
    repo?: string,
  ): Promise<{ content?: { html_url?: string } }>;
}

export interface SkillHubOptions {
  /** Active skills directory (data/skills). Resolved lazily if omitted. */
  skillsBasePath?: string;
  /** Raw base URL of the registry repo. Defaults to SKILLS_HUB_URL. */
  hubUrl?: string;
  /** HTTP fetch implementation (injectable for tests). */
  fetchImpl?: typeof fetch;
  /** GitHub publisher (injectable for tests). */
  publisher?: HubPublisher;
  /** Allow pushing to the shared registry. Defaults to SKILLS_HUB_PUBLISH_ENABLED. */
  publishEnabled?: boolean;
  /** Per-request timeout (ms) for hub fetches. Defaults to SKILLS_HUB_TIMEOUT_MS. */
  timeoutMs?: number;
}

export class SkillHub {
  private _skillsBasePath?: string;
  private hubUrl: string;
  private fetchImpl: typeof fetch;
  private publisher?: HubPublisher;
  private publishEnabled: boolean;
  private timeoutMs: number;

  constructor(opts: SkillHubOptions = {}) {
    this._skillsBasePath = opts.skillsBasePath;
    this.hubUrl = (opts.hubUrl ?? env.SKILLS_HUB_URL ?? DEFAULT_HUB_URL).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.publisher = opts.publisher;
    this.publishEnabled = opts.publishEnabled ?? env.SKILLS_HUB_PUBLISH_ENABLED;
    this.timeoutMs = opts.timeoutMs ?? env.SKILLS_HUB_TIMEOUT_MS;
  }

  /** Fetch with an AbortController timeout so a slow hub cannot hang the agent. */
  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: controller.signal });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        throw new Error(
          `Hub request to '${url}' timed out after ${this.timeoutMs}ms`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private get skillsBasePath(): string {
    if (!this._skillsBasePath) {
      this._skillsBasePath = resolveSkillsBasePath();
    }
    return this._skillsBasePath;
  }

  private get hubDir(): string {
    return path.join(this.skillsBasePath, ".hub");
  }

  private get quarantineDir(): string {
    return path.join(this.hubDir, "quarantine");
  }

  private get indexPath(): string {
    return path.join(this.hubDir, "index.json");
  }

  /** Resolve a relative path under skillsBasePath, rejecting any escape. */
  private resolveUnderBase(relativePath: string): string {
    const base = path.resolve(this.skillsBasePath);
    const resolved = path.resolve(base, relativePath);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error("local_path escapes the skills directory");
    }
    return resolved;
  }

  /** Ensure a download URL shares the configured hub's origin and path prefix. */
  private assertHubOrigin(url: string): void {
    let target: URL;
    let base: URL;
    try {
      target = new URL(url);
      base = new URL(this.hubUrl);
    } catch {
      throw new Error(`Invalid download URL '${url}'`);
    }
    const basePath = base.pathname.replace(/\/+$/, "");
    const underBase =
      target.pathname === basePath ||
      target.pathname.startsWith(basePath + "/");
    if (target.origin !== base.origin || !underBase) {
      throw new Error(
        `Refusing to download from '${url}': must be under hub URL '${this.hubUrl}'`,
      );
    }
  }

  // ── Registry (remote) ─────────────────────────────────────────────

  /** Fetch the registry index and filter manifests locally. */
  async search(query: string): Promise<HubSearchResult[]> {
    const manifests = await this.fetchRegistryIndex();
    const lower = (query ?? "").toLowerCase();
    const matched = lower
      ? manifests.filter(
          (m) =>
            m.name.toLowerCase().includes(lower) ||
            m.description.toLowerCase().includes(lower) ||
            m.category.toLowerCase().includes(lower) ||
            (m.tags ?? []).some((t) => t.toLowerCase().includes(lower)),
        )
      : manifests;

    return matched.map((m) => ({
      name: m.name,
      description: m.description,
      category: m.category,
      author: m.author,
      version: m.version,
      installs: typeof (m as any).installs === "number" ? (m as any).installs : 0,
      rating: typeof (m as any).rating === "number" ? (m as any).rating : 0,
    }));
  }

  private async fetchRegistryIndex(): Promise<SkillManifest[]> {
    const res = await this.fetchWithTimeout(`${this.hubUrl}/index.json`);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch hub index (HTTP ${res.status}) from ${this.hubUrl}/index.json`,
      );
    }
    const data = (await res.json()) as unknown;
    return parseManifestList(data);
  }

  // ── Install / quarantine ──────────────────────────────────────────

  /**
   * Download a skill into the quarantine directory and verify its checksum.
   * The skill is NOT activated — call promote() after reviewing it.
   */
  async install(name: string): Promise<InstallResult> {
    try {
      sanitizeSegment(name, "name");
    } catch (e) {
      return { success: false, name, error: (e as Error).message };
    }

    let manifest: SkillManifest | undefined;
    try {
      const manifests = await this.fetchRegistryIndex();
      manifest = manifests.find((m) => m.name === name);
    } catch (e) {
      return { success: false, name, error: (e as Error).message };
    }

    if (!manifest) {
      return { success: false, name, error: `Skill '${name}' not found in hub registry` };
    }

    return this.installFromManifest(manifest);
  }

  /** Download a known manifest into quarantine and verify its checksum. */
  async installFromManifest(manifest: SkillManifest): Promise<InstallResult> {
    const name = manifest.name;
    try {
      sanitizeSegment(name, "name");
      sanitizeSegment(manifest.category, "category");
    } catch (e) {
      return { success: false, name, error: (e as Error).message };
    }

    // Integrity is mandatory: a manifest without a checksum defeats the
    // quarantine guarantee, so refuse it outright.
    if (!manifest.checksum) {
      return {
        success: false,
        name,
        checksumVerified: false,
        error: `Refusing to install '${name}': manifest is missing a checksum`,
      };
    }

    const url =
      manifest.downloadUrl ||
      `${this.hubUrl}/skills/${manifest.category}/${name}/SKILL.md`;

    // Only download from the configured hub origin. A compromised registry
    // could otherwise point downloadUrl at an arbitrary host (SSRF).
    try {
      this.assertHubOrigin(url);
    } catch (e) {
      return { success: false, name, error: (e as Error).message };
    }

    let body: string;
    try {
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) {
        return {
          success: false,
          name,
          error: `Failed to download skill '${name}' (HTTP ${res.status})`,
        };
      }
      body = await res.text();
    } catch (e) {
      return { success: false, name, error: (e as Error).message };
    }

    const actual = sha256(body);
    if (actual !== manifest.checksum) {
      return {
        success: false,
        name,
        checksumVerified: false,
        error: `Checksum mismatch for '${name}': expected ${manifest.checksum}, got ${actual}`,
      };
    }

    const destDir = path.join(this.quarantineDir, name);
    fs.mkdirSync(destDir, { recursive: true });
    const skillFile = path.join(destDir, "SKILL.md");
    const tmp = `${skillFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, body, "utf-8");
    fs.renameSync(tmp, skillFile);

    this.upsertIndexEntry({
      ...manifest,
      status: "quarantined",
      installedAt: new Date().toISOString(),
    });

    return {
      success: true,
      name,
      quarantinePath: path.join(".hub", "quarantine", name, "SKILL.md"),
      manifest,
      checksumVerified: true,
      preview: body,
    };
  }

  /**
   * Move a quarantined skill into the active skills directory under its
   * category, after the user has reviewed it.
   */
  async promote(name: string): Promise<void> {
    sanitizeSegment(name, "name");

    const entry = this.readIndex().skills.find((s) => s.name === name);
    const srcDir = path.join(this.quarantineDir, name);
    const srcFile = path.join(srcDir, "SKILL.md");
    if (!fs.existsSync(srcFile)) {
      throw new Error(`No quarantined skill named '${name}' to promote`);
    }

    const body = fs.readFileSync(srcFile, "utf-8");
    const category = entry?.category || parseCategory(body) || "community";
    sanitizeSegment(category, "category");

    const destDir = path.join(this.skillsBasePath, category, name);
    if (fs.existsSync(path.join(destDir, "SKILL.md"))) {
      throw new Error(`Skill already exists at ${category}/${name}`);
    }
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(destDir, "SKILL.md");
    const tmp = `${destFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, body, "utf-8");
    fs.renameSync(tmp, destFile);

    fs.rmSync(srcDir, { recursive: true, force: true });

    if (entry) {
      entry.status = "promoted";
      entry.category = category;
      entry.promotedPath = `${category}/${name}/SKILL.md`;
      this.writeIndex(this.readIndex().skills.map((s) => (s.name === name ? entry : s)));
    }
  }

  // ── Publish ───────────────────────────────────────────────────────

  /** Package a local skill and push it to the registry repo. */
  async publish(localPath: string): Promise<PublishResult> {
    // Publishing mutates a shared, public registry. Require an explicit opt-in
    // so an agent cannot push to the community repo by default.
    if (!this.publishEnabled) {
      return {
        success: false,
        name: localPath,
        error:
          "Publishing to the skill hub is disabled. Set SKILLS_HUB_PUBLISH_ENABLED=true to enable it.",
      };
    }

    const publisher = this.publisher;
    if (!publisher) {
      return { success: false, name: localPath, error: "No hub publisher configured" };
    }

    // Constrain the path to the skills directory. path.resolve collapses any
    // "..", absolute, or symlink-ish input, and the containment check then
    // rejects anything that escapes — preventing arbitrary file reads.
    let resolved: string;
    try {
      resolved = this.resolveUnderBase(localPath);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        resolved = this.resolveUnderBase(path.join(localPath, "SKILL.md"));
      }
    } catch (e) {
      return { success: false, name: localPath, error: (e as Error).message };
    }
    if (!fs.existsSync(resolved)) {
      return { success: false, name: localPath, error: `Skill not found at ${localPath}` };
    }

    const body = fs.readFileSync(resolved, "utf-8");
    const fm = parseFrontmatterFields(body);
    const name = fm.name;
    const category = fm.category;
    if (!name || !category) {
      return {
        success: false,
        name: name || localPath,
        error: "Skill SKILL.md is missing a name or category in its frontmatter",
      };
    }

    try {
      sanitizeSegment(name, "name");
      sanitizeSegment(category, "category");
    } catch (e) {
      return { success: false, name, error: (e as Error).message };
    }

    const checksum = sha256(body);
    const skillRepoPath = `skills/${category}/${name}/SKILL.md`;
    const manifest: SkillManifest = {
      name,
      version: fm.version || "1.0.0",
      author: fm.author || env.GITHUB_DEFAULT_OWNER || "unknown",
      description: fm.description || "",
      category,
      tags: fm.tags ?? [],
      checksum,
      downloadUrl: `${this.hubUrl}/${skillRepoPath}`,
      license: fm.license || "MIT",
    };

    try {
      // Push the skill file (create or update).
      await this.putRepoFile(
        publisher,
        skillRepoPath,
        body,
        `Publish skill ${category}/${name}`,
      );

      // Upsert the manifest into the registry index.json.
      const index = await this.fetchRegistryIndexForPublish(publisher);
      const next = index.filter((m) => m.name !== name);
      next.push(manifest);
      const url = await this.putRepoFile(
        publisher,
        "index.json",
        JSON.stringify({ skills: next }, null, 2) + "\n",
        `Update index for ${name}`,
      );

      return { success: true, name, manifest, url };
    } catch (e) {
      return { success: false, name, error: (e as Error).message };
    }
  }

  private async fetchRegistryIndexForPublish(
    publisher: HubPublisher,
  ): Promise<SkillManifest[]> {
    let file: { content: string; encoding: string; sha: string };
    try {
      file = await publisher.getFile(
        "index.json",
        HUB_REPO_BRANCH,
        HUB_REPO_OWNER,
        HUB_REPO_NAME,
      );
    } catch (e) {
      // A missing index.json (first publish ever) is expected — start fresh.
      // Any other failure (transient API error, auth, rate limit) must NOT be
      // swallowed: returning [] here would overwrite the whole registry with
      // only the new skill, destroying every other entry.
      if (isNotFoundError(e)) return [];
      throw new Error(
        `Failed to read registry index before publish: ${(e as Error).message}. Aborting to avoid clobbering the registry.`,
      );
    }

    const decoded =
      file.encoding === "base64"
        ? Buffer.from(file.content, "base64").toString("utf-8")
        : file.content;
    const data = JSON.parse(decoded);
    return parseManifestList(data);
  }

  private async putRepoFile(
    publisher: HubPublisher,
    filePath: string,
    content: string,
    message: string,
  ): Promise<string | undefined> {
    let existingSha: string | undefined;
    try {
      const existing = await publisher.getFile(
        filePath,
        HUB_REPO_BRANCH,
        HUB_REPO_OWNER,
        HUB_REPO_NAME,
      );
      existingSha = existing.sha;
    } catch (e) {
      // 404 means the file does not exist yet → create it. Any other error must
      // propagate so we don't blindly create over a file we failed to read.
      if (!isNotFoundError(e)) throw e;
      existingSha = undefined;
    }

    const res = existingSha
      ? await publisher.updateFile(
          filePath,
          content,
          message,
          HUB_REPO_BRANCH,
          existingSha,
          HUB_REPO_OWNER,
          HUB_REPO_NAME,
        )
      : await publisher.createFile(
          filePath,
          content,
          message,
          HUB_REPO_BRANCH,
          HUB_REPO_OWNER,
          HUB_REPO_NAME,
        );
    return res?.content?.html_url;
  }

  // ── Local index ───────────────────────────────────────────────────

  /** List all hub-installed skills (quarantined and promoted). */
  async listInstalled(): Promise<SkillManifest[]> {
    return this.readIndex().skills.map((entry) => {
      const { status, installedAt, promotedPath, ...manifest } = entry;
      void status;
      void installedAt;
      void promotedPath;
      return manifest;
    });
  }

  /** Remove a hub-installed skill from quarantine and/or active skills. */
  async remove(name: string): Promise<void> {
    sanitizeSegment(name, "name");
    const entries = this.readIndex().skills;
    const entry = entries.find((s) => s.name === name);

    fs.rmSync(path.join(this.quarantineDir, name), {
      recursive: true,
      force: true,
    });

    if (entry?.status === "promoted") {
      const category = entry.category;
      try {
        sanitizeSegment(category, "category");
        fs.rmSync(path.join(this.skillsBasePath, category, name), {
          recursive: true,
          force: true,
        });
      } catch {
        // Leave malformed category dirs untouched.
      }
    }

    this.writeIndex(entries.filter((s) => s.name !== name));
  }

  readIndex(): HubIndex {
    try {
      const raw = fs.readFileSync(this.indexPath, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data?.skills)) return { skills: data.skills };
    } catch {
      // No index yet.
    }
    return { skills: [] };
  }

  private writeIndex(skills: HubIndexEntry[]): void {
    fs.mkdirSync(this.hubDir, { recursive: true });
    const tmp = `${this.indexPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ skills }, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, this.indexPath);
  }

  private upsertIndexEntry(entry: HubIndexEntry): void {
    const skills = this.readIndex().skills.filter((s) => s.name !== entry.name);
    skills.push(entry);
    this.writeIndex(skills);
  }
}

// ── Remote index validation ─────────────────────────────────────────

/** True if an error from the publisher represents a missing file (HTTP 404). */
function isNotFoundError(e: unknown): boolean {
  const err = e as {
    status?: number;
    response?: { status?: number };
    message?: string;
  };
  if (err?.status === 404 || err?.response?.status === 404) return true;
  return typeof err?.message === "string" && /\b404\b|not found/i.test(err.message);
}

/**
 * Validate the shape of a remote manifest. Remote registry JSON is untrusted:
 * name/category feed path construction and the other fields are surfaced to the
 * user, so every required field must be a string of the expected form.
 */
function isValidManifest(value: unknown): value is SkillManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  const requiredStrings = [
    "name",
    "version",
    "author",
    "description",
    "category",
    "checksum",
    "downloadUrl",
    "license",
  ];
  for (const key of requiredStrings) {
    if (typeof m[key] !== "string" || (m[key] as string).length === 0) {
      return false;
    }
  }
  // name and category are used to build filesystem and URL paths — they must be
  // safe segments, never traversal or absolute fragments.
  if (
    !VALID_SEGMENT_RE.test(m.name as string) ||
    !VALID_SEGMENT_RE.test(m.category as string)
  ) {
    return false;
  }
  if (m.tags !== undefined && !Array.isArray(m.tags)) return false;
  return true;
}

/** Coerce arbitrary remote JSON into a list of validated manifests. */
function parseManifestList(data: unknown): SkillManifest[] {
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { skills?: unknown })?.skills)
      ? (data as { skills: unknown[] }).skills
      : [];
  return list.filter(isValidManifest);
}

// ── Frontmatter helpers ─────────────────────────────────────────────

function parseCategory(body: string): string | undefined {
  return parseFrontmatterFields(body).category;
}

interface FrontmatterFields {
  name?: string;
  category?: string;
  version?: string;
  description?: string;
  author?: string;
  license?: string;
  tags?: string[];
}

function parseFrontmatterFields(content: string): FrontmatterFields {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields: FrontmatterFields = {};
  const lines = match[1].split("\n");
  let inTags = false;
  for (const line of lines) {
    const arrayItem = line.match(/^\s+-\s+(.+)$/);
    if (inTags && arrayItem) {
      (fields.tags ??= []).push(arrayItem[1].trim());
      continue;
    }
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim().replace(/^["']|["']$/g, "");
    inTags = false;
    if (key === "tags") {
      inTags = true;
      if (value) fields.tags = value.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      else fields.tags = [];
    } else if (
      key === "name" ||
      key === "category" ||
      key === "version" ||
      key === "description" ||
      key === "author" ||
      key === "license"
    ) {
      (fields as Record<string, unknown>)[key] = value;
    }
  }
  return fields;
}

export const skillHub = new SkillHub();
