import type { AudioTechnicalMetrics } from "../../musician/analysis-types";

/**
 * Ffprobe output format for audio metadata extraction.
 */
export interface FfprobeData {
  format: {
    filename: string;
    nb_streams: number;
    format_name: string;
    size?: string;
    duration?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
  streams: Array<{
    index: number;
    codec_name: string;
    codec_long_name?: string;
    codec_type: "audio" | "video" | "subtitle" | "data";
    sample_rate?: string;
    channels?: number;
    channel_layout?: string;
    duration?: string;
    bit_rate?: string;
    profile?: string;
    sample_fmt?: string;
    bits_per_sample?: number;
    bits_per_raw_sample?: number;
    codec_tag_string?: string;
    codec_tag?: string;
    extradata_size?: number;
  }>;
}

/**
 * Options for audio normalization.
 */
export interface NormalizeOptions {
  /** Target sample rate in Hz (default: 48000) */
  sampleRate?: number;
  /** Target channels: 'stereo' or 'mono' (default: 'stereo') */
  channels?: "stereo" | "mono";
  /** Audio filter to apply (optional) */
  filter?: string;
  /** Output format: 'wav', 'mp3', 'flac' (default: 'wav') */
  outputFormat?: "wav" | "mp3" | "flac";
  /** Target loudness in LUFS (default: -14 for streaming) */
  targetLufs?: number;
}

/**
 * Result of audio normalization process.
 */
export interface AudioNormalizationResult {
  /** Path to the normalized audio file */
  outputPath: string;
  /** Any warnings encountered during normalization */
  warnings: string[];
  /** Original file duration in seconds */
  originalDuration?: number;
  /** Normalized file duration in seconds */
  normalizedDuration?: number;
  /** Actual sample rate after normalization */
  sampleRate?: number;
  /** Actual channels after normalization */
  channels?: number;
}

/**
 * Result of audio analysis with Essentia.
 */
export interface EssentiaAnalysisResult {
  /** Detected key (e.g., "C", "Am", "G major") */
  key?: string;
  /** Detected scale for key */
  scale?: string;
  /** Detected tempo in BPM */
  tempo?: number;
  /** Beats array with timestamps */
  beats?: Array<{ time: number; position?: number }>;
  /** Duration in seconds */
  duration?: number;
  /** Zero-crossing rate */
  zcr?: number;
  /** Spectral centroid */
  spectralCentroid?: number;
  /** Spectral rolloff */
  spectralRolloff?: number;
  /** Spectral flux */
  spectralFlux?: number;
  /** Mfcc features */
  mfcc?: number[][];
  /** Bark bands */
  barkBands?: number[][];
  /** Warning messages */
  warnings?: string[];
}

/**
 * Result of transcription with Basic Pitch.
 */
export interface TranscriptionResult {
  /** Path to generated MIDI file (if any) */
  midiPath?: string;
  /** Array of detected notes */
  notes?: Array<{
    pitch: string; // Note name (e.g., "C4", "A#3")
    startTime: number; // seconds
    endTime: number; // seconds
    velocity: number; // 0-127
    confidence?: number; // 0-1
    instrument?: string; // instrument classification
  }>;
  /** Array of detected chords */
  chords?: Array<{
    chord: string; // e.g., "C", "G7", "Am"
    startTime: number; // seconds
    endTime: number; // seconds
    confidence?: number;
  }>;
  /** Array of detected onsets (note attacks) */
  onsets?: Array<{ time: number; confidence: number }>;
  /** Any warnings encountered during transcription */
  warnings: string[];
  /** Path to any intermediate files created */
  tempFiles?: string[];
}

/**
 * Result of MusicGen generation.
 */
export interface MusicGenGenerationResult {
  /** Unique identifier for the generated audio */
  assetId: string;
  /** Path to generated audio file */
  filePath: string;
  /** Duration in seconds */
  duration: number;
  /** Generation mode used: 'dryRun', 'mock', or actual model name */
  mode: "dryRun" | "mock" | "local" | "hf" | "external";
  /** Prompt used for generation */
  prompt: string;
  /** Model version used */
  model?: string;
  /** Random seed used (for reproducibility) */
  seed?: number;
  /** Temperature parameter */
  temperature?: number;
  /** Top-k parameter */
  topK?: number;
  /** Top-p parameter */
  topP?: number;
  /** Genre used for generation */
  genre?: string;
  /** Mood used for generation */
  mood?: string;
  /** Tempo used for generation */
  tempo?: number;
  /** Key used for generation */
  key?: string;
  /** Warnings encountered during generation */
  warnings?: string[];
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** File size in bytes */
  fileSize?: number;
  /** SHA256 hash of the generated file */
  sha256?: string;
}

/**
 * Configuration for Essentia adapter.
 */
export interface EssentiaConfig {
  /** Path to Essentia Python script or executable */
  essentiaPath?: string;
  /** Path to Essentia models directory */
  modelsPath?: string;
  /** Use Python subprocess instead of CLI */
  usePython?: boolean;
}

/**
 * Configuration for Basic Pitch adapter.
 */
export interface BasicPitchConfig {
  /** Path to basic-pitch Python script or executable */
  basicPitchPath?: string;
  /** Use Python subprocess instead of CLI */
  usePython?: boolean;
  /** Confidence threshold for detection (0-1) */
  confidenceThreshold?: number;
}

/**
 * Configuration for MusicGen adapter.
 */
export interface MusicGenConfig {
  /** Generation mode: 'dryRun', 'mock', 'local', 'hf', 'external' */
  mode?: "dryRun" | "mock" | "local" | "hf" | "external";
  /** Local path to MusicGen Python script or model */
  localModelPath?: string;
  /** Hugging Face model ID */
  hfModelId?: string;
  /** External API endpoint for MusicGen */
  apiUrl?: string;
  /** API key for external services */
  apiKey?: string;
  /** Default duration in seconds */
  defaultDuration?: number;
}

/**
 * Input for audio analysis functions.
 */
export interface AudioAnalysisInput {
  /** Path to the audio file */
  filePath: string;
  /** Optional: Analysis context or purpose */
  context?: string;
  /** Optional: Analysis options */
  options?: Record<string, unknown>;
}

/**
 * Output for audio analysis functions.
 */
export interface AudioAnalysisOutput {
  /** Whether analysis was successful */
  success: boolean;
  /** Analysis data or partial data */
  data?: AudioTechnicalMetrics | Partial<AudioTechnicalMetrics>;
  /** Any warnings encountered */
  warnings: string[];
  /** Error message if failed */
  error?: string;
  /** Temporary files created during analysis */
  tempFiles?: string[];
}

/**
 * Result of audio metadata extraction.
 */
export interface AudioMetadataResult {
  /** Audio technical metrics (may be partial) */
  metrics: AudioTechnicalMetrics;
  /** Warnings encountered during extraction */
  warnings: string[];
  /** Error message if failed */
  error?: string;
}
