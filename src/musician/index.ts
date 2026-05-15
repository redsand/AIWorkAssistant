/**
 * Musician Assistant - Module exports
 *
 * Centralized exports for all musician assistant types and utilities.
 */

// Import type for runtime type guards
import type { MusicianAssistantMode } from "./analysis-types";

// Re-export types from analysis-types
export type {
  MusicalTheoryRequest,
  CompositionRequest,
  AudioAnalysisRequest,
  AudioTechnicalMetrics,
  MixFeedbackReport,
  MasteringFeedbackReport,
  MusicGenerationRequest,
  MusicGenerationResult,
  MusicianAssistantMode,
  AssistantModeConfig,
  AssistantResponse,
  SessionContext,
  UserFeedback,
  // Asset types
  AudioAsset,
  GeneratedAudioAsset,
  ListAssetsOptions,
  ListAssetsResult,
  UploadResult,
  PathTraversalError,
  SizeLimitError,
} from "./analysis-types";

// Re-export types from types.ts
export type {
  AudioAsset,
  GeneratedAudioAsset,
  ListAssetsOptions,
  ListAssetsResult,
  UploadResult,
  PathTraversalError,
  SizeLimitError,
} from "./types";

// Re-export constants from analysis-types
export { MUSICIAN_MODES } from "./analysis-types";

// Re-export prompt exports from prompts.ts
export {
  MUSICIAN_SYSTEM_PROMPT,
  buildMusicianPrompt,
  getMusicianOutputFormat,
  getMusicianModeDescription,
} from "./prompts";

// Re-export asset exports from assets.ts
export {
  saveUploadedAudio,
  getAudioAsset,
  getAudioAssetPath,
  createGeneratedAudioAsset,
  listMusicianAssets,
  deleteMusicianAsset,
  getMusicianAssetFilePath,
  initializeMusicianStorage,
} from "./assets";

// Mode constants (runtime values)
export const MUSICIAN_MODE_VALUES = [
  "theory",
  "composition",
  "generation",
  "audio_feedback",
  "practice",
  "session_coach",
] as const;

// Type guards and utilities
// Note: This type guard uses a string array for runtime checking
export function isMusicianAssistantMode(value: unknown): value is MusicianAssistantMode {
  const modes = MUSICIAN_MODE_VALUES;
  return (modes as readonly string[]).includes(value as string);
}

// Helper type assertion for when you know the value should be a mode
export function assertMusicianMode(value: unknown): asserts value is MusicianAssistantMode {
  const modes = MUSICIAN_MODE_VALUES;
  if (!(modes as readonly string[]).includes(value as string)) {
    throw new Error(`Invalid musician mode: ${value}. Valid modes: ${modes.join(", ")}`);
  }
}
