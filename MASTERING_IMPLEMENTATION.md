# Mastering Preflight Engine Implementation

## Overview
Comprehensive release readiness assessment engine for mastered audio, validating technical requirements for streaming platforms, physical media, and broadcast.

## Features

### Release Readiness Assessment
Four-tier system:
- **ready** - No issues, cleared for release
- **nearly_ready** - Minor issues, safe to release but could be improved
- **needs_work** - Multiple issues requiring attention
- **not_ready** - Critical issues blocking release (clipping, severe phase issues)

### Technical Analysis

#### 1. Loudness Analysis
- Target: -14 LUFS (streaming standard)
- Broadcast: -23 LUFS (EBU R128 / ATSC A/85)
- Streaming normalization detection
- Loudness war assessment (brick-walled, over-compressed, moderate, dynamic)
- Loudness Range (LRA) measurement
- Graceful handling when LUFS unavailable (informational, not blocking)

#### 2. True Peak Analysis
- **Critical**: > -0.1 dBTP (intersample clipping on DACs)
- **High**: > -1.0 dBTP (may distort on lossy codecs)
- Streaming limit: -1.0 dBTP
- CD limit: -0.3 dBTP
- Vinyl limit: -3.0 dBTP
- Headroom calculation
- Intersample peak detection

#### 3. Dynamic Range Assessment
- Minimum: 6 dB (below is over-compressed)
- Good: 8 dB
- Excellent: 12+ dB
- Punch retention evaluation
- Loudness vs dynamics relationship
- Listening fatigue warnings

#### 4. Clipping Detection
- **Critical priority** - Blocks release
- Immediate fix required
- Suggests gain reduction

#### 5. Phase Compatibility
- **Critical**: Negative phase correlation (mono cancellation)
- **High**: < 0.7 (poor mono compatibility)
- Good: > 0.85
- Stereo/mono translation assessment

#### 6. Tonal Balance
- Bass, midrange, treble analysis
- Assessments: balanced, warm, bright, boomy, thin
- Translation warnings for excessive bass
- Sibilance/harshness detection

#### 7. Silence/Trim Analysis
- Flags > 5% silence
- Start/end trim recommendations
- Fade suggestions (50-200ms)

#### 8. DC Offset Detection
- Limit: 0.01
- Removal recommendations

### Streaming Platform Readiness

Validates against platform specs:
- **Spotify**: -14 LUFS, -1.0 dBTP, normalization
- **Apple Music**: -16 LUFS, -1.0 dBTP, normalization
- **YouTube**: -13 LUFS, -1.0 dBTP, normalization
- **SoundCloud**: -14 LUFS, -1.0 dBTP, normalization
- **Bandcamp**: -14 LUFS, -0.3 dBTP, no normalization

Status per platform:
- **ready** - Meets all requirements
- **needs_adjustment** - Technical issue (usually true peak)
- **will_gain_match** - Platform will apply normalization

### Export Recommendations

#### Format
- **Primary**: WAV or FLAC
- **Archival**: 24-bit or 32-bit float
- **Distribution**: Match source sample rate

#### Sample Rate
- 44.1 kHz (CD quality)
- 48 kHz (video/broadcast)
- 96 kHz (high-res)
- 192 kHz (archival)
- **Recommendation**: Match session rate unless specific target requires conversion

#### Bit Depth
- **24-bit** recommended for master
- **16-bit** for CD with dithering
- **32-bit float** for archival

#### Dithering
- Recommended for 16-bit conversion
- Type: noise-shaped (preferred), triangle, rectangular
- Not needed for 24/32-bit

#### Export Chain
Dynamic recommendations based on analysis:
1. Apply true peak limiting if needed (-1.0 dBTP target)
2. Remove DC offset if detected
3. Apply dithering for 16-bit exports
4. Export as WAV/FLAC at source rate
5. Archive 24-bit or 32-bit float master

#### Alternate Exports
Suggests when useful:
- Instrumental versions
- Acapella versions
- TV mix (dialog-safe)
- Extended/radio edits

### Vinyl/Club Readiness (Optional)

Generated when requested via user questions:

#### Vinyl-Specific
- Mono bass below 150Hz requirement
- Sibilance check
- True peak limit: -3.0 dBTP
- Stereo width restrictions in low end
- Lacquer cutting notes:
  - Additional headroom needed
  - High frequency reduction may be needed
  - Very low bass filtering
  - Duration per side considerations

#### Club/DJ
- Format validation
- DJ edit availability
- System compatibility

### Prioritized Fixes

Ordered by severity:
- **Critical** (blocks release): Clipping, severe phase issues, extreme peaks
- **High**: True peak > -1.0, phase issues, over-compression
- **Medium**: Excessive bass/treble, DC offset, moderate issues
- **Low**: Silence trimming, informational items

Each fix includes:
- Priority level
- Issue description
- Mastering solution
- Plugin type recommendation
- Estimated impact

### Plugin Type Inference

Automatically suggests appropriate tools:
- `limiter_true` - True peak limiting
- `eq_shelving` - Tonal balance correction
- `compression` - Dynamics control
- `alignment_phase` - Phase alignment
- `restoration_balance` - DC offset removal
- `dither_noise` - Noise-shaped dithering

## API

```typescript
export function generateMasteringFeedback(
  metrics: Partial<AudioTechnicalMetrics>,
  request: AudioAnalysisRequest
): MasteringFeedbackReport
```

## Test Coverage

52 tests covering:
- Release readiness assessment (ready/nearly_ready/needs_work/not_ready)
- Missing metrics handling (graceful degradation)
- Clipping detection
- True peak analysis
- Dynamic range assessment
- Loudness analysis
- Phase compatibility
- Tonal balance
- Silence detection
- DC offset detection
- Streaming platform readiness
- Export recommendations
- Vinyl/club readiness (optional)
- Prioritized fixes
- Report structure validation

## Example Usage

```typescript
const metrics: Partial<AudioTechnicalMetrics> = {
  integratedLufs: -14,
  truePeakDbtp: -1.2,
  dynamicRange: 9,
  phaseCorrelation: 0.85,
  spectralBalance: {
    low: 2,
    sub: 3,
    lowMid: 1,
    mid: 2,
    highMid: 2,
    high: 3,
  },
  clippingDetected: false,
  silencePercent: 1,
  dcOffset: 0.001,
};

const request: AudioAnalysisRequest = {
  analysisType: "mastering",
  userQuestions: ["Is this ready for vinyl?"],
};

const report = generateMasteringFeedback(metrics, request);

console.log(report.releaseReadiness); // "ready"
console.log(report.streamingReadiness.spotify); // "ready"
console.log(report.exportRecommendations.idealFormat); // "wav"
console.log(report.vinylOrClubReadiness); // Vinyl-specific recommendations
```

## Mastering Standards Reference

### Streaming Loudness Targets
- Industry standard: -14 LUFS
- Spotify: -14 LUFS (normalizes to this)
- Apple Music: -16 LUFS (normalizes to this)
- YouTube: -13 LUFS (normalizes to this)
- Tidal: -14 LUFS

### True Peak Limits
- Streaming safe: -1.0 dBTP
- CD safe: -0.3 dBTP
- Vinyl safe: -3.0 dBTP
- Critical threshold: -0.1 dBTP (intersample clipping)

### Dynamic Range
- Over-compressed: < 6 dB
- Good: 8-12 dB
- Excellent: 12+ dB
- Classical/jazz: 15-25 dB

### Phase Correlation
- Problematic: < 0.7
- Acceptable: 0.7-0.85
- Good: 0.85-0.95
- Mono: ~1.0

## Non-Blocking Design

The engine is designed to provide comprehensive feedback WITHOUT blocking release for missing measurements:

- **Missing LUFS**: Informational message, suggests backend support, doesn't fail
- **Missing true peak**: Warning, suggests measurement, provides estimate
- **Missing spectral data**: Skips tonal analysis, no warnings
- **Missing dynamic range**: Skips DR analysis, informational message

Only actual technical issues block release:
- Digital clipping (critical)
- Severe phase problems (critical)
- Extreme true peaks (critical)

## File Locations
- Implementation: `src/musician/mastering.ts`
- Tests: `tests/unit/musician/mastering.test.ts`
- Types: `src/musician/analysis-types.ts` (MasteringFeedbackReport)
