/**
 * Mix Feedback Engine
 *
 * Genre-aware deterministic feedback for mixdown analysis.
 * Provides structured, actionable feedback based on technical metrics
 * with genre-specific thresholds and expectations.
 */

import {
  AudioTechnicalMetrics,
  AudioAnalysisRequest,
  MixFeedbackReport,
} from "./analysis-types";

// =============================================================================
// Genre Profiles
// =============================================================================

interface GenreProfile {
  name: string;
  targetLufsMin: number;
  targetLufsMax: number;
  minDynamicRange: number; // Minimum acceptable DR
  maxDynamicRange: number; // Maximum typical DR
  expectedCompression: "none" | "light" | "moderate" | "heavy" | "brick-walled";
  lowEndEmphasis: "minimal" | "moderate" | "heavy" | "extreme"; // Sub/bass importance
  stereoWidthExpectation: "narrow" | "moderate" | "wide" | "very-wide";
  phaseCorrelationMin: number; // Minimum safe phase correlation
  truePeakLimit: number; // dBTP limit
  frequencyBalance: {
    // Expected relative levels (-10 to +10)
    sub: number;
    bass: number;
    lowMid: number;
    mid: number;
    highMid: number;
    high: number;
  };
}

const GENRE_PROFILES: Record<string, GenreProfile> = {
  "drum-and-bass": {
    name: "Drum and Bass",
    targetLufsMin: -7,
    targetLufsMax: -5,
    minDynamicRange: 4,
    maxDynamicRange: 8,
    expectedCompression: "heavy",
    lowEndEmphasis: "extreme",
    stereoWidthExpectation: "wide",
    phaseCorrelationMin: 0.7,
    truePeakLimit: -0.3,
    frequencyBalance: {
      sub: 8, // Very strong sub
      bass: 6,
      lowMid: 0,
      mid: 2,
      highMid: 4,
      high: 5,
    },
  },
  dnb: {
    // Alias
    name: "Drum and Bass",
    targetLufsMin: -7,
    targetLufsMax: -5,
    minDynamicRange: 4,
    maxDynamicRange: 8,
    expectedCompression: "heavy",
    lowEndEmphasis: "extreme",
    stereoWidthExpectation: "wide",
    phaseCorrelationMin: 0.7,
    truePeakLimit: -0.3,
    frequencyBalance: {
      sub: 8,
      bass: 6,
      lowMid: 0,
      mid: 2,
      highMid: 4,
      high: 5,
    },
  },
  edm: {
    name: "EDM/Electronic",
    targetLufsMin: -8,
    targetLufsMax: -4,
    minDynamicRange: 4,
    maxDynamicRange: 7,
    expectedCompression: "brick-walled",
    lowEndEmphasis: "extreme",
    stereoWidthExpectation: "very-wide",
    phaseCorrelationMin: 0.65,
    truePeakLimit: -0.1,
    frequencyBalance: {
      sub: 7,
      bass: 6,
      lowMid: -2,
      mid: 0,
      highMid: 3,
      high: 5,
    },
  },
  electronic: {
    name: "Electronic",
    targetLufsMin: -10,
    targetLufsMax: -6,
    minDynamicRange: 5,
    maxDynamicRange: 9,
    expectedCompression: "heavy",
    lowEndEmphasis: "heavy",
    stereoWidthExpectation: "wide",
    phaseCorrelationMin: 0.7,
    truePeakLimit: -0.5,
    frequencyBalance: {
      sub: 5,
      bass: 4,
      lowMid: -1,
      mid: 0,
      highMid: 2,
      high: 4,
    },
  },
  pop: {
    name: "Pop",
    targetLufsMin: -9,
    targetLufsMax: -7,
    minDynamicRange: 6,
    maxDynamicRange: 10,
    expectedCompression: "moderate",
    lowEndEmphasis: "moderate",
    stereoWidthExpectation: "wide",
    phaseCorrelationMin: 0.75,
    truePeakLimit: -1.0,
    frequencyBalance: {
      sub: 2,
      bass: 3,
      lowMid: 0,
      mid: 2,
      highMid: 3,
      high: 4,
    },
  },
  rock: {
    name: "Rock",
    targetLufsMin: -9,
    targetLufsMax: -6,
    minDynamicRange: 7,
    maxDynamicRange: 12,
    expectedCompression: "moderate",
    lowEndEmphasis: "moderate",
    stereoWidthExpectation: "wide",
    phaseCorrelationMin: 0.75,
    truePeakLimit: -1.0,
    frequencyBalance: {
      sub: 0,
      bass: 3,
      lowMid: 2,
      mid: 3,
      highMid: 4,
      high: 3,
    },
  },
  metal: {
    name: "Metal",
    targetLufsMin: -8,
    targetLufsMax: -5,
    minDynamicRange: 5,
    maxDynamicRange: 9,
    expectedCompression: "heavy",
    lowEndEmphasis: "heavy",
    stereoWidthExpectation: "wide",
    phaseCorrelationMin: 0.7,
    truePeakLimit: -0.5,
    frequencyBalance: {
      sub: 1,
      bass: 5,
      lowMid: 2,
      mid: 0,
      highMid: 5,
      high: 6,
    },
  },
  "hip-hop": {
    name: "Hip Hop",
    targetLufsMin: -9,
    targetLufsMax: -6,
    minDynamicRange: 6,
    maxDynamicRange: 10,
    expectedCompression: "moderate",
    lowEndEmphasis: "extreme",
    stereoWidthExpectation: "moderate",
    phaseCorrelationMin: 0.8,
    truePeakLimit: -1.0,
    frequencyBalance: {
      sub: 7,
      bass: 6,
      lowMid: 0,
      mid: 2,
      highMid: 3,
      high: 2,
    },
  },
  hiphop: {
    // Alias
    name: "Hip Hop",
    targetLufsMin: -9,
    targetLufsMax: -6,
    minDynamicRange: 6,
    maxDynamicRange: 10,
    expectedCompression: "moderate",
    lowEndEmphasis: "extreme",
    stereoWidthExpectation: "moderate",
    phaseCorrelationMin: 0.8,
    truePeakLimit: -1.0,
    frequencyBalance: {
      sub: 7,
      bass: 6,
      lowMid: 0,
      mid: 2,
      highMid: 3,
      high: 2,
    },
  },
  rap: {
    // Alias
    name: "Hip Hop",
    targetLufsMin: -9,
    targetLufsMax: -6,
    minDynamicRange: 6,
    maxDynamicRange: 10,
    expectedCompression: "moderate",
    lowEndEmphasis: "extreme",
    stereoWidthExpectation: "moderate",
    phaseCorrelationMin: 0.8,
    truePeakLimit: -1.0,
    frequencyBalance: {
      sub: 7,
      bass: 6,
      lowMid: 0,
      mid: 2,
      highMid: 3,
      high: 2,
    },
  },
  jazz: {
    name: "Jazz",
    targetLufsMin: -18,
    targetLufsMax: -14,
    minDynamicRange: 12,
    maxDynamicRange: 20,
    expectedCompression: "light",
    lowEndEmphasis: "moderate",
    stereoWidthExpectation: "moderate",
    phaseCorrelationMin: 0.85,
    truePeakLimit: -2.0,
    frequencyBalance: {
      sub: -2,
      bass: 1,
      lowMid: 2,
      mid: 3,
      highMid: 2,
      high: 3,
    },
  },
  classical: {
    name: "Classical",
    targetLufsMin: -23,
    targetLufsMax: -18,
    minDynamicRange: 15,
    maxDynamicRange: 25,
    expectedCompression: "none",
    lowEndEmphasis: "minimal",
    stereoWidthExpectation: "moderate",
    phaseCorrelationMin: 0.9,
    truePeakLimit: -3.0,
    frequencyBalance: {
      sub: -3,
      bass: 0,
      lowMid: 1,
      mid: 2,
      highMid: 2,
      high: 3,
    },
  },
  acoustic: {
    name: "Acoustic/Folk",
    targetLufsMin: -16,
    targetLufsMax: -12,
    minDynamicRange: 10,
    maxDynamicRange: 16,
    expectedCompression: "light",
    lowEndEmphasis: "minimal",
    stereoWidthExpectation: "moderate",
    phaseCorrelationMin: 0.85,
    truePeakLimit: -1.5,
    frequencyBalance: {
      sub: -2,
      bass: 1,
      lowMid: 2,
      mid: 3,
      highMid: 3,
      high: 4,
    },
  },
  folk: {
    // Alias
    name: "Acoustic/Folk",
    targetLufsMin: -16,
    targetLufsMax: -12,
    minDynamicRange: 10,
    maxDynamicRange: 16,
    expectedCompression: "light",
    lowEndEmphasis: "minimal",
    stereoWidthExpectation: "moderate",
    phaseCorrelationMin: 0.85,
    truePeakLimit: -1.5,
    frequencyBalance: {
      sub: -2,
      bass: 1,
      lowMid: 2,
      mid: 3,
      highMid: 3,
      high: 4,
    },
  },
  country: {
    name: "Country",
    targetLufsMin: -12,
    targetLufsMax: -8,
    minDynamicRange: 8,
    maxDynamicRange: 14,
    expectedCompression: "moderate",
    lowEndEmphasis: "moderate",
    stereoWidthExpectation: "wide",
    phaseCorrelationMin: 0.8,
    truePeakLimit: -1.0,
    frequencyBalance: {
      sub: -1,
      bass: 2,
      lowMid: 2,
      mid: 3,
      highMid: 4,
      high: 4,
    },
  },
  indie: {
    name: "Indie",
    targetLufsMin: -12,
    targetLufsMax: -8,
    minDynamicRange: 8,
    maxDynamicRange: 14,
    expectedCompression: "light",
    lowEndEmphasis: "moderate",
    stereoWidthExpectation: "wide",
    phaseCorrelationMin: 0.8,
    truePeakLimit: -1.5,
    frequencyBalance: {
      sub: 0,
      bass: 2,
      lowMid: 1,
      mid: 2,
      highMid: 3,
      high: 4,
    },
  },
  reggae: {
    name: "Reggae",
    targetLufsMin: -10,
    targetLufsMax: -7,
    minDynamicRange: 8,
    maxDynamicRange: 12,
    expectedCompression: "moderate",
    lowEndEmphasis: "heavy",
    stereoWidthExpectation: "moderate",
    phaseCorrelationMin: 0.85,
    truePeakLimit: -1.0,
    frequencyBalance: {
      sub: 6,
      bass: 5,
      lowMid: 0,
      mid: 1,
      highMid: 2,
      high: 3,
    },
  },
  dubstep: {
    name: "Dubstep",
    targetLufsMin: -8,
    targetLufsMax: -5,
    minDynamicRange: 5,
    maxDynamicRange: 9,
    expectedCompression: "heavy",
    lowEndEmphasis: "extreme",
    stereoWidthExpectation: "very-wide",
    phaseCorrelationMin: 0.65,
    truePeakLimit: -0.3,
    frequencyBalance: {
      sub: 9,
      bass: 7,
      lowMid: -2,
      mid: 0,
      highMid: 4,
      high: 5,
    },
  },
  house: {
    name: "House",
    targetLufsMin: -9,
    targetLufsMax: -6,
    minDynamicRange: 5,
    maxDynamicRange: 9,
    expectedCompression: "heavy",
    lowEndEmphasis: "heavy",
    stereoWidthExpectation: "wide",
    phaseCorrelationMin: 0.75,
    truePeakLimit: -0.5,
    frequencyBalance: {
      sub: 6,
      bass: 5,
      lowMid: -1,
      mid: 1,
      highMid: 3,
      high: 4,
    },
  },
  techno: {
    name: "Techno",
    targetLufsMin: -9,
    targetLufsMax: -6,
    minDynamicRange: 5,
    maxDynamicRange: 9,
    expectedCompression: "heavy",
    lowEndEmphasis: "heavy",
    stereoWidthExpectation: "wide",
    phaseCorrelationMin: 0.75,
    truePeakLimit: -0.5,
    frequencyBalance: {
      sub: 6,
      bass: 5,
      lowMid: -1,
      mid: 0,
      highMid: 2,
      high: 3,
    },
  },
  trance: {
    name: "Trance",
    targetLufsMin: -9,
    targetLufsMax: -6,
    minDynamicRange: 6,
    maxDynamicRange: 10,
    expectedCompression: "heavy",
    lowEndEmphasis: "heavy",
    stereoWidthExpectation: "very-wide",
    phaseCorrelationMin: 0.7,
    truePeakLimit: -0.5,
    frequencyBalance: {
      sub: 5,
      bass: 5,
      lowMid: 0,
      mid: 1,
      highMid: 4,
      high: 5,
    },
  },
};

// Default profile for unknown genres
const DEFAULT_PROFILE: GenreProfile = {
  name: "Generic",
  targetLufsMin: -14,
  targetLufsMax: -10,
  minDynamicRange: 8,
  maxDynamicRange: 14,
  expectedCompression: "moderate",
  lowEndEmphasis: "moderate",
  stereoWidthExpectation: "moderate",
  phaseCorrelationMin: 0.75,
  truePeakLimit: -1.0,
  frequencyBalance: {
    sub: 0,
    bass: 2,
    lowMid: 1,
    mid: 2,
    highMid: 2,
    high: 3,
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

function getGenreProfile(genre?: string): GenreProfile {
  if (!genre) return DEFAULT_PROFILE;

  const normalized = genre.toLowerCase().trim().replace(/\s+/g, "-");
  return GENRE_PROFILES[normalized] || DEFAULT_PROFILE;
}

function formatLufs(lufs: number): string {
  return `${lufs.toFixed(1)} LUFS`;
}

function formatDbtp(dbtp: number): string {
  return `${dbtp.toFixed(1)} dBTP`;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

// =============================================================================
// Analysis Functions
// =============================================================================

interface AnalysisContext {
  metrics: Partial<AudioTechnicalMetrics>;
  request: AudioAnalysisRequest;
  profile: GenreProfile;
}

function analyzeClipping(ctx: AnalysisContext): {
  hasCriticalIssue: boolean;
  message: string;
} {
  if (ctx.metrics.clippingDetected === true) {
    return {
      hasCriticalIssue: true,
      message: "Digital clipping detected - immediate fix required before any other processing",
    };
  }
  return { hasCriticalIssue: false, message: "" };
}

function analyzeTruePeak(ctx: AnalysisContext): {
  hasIssue: boolean;
  severity: "critical" | "high" | "medium" | "low" | "none";
  message: string;
} {
  const { truePeakDbtp } = ctx.metrics;
  if (truePeakDbtp === undefined) {
    return { hasIssue: false, severity: "none", message: "" };
  }

  const limit = ctx.profile.truePeakLimit;

  if (truePeakDbtp > -0.1) {
    return {
      hasIssue: true,
      severity: "critical",
      message: `True peak at ${formatDbtp(truePeakDbtp)} exceeds safe limits - intersample peaks will cause clipping on DACs and streaming codecs`,
    };
  }

  if (truePeakDbtp > limit) {
    return {
      hasIssue: true,
      severity: "high",
      message: `True peak at ${formatDbtp(truePeakDbtp)} exceeds ${ctx.profile.name} target of ${formatDbtp(limit)} - risk of distortion on some playback systems`,
    };
  }

  return { hasIssue: false, severity: "none", message: "" };
}

function analyzeLoudness(ctx: AnalysisContext): {
  assessment: string;
  issues: string[];
  strengths: string[];
} {
  const { integratedLufs } = ctx.metrics;
  const issues: string[] = [];
  const strengths: string[] = [];

  if (integratedLufs === undefined) {
    return {
      assessment: "Loudness could not be measured",
      issues: ["Integrated LUFS measurement unavailable"],
      strengths: [],
    };
  }

  const { targetLufsMin, targetLufsMax, name } = ctx.profile;
  const lufsStr = formatLufs(integratedLufs);

  if (integratedLufs < targetLufsMin) {
    const deficit = targetLufsMin - integratedLufs;
    issues.push(
      `Mix is ${deficit.toFixed(1)}dB quieter than ${name} target range (${formatLufs(targetLufsMin)} to ${formatLufs(targetLufsMax)}) - needs more gain/limiting`
    );
    return {
      assessment: `Quieter than typical ${name} mixes`,
      issues,
      strengths,
    };
  }

  if (integratedLufs > targetLufsMax) {
    const excess = integratedLufs - targetLufsMax;
    issues.push(
      `Mix is ${excess.toFixed(1)}dB louder than ${name} target range (${formatLufs(targetLufsMin)} to ${formatLufs(targetLufsMax)}) - may be over-limited`
    );
    return {
      assessment: `Louder than typical ${name} mixes`,
      issues,
      strengths,
    };
  }

  strengths.push(
    `Loudness at ${lufsStr} is within ${name} target range (${formatLufs(targetLufsMin)} to ${formatLufs(targetLufsMax)})`
  );
  return {
    assessment: `Appropriate loudness for ${name}`,
    issues,
    strengths,
  };
}

function analyzeDynamics(ctx: AnalysisContext): {
  assessment: string;
  issues: string[];
  strengths: string[];
} {
  const { dynamicRange } = ctx.metrics;
  const issues: string[] = [];
  const strengths: string[] = [];

  if (dynamicRange === undefined) {
    return {
      assessment: "Dynamic range could not be measured",
      issues: ["DR measurement unavailable"],
      strengths: [],
    };
  }

  const { minDynamicRange, maxDynamicRange, name, expectedCompression } = ctx.profile;

  if (dynamicRange < minDynamicRange) {
    const deficit = minDynamicRange - dynamicRange;
    issues.push(
      `Dynamic range of ${dynamicRange.toFixed(1)}dB is ${deficit.toFixed(1)}dB below ${name} minimum (${minDynamicRange}dB) - over-compressed or brick-walled`
    );
    return {
      assessment: "Over-compressed",
      issues,
      strengths,
    };
  }

  if (dynamicRange > maxDynamicRange) {
    const excess = dynamicRange - maxDynamicRange;
    // This is only an issue for loud genres
    if (expectedCompression === "heavy" || expectedCompression === "brick-walled") {
      issues.push(
        `Dynamic range of ${dynamicRange.toFixed(1)}dB exceeds typical ${name} range (${maxDynamicRange}dB) - may lack punch or impact`
      );
    } else {
      strengths.push(
        `Healthy dynamic range of ${dynamicRange.toFixed(1)}dB preserves musical expression`
      );
    }
  } else {
    strengths.push(
      `Dynamic range of ${dynamicRange.toFixed(1)}dB is appropriate for ${name} (${minDynamicRange}-${maxDynamicRange}dB)`
    );
  }

  return {
    assessment: `Dynamic range: ${dynamicRange.toFixed(1)}dB`,
    issues,
    strengths,
  };
}

function analyzePhaseCorrelation(ctx: AnalysisContext): {
  assessment: string;
  issues: string[];
  warnings: string[];
} {
  const { phaseCorrelation } = ctx.metrics;
  const issues: string[] = [];
  const warnings: string[] = [];

  if (phaseCorrelation === undefined) {
    return {
      assessment: "Phase correlation not measured",
      issues: [],
      warnings: [],
    };
  }

  const { phaseCorrelationMin, name } = ctx.profile;

  if (phaseCorrelation < 0) {
    issues.push(
      `Phase correlation at ${phaseCorrelation.toFixed(2)} indicates out-of-phase content - will collapse or cancel in mono playback`
    );
    return {
      assessment: "Severe phase issues",
      issues,
      warnings,
    };
  }

  if (phaseCorrelation < phaseCorrelationMin) {
    warnings.push(
      `Phase correlation at ${phaseCorrelation.toFixed(2)} is below ${name} minimum (${phaseCorrelationMin.toFixed(2)}) - poor mono compatibility`
    );
    return {
      assessment: "Phase compatibility issues",
      issues,
      warnings,
    };
  }

  return {
    assessment: `Phase correlation at ${phaseCorrelation.toFixed(2)} is healthy`,
    issues,
    warnings,
  };
}

function analyzeStereoWidth(ctx: AnalysisContext): {
  assessment: string;
  issues: string[];
  warnings: string[];
} {
  const { stereoWidth } = ctx.metrics;
  const issues: string[] = [];
  const warnings: string[] = [];

  if (stereoWidth === undefined) {
    return {
      assessment: "Stereo width not measured",
      issues: [],
      warnings: [],
    };
  }

  const { stereoWidthExpectation, name } = ctx.profile;

  // Define width ranges
  const ranges = {
    narrow: { min: 0, max: 40 },
    moderate: { min: 40, max: 70 },
    wide: { min: 60, max: 90 },
    "very-wide": { min: 80, max: 100 },
  };

  const expected = ranges[stereoWidthExpectation];

  if (stereoWidth < expected.min) {
    warnings.push(
      `Stereo width at ${formatPercent(stereoWidth)} is narrower than typical ${name} mixes (${formatPercent(expected.min)}-${formatPercent(expected.max)}) - may lack spaciousness`
    );
  } else if (stereoWidth > expected.max && stereoWidth > 90) {
    warnings.push(
      `Stereo width at ${formatPercent(stereoWidth)} is extremely wide - may cause phase issues or poor mono translation`
    );
  }

  return {
    assessment: `Stereo width: ${formatPercent(stereoWidth)}`,
    issues,
    warnings,
  };
}

function analyzeFrequencyBalance(ctx: AnalysisContext): {
  assessment: string;
  issues: string[];
  warnings: string[];
  details: string;
} {
  const { spectralBalance } = ctx.metrics;
  const issues: string[] = [];
  const warnings: string[] = [];

  if (!spectralBalance) {
    return {
      assessment: "Frequency balance not measured",
      issues: [],
      warnings: [],
      details: "Spectral analysis unavailable",
    };
  }

  const { frequencyBalance: expected, name, lowEndEmphasis } = ctx.profile;

  // Calculate deviations from expected profile
  const deviations = {
    sub: spectralBalance.low - expected.sub,
    bass: spectralBalance.sub - expected.bass,
    lowMid: spectralBalance.lowMid - expected.lowMid,
    mid: spectralBalance.mid - expected.mid,
    highMid: spectralBalance.highMid - expected.highMid,
    high: spectralBalance.high - expected.high,
  };

  // Check for problematic imbalances
  if (deviations.sub > 5) {
    issues.push(
      `Sub-bass is ${deviations.sub.toFixed(1)}dB above ${name} target - may sound muddy or boomy`
    );
  } else if (deviations.sub < -5 && lowEndEmphasis === "extreme") {
    warnings.push(
      `Sub-bass is ${Math.abs(deviations.sub).toFixed(1)}dB below ${name} expectations - lacks low-end weight`
    );
  }

  if (deviations.bass > 5) {
    issues.push(
      `Bass is ${deviations.bass.toFixed(1)}dB above target - low end may be bloated or mask midrange`
    );
  }

  if (deviations.lowMid > 5) {
    issues.push(
      `Low-mids are ${deviations.lowMid.toFixed(1)}dB excessive - mix may sound boxy or muddy`
    );
  }

  if (deviations.mid < -5) {
    warnings.push(
      `Midrange is ${Math.abs(deviations.mid).toFixed(1)}dB weak - vocals/leads may lack presence`
    );
  }

  if (deviations.highMid > 5) {
    warnings.push(
      `High-mids are ${deviations.highMid.toFixed(1)}dB excessive - may cause listening fatigue or harshness`
    );
  }

  if (deviations.high > 6) {
    warnings.push(
      `Highs are ${deviations.high.toFixed(1)}dB excessive - may sound harsh, brittle, or sibilant`
    );
  } else if (deviations.high < -5) {
    warnings.push(
      `Highs are ${Math.abs(deviations.high).toFixed(1)}dB weak - mix may sound dull or muffled`
    );
  }

  const details = `Sub: ${spectralBalance.low.toFixed(1)}dB, Bass: ${spectralBalance.sub.toFixed(1)}dB, Low-mid: ${spectralBalance.lowMid.toFixed(1)}dB, Mid: ${spectralBalance.mid.toFixed(1)}dB, High-mid: ${spectralBalance.highMid.toFixed(1)}dB, High: ${spectralBalance.high.toFixed(1)}dB`;

  return {
    assessment: issues.length > 0 ? "Frequency imbalances detected" : "Frequency balance acceptable",
    issues,
    warnings,
    details,
  };
}

function analyzeSilence(ctx: AnalysisContext): string[] {
  const { silencePercent } = ctx.metrics;
  const warnings: string[] = [];

  if (silencePercent !== undefined && silencePercent > 10) {
    warnings.push(
      `${formatPercent(silencePercent)} of track is silence - check for unnecessary gaps at beginning/end, consider trim or fade adjustments`
    );
  }

  return warnings;
}

function generateTranslationRisks(ctx: AnalysisContext): string[] {
  const risks: string[] = [];

  // Phase issues
  if (ctx.metrics.phaseCorrelation !== undefined && ctx.metrics.phaseCorrelation < 0.7) {
    risks.push("Mono compatibility - phase correlation below 0.7 may cause cancellation on mono speakers");
  }

  // Extreme stereo width
  if (ctx.metrics.stereoWidth !== undefined && ctx.metrics.stereoWidth > 85) {
    risks.push("Extreme stereo width may collapse poorly to mono (phones, clubs, broadcasts)");
  }

  // Over-compression
  if (ctx.metrics.dynamicRange !== undefined && ctx.metrics.dynamicRange < 5) {
    risks.push("Heavy compression may sound fatiguing on quality systems or at high volumes");
  }

  // Low-end issues for bass-heavy genres
  if (ctx.profile.lowEndEmphasis === "extreme" || ctx.profile.lowEndEmphasis === "heavy") {
    if (ctx.metrics.spectralBalance) {
      const subLevel = ctx.metrics.spectralBalance.low;
      if (subLevel > 8) {
        risks.push("Sub-bass may be inaudible on small speakers (laptops, phones) while overwhelming on club systems");
      }
    }
  }

  // True peak issues
  if (ctx.metrics.truePeakDbtp !== undefined && ctx.metrics.truePeakDbtp > -0.5) {
    risks.push("High true peak may cause distortion when transcoded to lossy formats (MP3, AAC, Ogg)");
  }

  return risks;
}

function generatePrioritizedFixes(ctx: AnalysisContext): MixFeedbackReport["prioritizedFixes"] {
  const fixes: MixFeedbackReport["prioritizedFixes"] = [];

  // Critical: Clipping
  if (ctx.metrics.clippingDetected) {
    fixes.push({
      priority: "critical",
      issue: "Digital clipping detected",
      recommendation: "Reduce master fader or individual track levels before any limiting. Remove or reduce any hard clipping plugins.",
      estimatedImpact: "Essential - clipping creates harsh distortion that cannot be fixed later",
    });
  }

  // Critical: True peak over 0
  if (ctx.metrics.truePeakDbtp !== undefined && ctx.metrics.truePeakDbtp > -0.1) {
    fixes.push({
      priority: "critical",
      issue: `True peak at ${formatDbtp(ctx.metrics.truePeakDbtp)} exceeds safe limits`,
      recommendation: "Apply true peak limiting to keep peaks below -0.3 dBTP. Use a brickwall limiter with inter-sample peak detection.",
      estimatedImpact: "Essential - prevents distortion on DACs and streaming codecs",
    });
  }

  // High: Phase issues
  if (ctx.metrics.phaseCorrelation !== undefined && ctx.metrics.phaseCorrelation < ctx.profile.phaseCorrelationMin) {
    fixes.push({
      priority: "high",
      issue: `Phase correlation at ${ctx.metrics.phaseCorrelation.toFixed(2)} indicates mono compatibility issues`,
      recommendation: "Check stereo widening plugins, verify bass is mono below 100Hz, examine phase relationships between multi-miked sources.",
      estimatedImpact: "High - will sound poor on mono systems (clubs, phones, some broadcasts)",
    });
  }

  // High: Over-compression
  if (ctx.metrics.dynamicRange !== undefined && ctx.metrics.dynamicRange < ctx.profile.minDynamicRange) {
    fixes.push({
      priority: "high",
      issue: `Dynamic range of ${ctx.metrics.dynamicRange.toFixed(1)}dB is below ${ctx.profile.name} minimum`,
      recommendation: "Reduce compression ratios, raise thresholds, or use parallel compression. Preserve transients and dynamics.",
      estimatedImpact: "High - restores musical dynamics and reduces listening fatigue",
    });
  }

  // Medium: Loudness
  if (ctx.metrics.integratedLufs !== undefined) {
    if (ctx.metrics.integratedLufs < ctx.profile.targetLufsMin - 2) {
      fixes.push({
        priority: "medium",
        issue: `Mix at ${formatLufs(ctx.metrics.integratedLufs)} is quieter than ${ctx.profile.name} target`,
        recommendation: "Apply gain/limiting to reach target range, or verify this is intentional for the project.",
        estimatedImpact: "Medium - ensures mix competes with commercial releases in the genre",
      });
    } else if (ctx.metrics.integratedLufs > ctx.profile.targetLufsMax + 1) {
      fixes.push({
        priority: "medium",
        issue: `Mix at ${formatLufs(ctx.metrics.integratedLufs)} is louder than ${ctx.profile.name} target`,
        recommendation: "Reduce limiting or overall gain. Consider whether excessive loudness is compromising dynamics.",
        estimatedImpact: "Medium - may improve dynamic expression and reduce fatigue",
      });
    }
  }

  // Medium: Frequency balance
  if (ctx.metrics.spectralBalance) {
    const { spectralBalance } = ctx.metrics;
    const expected = ctx.profile.frequencyBalance;

    if (spectralBalance.low - expected.sub > 5) {
      fixes.push({
        priority: "medium",
        issue: "Excessive sub-bass energy",
        recommendation: "Apply high-pass filtering below 30Hz, reduce sub-bass levels, or use multiband compression on low end.",
        estimatedImpact: "Medium - improves clarity and prevents system overload",
      });
    }

    if (spectralBalance.highMid - expected.highMid > 5) {
      fixes.push({
        priority: "medium",
        issue: "Excessive high-mid energy causing potential harshness",
        recommendation: "Apply gentle EQ cuts in 2-4kHz range, reduce vocal or cymbal brightness, or use de-esser on harsh sources.",
        estimatedImpact: "Medium - reduces listening fatigue",
      });
    }
  }

  // Low: Silence
  if (ctx.metrics.silencePercent !== undefined && ctx.metrics.silencePercent > 10) {
    fixes.push({
      priority: "low",
      issue: `${formatPercent(ctx.metrics.silencePercent)} of track is silence`,
      recommendation: "Trim silence from beginning and end, or add appropriate fades.",
      estimatedImpact: "Low - cleaner presentation, better file size",
    });
  }

  return fixes;
}

function generateExecutiveSummary(
  ctx: AnalysisContext,
  fixes: MixFeedbackReport["prioritizedFixes"]
): string {
  const { metrics, profile } = ctx;
  const lines: string[] = [];

  lines.push(`## Mix Analysis: ${profile.name}`);
  lines.push("");

  // Critical issues
  const criticalIssues = fixes.filter((f) => f.priority === "critical");
  if (criticalIssues.length > 0) {
    lines.push("**⚠️ CRITICAL ISSUES REQUIRE IMMEDIATE ATTENTION**");
    lines.push("");
  }

  // Overall status
  if (criticalIssues.length === 0) {
    const highIssues = fixes.filter((f) => f.priority === "high");
    if (highIssues.length === 0) {
      lines.push("Mix is in good technical shape with no critical issues.");
    } else {
      lines.push("Mix has no critical issues but requires attention to high-priority items.");
    }
  } else {
    lines.push("Mix requires critical fixes before further processing.");
  }

  lines.push("");

  // Key metrics
  if (metrics.integratedLufs !== undefined) {
    lines.push(`- Loudness: ${formatLufs(metrics.integratedLufs)} (${profile.name} target: ${formatLufs(profile.targetLufsMin)}-${formatLufs(profile.targetLufsMax)})`);
  }

  if (metrics.dynamicRange !== undefined) {
    lines.push(`- Dynamic Range: ${metrics.dynamicRange.toFixed(1)}dB (${profile.name} target: ${profile.minDynamicRange}-${profile.maxDynamicRange}dB)`);
  }

  if (metrics.truePeakDbtp !== undefined) {
    lines.push(`- True Peak: ${formatDbtp(metrics.truePeakDbtp)} (limit: ${formatDbtp(profile.truePeakLimit)})`);
  }

  if (metrics.phaseCorrelation !== undefined) {
    lines.push(`- Phase Correlation: ${metrics.phaseCorrelation.toFixed(2)} (minimum: ${profile.phaseCorrelationMin.toFixed(2)})`);
  }

  return lines.join("\n");
}

function generateSuggestedNextPass(
  ctx: AnalysisContext,
  fixes: MixFeedbackReport["prioritizedFixes"]
): string {
  const lines: string[] = [];

  lines.push("## Suggested Mix Pass Workflow");
  lines.push("");

  const criticalFixes = fixes.filter((f) => f.priority === "critical");
  const highFixes = fixes.filter((f) => f.priority === "high");

  if (criticalFixes.length > 0) {
    lines.push("### 1. Address Critical Issues First");
    criticalFixes.forEach((fix) => {
      lines.push(`- ${fix.recommendation}`);
    });
    lines.push("");
  }

  if (highFixes.length > 0) {
    lines.push(`### ${criticalFixes.length > 0 ? "2" : "1"}. Address High-Priority Items`);
    highFixes.forEach((fix) => {
      lines.push(`- ${fix.recommendation}`);
    });
    lines.push("");
  }

  const nextStep = criticalFixes.length > 0 ? criticalFixes.length + highFixes.length + 1 : highFixes.length + 1;
  lines.push(`### ${nextStep}. Re-analyze`);
  lines.push("- Export a new mix after addressing the above items");
  lines.push("- Run analysis again to verify improvements");
  lines.push("- Check mix on multiple playback systems");
  lines.push("");

  return lines.join("\n");
}

function generateQuestionsForUser(ctx: AnalysisContext): string[] {
  const questions: string[] = [];

  // Genre-specific questions
  if (ctx.profile.name === "Generic") {
    questions.push("What genre or style are you targeting? This will help provide more specific feedback.");
  }

  // Dynamic range questions
  if (ctx.metrics.dynamicRange !== undefined) {
    if (ctx.metrics.dynamicRange < ctx.profile.minDynamicRange) {
      questions.push("Is the heavy compression intentional for this track, or would you like help restoring dynamics?");
    }
  }

  // Loudness questions
  if (ctx.metrics.integratedLufs !== undefined) {
    if (ctx.metrics.integratedLufs < ctx.profile.targetLufsMin - 3) {
      questions.push("Are you planning to master this track later, or should it be louder at the mix stage?");
    }
  }

  // Reference questions
  if (!ctx.request.targetReferences || ctx.request.targetReferences.length === 0) {
    questions.push("Do you have reference tracks you're trying to match? Comparing to references can help identify specific areas for improvement.");
  }

  // Listening context
  if (!ctx.request.listeningContext) {
    questions.push("What's your primary listening environment for this project? (earbuds, studio monitors, car, club, etc.)");
  }

  // User concerns
  if (!ctx.request.userQuestions || ctx.request.userQuestions.length === 0) {
    questions.push("Are there specific aspects of the mix you're concerned about or want feedback on?");
  }

  return questions;
}

// =============================================================================
// Main Export: generateMixFeedback
// =============================================================================

/**
 * Generate mix feedback report from technical metrics.
 * Pure function suitable for unit testing.
 */
export function generateMixFeedback(
  metrics: Partial<AudioTechnicalMetrics>,
  request: AudioAnalysisRequest
): MixFeedbackReport {
  const profile = getGenreProfile(request.genre);
  const ctx: AnalysisContext = { metrics, request, profile };

  // Run all analyses
  const clippingAnalysis = analyzeClipping(ctx);
  const truePeakAnalysis = analyzeTruePeak(ctx);
  const loudnessAnalysis = analyzeLoudness(ctx);
  const dynamicsAnalysis = analyzeDynamics(ctx);
  const phaseAnalysis = analyzePhaseCorrelation(ctx);
  const stereoWidthAnalysis = analyzeStereoWidth(ctx);
  const frequencyAnalysis = analyzeFrequencyBalance(ctx);
  const silenceWarnings = analyzeSilence(ctx);
  const translationRisks = generateTranslationRisks(ctx);
  const prioritizedFixes = generatePrioritizedFixes(ctx);

  // Collect all issues and strengths
  const allIssues: string[] = [];
  const allStrengths: string[] = [];

  if (clippingAnalysis.hasCriticalIssue) {
    allIssues.push(clippingAnalysis.message);
  }

  if (truePeakAnalysis.hasIssue) {
    allIssues.push(truePeakAnalysis.message);
  }

  allIssues.push(...loudnessAnalysis.issues);
  allStrengths.push(...loudnessAnalysis.strengths);

  allIssues.push(...dynamicsAnalysis.issues);
  allStrengths.push(...dynamicsAnalysis.strengths);

  allIssues.push(...phaseAnalysis.issues);
  allIssues.push(...phaseAnalysis.warnings);

  allIssues.push(...stereoWidthAnalysis.issues);
  allIssues.push(...stereoWidthAnalysis.warnings);

  allIssues.push(...frequencyAnalysis.issues);
  allIssues.push(...frequencyAnalysis.warnings);

  allIssues.push(...silenceWarnings);

  // Generate narrative sections
  const executiveSummary = generateExecutiveSummary(ctx, prioritizedFixes);
  const suggestedNextPass = generateSuggestedNextPass(ctx, prioritizedFixes);
  const questionsForUser = generateQuestionsForUser(ctx);

  // Build frequency balance section
  const frequencyGauge = metrics.spectralBalance
    ? {
        sub: metrics.spectralBalance.low - profile.frequencyBalance.sub,
        bass: metrics.spectralBalance.sub - profile.frequencyBalance.bass,
        lowMid: metrics.spectralBalance.lowMid - profile.frequencyBalance.lowMid,
        mid: metrics.spectralBalance.mid - profile.frequencyBalance.mid,
        highMid: metrics.spectralBalance.highMid - profile.frequencyBalance.highMid,
        high: metrics.spectralBalance.high - profile.frequencyBalance.high,
      }
    : { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 };

  // Determine assessments
  let frequencyOverallAssessment: MixFeedbackReport["frequencyBalance"]["overallAssessment"] = "balanced";
  if (frequencyGauge.sub > 5 || frequencyGauge.bass > 5) {
    frequencyOverallAssessment = "boomy";
  } else if (frequencyGauge.lowMid > 5) {
    frequencyOverallAssessment = "muddy";
  } else if (frequencyGauge.high > 5 || frequencyGauge.highMid > 5) {
    frequencyOverallAssessment = "harsh";
  } else if (frequencyGauge.high < -5) {
    frequencyOverallAssessment = "dull";
  } else if (frequencyGauge.bass < -5 && frequencyGauge.sub < -5) {
    frequencyOverallAssessment = "thin";
  }

  let dynamicsOverallAssessment: MixFeedbackReport["dynamics"]["overallAssessment"] = "moderate";
  if (metrics.dynamicRange !== undefined) {
    if (metrics.dynamicRange < 5) {
      dynamicsOverallAssessment = "crushed";
    } else if (metrics.dynamicRange < 7) {
      dynamicsOverallAssessment = "flat";
    } else if (metrics.dynamicRange > 14) {
      dynamicsOverallAssessment = "dynamic";
    }
  }

  let stereoOverallAssessment: MixFeedbackReport["stereoImage"]["overallAssessment"] = "moderate";
  if (metrics.stereoWidth !== undefined) {
    if (metrics.stereoWidth < 40) {
      stereoOverallAssessment = "narrow";
    } else if (metrics.stereoWidth > 85) {
      stereoOverallAssessment = "wide";
    }
  }
  if (metrics.phaseCorrelation !== undefined && metrics.phaseCorrelation < 0.7) {
    stereoOverallAssessment = "phased";
  }

  // Calculate confidence
  let confidence = 0.5;
  const availableMetrics = [
    metrics.integratedLufs,
    metrics.truePeakDbtp,
    metrics.dynamicRange,
    metrics.phaseCorrelation,
    metrics.stereoWidth,
    metrics.spectralBalance,
  ].filter((m) => m !== undefined).length;
  confidence = Math.min(0.95, 0.3 + availableMetrics * 0.1);

  // Build the full report
  const report: MixFeedbackReport = {
    summary: executiveSummary,
    strengths: allStrengths,
    issues: allIssues,

    frequencyBalance: {
      overallAssessment: frequencyOverallAssessment,
      bassEnergy: frequencyGauge.bass > 5 ? "excessive" : frequencyGauge.bass < -5 ? "weak" : "present",
      midClarity: frequencyGauge.mid < -5 ? "muffled" : frequencyGauge.lowMid > 5 ? "boxy" : "clear",
      highExtension: frequencyGauge.high > 5 ? "harsh" : frequencyGauge.high < -5 ? "dull" : "sparkle",
      frequencyGauge,
    },

    dynamics: {
      overallAssessment: dynamicsOverallAssessment,
      compressionAmount:
        metrics.dynamicRange === undefined
          ? "none"
          : metrics.dynamicRange < 5
            ? "brick-walled"
            : metrics.dynamicRange < 7
              ? "heavy"
              : metrics.dynamicRange < 10
                ? "moderate"
                : "light",
      punch: metrics.dynamicRange !== undefined && metrics.dynamicRange < 6 ? "killed" : "preserved",
      sustain: "natural",
      loudnessLufs: metrics.integratedLufs || 0,
    },

    stereoImage: {
      overallAssessment: stereoOverallAssessment,
      width: metrics.stereoWidth || 50,
      centerImageStability: "stable",
      panningBalance: "balanced",
      stereoToolsUsed: [],
    },

    depthAndSpace: {
      overallAssessment: "moderate",
      frontElements: [],
      middleElements: [],
      backElements: [],
      reverbAmount: "moderate",
      senseOfSpace: "Mix depth analysis requires spectral and transient analysis",
    },

    vocalOrLeadPresence: {
      overallAssessment: "moderate",
      intelligibility: "fair",
      emotionPreservation: "preserved",
      processingApplied: [],
    },

    lowEnd: {
      overallAssessment:
        frequencyGauge.sub > 5 || frequencyGauge.bass > 5
          ? "boomy"
          : frequencyGauge.bass < -5
            ? "weak"
            : "clean",
      subBass:
        frequencyGauge.sub > 5 ? "uncontrolled" : frequencyGauge.sub < -5 ? "absent" : "controlled",
      kickDrum: "tight",
      bassClarity: frequencyGauge.lowMid > 5 ? "muddy" : "defined",
      phaseIssues: metrics.phaseCorrelation !== undefined && metrics.phaseCorrelation < 0.7,
    },

    transients: {
      overallAssessment: metrics.dynamicRange !== undefined && metrics.dynamicRange < 6 ? "crushed" : "punchy",
      kickAttack: "present",
      snareAttack: "present",
      percussiveElements: metrics.dynamicRange !== undefined && metrics.dynamicRange < 6 ? "compressed" : "preserved",
      transientShaping: [],
    },

    noiseArtifacts: {
      hasNoise: false,
      noiseType: "none",
      noiseLevel: "inaudible",
      quantizationIssues: false,
      ditheringApplied: false,
    },

    translationRisks,
    prioritizedFixes,

    suggestedPluginsOrProcesses: [], // Could be expanded in future

    confidence,
  };

  return report;
}

/**
 * Get list of supported genres
 */
export function getSupportedGenres(): string[] {
  return Object.keys(GENRE_PROFILES).sort();
}

/**
 * Get genre profile details
 */
export function getGenreProfileDetails(genre: string): GenreProfile | null {
  const normalized = genre.toLowerCase().trim().replace(/\s+/g, "-");
  return GENRE_PROFILES[normalized] || null;
}
