/**
 * Musician Assistant - Shared TypeScript Types
 *
 * Core types and interfaces for the Musician Assistant module.
 * These types are shared across the domain module, agent integration,
 * and API layer.
 */

// =============================================================================
// 1. Musical Theory Types
// =============================================================================

/**
 * Request for music theory explanation or instruction.
 */
export interface MusicalTheoryRequest {
  /**
   * The specific music theory topic to explain.
   * Examples: "dominant seventh chords", "circle of fifths", "voice leading"
   */
  topic: string;

  /**
   * The user's current skill level for tailoring the explanation.
   */
  skillLevel: "beginner" | "intermediate" | "advanced" | "pro";

  /**
   * Target instrument for the explanation (optional).
   * Helps provide instrument-specific examples.
   */
  instrument?: string;

  /**
   * Music style/genre context for examples (optional).
   * Examples: "jazz", "rock", "classical", "pop"
   */
  style?: string;

  /**
   * Whether to include interactive exercises in the response.
   * When true, the assistant will provide playable exercises.
   */
  includeExercises?: boolean;

  /**
   * Whether to include musical examples in the response.
   * When true, the assistant will provide example progressions or patterns.
   */
  includeExamples?: boolean;
}

// =============================================================================
// 2. Composition Types
// =============================================================================

/**
 * Request for song composition or arrangement guidance.
 */
export interface CompositionRequest {
  /**
   * The primary goal or purpose of the composition.
   * Examples: "write a chorus", "create a bridge", "write a complete song"
   */
  goal: string;

  /**
   * Target genre for the composition (optional).
   * Examples: "pop", "rock", "jazz", "electronic", "classical"
   */
  genre?: string;

  /**
   * Mood or emotional tone for the composition (optional).
   * Examples: "uplifting", "melancholic", "tense", "relaxed"
   */
  mood?: string;

  /**
   * Target tempo in BPM (optional).
   */
  tempo?: number;

  /**
   * Target key or tonal center (optional).
   * Examples: "C major", "Am", "D dorian"
   */
  key?: string;

  /**
   * Target time signature (optional).
   * Examples: "4/4", "3/4", "6/8", "7/8"
   */
  timeSignature?: string;

  /**
   * List of instruments to use (optional).
   */
  instruments?: string[];

  /**
   * Reference tracks or artists to guide the composition (optional).
   */
  references?: string[];

  /**
   * Any constraints or boundaries for the composition (optional).
   * Examples: "under 2 minutes", "only diatonic chords", "no percussion"
   */
  constraints?: string;

  /**
   * Existing lyrics to incorporate (optional).
   */
  lyrics?: string;

  /**
   * Existing chord progression to use or build upon (optional).
   * Examples: "I-V-vi-IV", "C-G-Am-F"
   */
  chordProgression?: string;

  /**
   * Description of an existing melody (optional).
   * Can be a written description or reference to existing material.
   */
  melodyDescription?: string;

  /**
   * Desired output format for the composition result.
   */
  outputFormat: "markdown" | "lead_sheet" | "chord_chart" | "arrangement_plan" | "midi_plan";
}

// =============================================================================
// 3. Audio Analysis Types
// =============================================================================

/**
 * Request for audio file analysis.
 */
export interface AudioAnalysisRequest {
  /**
   * Identifier for the uploaded audio file.
   * Either fileId or filePath must be provided.
   */
  fileId?: string;

  /**
   * File system path to the audio file.
   * Either fileId or filePath must be provided.
   */
  filePath?: string;

  /**
   * Type of analysis to perform.
   * - mixdown: Analyze mix quality and balance
   * - mastering: Analyze master preparation and loudness
   * - composition: Analyze harmonic/melodic structure
   * - arrangement: Analyze instrumentation and voicing
   * - performance: Analyze timing and intonation
   * - transcription: Attempt to identify notes and chords
   * - all: Run all available analyses
   */
  analysisType: "mixdown" | "mastering" | "composition" | "arrangement" | "performance" | "transcription" | "all";

  /**
   * Genre of the audio for context-aware analysis (optional).
   */
  genre?: string;

  /**
   * Reference tracks for comparison (optional).
   * Used for benchmarking quality and style.
   */
  targetReferences?: string[];

  /**
   * Listening context for analysis interpretation (optional).
   * Different environments reveal different issues.
   */
  listeningContext?: "earbuds" | "car" | "club" | "streaming" | "broadcast" | "live";

  /**
   * Specific questions the user wants answered (optional).
   * Allows targeted analysis focused on user concerns.
   */
  userQuestions?: string[];

  /**
   * Whether to include detailed technical measurements (optional).
   * When true, include objective audio metrics.
   */
  includeTechnicalMetrics?: boolean;

  /**
   * Whether to include actionable improvement steps (optional).
   * When true, include specific what-to-do recommendations.
   */
  includeActionPlan?: boolean;
}

/**
 * Technical audio measurements and characteristics.
 */
export interface AudioTechnicalMetrics {
  /**
   * Duration of the audio in seconds.
   */
  durationSeconds: number;

  /**
   * Sample rate in Hz (e.g., 44100, 48000).
   */
  sampleRate: number;

  /**
   * Number of audio channels (1 = mono, 2 = stereo).
   */
  channels: number;

  /**
   * Integrated loudness in LUFS (Loudness Units relative to Full Scale).
   * Typical broadcast target: -23 LUFS, streaming target: -14 LUFS.
   */
  integratedLufs?: number;

  /**
   * True peak in dBTP (Decibels True Peak).
   * Should typically be below -1 dBTP for interstitial limiting.
   */
  truePeakDbtp?: number;

  /**
   * Peak level in dBFS (Decibels Full Scale).
   * Maximum sample value relative to digital full scale.
   */
  peakDbfs?: number;

  /**
   * RMS (Root Mean Square) level in dB.
   * Represents average signal level.
   */
  rmsDb?: number;

  /**
   * Dynamic range measurement.
   * Higher values indicate more dynamic (less compressed) audio.
   */
  dynamicRange?: number;

  /**
   * Crest factor (peak-to-RMS ratio) in dB.
   * Indicates how much headroom is needed for peaks.
   */
  crestFactor?: number;

  /**
   * Spectral centroid frequency in Hz.
   * "Center of gravity" of the spectrum; indicates brightness.
   */
  spectralCentroid?: number;

  /**
   * Spectral balance across frequency bands.
   * Shows relative energy distribution across sub, bass, mids, and highs.
   */
  spectralBalance?: {
    low: number;   // Sub-bass, 20-60 Hz
    sub: number;   // Bass, 60-250 Hz
    lowMid: number; // Low-mid, 250-500 Hz
    mid: number;   // Mid, 500-2000 Hz
    highMid: number; // High-mid, 2-4 kHz
    high: number;  // High, 4-16 kHz
  };

  /**
   * Stereo width as a percentage (0-100).
   * 0% = mono, 100% = fully wide.
   */
  stereoWidth?: number;

  /**
   * Phase correlation between left and right channels.
   * Ranges from -1 (opposite) to 1 (identical).
   * 0.7+ is typically good for stereo.
   */
  phaseCorrelation?: number;

  /**
   * Detected tempo in BPM (beats per minute).
   */
  tempoBpm?: number;

  /**
   * Detected key or tonal center.
   * Examples: "C", "Am", "G major".
   */
  keyEstimate?: string;

  /**
   * Detected time signature.
   * Examples: "4/4", "3/4", "6/8".
   */
  timeSignatureEstimate?: string;

  /**
   * Onset density - number of note attacks per second.
   * Indicates rhythmic complexity.
   */
  onsetDensity?: number;

  /**
   * Whether clipping/distortion was detected.
   */
  clippingDetected?: boolean;

  /**
   * Percentage of the track that is silent.
   */
  silencePercent?: number;

  /**
   * DC offset in normalized units (-1 to 1).
   * Should be close to 0 for proper audio.
   */
  dcOffset?: number;

  /**
   * Detected notes (for transcription analysis).
   * Array of note names in MIDI format.
   */
  notes?: string[];
}

// =============================================================================
// 4. Mix Feedback Types
// =============================================================================

/**
 * Feedback report for mixdown analysis.
 */
export interface MixFeedbackReport {
  /**
   * Overall summary of the mix quality.
   */
  summary: string;

  /**
   * List of successful elements in the mix.
   * What's working well.
   */
  strengths: string[];

  /**
   * List of identified issues.
   * What needs improvement.
   */
  issues: string[];

  /**
   * Frequency balance analysis.
   * How energy is distributed across the spectrum.
   */
  frequencyBalance: {
    overallAssessment: "balanced" | "boomy" | "thin" | "muddy" | "harsh" | "dull";
    bassEnergy: "absent" | "weak" | "present" | "excessive";
    midClarity: "clear" | "muffled" | "boxy" | "thin";
    highExtension: "air" | "sparkle" | "dull" | "harsh";
    frequencyGauge: {
      sub: number;   // -10 to +10 relative to reference
      bass: number;
      lowMid: number;
      mid: number;
      highMid: number;
      high: number;
    };
  };

  /**
   * Dynamics processing analysis.
   * Compression, limiting, and overall loudness.
   */
  dynamics: {
    overallAssessment: "dynamic" | "moderate" | "crushed" | "flat";
    compressionAmount: "none" | "light" | "moderate" | "heavy" | "brick-walled";
    punch: "preserved" | "reduced" | "killed";
    sustain: "natural" | "extended" | "sustained";
    loudnessLufs: number;
  };

  /**
   * Stereo imaging analysis.
   * Width, panning, and spatial characteristics.
   */
  stereoImage: {
    overallAssessment: "narrow" | "moderate" | "wide" | "phased";
    width: number; // 0-100%
    centerImageStability: "stable" | "wandering" | "unfocused";
    panningBalance: "left-heavy" | "balanced" | "right-heavy";
    stereoToolsUsed: string[]; // List of detected stereo processing
  };

  /**
   * Depth and spatial relationships.
   * How instruments are positioned in 3D space.
   */
  depthAndSpace: {
    overallAssessment: "flat" | "shallow" | "moderate" | "deep" | "layered";
    frontElements: string[]; // Instruments perceived as closest
    middleElements: string[];
    backElements: string[]; // Instruments perceived as farthest
    reverbAmount: "dry" | "moderate" | "wet";
    senseOfSpace: string;
  };

  /**
   * Vocal or lead instrument presence and quality.
   * Critical for most genres.
   */
  vocalOrLeadPresence: {
    overallAssessment: "absent" | "distant" | "moderate" | "present" | "overwhelming";
    intelligibility: "poor" | "fair" | "good" | "excellent";
    emotionPreservation: "lost" | "preserved" | "enhanced";
    processingApplied: string[]; // List of EQ, compression, effects used
  };

  /**
   * Low end (bass) analysis.
   * Often the most problematic area.
   */
  lowEnd: {
    overallAssessment: "clean" | "muddy" | "boomy" | "weak" | "boomy+weak";
    subBass: "controlled" | "uncontrolled" | "absent";
    kickDrum: "tight" | "loose" | "one-note" | "complex";
    bassClarity: "defined" | "muddy" | "indistinct";
    phaseIssues: boolean;
  };

  /**
   * Transient (attack) analysis.
   * Impact and punch of the rhythm section.
   */
  transients: {
    overallAssessment: "punchy" | "controlled" | "soft" | "crushed";
    kickAttack: "present" | "reduced" | "absent";
    snareAttack: "present" | "reduced" | "absent";
    percussiveElements: "preserved" | "compressed" | "lost";
    transientShaping: string[];
  };

  /**
   * Background noise and artifacts.
   * Hiss, hum, clicks, and other unwanted elements.
   */
  noiseArtifacts: {
    hasNoise: boolean;
    noiseType: "hiss" | "hum" | "clicks" | "pops" | "circuit noise" | "none";
    noiseLevel: "inaudible" | "low" | "moderate" | "high" | "problematic";
    quantizationIssues: boolean;
    ditheringApplied: boolean;
  };

  /**
   * How well the mix translates across playback systems.
   */
  translationRisks: string[]; // List of potential translation issues

  /**
   * Prioritized list of fixes to implement.
   * Ordered by impact and ease of implementation.
   */
  prioritizedFixes: Array<{
    priority: "critical" | "high" | "medium" | "low";
    issue: string;
    recommendation: string;
    estimatedImpact: string;
  }>,

  /**
   * Suggested plugins or processing chains for fixes.
   */
  suggestedPluginsOrProcesses: Array<{
    purpose: string; // What the plugin should do
    type:
      | "eq"                  // Equalization
      | "eq_parametric"       // Parametric EQ
      | "eq_graphic"          // Graphic EQ
      | "eq_shelving"         // Shelf EQ
      | "eq_peaking"          // Peaking EQ
      | "eq_notch"            // Notch EQ
      | "eq_bass"             // Bass EQ
      | "eq_treble"           // Treble EQ
      | "eq_mid"              // Mid EQ
      | "eq_hpf"              // High-pass filter
      | "eq_lpf"              // Low-pass filter
      | "compression"         // General compression
      | "compression_vari"    // Variable mode compression
      | "compression_stereo"  // Stereo compression
      | "compression_sidechain" // Sidechain compression
      | "compression_parallel"  // Parallel compression
      | "compression_multiband" // Multiband compression
      | "compression_upward"    // Upward compression
      | "compression_downward"  // Downward compression
      | "limiting"            // Limiting
      | "limiter_clipping"    // Hard clipping limiting
      | "limiter_peak"        // Peak limiting
      | "limiter_true"        // True peak limiting
      | "stereo"              // General stereo processing
      | "stereo widening"     // Stereo width enhancement
      | "stereo_width"        // Stereo width control
      | "stereo_midi"         // Mid-side processing
      | "stereo_phase"        // Phase alignment
      | "stereo_upmix"        // Upmixing to stereo
      | "stereo_downmix"      // Downmixing to mono
      | "reverb"              // General reverb
      | "reverb_hall"         // Hall reverb
      | "reverb_room"         // Room reverb
      | "reverb_plate"        // Plate reverb
      | "reverb_spring"       // Spring reverb
      | "reverb_gate"         // Reverb gate
      | "reverb_convolution"  // Convolution reverb
      | "reverb_algorithmic"  // Algorithmic reverb
      | "reverb_shimmer"      // Shimmer reverb
      | "saturation"          // General saturation
      | "saturation_tape"     // Tape saturation
      | "saturation_valve"    // Valve/tube saturation
      | "saturation_transistor" // Transistor saturation
      | "saturation_harmonic" // Harmonic saturation
      | "saturation_distortion" // Distortion
      | "saturation_warmth"   // Warmth saturation
      | "delay"               // General delay
      | "delay_analog"        // Analog delay
      | "delay_digital"       // Digital delay
      | "delay_tape"          // Tape delay
      | "delay_slot"          // Multi-tap delay
      | "delay_modulated"     // Modulated delay
      | "delay_pinging"       // Ping-pong delay
      | "delay_echo"          // Echo delay
      | "delay_granular"      // Granular delay
      | "delay_stutter"       // Stutter delay
      | "delay_spatial"       // Spatial delay
      | "distortion"          // General distortion
      | "distortion_hard"     // Hard clipping distortion
      | "distortion_soft"     // Soft clipping distortion
      | "distortion_wave"     // Wavefolding
      | "distortion_bitcrush" // Bitcrush distortion
      | "distortion_fold"     // Foldback distortion
      | "distortion_clipping" // Clipping distortion
      | "granular"            // Granular processing
      | "granular_reverse"    // Reverse granular
      | "granular_stutter"    // Stutter granular
      | "envelope"            // Envelope shaping
      | "envelope_attack"     // Attack shaping
      | "envelope_release"    // Release shaping
      | "envelope_dynamics"   // Dynamic envelope
      | "spatial"             // General spatial processing
      | "spatial_pan"         // Panning
      | "spatial_3d"          // 3D spatialization
      | "spatial_binaural"    // Binaural processing
      | "spatial_hrtf"        // HRTF spatialization
      | "spatial_impulse"     // Impulse response
      | "spatial_reflection"  // Reflection simulation
      | "spatial_environment" // Environmental simulation
      | "filter"              // General filtering
      | "filter_lowpass"      // Low-pass filter
      | "filter_highpass"     // High-pass filter
      | "filter_bandpass"     // Band-pass filter
      | "filter_notch"        // Notch filter
      | "filter_allpass"      // All-pass filter
      | "filter_resonance"    // Resonant filter
      | "filter_formant"      // Formant filter
      | "filter_morph"        // Morphing filter
      | "modulation"          // General modulation
      | "modulation_chorus"   // Chorus
      | "modulation_flanger"  // Flanger
      | "modulation_phaser"   // Phaser
      | "modulation_vibrato"  // Vibrato
      | "modulation_tremolo"  // Tremolo
      | "modulation_rotary"   // Rotary speaker
      | "modulation_wah"      // Wah-wah
      | "modulation_envelope" // Envelope modulation
      | "noise"               // General noise processing
      | "noise_reduction"     // Noise reduction
      | "noise_gate"          // Noise gate
      | "noise_suppress"      // Noise suppress
      | "noise_floor"         // Floor noise treatment
      | "restoration"         // Audio restoration
      | "restoration_declick" // Declicking
      | "restoration_denoise" // Denoising
      | "restoration_hum"     // Hum removal
      | "restoration_pop"     // Pop removal
      | "restoration_clip"    // Clip restoration
      | "restoration_balance" // Balance restoration
      | "pitch"               // Pitch processing
      | "pitch_shift"         // Pitch shifting
      | "pitch_quantize"      // Pitch quantization
      | "pitch_formant"       // Formant shifting
      | "pitch_monitor"       // Pitch monitoring
      | "transposition"       // Transposition
      | "alignment"           // Audio alignment
      | "alignment_stretch"   // Time-stretching
      | "alignment_phase"     // Phase alignment
      | "alignment_sync"      // Sync alignment
      | "level"               // General level processing
      | "level_gain"          // Gain adjustment
      | "level_balance"       // Balance adjustment
      | "level_automate"      // Automation
      | "level_match"         // Level matching
      | "level_normalization" // Normalization
      | "level_limiter"       // Level limiting
      | "monitoring"          // Monitoring tools
      | "monitoring_meter"    // Metering
      | "monitoring_phase"    // Phase monitoring
      | "monitoring_spectrum" // Spectrum analysis
      | "monitoring_reference" // Reference comparison
      | "monitoring_stereo"   // Stereo monitoring
      | "automation"          // Automation
      | "automation_envelope" // Envelope automation
      | "automation_midi"     // MIDI automation
      | "automation_script"   // Script automation
      | "dither"              // Dithering
      | "dither_noise"        // Noise-shaped dither
      | "dither_triangle"     // Triangle dither
      | "dither_square"       // Square dither
      | "convolution"         // Convolution processing
      | "convolution_impulse" // Impulse convolution
      | "convolution_linear"  // Linear convolution
      | "convolution_nonlinear" // Non-linear convolution
      | "upscaling"           // Audio upscaling
      | "upscaling_resample"  // Resampling
      | "upscaling_bitdepth"  // Bit-depth expansion
      | "downscaling"         // Audio downscaling
      | "downsampling"        // Downsampling
      | "format_conversion"   // Format conversion
      | "metadata"            // Metadata processing
      | "metadata_edit"       // Metadata editing
      | "metadata_bake"       // Metadata baking
      | "visualization"       // Audio visualization
      | "visualization_waveform" // Waveform display
      | "visualization_spectrum" // Spectrum display
      | "visualization_stereo" // Stereo scope
      | "visualization_phase"   // Phase display
      | "export"              // Export processing
      | "export_dither"       // Export dithering
      | "export_normalization" // Export normalization
      | "other"               // Other/unknown type
    ;
    suggestedChain: string[]; // Example plugin chain
  }>;

  /**
   * Comparison with reference tracks (optional).
   */
  referenceComparison?: {
    comparedTo: string[];
    matchingStrengths: string[];
    missingElements: string[];
    qualityGap: "close" | "moderate" | "significant";
  };

  /**
   * Confidence level in the analysis (0-1).
   * Based on audio quality and available data.
   */
  confidence: number;
}

// =============================================================================
// 5. Mastering Feedback Types
// =============================================================================

/**
 * Feedback report for mastering analysis.
 */
export interface MasteringFeedbackReport {
  /**
   * Overall release readiness assessment.
   */
  releaseReadiness: "ready" | "nearly_ready" | "needs_work" | "not_ready";

  /**
   * Loudness analysis and recommendations.
   */
  loudness: {
    currentLufs: number;
    targetLufs: number;
    loudnessRange: number; // LRA - Loudness Range
    luRange: string; // "0-5" = dynamic, "6+" = compressed
    streamingNormalization: "will_gain_match" | "already_normalized" | "needs_reduction";
    loudnessWarStatus: "dynamic" | "moderate" | "over-compressed" | "brick-walled";
  };

  /**
   * True peak analysis.
   */
  truePeak: {
    measuredDbtp: number;
    maxAllowedDbtp: number; // Usually -1 dBTP for interstitial limiting
    headroom: number;
    interSamplePeak: boolean; // Whether inter-sample peaks are present
    interSamplePeakLevel?: number; // Measured ISPS in dBTP
  };

  /**
   * Dynamics analysis for mastering context.
   */
  dynamics: {
    dynamicRange: number; // In dB
    compressorsUsed: string[]; // Detected processors
    limitingCycles: number; // How many limiting stages
    punchRetained: boolean;
    loudnessVersusDynamicRange: "loud_and_compressed" | "moderate" | "dynamic";
  };

  /**
   * Tonal balance analysis for mastering context.
   */
  tonalBalance: {
    overallAssessment: "balanced" | "warm" | "bright" | "boomy" | "thin";
    bass: number; // -10 to +10 relative to reference
    midrange: number;
    treble: number;
    consistency: "consistent" | "inconsistent" | "uneven";
  };

  /**
   * Notes about track sequencing (for albums).
   */
  sequencingNotes: Array<{
    trackIndex: number;
    trackName: string;
    gapSeconds: number;
    loudnessMatched: boolean;
    tonalBalanceMatched: boolean;
    transitionType: "direct" | "fade" | "crossfade" | "pause";
    notes: string[];
  }>;

  /**
   * Readiness for various streaming platforms.
   */
  streamingReadiness: {
    spotify: "ready" | "needs_adjustment" | "will_gain_match";
    appleMusic: "ready" | "needs_adjustment" | "will_gain_match";
    youtube: "ready" | "needs_adjustment";
    soundcloud: "ready" | "needs_adjustment";
    bandcamp: "ready" | "needs_adjustment";
  };

  /**
   * Specialized readiness for physical or club playback.
   */
  vinylOrClubReadiness?: {
    format: "vinyl" | "cd" | "club_dj";
    preMasterRequirements: string[];
    lacquerCutSpecificNotes: string[]; // For vinyl
    djEditAvailable: boolean;
  };

  /**
   * Prioritized mastering fixes.
   */
  prioritizedFixes: Array<{
    priority: "critical" | "high" | "medium" | "low";
    issue: string;
    masteringSolution: string;
    pluginType:
      | "eq"
      | "eq_parametric"
      | "eq_graphic"
      | "eq_shelving"
      | "compression"
      | "compression_multiband"
      | "limiting"
      | "limiter_true"
      | "stereo"
      | "stereo_width"
      | "saturation"
      | "saturation_tape"
      | "saturation_valve"
      | "delay"
      | "dither"
      | "dither_noise"
      | "convolution"
      | "upscaling"
      | "format_conversion";
  }>;

  /**
   * Export recommendations for final delivery.
   */
  exportRecommendations: {
    idealFormat: "wav" | "aiff" | "flac";
    bitDepth: "16" | "24" | "32";
    sampleRate: "44.1" | "48" | "96" | "192" | "match_source";
    ditherRecommended: boolean;
    ditherType: "noise-shaped" | "triangle" | "rectangular";
    exportChain: string[]; // Recommended processing chain
    clippingCheck: "passed" | "requires_reduction";
  };
}

// =============================================================================
// 6. Music Generation Types
// =============================================================================

/**
 * Request for AI music generation.
 */
export interface MusicGenerationRequest {
  /**
   * Text prompt describing the desired music.
   * Should include genre, mood, instruments, and any specific elements.
   */
  prompt: string;

  /**
   * Elements to avoid in generation (optional).
   */
  negativePrompt?: string;

  /**
   * Target genre (optional).
   */
  genre?: string;

  /**
   * Target mood or emotion (optional).
   */
  mood?: string;

  /**
   * Target tempo in BPM (optional).
   */
  tempo?: number;

  /**
   * Target key or tonal center (optional).
   * Examples: "C major", "Am"
   */
  key?: string;

  /**
   * Duration of the generated audio in seconds.
   */
  durationSeconds: number;

  /**
   * Random seed for reproducible generation (optional).
   */
  seed?: number;

  /**
   * Preferred generation model or method (optional).
   */
  modelPreference?: "local_musicgen" | "huggingface" | "external_api" | "mock";

  /**
   * File ID of audio to continue/extend (optional).
   * Enables continuation of existing music.
   */
  continuationAudioFileId?: string;

  /**
   * Desired output format (optional).
   */
  outputFormat?: "wav" | "mp3" | "flac";

  /**
   * When true, returns a preview without generating actual audio.
   * Used for checking prompt validity and cost estimation.
   */
  dryRun?: boolean;
}

/**
 * Result of a music generation request.
 */
export interface MusicGenerationResult {
  /**
   * Unique identifier for the generated asset.
   */
  assetId: string;

  /**
   * Path to the generated audio file.
   */
  filePath: string;

  /**
   * Duration of the generated audio in seconds.
   */
  durationSeconds: number;

  /**
   * The original text prompt used.
   */
  prompt: string;

  /**
   * Model name used for generation.
   */
  model: string;

  /**
   * Random seed used for generation.
   */
  seed: number;

  /**
   * Timestamp of generation.
   */
  createdAt: string;

  /**
   * Additional metadata about the generation.
   */
  metadata: {
    genre: string;
    mood: string;
    tempo: number;
    key: string;
    duration: number;
    modelVersion: string;
    generationTimeSeconds: number;
    tokensUsed?: number;
    costEstimate?: number;
    license: "personal" | "commercial" | "restricted";
  };

  /**
   * Any warnings encountered during generation.
   */
  warnings: string[];
}

// =============================================================================
// 7. Assistant Mode Types
// =============================================================================

/**
 * Modes available in the Musician Assistant.
 */
export type MusicianAssistantMode =
  | "theory"        // Music theory explanation and learning
  | "composition"   // Songwriting and composition guidance
  | "generation"    // Text-to-music generation
  | "audio_feedback" // Audio analysis and feedback
  | "practice"      // Practice planning and coaching
  | "session_coach"; // Session management and follow-up

/**
 * Mode configuration for the assistant.
 */
export interface AssistantModeConfig {
  mode: MusicianAssistantMode;
  name: string;
  description: string;
  supportedFeatures: string[];
  requiredTools: string[]; // Tool names required for this mode
  systemPromptSuffix: string; // Additional context for this mode
}

/**
 * Available mode configurations.
 */
export const MUSICIAN_MODES: Record<MusicianAssistantMode, AssistantModeConfig> = {
  theory: {
    mode: "theory",
    name: "Music Theory Tutor",
    description: "Learn music theory concepts with interactive examples and exercises",
    supportedFeatures: [
      "explain_concepts",
      "generate_exercises",
      "quiz_mode",
      "instrument_specific_examples",
      "progress_tracking"
    ],
    requiredTools: [
      "musician.explain_theory",
      "musician.generate_exercise",
      "musician.submit_exercise"
    ],
    systemPromptSuffix: "You are a patient and knowledgeable music theory teacher. Focus on clear explanations with practical examples. Use the interactive exercises feature when requested."
  },
  composition: {
    mode: "composition",
    name: "Songwriting Partner",
    description: "Collaborate on songwriting, chord progressions, and arrangement",
    supportedFeatures: [
      "chord_progression_generation",
      "melody_ideas",
      "lyric_brainstorming",
      "arrangement_feedback",
      "reference_analysis"
    ],
    requiredTools: [
      "musician.compose_chord_progression",
      "musician.arrange_song",
      "musician.generate_lyrics"
    ],
    systemPromptSuffix: "You are an experienced songwriting partner. Help develop musical ideas while respecting the user's creative vision. Provide specific, actionable suggestions for improvement."
  },
  generation: {
    mode: "generation",
    name: "AI Music Generator",
    description: "Generate music from text descriptions using AI models",
    supportedFeatures: [
      "text_to_music",
      "audio_continuation",
      "model_selection",
      "dry_run_previews",
      "license_tracking"
    ],
    requiredTools: [
      "musician.generate_music",
      "musician.generate_music:dry_run"
    ],
    systemPromptSuffix: "You are an AI music generation assistant. Help users create music by crafting effective prompts. Explain generation options and manage expectations about output quality."
  },
  audio_feedback: {
    mode: "audio_feedback",
    name: "Audio Analysis Expert",
    description: "Analyze audio files and provide detailed feedback on mix and master",
    supportedFeatures: [
      "mixdown_analysis",
      "mastering_analysis",
      "technical_metrics",
      "reference_comparison",
      "actionable_recommendations"
    ],
    requiredTools: [
      "musician.analyze_audio",
      "musician.feedback_mix",
      "musician.feedback_master"
    ],
    systemPromptSuffix: "You are an expert audio engineer providing technical and creative feedback. Distinguish between measurable observations and subjective preferences. Focus on actionable improvement steps."
  },
  practice: {
    mode: "practice",
    name: "Practice Coach",
    description: "Create and manage personalized practice plans with progress tracking",
    supportedFeatures: [
      "practice_plan_generation",
      "exercise_library",
      "progress_tracking",
      "milestone_setting",
      "instrument_specific_plans"
    ],
    requiredTools: [
      "musician.practice_plan",
      "musician.practice_exercise",
      "musician.practice_log"
    ],
    systemPromptSuffix: "You are a supportive practice coach. Help users build effective practice routines with clear goals and achievable milestones. Track progress and adjust plans as needed."
  },
  session_coach: {
    mode: "session_coach",
    name: "Session Coach",
    description: "Manage music sessions, take notes, and maintain follow-up items",
    supportedFeatures: [
      "session_creation",
      "note_taking",
      "follow_up_management",
      "idea_storage",
      "session_summarization"
    ],
    requiredTools: [
      "musician.session_note",
      "musician.session_summary",
      "musician.memory.follow_up"
    ],
    systemPromptSuffix: "You are a session coach helping organize music work. Capture ideas, create action items, and maintain continuity between sessions. Help users remember and build on previous work."
  }
};

// =============================================================================
// 8. Utility/Response Types
// =============================================================================

/**
 * Generic response from any Musician Assistant operation.
 */
export interface AssistantResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  mode?: MusicianAssistantMode;
  suggestedNextSteps?: string[];
  relatedResources?: {
    topic: string;
    link: string;
    type: "article" | "exercise" | "video" | "tool";
  }[];
}

/**
 * User's current session context.
 */
export interface SessionContext {
  sessionId?: string;
  mode: MusicianAssistantMode;
  userId: string;
  timestamp: string;
  recentActions: string[];
  pendingTasks: string[];
  userPreferences: {
    learningStyle: "visual" | "auditory" | "kinesthetic" | "reading";
    preferredTempo: number;
    targetSkillLevel: "beginner" | "intermediate" | "advanced" | "pro";
    instrumentFocus: string[];
    stylePreferences: string[];
  };
}

/**
 * Feedback submission from user.
 */
export interface UserFeedback {
  sessionId: string;
  feedbackType: "positive" | "negative" | "suggestion";
  content: string;
  relatedTo: string; // What this feedback relates to
  createdAt: string;
}
