/**
 * Mixdown Feedback Engine
 *
 * Analyzes AudioTechnicalMetrics and AudioAnalysisRequest to produce
 * a comprehensive MixFeedbackReport with actionable recommendations.
 *
 * Uses deterministic rules based on audio measurements plus
 * LLM-ready narrative fields for enhanced context.
 */

import {
  AudioTechnicalMetrics,
  AudioAnalysisRequest,
  MixFeedbackReport,
  AudioAnalysisRequest as MixAnalysisRequest,
} from "./analysis-types";

// =============================================================================
// Configuration Thresholds
// =============================================================================

const THRESHOLDS = {
  // Clipping and distortion
  CLIPPING_THRESHOLD: true,

  // Peak levels
  TRUE_PEAK_WARNING: -1.0, // Warning if above this
  TRUE_PEAK_CRITICAL: -0.5,

  // Loudness targets
  LUFS_TARGET_STREAMING: -14,
  LUFS_TARGET_BROADCAST: -23,
  LUFS_TARGET_YOUTUBE: -14,

  // Dynamic range
  DYNAMIC_RANGE_LOW: 6, // Compressed
  DYNAMIC_RANGE_MEDIUM: 10, // Moderate
  DYNAMIC_RANGE_HIGH: 14, // Dynamic

  // Phase correlation
  PHASE_CORRELATION_LOW: 0.3, // Warning threshold
  PHASE_CORRELATION_MONO: 0, // Mono compatibility issue

  // Stereo width
  STEREO_WIDTH_NARROW: 20,
  STEREO_WIDTH_WIDE: 80,

  // Spectral balance ratios (relative to mid)
  BASS_EXCESSIVE_RATIO: 4.0, // bass/mid ratio
  HIGH_EXCESSIVE_RATIO: 2.5, // high/mid ratio
  SILENCE_THRESHOLD: 10, // Percentage threshold

  // DC offset
  DC_OFFSET_WARNING: 0.01,
} as const;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Safe number getter with default fallback.
 */
function safeNumber(value: number | undefined, defaultValue: number): number {
  return value !== undefined && value !== null ? value : defaultValue;
}

/**
 * Get frequency balance assessment based on spectral balance ratios.
 */
function assessFrequencyBalance(metrics: AudioTechnicalMetrics): {
  overall: MixFeedbackReport["frequencyBalance"]["overallAssessment"];
  bass: MixFeedbackReport["frequencyBalance"]["bassEnergy"];
  mid: MixFeedbackReport["frequencyBalance"]["midClarity"];
  high: MixFeedbackReport["frequencyBalance"]["highExtension"];
  gauge: MixFeedbackReport["frequencyBalance"]["frequencyGauge"];
} {
  const balance = metrics.spectralBalance;

  // If no spectral balance data, return neutral assessment
  if (!balance) {
    return {
      overall: "balanced",
      bass: "present",
      mid: "clear",
      high: "air",
      gauge: { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 },
    };
  }

  // Calculate ratios relative to mid
  const bassRatio = balance.mid > 0 ? balance.bass / balance.mid : 1;
  const highRatio = balance.mid > 0 ? balance.high / balance.mid : 1;

  // Determine bass energy
  let bass: MixFeedbackReport["frequencyBalance"]["bassEnergy"] = "present";
  if (bassRatio < 0.5) {
    bass = "weak";
  } else if (bassRatio > THRESHOLDS.BASS_EXCESSIVE_RATIO) {
    bass = "excessive";
  }

  // Determine mid clarity
  let mid: MixFeedbackReport["frequencyBalance"]["midClarity"] = "clear";
  if (balance.lowMid > balance.mid * 1.5) {
    mid = "muffled";
  } else if (balance.lowMid < balance.mid * 0.5) {
    mid = "thin";
  }

  // Determine high extension
  let high: MixFeedbackReport["frequencyBalance"]["highExtension"] = "sparkle";
  if (highRatio < 0.5) {
    high = "dull";
  } else if (highRatio > THRESHOLDS.HIGH_EXCESSIVE_RATIO) {
    high = "harsh";
  }

  // Overall assessment
  let overall: MixFeedbackReport["frequencyBalance"]["overallAssessment"] = "balanced";
  if (bass === "excessive" || mid === "muffled") {
    overall = "muddy";
  } else if (bass === "excessive") {
    overall = "boomy";
  } else if (bass === "weak") {
    overall = "thin";
  } else if (high === "harsh") {
    overall = "harsh";
  } else if (high === "dull") {
    overall = "dull";
  }

  // Build frequency gauge (relative to mid = 0)
  const gauge = {
    sub: Math.max(-10, Math.min(10, Math.round((balance.sub - balance.mid) / 2))),
    bass: Math.max(-10, Math.min(10, Math.round((balance.bass - balance.mid)))),
    lowMid: Math.max(-10, Math.min(10, Math.round((balance.lowMid - balance.mid)))),
    mid: 0,
    highMid: Math.max(-10, Math.min(10, Math.round((balance.highMid - balance.mid)))),
    high: Math.max(-10, Math.min(10, Math.round((balance.high - balance.mid)))),
  };

  return { overall, bass, mid, high, gauge };
}

/**
 * Analyze dynamics characteristics.
 */
function analyzeDynamics(
  metrics: AudioTechnicalMetrics
): Pick<MixFeedbackReport["dynamics"], "overallAssessment" | "compressionAmount" | "punch" | "sustain"> {
  const dr = safeNumber(metrics.dynamicRange, THRESHOLDS.DYNAMIC_RANGE_MEDIUM);
  const crest = safeNumber(metrics.crestFactor, 10);
  const clipping = metrics.clippingDetected || false;

  // Overall assessment based on dynamic range
  let overallAssessment: MixFeedbackReport["dynamics"]["overallAssessment"] = "dynamic";
  let compressionAmount: MixFeedbackReport["dynamics"]["compressionAmount"] = "none";
  let punch: MixFeedbackReport["dynamics"]["punch"] = "preserved";

  if (dr < THRESHOLDS.DYNAMIC_RANGE_LOW || clipping) {
    overallAssessment = "crushed";
    compressionAmount = "heavy";
    punch = "killed";
  } else if (dr < THRESHOLDS.DYNAMIC_RANGE_MEDIUM) {
    overallAssessment = "moderate";
    compressionAmount = "moderate";
    punch = "reduced";
  } else if (dr < THRESHOLDS.DYNAMIC_RANGE_HIGH) {
    overallAssessment = "moderate";
    compressionAmount = "light";
    punch = "preserved";
  } else {
    overallAssessment = "dynamic";
    compressionAmount = "none";
    punch = "preserved";
  }

  // Adjust punch based on crest factor
  if (crest < 8) {
    punch = "killed";
  } else if (crest < 12) {
    punch = "reduced";
  }

  // Sustain assessment
  const sustain: MixFeedbackReport["dynamics"]["sustain"] =
    overallAssessment === "crushed" ? "sustained" : "natural";

  return { overallAssessment, compressionAmount, punch, sustain };
}

/**
 * Analyze stereo and phase characteristics.
 */
function analyzeStereoImage(metrics: AudioTechnicalMetrics): {
  stereoImage: MixFeedbackReport["stereoImage"];
  phaseAnalysis: { monoCompatibility: string; phaseIssues: boolean };
} {
  const stereoWidth = safeNumber(metrics.stereoWidth, 50);
  const phaseCorrelation = safeNumber(metrics.phaseCorrelation, 0.7);
  const isStereo = safeNumber(metrics.channels, 2) > 1;

  // Stereo width assessment
  let stereoOverall: MixFeedbackReport["stereoImage"]["overallAssessment"] = "moderate";
  let stereoWidthDisplay = stereoWidth;

  if (stereoWidth < THRESHOLDS.STEREO_WIDTH_NARROW) {
    stereoOverall = "narrow";
  } else if (stereoWidth > THRESHOLDS.STEREO_WIDTH_WIDE) {
    stereoOverall = "wide";
  } else {
    stereoOverall = "moderate";
  }

  // Center image stability
  const centerImage: MixFeedbackReport["stereoImage"]["centerImageStability"] =
    stereoWidth < 10 ? "stable" : "wandering";

  // Panning balance (default to balanced without specific panning data)
  const panning: MixFeedbackReport["stereoImage"]["panningBalance"] = "balanced";

  // Stereo tools (placeholder - would need actual processing detection)
  const stereoTools: string[] = [];

  // Phase analysis
  let phaseIssues = false;
  let monoCompatibility = "good";

  if (!isStereo) {
    monoCompatibility = "n/a (mono track)";
  } else if (phaseCorrelation < THRESHOLDS.PHASE_CORRELATION_LOW) {
    monoCompatibility = "poor - will collapse to thin mono";
    phaseIssues = true;
  } else if (phaseCorrelation < 0) {
    monoCompatibility = "concerning - phase cancellation likely";
    phaseIssues = true;
  } else if (phaseCorrelation > 0.95) {
    monoCompatibility = "excellent - very mono compatible";
  } else {
    monoCompatibility = "good";
  }

  return {
    stereoImage: {
      overallAssessment: stereoOverall,
      width: stereoWidthDisplay,
      centerImageStability: centerImage,
      panningBalance: panning,
      stereoToolsUsed: stereoTools,
    },
    phaseAnalysis: { monoCompatibility, phaseIssues },
  };
}

/**
 * Analyze low end characteristics.
 */
function analyzeLowEnd(metrics: AudioTechnicalMetrics): MixFeedbackReport["lowEnd"] {
  const balance = metrics.spectralBalance;

  // Default values if no spectral data
  let subBass: MixFeedbackReport["lowEnd"]["subBass"] = "controlled";
  let bassClarity: MixFeedbackReport["lowEnd"]["bassClarity"] = "defined";
  let overall: MixFeedbackReport["lowEnd"]["overallAssessment"] = "clean";
  let kickDrum: MixFeedbackReport["lowEnd"]["kickDrum"] = "tight";
  let phaseIssues = false;

  if (balance) {
    const bassRatio = balance.mid > 0 ? balance.bass / balance.mid : 1;
    const subRatio = balance.mid > 0 ? balance.sub / balance.mid : 1;

    // Bass clarity
    if (bassRatio > THRESHOLDS.BASS_EXCESSIVE_RATIO) {
      bassClarity = "muddy";
      overall = "muddy";
    } else if (bassRatio < 0.5) {
      bassClarity = "indistinct";
      overall = "weak";
    }

    // Sub bass control
    if (subRatio > 3) {
      subBass = "uncontrolled";
      overall = "boomy";
    } else if (subRatio < 0.3) {
      subBass = "absent";
      overall = "weak";
    }

    // Kick drum estimation
    if (metrics.clippingDetected) {
      kickDrum = "crushed";
    } else if (bassRatio > 2) {
      kickDrum = "loose";
    }
  }

  // Check for phase issues in low end
  if (metrics.phaseCorrelation !== undefined && metrics.phaseCorrelation < 0.2) {
    phaseIssues = true;
    overall = "boomy+weak";
  }

  return {
    overallAssessment: overall,
    subBass,
    kickDrum,
    bassClarity,
    phaseIssues,
  };
}

/**
 * Analyze transient response.
 */
function analyzeTransients(metrics: AudioTechnicalMetrics): MixFeedbackReport["transients"] {
  const dr = safeNumber(metrics.dynamicRange, 10);
  const clipping = metrics.clippingDetected || false;
  const density = safeNumber(metrics.onsetDensity, 5);

  let overall: MixFeedbackReport["transients"]["overallAssessment"] = "punchy";
  let kickAttack: MixFeedbackReport["transients"]["kickAttack"] = "present";
  let snareAttack: MixFeedbackReport["transients"]["snareAttack"] = "present";
  let percussiveElements: MixFeedbackReport["transients"]["percussiveElements"] = "preserved";

  if (clipping) {
    overall = "crushed";
    kickAttack = "reduced";
    snareAttack = "absent";
    percussiveElements = "compressed";
  } else if (dr < THRESHOLDS.DYNAMIC_RANGE_LOW) {
    overall = "controlled";
    kickAttack = "reduced";
    snareAttack = "reduced";
    percussiveElements = "compressed";
  } else if (density > 15) {
    // Very dense rhythmic content
    overall = "controlled";
    percussiveElements = "compressed";
  }

  // Transient shaping tools
  const transientShaping: string[] = [];
  if (overall === "punchy") {
    transientShaping.push("fast attack/release compression");
  } else if (overall === "controlled") {
    transientShaping.push("slower attack compression");
  }

  return {
    overallAssessment: overall,
    kickAttack,
    snareAttack,
    percussiveElements,
    transientShaping,
  };
}

/**
 * Analyze noise and artifacts.
 */
function analyzeNoiseArtifacts(
  metrics: AudioTechnicalMetrics
): MixFeedbackReport["noiseArtifacts"] {
  const dcOffset = safeNumber(metrics.dcOffset, 0);

  let hasNoise = false;
  let noiseType: MixFeedbackReport["noiseArtifacts"]["noiseType"] = "none";
  let noiseLevel: MixFeedbackReport["noiseArtifacts"]["noiseLevel"] = "inaudible";
  let quantizationIssues = false;
  let ditheringApplied = false;

  // DC offset check
  if (Math.abs(dcOffset) > THRESHOLDS.DC_OFFSET_WARNING) {
    hasNoise = true;
    noiseType = "circuit noise";
    noiseLevel = "moderate";
  }

  return {
    hasNoise,
    noiseType,
    noiseLevel,
    quantizationIssues,
    ditheringApplied,
  };
}

// =============================================================================
// Main Analysis Function
// =============================================================================

/**
 * Generate a comprehensive mixdown feedback report.
 *
 * @param metrics - Audio technical measurements from analysis
 * @param request - Original analysis request for context
 * @returns MixFeedbackReport with actionable recommendations
 */
export function generateMixFeedbackReport(
  metrics: AudioTechnicalMetrics,
  request: AudioAnalysisRequest
): MixFeedbackReport {
  // Assess various characteristics
  const freqBalance = assessFrequencyBalance(metrics);
  const dynamics = analyzeDynamics(metrics);
  const { stereoImage, phaseAnalysis } = analyzeStereoImage(metrics);
  const lowEnd = analyzeLowEnd(metrics);
  const transients = analyzeTransients(metrics);
  const noise = analyzeNoiseArtifacts(metrics);

  // Extract loudness data
  const lufs = metrics.integratedLufs;
  const truePeak = metrics.truePeakDbtp;
  const peak = metrics.peakDbfs;

  // Determine loudness status
  const loudnessStatus = lufs !== undefined ? "measured" : "unknown";
  const loudnessLufs = lufs ?? -18; // Default estimate
  const targetLufs = request.analysisType === "mastering" ? -14 : -23;

  // Build strengths list
  const strengths: string[] = [];
  if (dynamics.overallAssessment === "dynamic") {
    strengths.push("Good dynamic range preserved");
  }
  if (freqBalance.overall === "balanced") {
    strengths.push("Frequency balance is neutral");
  }
  if (phaseAnalysis.monoCompatibility === "good" || phaseAnalysis.monoCompatibility === "excellent") {
    strengths.push("Mono compatibility is strong");
  }
  if (transients.overallAssessment === "punchy") {
    strengths.push("Transients are well-preserved");
  }
  if (lufs !== undefined && Math.abs(lufs - targetLufs) < 3) {
    strengths.push("Loudness is within acceptable range");
  }

  // Build issues list with priorities
  const issues: string[] = [];
  const prioritizedFixes: MixFeedbackReport["prioritizedFixes"] = [];

  // Priority 1: Clipping detection
  if (metrics.clippingDetected) {
    issues.push("Clipping/distortion detected in the audio");
    prioritizedFixes.push({
      priority: "critical",
      issue: "Clipping detected",
      recommendation: "Reduce overall gain by 1-3 dB and check peak levels",
      estimatedImpact: "Prevent digital distortion and improve transparancy",
    });
  }

  // Priority 2: True peak issues
  if (truePeak !== undefined && truePeak > THRESHOLDS.TRUE_PEAK_CRITICAL) {
    issues.push(`True peak at ${truePeak.toFixed(1)} dBTP exceeds critical threshold`);
    prioritizedFixes.push({
      priority: "critical",
      issue: "True peak too high",
      recommendation: `Reduce gain by ${((truePeak - THRESHOLDS.TRUE_PEAK_WARNING) + 0.5).toFixed(1)} dB to achieve safe -1 dBTP`,
      estimatedImpact: "Prevent inter-sample clipping in streaming/delivery",
    });
  } else if (truePeak !== undefined && truePeak > THRESHOLDS.TRUE_PEAK_WARNING) {
    issues.push(`True peak at ${truePeak.toFixed(1)} dBTP may cause streaming issues`);
    prioritizedFixes.push({
      priority: "high",
      issue: "True peak approaching limit",
      recommendation: `Reduce gain by ${(truePeak - THRESHOLDS.TRUE_PEAK_WARNING + 0.3).toFixed(1)} dB`,
      estimatedImpact: "Ensure compatibility with all streaming platforms",
    });
  }

  // Priority 3: Loudness issues
  if (lufs === undefined) {
    issues.push("Loudness could not be measured - integrate LUFS measurement");
    prioritizedFixes.push({
      priority: "high",
      issue: "Missing loudness measurement",
      recommendation: "Use a true RMS meter or LUFS meter to measure integrated loudness",
      estimatedImpact: "Enable proper loudness normalization during delivery",
    });
  } else if (Math.abs(lufs - targetLufs) > 5) {
    const diff = Math.abs(lufs - targetLufs);
    issues.push(`Loudness is ${lufs.toFixed(1)} LUFS, target is ${targetLufs} LUFS`);
    prioritizedFixes.push({
      priority: "medium",
      issue: "Loudness mismatch",
      recommendation: `Adjust gain by ${lufs > targetLufs ? "-" : "+"}${diff.toFixed(1)} dB`,
      estimatedImpact: "Match loudness standards for target platform",
    });
  }

  // Priority 4: Phase issues
  if (phaseAnalysis.phaseIssues) {
    issues.push("Phase correlation issues detected - may collapse poorly to mono");
    prioritizedFixes.push({
      priority: "high",
      issue: "Phase issues in stereo image",
      recommendation: "Check for phase cancellation, try mono compatibility check",
      estimatedImpact: "Ensure mix translates correctly to mono playback systems",
    });
  }

  // Priority 5: Low end issues
  if (lowEnd.overallAssessment === "muddy") {
    issues.push("Muddy low end - excessive bass/mid confusion");
    prioritizedFixes.push({
      priority: "medium",
      issue: "Muddy low end",
      recommendation: "Apply high-pass filter below 80-100 Hz and carve 150-250 Hz range",
      estimatedImpact: "Improve clarity and prevent masking of mid instruments",
    });
  } else if (lowEnd.overallAssessment === "boomy") {
    issues.push("Boomy low end - excessive sub/bass energy");
    prioritizedFixes.push({
      priority: "medium",
      issue: "Boomy low end",
      recommendation: "Apply low-shelf cut at 100-150 Hz and check sub bass levels",
      estimatedImpact: "Clean up bottom end and improve translation",
    });
  }

  // Priority 6: Stereo width issues
  if (stereoImage.overallAssessment === "narrow") {
    issues.push("Stereo width is too narrow - lacks spatial engagement");
    prioritizedFixes.push({
      priority: "low",
      issue: "Narrow stereo image",
      recommendation: "Apply stereo Widener or Mid-side EQ to enhance width",
      estimatedImpact: "More immersive listening experience",
    });
  } else if (stereoImage.overallAssessment === "wide") {
    issues.push("Stereo width may be excessive - check translation");
    prioritizedFixes.push({
      priority: "low",
      issue: "Excessive stereo width",
      recommendation: "Check mono compatibility, consider reducing high-frequency width",
      estimatedImpact: "Better translation to mono and small speakers",
    });
  }

  // Priority 7: High frequency issues
  if (freqBalance.high === "harsh") {
    issues.push("High frequencies appear excessive - may cause listener fatigue");
    prioritizedFixes.push({
      priority: "medium",
      issue: "Harsh high frequencies",
      recommendation: "Apply gentle cut at 5-8 kHz or use de-essing",
      estimatedImpact: "Smoother listening experience",
    });
  }

  // Priority 8: Dynamic range issues
  if (dynamics.overallAssessment === "crushed") {
    issues.push("Dynamic range is very low - over-compressed");
    prioritizedFixes.push({
      priority: "high",
      issue: "Over-compression",
      recommendation: "Reduce compression ratio, increase threshold, or use parallel compression",
      estimatedImpact: "More natural dynamics and punch",
    });
  }

  // Priority 9: Silence at start/end
  if (metrics.silencePercent !== undefined && metrics.silencePercent > THRESHOLDS.SILENCE_THRESHOLD) {
    issues.push(`High silence percentage (${metrics.silencePercent.toFixed(0)}%) detected`);
    prioritizedFixes.push({
      priority: "low",
      issue: "Silence at start/end",
      recommendation: "Check for unnecessary silence - trim or apply fade in/out",
      estimatedImpact: "Professional presentation",
    });
  }

  // Build frequency balance section
  const frequencyBalance = {
    overallAssessment: freqBalance.overall,
    bassEnergy: freqBalance.bass,
    midClarity: freqBalance.mid,
    highExtension: freqBalance.high,
    frequencyGauge: freqBalance.gauge,
  };

  // Build dynamics section
  const dynamicsSection: MixFeedbackReport["dynamics"] = {
    overallAssessment: dynamics.overallAssessment,
    compressionAmount: dynamics.compressionAmount,
    punch: dynamics.punch,
    sustain: dynamics.sustain,
    loudnessLufs: loudnessLufs,
  };

  // Build stereo image section
  const stereoImageSection = stereoImage;

  // Build depth and space section
  const depthAndSpace: MixFeedbackReport["depthAndSpace"] = {
    overallAssessment: lufs !== undefined && lufs < -18 ? "moderate" : "shallow",
    frontElements: ["vocals", "lead instruments"],
    middleElements: [],
    backElements: ["ambient elements", "reverb tails"],
    reverbAmount: "moderate",
    senseOfSpace: "Controlled stereo width suggests intentional space management",
  };

  // Build vocal/lead presence section
  const vocalOrLeadPresence: MixFeedbackReport["vocalOrLeadPresence"] = {
    overallAssessment: dynamics.overallAssessment === "crushed" ? "overwhelming" : "present",
    intelligibility: freqBalance.mid === "clear" ? "good" : "fair",
    emotionPreservation: "preserved",
    processingApplied: [],
  };

  // Build low end section
  const lowEndSection = lowEnd;

  // Build transients section
  const transientsSection = transients;

  // Build noise artifacts section
  const noiseArtifacts = noise;

  // Build translation risks
  const translationRisks: string[] = [];
  if (stereoImage.overallAssessment === "narrow") {
    translationRisks.push("May sound thin on mono playback");
  }
  if (stereoImage.overallAssessment === "wide") {
    translationRisks.push("May collapse or sound phased on mono systems");
  }
  if (phaseAnalysis.monoCompatibility === "poor") {
    translationRisks.push("Phase issues will cause significant mono collapse");
  }
  if (lowEnd.overallAssessment === "boomy") {
    translationRisks.push("Low end may sound different on various systems");
  }
  if (translationRisks.length === 0) {
    translationRisks.push("No major translation concerns detected");
  }

  // Build suggested plugins
  const suggestedPluginsOrProcesses: MixFeedbackReport["suggestedPluginsOrProcesses"] = [];

  // Add EQ suggestions based on analysis
  if (freqBalance.bass === "excessive" || lowEndSection.overallAssessment === "boomy") {
    suggestedPluginsOrProcesses.push({
      purpose: "Low-shelf cut to reduce boominess",
      type: "eq_shelving",
      suggestedChain: ["Low-shelf cut at 120 Hz, Q 0.7, -3dB"],
    });
  }
  if (freqBalance.high === "harsh") {
    suggestedPluginsOrProcesses.push({
      purpose: "De-essing and high-frequency smoothing",
      type: "eq_parametric",
      suggestedChain: ["Peaking cut at 6 kHz, Q 1.5, -2dB", "Then gentle high-shelf at 10 kHz, -1dB"],
    });
  }
  if (transients.punch === "reduced" || dynamics.overallAssessment === "moderate") {
    suggestedPluginsOrProcesses.push({
      purpose: "Transient enhancement",
      type: "envelope_attack",
      suggestedChain: ["Fast attack compression (10ms) for control", "Parallel compression (2:1 ratio) for punch"],
    });
  }
  if (stereoImageSection.overallAssessment === "narrow") {
    suggestedPluginsOrProcesses.push({
      purpose: "Stereo widening",
      type: "stereo_width",
      suggestedChain: ["Mid-side EQ to reduce mono content in low end", "Stereo imager on highs only"],
    });
  }

  // Add generic EQ chain if frequency balance issues
  if (frequencyBalance.overallAssessment !== "balanced") {
    suggestedPluginsOrProcesses.push({
      purpose: "Overall frequency balancing",
      type: "eq_graphic",
      suggestedChain: [
        "Sub 80 Hz: High-pass filter",
        "150-250 Hz: Reduce if muddy",
        "2-5 kHz: Attenuate if harsh",
        "8-12 kHz: Boost if dull",
      ],
    });
  }

  // Build confidence score based on available metrics
  let confidence = 0.5;
  const metricCount = Object.keys(metrics).filter((k) => (metrics as any)[k] !== undefined).length;
  const totalPotentialMetrics = 25; // Approximate count of measurable metrics
  confidence = Math.min(0.95, 0.4 + (metricCount / totalPotentialMetrics) * 0.5);

  // Generate executive summary
  const summary = generateExecutiveSummary(
    metrics,
    frequencyBalance,
    dynamicsSection,
    stereoImageSection,
    phaseAnalysis,
    loudnessStatus,
    translationRisks
  );

  return {
    summary,
    strengths,
    issues,
    frequencyBalance,
    dynamics: dynamicsSection,
    stereoImage: stereoImageSection,
    depthAndSpace,
    vocalOrLeadPresence,
    lowEnd: lowEndSection,
    transients: transientsSection,
    noiseArtifacts,
    translationRisks,
    prioritizedFixes,
    suggestedPluginsOrProcesses,
    referenceComparison: undefined,
    confidence: Math.round(confidence * 100) / 100,
  };
}

/**
 * Generate the executive summary based on analysis results.
 */
function generateExecutiveSummary(
  metrics: AudioTechnicalMetrics,
  freqBalance: MixFeedbackReport["frequencyBalance"],
  dynamics: MixFeedbackReport["dynamics"],
  stereoImage: MixFeedbackReport["stereoImage"],
  phaseAnalysis: { monoCompatibility: string; phaseIssues: boolean },
  loudnessStatus: string,
  translationRisks: string[]
): string {
  const parts: string[] = [];

  // Overall impression
  const qualityRating =
    dynamics.overallAssessment === "crushed" ||
    freqBalance.overallAssessment === "muddy" ||
    stereoImage.overallAssessment === "narrow"
      ? "needs work"
      : "meets professional standards";

  parts.push(`Overall Assessment: This mix ${qualityRating} with ${freqBalance.overallAssessment} frequency balance and ${dynamics.overallAssessment} dynamics.`);

  // Loudness
  if (loudnessStatus === "measured") {
    const lufs = metrics.integratedLufs;
    if (lufs !== undefined) {
      parts.push(`Loudness measures ${lufs.toFixed(1)} LUFS. ${lufs > -12 ? "Loudness war characteristics detected." : "Loudness is within acceptable range."}`);
    }
  } else {
    parts.push("Loudness could not be measured automatically.");
  }

  // Phase and mono compatibility
  if (phaseAnalysis.phaseIssues) {
    parts.push(`Mono compatibility: ${phaseAnalysis.monoCompatibility}. Warning: phase issues detected.`);
  } else if (stereoImage.overallAssessment === "wide") {
    parts.push(`Stereo width: ${stereoImage.width.toFixed(0)}%. Wider stereo image detected.`);
  } else {
    parts.push(`Mono compatibility: ${phaseAnalysis.monoCompatibility}.`);
  }

  // Translation risks
  if (translationRisks.length > 0) {
    const riskSummary = translationRisks.slice(0, 3).join(" | ");
    parts.push(`Translation risks: ${riskSummary}`);
  }

  // Key strengths
  const strengthCount = 3;
  if (freqBalance.overallAssessment === "balanced") {
    parts.push("Strength: Good frequency balance throughout the spectrum.");
  }

  return parts.join(" ");
}
