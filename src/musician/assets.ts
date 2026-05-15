/**
 * Musician Assistant - Audio Asset Management
 *
 * Safe storage for audio files with path traversal protection,
 * size limits, and JSONL metadata storage.
 */

import { v4 as uuidv4 } from "uuid";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { env } from "../config/env";
import {
  ALLOWED_AUDIO_MIME_TYPES,
  AudioAsset,
  GeneratedAudioAsset,
  ListAssetsOptions,
  ListAssetsResult,
  AllowedAudioMIMEType,
} from "./types";

// =============================================================================
// Configuration
// =============================================================================

const AUDIO_UPLOAD_DIR = env.MUSICIAN_AUDIO_UPLOAD_DIR;
const AUDIO_ANALYSIS_DIR = env.MUSICIAN_AUDIO_ANALYSIS_DIR;
const GENERATED_AUDIO_DIR = env.MUSICIAN_GENERATED_AUDIO_DIR;
const MAX_UPLOAD_SIZE = env.MUSICIAN_MAX_UPLOAD_MB * 1024 * 1024; // Convert MB to bytes
const MAX_GENERATION_SECONDS = env.MUSICIAN_MAX_GENERATION_SECONDS;
const DEFAULT_SAMPLE_RATE = env.MUSICIAN_DEFAULT_SAMPLE_RATE;

// Metadata file for upload assets
const UPLOADS_METADATA_FILE = path.join(AUDIO_UPLOAD_DIR, "metadata.jsonl");
// Metadata file for generated assets
const GENERATED_METADATA_FILE = path.join(GENERATED_AUDIO_DIR, "metadata.jsonl");

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Ensure a directory exists, creating it if necessary.
 */
function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create directory ${dirPath}: ${error}`);
    }
  }
}

/**
 * Validate that a path doesn't contain path traversal sequences.
 */
function sanitizePath(input: string): string {
  // Normalize the path
  const normalized = path.normalize(input);
  // Check if it's still within allowed base
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    throw new Error("Path traversal detected");
  }
  return normalized;
}

/**
 * Check if a file is within an allowed directory.
 */
function isPathSafe(filePath: string, allowedBase: string): boolean {
  const resolved = path.resolve(allowedBase);
  const requested = path.resolve(filePath);
  return requested.startsWith(resolved + path.sep) || requested === resolved;
}

/**
 * Validate file size against limit.
 */
function validateFileSize(size: number, maxSize: number): void {
  if (size > maxSize) {
    throw new Error(`File size ${size} bytes exceeds maximum ${maxSize} bytes`);
  }
}

/**
 * Calculate SHA256 hash of a file buffer.
 */
function calculateSHA256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Sanitize filename to prevent path traversal and invalid characters.
 */
function sanitizeFilename(filename: string): string {
  // Remove any path components
  const basename = path.basename(filename);
  // Replace any dangerous characters
  return basename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Extract file extension from filename.
 */
function getExtension(filename: string): string {
  const parts = filename.split(".");
  if (parts.length > 1) {
    return "." + parts.pop()?.toLowerCase() || "";
  }
  return "";
}

/**
 * Validate MIME type is in allowed list.
 */
function isValidMimeType(mimeType: string): mimeType is AllowedAudioMIMEType {
  return ALLOWED_AUDIO_MIME_TYPES.includes(mimeType as AllowedAudioMIMEType);
}

/**
 * Get allowed MIME types as a string for error messages.
 */
function getAllowedMimeTypes(): string {
  return ALLOWED_AUDIO_MIME_TYPES.join(", ");
}

/**
 * Read JSONL file and parse entries.
 */
function readJsonlFile(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * Append entry to JSONL file.
 */
function appendJsonlFile(filePath: string, entry: Record<string, unknown>): void {
  ensureDirectory(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
}

// =============================================================================
// Audio Asset Management
// =============================================================================

/**
 * Save an uploaded audio file.
 */
export async function saveUploadedAudio(
  buffer: Buffer,
  originalFilename: string,
  mimeType: string,
  userId?: string
): Promise<AudioAsset> {
  // Validate MIME type
  if (!isValidMimeType(mimeType)) {
    throw new Error(
      `Invalid MIME type: ${mimeType}. Allowed types: ${getAllowedMimeTypes()}`
    );
  }

  // Validate file size
  validateFileSize(buffer.length, MAX_UPLOAD_SIZE);

  // Sanitize original filename
  const sanitizedFilename = sanitizeFilename(originalFilename);
  const extension = getExtension(sanitizedFilename);

  // Generate unique filename
  const uniqueFilename = `${uuidv4()}${extension}`;
  const filePath = path.join(AUDIO_UPLOAD_DIR, uniqueFilename);

  // Ensure directory exists
  ensureDirectory(AUDIO_UPLOAD_DIR);

  // Path safety check
  if (!isPathSafe(filePath, AUDIO_UPLOAD_DIR)) {
    throw new Error("Invalid file path");
  }

  // Write file
  fs.writeFileSync(filePath, buffer);

  // Calculate SHA256
  const sha256 = calculateSHA256(buffer);

  // Extract duration and metadata if available
  let durationSeconds: number | undefined;
  let sampleRate: number | undefined;
  let channels: number | undefined;

  try {
    // Attempt to get metadata from ffprobe
    const { getAudioMetadata } = await import(
      "../integrations/audio/metadata"
    );
    const metadataResult = await getAudioMetadata(filePath);
    if (metadataResult.metrics) {
      durationSeconds = metadataResult.metrics.durationSeconds;
      sampleRate = metadataResult.metrics.sampleRate;
      channels = metadataResult.metrics.channels;
    }
  } catch {
    // Metadata extraction is optional
  }

  // Create asset record
  const asset: AudioAsset = {
    id: uniqueFilename,
    originalFilename,
    storedFilename: uniqueFilename,
    filePath,
    size: buffer.length,
    mimeType,
    sha256,
    userId,
    createdAt: new Date().toISOString(),
    durationSeconds,
    sampleRate,
    channels,
  };

  // Save metadata to JSONL
  appendJsonlFile(UPLOADS_METADATA_FILE, {
    ...asset,
    createdAt: asset.createdAt,
  });

  return asset;
}

/**
 * Get an audio asset by its ID.
 */
export async function getAudioAsset(fileId: string): Promise<AudioAsset | null> {
  // Read all upload metadata
  const entries = readJsonlFile(UPLOADS_METADATA_FILE);

  // Find matching asset
  for (const entry of entries) {
    if (entry.id === fileId) {
      return entry as unknown as AudioAsset;
    }
  }

  // Check generated audio
  const generatedEntries = readJsonlFile(GENERATED_METADATA_FILE);
  for (const entry of generatedEntries) {
    if (entry.id === fileId) {
      return entry as unknown as AudioAsset;
    }
  }

  return null;
}

/**
 * Get the file path for an audio asset by its ID.
 */
export async function getAudioAssetPath(fileId: string): Promise<string> {
  const asset = await getAudioAsset(fileId);
  if (!asset) {
    throw new Error(`Asset not found: ${fileId}`);
  }
  return asset.filePath;
}

/**
 * Create a generated audio asset.
 */
export async function createGeneratedAudioAsset(
  metadata: {
    prompt: string;
    filePath: string;
    durationSeconds?: number;
    genre?: string;
    mood?: string;
    seed?: number;
    model?: string;
    provider?: string;
    userId?: string;
    warnings?: string[];
  }
): Promise<GeneratedAudioAsset> {
  const { prompt, filePath, userId, warnings } = metadata;

  // Validate file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`Generated file not found: ${filePath}`);
  }

  // Get file stats
  const stats = fs.statSync(filePath);

  // Validate duration
  const duration = metadata.durationSeconds ?? MAX_GENERATION_SECONDS;
  if (duration > MAX_GENERATION_SECONDS) {
    throw new Error(
      `Duration ${duration}s exceeds maximum ${MAX_GENERATION_SECONDS}s`
    );
  }

  // Determine MIME type from extension
  const ext = path.extname(filePath).toLowerCase();
  let mimeType: "audio/wav" | "audio/mp3" | "audio/flac" = "audio/wav";
  if (ext === ".mp3") {
    mimeType = "audio/mp3";
  } else if (ext === ".flac") {
    mimeType = "audio/flac";
  }

  // Calculate SHA256
  const buffer = fs.readFileSync(filePath);
  const sha256 = calculateSHA256(buffer);

  // Create asset record
  const asset: GeneratedAudioAsset = {
    id: path.basename(filePath),
    storedFilename: path.basename(filePath),
    filePath,
    size: stats.size,
    mimeType,
    sha256,
    userId,
    createdAt: new Date().toISOString(),
    durationSeconds: duration,
    metadata: {
      prompt,
      model: metadata.model,
      provider: metadata.provider,
      durationSeconds: duration,
      genre: metadata.genre,
      mood: metadata.mood,
      seed: metadata.seed,
    },
    warnings,
  };

  // Save metadata to JSONL
  appendJsonlFile(GENERATED_METADATA_FILE, {
    ...asset,
    createdAt: asset.createdAt,
  });

  return asset;
}

/**
 * List musician assets with filtering.
 */
export function listMusicianAssets(
  options: ListAssetsOptions = {}
): ListAssetsResult {
  const { type, limit, offset, userId } = options;
  const assets: (AudioAsset | GeneratedAudioAsset)[] = [];

  // Read upload assets
  if (type === undefined || type === "upload") {
    const uploadEntries = readJsonlFile(UPLOADS_METADATA_FILE);
    for (const entry of uploadEntries) {
      if (!userId || entry.userId === userId) {
        assets.push(entry as unknown as AudioAsset);
      }
    }
  }

  // Read generated assets
  if (type === undefined || type === "generated") {
    const generatedEntries = readJsonlFile(GENERATED_METADATA_FILE);
    for (const entry of generatedEntries) {
      if (!userId || entry.userId === userId) {
        assets.push(entry as unknown as GeneratedAudioAsset);
      }
    }
  }

  // Sort by createdAt descending
  assets.sort((a, b) => {
    const dateA = new Date(a.createdAt).getTime();
    const dateB = new Date(b.createdAt).getTime();
    return dateB - dateA;
  });

  // Apply pagination
  const skip = offset ?? 0;
  const take = limit ?? assets.length;
  const paginated = assets.slice(skip, skip + take);

  return {
    assets: paginated,
    total: assets.length,
  };
}

/**
 * Delete a musician asset by ID.
 */
export async function deleteMusicianAsset(fileId: string): Promise<boolean> {
  // Find and remove from uploads
  let found = false;
  const uploadEntries = readJsonlFile(UPLOADS_METADATA_FILE);
  const newUploadEntries: Record<string, unknown>[] = [];

  for (const entry of uploadEntries) {
    if (entry.id === fileId) {
      found = true;
      const filePath = entry.filePath as string;
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } else {
      newUploadEntries.push(entry);
    }
  }

  if (found) {
    fs.writeFileSync(UPLOADS_METADATA_FILE, newUploadEntries.join("\n"));
    return true;
  }

  // Find and remove from generated
  const generatedEntries = readJsonlFile(GENERATED_METADATA_FILE);
  const newGeneratedEntries: Record<string, unknown>[] = [];

  for (const entry of generatedEntries) {
    if (entry.id === fileId) {
      found = true;
      const filePath = entry.filePath as string;
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } else {
      newGeneratedEntries.push(entry);
    }
  }

  if (found) {
    fs.writeFileSync(GENERATED_METADATA_FILE, newGeneratedEntries.join("\n"));
    return true;
  }

  return false;
}

/**
 * Get file path for a musician asset by ID.
 * This is a convenience function for the asset storage system.
 */
export async function getMusicianAssetFilePath(fileId: string): Promise<string> {
  // Check uploads first
  const uploadPath = path.join(AUDIO_UPLOAD_DIR, fileId);
  if (fs.existsSync(uploadPath)) {
    return uploadPath;
  }

  // Check generated
  const generatedPath = path.join(GENERATED_AUDIO_DIR, fileId);
  if (fs.existsSync(generatedPath)) {
    return generatedPath;
  }

  throw new Error(`Asset not found: ${fileId}`);
}

/**
 * Initialize musician asset directories.
 * Should be called on application startup.
 */
export function initializeMusicianStorage(): void {
  ensureDirectory(AUDIO_UPLOAD_DIR);
  ensureDirectory(AUDIO_ANALYSIS_DIR);
  ensureDirectory(GENERATED_AUDIO_DIR);
}
