/**
 * Mastering Preflight Engine
 *
 * Comprehensive release readiness check for mastered audio.
 * Validates technical requirements for streaming, physical media, and broadcast.
 */

import {
  AudioTechnicalMetrics,
  AudioAnalysisRequest,
  MasteringFeedbackReport,
} from "./analysis-types";

// =============================================================================
// Mastering Standards and Targets
// =============================================================================

const MASTERING_STANDARDS = {
  // Streaming platform targets
  STREAMING_TARGET_LUFS: -14, // Industry standard for streaming
  STREAMING_PEAK_LIMIT: -1.0, // True peak limit for streaming

  // Broadcast standards
  BROADCAST_TARGET_LUFS: -23, // EBU R128 / ATSC A/85
  BROADCAST_PEAK_LIMIT: -2.0,

  // Physical media
  CD_PEAK_LIMIT: -0.3,
  VINYL_PEAK_LIMIT: -3.0,

  // Dynamic range thresholds
  DR_MINIMUM: 6, // Below this is over-compressed
  DR_GOOD: 8, // Good dynamic range
  DR_EXCELLENT: 12, // Excellent dynamic range

  // Phase correlation
  PHASE_MINIMUM: 0.7, // Below this has mono compatibility issues
  PHASE_GOOD: 0.85,

  // Silence detection
  SILENCE_THRESHOLD: 5, // % of track that's silence

  // DC offset
  DC_OFFSET_LIMIT: 0.01,
} as const;

// Streaming platform specifications
const STREAMING_SPECS = {
  spotify: {
    targetLufs: -14,
    normalization: true,
    maxTruePeak: -1.0,
  },
  appleMusic: {
    targetLufs: -16,
    normalization: true,
    maxTruePeak: -1.0,
  },
  youtube: {
    targetLufs: -13,
    normalization: true,
    maxTruePeak: -1.0,
  },
  soundcloud: {
    targetLufs: -14,
    normalization: true,
    maxTruePeak: -1.0,
  },
  bandcamp: {
    targetLufs: -14,
    normalization: false,
    maxTruePeak: -0.3,
  },
} as const;

// =============================================================================
// Helper Functions
// =============================================================================

function formatLufs(lufs: number): string {
  return `${lufs.toFixed(1)} LUFS`;
}

function formatDbtp(dbtp: number): string {
  return `${dbtp.toFixed(1)} dBTP`;
}

function formatDb(db: number): string {
  return `${db.toFixed(1)} dB`;
}

// =============================================================================
// Analysis Functions
// =============================================================================

interface MasteringContext {
  metrics: Partial<AudioTechnicalMetrics>;
  request: AudioAnalysisRequest;
}

/**
 * Determine overall release readiness
 */
function assessReleaseReadiness(
  ctx: MasteringContext,
  issues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }>
): MasteringFeedbackReport["releaseReadiness"] {
  const criticalIssues = issues.filter((i) => i.severity === "critical");
  const highIssues = issues.filter((i) => i.severity === "high");

  if (criticalIssues.length > 0) {
    return "not_ready";
  }

  if (highIssues.length > 2) {
    return "needs_work";
  }

  if (highIssues.length > 0) {
    return "nearly_ready";
  }

  return "ready";
}

/**
 * Analyze loudness characteristics
 */
function analyzeLoudness(ctx: MasteringContext): {
  loudness: MasteringFeedbackReport["loudness"];
  issues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }>;
} {
  const issues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }> = [];
  const { integratedLufs, dynamicRange } = ctx.metrics;

  // Default values
  let currentLufs = integratedLufs ?? 0;
  let targetLufs = MASTERING_STANDARDS.STREAMING_TARGET_LUFS;
  let loudnessRange = 0;
  let luRange = "unknown";
  let streamingNormalization: MasteringFeedbackReport["loudness"]["streamingNormalization"] = "already_normalized";
  let loudnessWarStatus: MasteringFeedbackReport["loudness"]["loudnessWarStatus"] = "moderate";

  // If LUFS is missing, explain but don't fail
  if (integratedLufs === undefined) {
    issues.push({
      severity: "medium",
      message:
        "Integrated LUFS measurement unavailable - loudness analysis requires backend audio processing support. This is informational only and does not prevent release.",
    });

    loudnessWarStatus = "moderate";
    streamingNormalization = "already_normalized";
  } else {
    currentLufs = integratedLufs;

    // Determine streaming normalization status
    const lufsDeviation = Math.abs(currentLufs - MASTERING_STANDARDS.STREAMING_TARGET_LUFS);
    if (lufsDeviation < 1) {
      streamingNormalization = "already_normalized";
    } else if (currentLufs > MASTERING_STANDARDS.STREAMING_TARGET_LUFS) {
      streamingNormalization = "needs_reduction";
      issues.push({
        severity: "low",
        message: `Master is ${(currentLufs - MASTERING_STANDARDS.STREAMING_TARGET_LUFS).toFixed(1)}dB louder than streaming target - platforms will apply gain reduction`,
      });
    } else {
      streamingNormalization = "will_gain_match";
      issues.push({
        severity: "low",
        message: `Master is ${(MASTERING_STANDARDS.STREAMING_TARGET_LUFS - currentLufs).toFixed(1)}dB quieter than streaming target - platforms will apply makeup gain`,
      });
    }

    // Assess loudness war status based on loudness and dynamics
    if (dynamicRange !== undefined) {
      if (currentLufs > -8 && dynamicRange < 6) {
        loudnessWarStatus = "brick-walled";
        issues.push({
          severity: "high",
          message: "Extremely loud master with minimal dynamics - may cause listening fatigue",
        });
      } else if (currentLufs > -10 && dynamicRange < 7) {
        loudnessWarStatus = "over-compressed";
        issues.push({
          severity: "medium",
          message: "Very loud master with limited dynamics - consider preserving more dynamic range",
        });
      } else if (dynamicRange > 12) {
        loudnessWarStatus = "dynamic";
      }
    }
  }

  // Loudness range (LRA)
  if (dynamicRange !== undefined) {
    loudnessRange = dynamicRange;
    if (dynamicRange < 3) {
      luRange = "0-3 (extremely compressed)";
    } else if (dynamicRange < 6) {
      luRange = "3-6 (heavily compressed)";
    } else if (dynamicRange < 10) {
      luRange = "6-10 (moderate dynamics)";
    } else {
      luRange = "10+ (dynamic)";
    }
  }

  return {
    loudness: {
      currentLufs,
      targetLufs,
      loudnessRange,
      luRange,
      streamingNormalization,
      loudnessWarStatus,
    },
    issues,
  };
}

/**
 * Analyze true peak levels
 */
function analyzeTruePeak(ctx: MasteringContext): {
  truePeak: MasteringFeedbackReport["truePeak"];
  issues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }>;
} {
  const issues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }> = [];
  const { truePeakDbtp, peakDbfs } = ctx.metrics;

  const maxAllowedDbtp = MASTERING_STANDARDS.STREAMING_PEAK_LIMIT;
  let measuredDbtp = truePeakDbtp ?? (peakDbfs ? peakDbfs + 0.5 : -1.0);
  let headroom = maxAllowedDbtp - measuredDbtp;
  let interSamplePeak = false;
  let interSamplePeakLevel: number | undefined;

  if (truePeakDbtp === undefined) {
    issues.push({
      severity: "medium",
      message: "True peak measurement unavailable - recommend measuring with true peak limiter before export",
    });
  } else {
    measuredDbtp = truePeakDbtp;
    headroom = maxAllowedDbtp - measuredDbtp;

    // Check for intersample peaks
    if (truePeakDbtp > -0.1) {
      interSamplePeak = true;
      interSamplePeakLevel = truePeakDbtp;
      issues.push({
        severity: "critical",
        message: `True peak at ${formatDbtp(truePeakDbtp)} will cause intersample clipping on DACs - immediate fix required`,
      });
    } else if (truePeakDbtp > maxAllowedDbtp) {
      interSamplePeak = true;
      interSamplePeakLevel = truePeakDbtp;
      issues.push({
        severity: "high",
        message: `True peak at ${formatDbtp(truePeakDbtp)} exceeds ${formatDbtp(maxAllowedDbtp)} limit - may distort on lossy codecs`,
      });
    }
  }

  return {
    truePeak: {
      measuredDbtp,
      maxAllowedDbtp,
      headroom,
      interSamplePeak,
      interSamplePeakLevel,
    },
    issues,
  };
}

/**
 * Analyze dynamics and compression
 */
function analyzeDynamics(ctx: MasteringContext): {
  dynamics: MasteringFeedbackReport["dynamics"];
  issues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }>;
} {
  const issues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }> = [];
  const { dynamicRange, integratedLufs } = ctx.metrics;

  let drValue = dynamicRange ?? MASTERING_STANDARDS.DR_GOOD;
  let compressorsUsed: string[] = [];
  let limitingCycles = 0;
  let punchRetained = true;
  let loudnessVersusDynamicRange: MasteringFeedbackReport["dynamics"]["loudnessVersusDynamicRange"] = "moderate";

  if (dynamicRange === undefined) {
    issues.push({
      severity: "low",
      message: "Dynamic range measurement unavailable - cannot assess compression level",
    });
  } else {
    drValue = dynamicRange;

    // Assess dynamic range
    if (dynamicRange < MASTERING_STANDARDS.DR_MINIMUM) {
      punchRetained = false;
      issues.push({
        severity: "high",
        message: `Dynamic range of ${formatDb(dynamicRange)} is severely limited - may cause listening fatigue`,
      });
    } else if (dynamicRange < MASTERING_STANDARDS.DR_GOOD) {
      issues.push({
        severity: "medium",
        message: `Dynamic range of ${formatDb(dynamicRange)} is lower than recommended - consider reducing limiting`,
      });
    }

    // Assess loudness vs dynamic range relationship
    if (integratedLufs !== undefined) {
      if (integratedLufs > -8 && dynamicRange < 6) {
        loudnessVersusDynamicRange = "loud_and_compressed";
        issues.push({
          severity: "high",
          message: "Extremely loud master with minimal dynamics - classic loudness war characteristics",
        });
      } else if (integratedLufs < -16 && dynamicRange > 12) {
        loudnessVersusDynamicRange = "dynamic";
      }
    }
  }

  return {
    dynamics: {
      dynamicRange: drValue,
      compressorsUsed,
      limitingCycles,
      punchRetained,
      loudnessVersusDynamicRange,
    },
    issues,
  };
}

/**
 * Analyze tonal balance
 */
function analyzeTonalBalance(ctx: MasteringContext): {
  tonalBalance: MasteringFeedbackReport["tonalBalance"];
  issues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }>;
} {
  const issues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }> = [];
  const { spectralBalance } = ctx.metrics;

  let overallAssessment: MasteringFeedbackReport["tonalBalance"]["overallAssessment"] = "balanced";
  let bass = 0;
  let midrange = 0;
  let treble = 0;
  let consistency: MasteringFeedbackReport["tonalBalance"]["consistency"] = "consistent";

  if (!spectralBalance) {
    issues.push({
      severity: "low",
      message: "Spectral analysis unavailable - cannot assess tonal balance",
    });
    return {
      tonalBalance: {
        overallAssessment,
        bass,
        midrange,
        treble,
        consistency,
      },
      issues,
    };
  }

  // Calculate relative levels
  const reference = spectralBalance.mid;
  bass = spectralBalance.sub + spectralBalance.low - reference * 2;
  midrange = spectralBalance.lowMid + spectralBalance.mid;
  treble = spectralBalance.highMid + spectralBalance.high - reference * 2;

  // Assess bass
  if (bass > 8) {
    overallAssessment = "boomy";
    issues.push({
      severity: "medium",
      message: "Excessive bass energy - may translate poorly to small speakers and overwhelm club systems",
    });
  } else if (bass < -5) {
    overallAssessment = "thin";
    issues.push({
      severity: "medium",
      message: "Insufficient bass energy - master may sound thin",
    });
  }

  // Assess treble
  if (treble > 6) {
    overallAssessment = "bright";
    issues.push({
      severity: "low",
      message: "Elevated high frequencies - may cause sibilance or listening fatigue",
    });
  } else if (treble < -5) {
    overallAssessment = "warm";
    issues.push({
      severity: "low",
      message: "Reduced high frequencies - master may lack air and sparkle",
    });
  }

  return {
    tonalBalance: {
      overallAssessment,
      bass,
      midrange,
      treble,
      consistency,
    },
    issues,
  };
}

/**
 * Check for clipping and artifacts
 */
function checkClipping(ctx: MasteringContext): Array<{
  severity: "critical" | "high" | "medium" | "low";
  message: string;
}> {
  const issues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }> = [];
  const { clippingDetected, dcOffset } = ctx.metrics;

  if (clippingDetected === true) {
    issues.push({
      severity: "critical",
      message: "Digital clipping detected - master is not release-ready until clipping is removed",
    });
  }

  if (dcOffset !== undefined && Math.abs(dcOffset) > MASTERING_STANDARDS.DC_OFFSET_LIMIT) {
    issues.push({
      severity: "medium",
      message: `DC offset of ${dcOffset.toFixed(3)} detected - remove DC offset before final export`,
    });
  }

  return issues;
}

/**
 * Check silence at start/end
 */
function checkSilence(ctx: MasteringContext): Array<{
  severity: "critical" | "high" | "medium" | "low";
  message: string;
}> {
  const issues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }> = [];
  const { silencePercent } = ctx.metrics;

  if (silencePercent !== undefined && silencePercent > MASTERING_STANDARDS.SILENCE_THRESHOLD) {
    issues.push({
      severity: "medium",
      message: `${silencePercent.toFixed(0)}% of master is silence - trim unnecessary silence and add appropriate fades`,
    });
  }

  return issues;
}

/**
 * Check stereo/mono compatibility
 */
function checkPhaseCompatibility(ctx: MasteringContext): Array<{
  severity: "critical" | "high" | "medium" | "low";
  message: string;
}> {
  const issues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }> = [];
  const { phaseCorrelation } = ctx.metrics;

  if (phaseCorrelation === undefined) {
    issues.push({
      severity: "low",
      message: "Phase correlation measurement unavailable - recommend checking mono compatibility",
    });
    return issues;
  }

  if (phaseCorrelation < 0) {
    issues.push({
      severity: "critical",
      message: `Phase correlation of ${phaseCorrelation.toFixed(2)} indicates out-of-phase content - will cancel in mono`,
    });
  } else if (phaseCorrelation < MASTERING_STANDARDS.PHASE_MINIMUM) {
    issues.push({
      severity: "high",
      message: `Phase correlation of ${phaseCorrelation.toFixed(2)} indicates poor mono compatibility - check on mono systems`,
    });
  }

  return issues;
}

/**
 * Assess streaming platform readiness
 */
function assessStreamingReadiness(
  ctx: MasteringContext,
  loudness: MasteringFeedbackReport["loudness"],
  truePeak: MasteringFeedbackReport["truePeak"]
): MasteringFeedbackReport["streamingReadiness"] {
  const readiness: MasteringFeedbackReport["streamingReadiness"] = {
    spotify: "ready",
    appleMusic: "ready",
    youtube: "ready",
    soundcloud: "ready",
    bandcamp: "ready",
  };

  // Check each platform
  for (const [platform, specs] of Object.entries(STREAMING_SPECS)) {
    const key = platform as keyof typeof readiness;

    // Check true peak
    if (truePeak.measuredDbtp > specs.maxTruePeak) {
      readiness[key] = "needs_adjustment";
      continue;
    }

    // Check loudness
    if (ctx.metrics.integratedLufs !== undefined) {
      const deviation = Math.abs(ctx.metrics.integratedLufs - specs.targetLufs);
      if (specs.normalization && deviation > 3) {
        readiness[key] = "will_gain_match";
      }
    }
  }

  return readiness;
}

/**
 * Generate export recommendations
 */
function generateExportRecommendations(
  ctx: MasteringContext,
  truePeak: MasteringFeedbackReport["truePeak"]
): MasteringFeedbackReport["exportRecommendations"] {
  const { sampleRate, clippingDetected } = ctx.metrics;

  // Determine ideal format
  const idealFormat: "wav" | "aiff" | "flac" = "wav";

  // Bit depth recommendation
  const bitDepth: "16" | "24" | "32" = "24";

  // Sample rate recommendation
  let sampleRateRec: "44.1" | "48" | "96" | "192" | "match_source" = "match_source";
  if (sampleRate === 44100) {
    sampleRateRec = "44.1";
  } else if (sampleRate === 48000) {
    sampleRateRec = "48";
  } else if (sampleRate && sampleRate >= 96000) {
    sampleRateRec = "96";
  }

  // Dithering recommendation
  const ditherRecommended = bitDepth === "16";
  const ditherType: "noise-shaped" | "triangle" | "rectangular" = "noise-shaped";

  // Export chain
  const exportChain: string[] = [];
  if (truePeak.measuredDbtp > -1.0) {
    exportChain.push("Apply true peak limiter to -1.0 dBTP");
  }
  if (ctx.metrics.dcOffset !== undefined && Math.abs(ctx.metrics.dcOffset) > 0.01) {
    exportChain.push("Remove DC offset");
  }
  if (ditherRecommended) {
    exportChain.push(`Apply ${ditherType} dither for 16-bit export`);
  }
  exportChain.push("Export as WAV or FLAC at source sample rate");
  exportChain.push("Archive 24-bit or 32-bit float master");

  // Clipping check
  const clippingCheck: "passed" | "requires_reduction" = clippingDetected === true
    ? "requires_reduction"
    : "passed";

  return {
    idealFormat,
    bitDepth,
    sampleRate: sampleRateRec,
    ditherRecommended,
    ditherType,
    exportChain,
    clippingCheck,
  };
}

/**
 * Generate vinyl/club readiness if requested
 */
function generateVinylClubReadiness(
  ctx: MasteringContext,
  truePeak: MasteringFeedbackReport["truePeak"]
): MasteringFeedbackReport["vinylOrClubReadiness"] | undefined {
  // Only generate if specifically requested in user questions
  const needsVinylClub = ctx.request.userQuestions?.some(
    (q) => q.toLowerCase().includes("vinyl") || q.toLowerCase().includes("club")
  );

  if (!needsVinylClub) {
    return undefined;
  }

  const format: "vinyl" | "cd" | "club_dj" = "vinyl";
  const preMasterRequirements: string[] = [
    "Ensure bass is mono below 150Hz",
    "Check for excessive sibilance (de-ess if needed)",
    "Limit true peak to -3.0 dBTP for vinyl",
    "Avoid extreme stereo width in low frequencies",
  ];

  const lacquerCutSpecificNotes: string[] = [
    "Lacquer cutting requires additional headroom",
    "High frequencies may need slight reduction",
    "Very low bass may require additional filtering",
    "Consider shorter duration per side for optimal levels",
  ];

  const djEditAvailable = false;

  return {
    format,
    preMasterRequirements,
    lacquerCutSpecificNotes,
    djEditAvailable,
  };
}

// =============================================================================
// Main Export: generateMasteringFeedback
// =============================================================================

/**
 * Generate comprehensive mastering feedback report.
 * Assesses release readiness and provides prioritized fixes.
 */
export function generateMasteringFeedback(
  metrics: Partial<AudioTechnicalMetrics>,
  request: AudioAnalysisRequest
): MasteringFeedbackReport {
  const ctx: MasteringContext = { metrics, request };

  // Collect all issues
  const allIssues: Array<{ severity: "critical" | "high" | "medium" | "low"; message: string }> = [];

  // Check for critical issues first
  allIssues.push(...checkClipping(ctx));
  allIssues.push(...checkPhaseCompatibility(ctx));
  allIssues.push(...checkSilence(ctx));

  // Analyze all aspects
  const loudnessAnalysis = analyzeLoudness(ctx);
  allIssues.push(...loudnessAnalysis.issues);

  const truePeakAnalysis = analyzeTruePeak(ctx);
  allIssues.push(...truePeakAnalysis.issues);

  const dynamicsAnalysis = analyzeDynamics(ctx);
  allIssues.push(...dynamicsAnalysis.issues);

  const tonalBalanceAnalysis = analyzeTonalBalance(ctx);
  allIssues.push(...tonalBalanceAnalysis.issues);

  // Determine release readiness
  const releaseReadiness = assessReleaseReadiness(ctx, allIssues);

  // Generate prioritized fixes
  const prioritizedFixes = allIssues
    .sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    })
    .map((issue) => ({
      priority: issue.severity,
      issue: issue.message,
      masteringSolution: generateSolution(issue.message),
      pluginType: inferPluginType(issue.message),
    }));

  // Generate remaining sections
  const streamingReadiness = assessStreamingReadiness(
    ctx,
    loudnessAnalysis.loudness,
    truePeakAnalysis.truePeak
  );

  const exportRecommendations = generateExportRecommendations(ctx, truePeakAnalysis.truePeak);

  const vinylOrClubReadiness = generateVinylClubReadiness(ctx, truePeakAnalysis.truePeak);

  return {
    releaseReadiness,
    loudness: loudnessAnalysis.loudness,
    truePeak: truePeakAnalysis.truePeak,
    dynamics: dynamicsAnalysis.dynamics,
    tonalBalance: tonalBalanceAnalysis.tonalBalance,
    sequencingNotes: [], // Empty for single track analysis
    streamingReadiness,
    vinylOrClubReadiness,
    prioritizedFixes,
    exportRecommendations,
  };
}

/**
 * Generate solution recommendation based on issue
 */
function generateSolution(issue: string): string {
  if (issue.includes("clipping")) {
    return "Reduce output level by 1-3dB and ensure no hard clipping plugins are active";
  }
  if (issue.includes("True peak") || issue.includes("intersample")) {
    return "Apply true peak limiter with inter-sample peak detection, target -1.0 dBTP";
  }
  if (issue.includes("phase") || issue.includes("out-of-phase")) {
    return "Check stereo processing, ensure bass is mono, verify phase alignment";
  }
  if (issue.includes("Dynamic range")) {
    return "Reduce limiting ratio, increase threshold, or use less aggressive compression";
  }
  if (issue.includes("bass energy")) {
    return "Apply shelf cut below 100Hz or use multiband compression on low end";
  }
  if (issue.includes("high frequencies")) {
    return "Apply gentle high shelf cut or de-esser to reduce harshness";
  }
  if (issue.includes("silence")) {
    return "Trim silence from start/end and add appropriate fades (50-200ms)";
  }
  if (issue.includes("DC offset")) {
    return "Apply DC offset removal filter before final export";
  }
  if (issue.includes("LUFS")) {
    return "Informational - streaming platforms will normalize automatically";
  }
  return "Review master and compare to reference tracks";
}

/**
 * Infer plugin type from issue description
 */
function inferPluginType(issue: string): MasteringFeedbackReport["prioritizedFixes"][0]["pluginType"] {
  if (issue.includes("clipping")) return "limiting";
  if (issue.includes("True peak") || issue.includes("intersample")) return "limiter_true";
  if (issue.includes("phase")) return "alignment_phase";
  if (issue.includes("Dynamic range") || issue.includes("compress")) return "compression";
  if (issue.includes("bass") || issue.includes("low")) return "eq_shelving";
  if (issue.includes("high frequencies") || issue.includes("sibilance")) return "eq_shelving";
  if (issue.includes("DC offset")) return "restoration_balance";
  if (issue.includes("dither")) return "dither_noise";
  return "eq";
}
