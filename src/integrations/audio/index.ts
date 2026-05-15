/**
 * Audio Processing Integrations - Module exports
 *
 * This module provides audio processing capabilities using external tools
 * (ffmpeg, ffprobe, essentia, basic-pitch) and AI models (MusicGen).
 *
 * Architecture:
 * - Tools like ffmpeg/ffprobe/essentia are invoked via CLI for maximum portability
 * - Python workers can be used for heavy AI models (essentia, basic-pitch, musicgen)
 * - All file operations are path-safe and do not overwrite originals
 */

// Core adapters
export { getAudioMetadata, detectFfprobe, runFfprobe, parseDuration, extractMetricsFromFfprobe } from "./metadata";
export { normalizeAudioForAnalysis } from "./ffmpeg";
export {
  detectClipping,
  estimateRms,
  estimatePeak,
  estimateSilencePercent,
  estimateDcOffset,
  analyzeWaveform,
} from "./waveform";

// AI model adapters
export { analyzeWithEssentia, detectEssentia, essentiaToAudioMetrics } from "./essentia-adapter";
export { transcribeWithBasicPitch, detectBasicPitch, notesToNoteNames } from "./basic-pitch-adapter";
export { generateWithMusicGen, validateMusicGenMode } from "./musicgen-adapter";

// Types
export type {
  FfprobeData,
  NormalizeOptions,
  AudioNormalizationResult,
  TranscriptionResult,
  MusicGenGenerationResult,
  MusicGenConfig,
  EssentiaAnalysisResult,
  EssentiaConfig,
  BasicPitchConfig,
  AudioMetadataResult,
} from "./types";
