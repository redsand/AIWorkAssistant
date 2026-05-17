/**
 * Musician Assistant - Asset Types
 *
 * Types for audio asset storage and management.
 */

// =============================================================================
// Audio Asset Types
// =============================================================================

/**
 * Audio MIME types allowed for upload.
 */
export const ALLOWED_AUDIO_MIME_TYPES = [
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/flac",
  "audio/aac",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
] as const;

export type AllowedAudioMIMEType = (typeof ALLOWED_AUDIO_MIME_TYPES)[number];

/**
 * Audio asset stored on disk.
 */
export interface AudioAsset {
  /**
   * Unique identifier for the asset.
   */
  id: string;

  /**
   * Original filename as uploaded by user.
   */
  originalFilename: string;

  /**
   * Stored filename on disk (UUID with extension).
   */
  storedFilename: string;

  /**
   * Full path to the file on disk.
   */
  filePath: string;

  /**
   * File size in bytes.
   */
  size: number;

  /**
   * MIME type of the audio file.
   */
  mimeType: AllowedAudioMIMEType;

  /**
   * SHA256 hash of the file content.
   */
  sha256: string;

  /**
   * Optional user ID who uploaded the asset.
   */
  userId?: string;

  /**
   * Upload timestamp in ISO format.
   */
  createdAt: string;

  /**
   * Duration in seconds if available from metadata.
   */
  durationSeconds?: number;

  /**
   * Sample rate if available from metadata.
   */
  sampleRate?: number;

  /**
   * Number of channels if available from metadata.
   */
  channels?: number;
}

/**
 * Generated audio asset with additional metadata.
 */
export interface GeneratedAudioAsset {
  /**
   * Unique identifier for the asset.
   */
  id: string;

  /**
   * Stored filename on disk (UUID with extension).
   */
  storedFilename: string;

  /**
   * Full path to the file on disk.
   */
  filePath: string;

  /**
   * File size in bytes.
   */
  size: number;

  /**
   * MIME type of the generated audio.
   */
  mimeType: "audio/wav" | "audio/mp3" | "audio/flac";

  /**
   * SHA256 hash of the file content.
   */
  sha256: string;

  /**
   * Optional user ID who requested generation.
   */
  userId?: string;

  /**
   * Timestamp in ISO format.
   */
  createdAt: string;

  /**
   * Duration in seconds.
   */
  durationSeconds: number;

  /**
   * Generation parameters.
   */
  metadata: {
    prompt: string;
    model?: string;
    provider?: string;
    durationSeconds: number;
    genre?: string;
    mood?: string;
    seed?: number;
  };

  /**
   * Any warnings during generation.
   */
  warnings?: string[];
}

/**
 * Query options for listing assets.
 */
export interface ListAssetsOptions {
  /**
   * Filter by asset type: 'upload' or 'generated'
   */
  type?: "upload" | "generated";

  /**
   * Maximum number of assets to return.
   */
  limit?: number;

  /**
   * Number of assets to skip.
   */
  offset?: number;

  /**
   * Optional user ID to filter by.
   */
  userId?: string;
}

/**
 * Result of listing assets.
 */
export interface ListAssetsResult {
  /**
   * List of assets.
   */
  assets: (AudioAsset | GeneratedAudioAsset)[];

  /**
   * Total count of assets matching the query.
   */
  total: number;
}

/**
 * Upload result with asset info.
 */
export interface UploadResult {
  /**
   * Success status.
   */
  success: boolean;

  /**
   * Asset if successful.
   */
  asset?: AudioAsset;

  /**
   * Error message if failed.
   */
  error?: string;

  /**
   * Warnings during upload.
   */
  warnings?: string[];
}

/**
 * Path traversal detection error.
 */
export interface PathTraversalError extends Error {
  kind: "path_traversal";
}

/**
 * File size limit exceeded error.
 */
export interface SizeLimitError extends Error {
  kind: "size_limit";
  actualSize: number;
  maxSize: number;
}
