# Musician Assistant - Demo Scenarios & Example Prompts

## Overview

This document provides comprehensive demo scenarios for testing and demonstrating the Musician Assistant features. Each scenario includes the user prompt, expected API call, response format, backend requirements, and fallback behavior.

**Purpose**: Manual QA testing, feature demonstrations, user onboarding

**Note**: All examples are style-neutral and avoid direct artist imitation.

---

## Table of Contents

1. [Theory Tutoring](#1-theory-tutoring)
2. [Composition Assistance](#2-composition-assistance)
3. [Arrangement Development](#3-arrangement-development)
4. [Mix Feedback Analysis](#4-mix-feedback-analysis)
5. [Mastering Feedback](#5-mastering-feedback)
6. [Practice Planning](#6-practice-planning)
7. [Sample Generation](#7-sample-generation)
8. [Audio Transcription](#8-audio-transcription)

---

## 1. Theory Tutoring

### Scenario 1.1: Secondary Dominants for Blues-Rock Guitar

**User Prompt (Web UI)**:
```
Topic: secondary dominants
Skill Level: intermediate
Instrument: guitar
Style: blues-rock
Include Examples: ✓
Include Exercises: ✓
```

**User Prompt (Discord)**:
```
/music-theory topic:secondary dominants level:intermediate instrument:guitar
```

**User Prompt (API)**:
```json
POST /api/musician/theory
{
  "topic": "secondary dominants",
  "skillLevel": "intermediate",
  "instrument": "guitar",
  "style": "blues-rock",
  "includeExamples": true,
  "includeExercises": true
}
```

**Expected Response Shape**:
```json
{
  "success": true,
  "content": "# Secondary Dominants for Blues-Rock Guitar\n\n## What Are Secondary Dominants?\n\nA secondary dominant is a dominant 7th chord that temporarily tonicizes (acts as V7 of) a chord other than the tonic...\n\n## In Blues-Rock Context\n\nBlues-rock frequently uses secondary dominants to add harmonic color and create tension...\n\n### Example Progression\n\nIn the key of A:\n```\n| A7 | A7 | D7 | D7 | \n| E7 (V/V) | D7 | A7 | A7 |\n```\n\nOn guitar:\n```\nA7:   x02020\nD7:   xx0212\nE7:   020100 (acts as V7 of A7)\nB7:   x21202 (V7/V - secondary dominant)\n```\n\n## Guitar Voicings\n\n**A7** (I7):\n- Root position: 5th fret A-shape barre\n- Move-able: x02020\n\n**E7** (V7 of A):\n- Open: 020100\n- Barre: 7th fret A-shape\n\n**B7** (V7/V - secondary dominant to E7):\n- Open: x21202\n- Creates strong pull to E7\n\n## Exercise\n\n1. Play a standard I-IV-V in A:\n   | A7 | D7 | E7 | A7 |\n\n2. Add B7 before E7:\n   | A7 | D7 | B7 | E7 | A7 |\n\n3. Experiment with:\n   - C#7 before F#m (if using vi chord)\n   - E7 before Am in a blues turnaround\n\n## Blues-Rock Application\n\nClassic blues-rock often uses:\n- V7/IV (E7) to approach IV (D7) in key of A\n- V7/V (B7) to create tension before V (E7)\n- Quick changes: A7-E7-D7-A7 with added B7\n\n**Pro Tip**: In blues-rock, you can treat almost any chord as a temporary tonic and approach it with its V7!"
}
```

**Backend Requirements**:
- None - Pure deterministic music theory knowledge
- LLM agent for formatting and explanation generation
- No external services required

**Fallback Behavior**:
- Always succeeds (no external dependencies)
- If LLM unavailable: Return pre-canned theory explanations
- Never requires audio processing

**QA Verification**:
- [ ] Response includes theory explanation
- [ ] Guitar-specific chord voicings provided
- [ ] Blues-rock context incorporated
- [ ] Examples use appropriate notation
- [ ] Exercise progression is logical

---

### Scenario 1.2: Modal Scales for Advanced Pianists

**User Prompt**:
```
Topic: modal scales and their applications
Skill Level: advanced
Instrument: piano
Style: jazz
Include Examples: ✓
```

**API Call**:
```json
POST /api/musician/theory
{
  "topic": "modal scales and their applications",
  "skillLevel": "advanced",
  "instrument": "piano",
  "style": "jazz",
  "includeExamples": true
}
```

**Expected Response Elements**:
- Detailed explanation of all 7 modes
- Piano-specific voicings and fingerings
- Jazz context and applications
- Chord-scale relationships
- II-V-I examples in modal contexts
- Practice suggestions for modal improvisation

**Backend Requirements**: None

**Fallback Behavior**: Always succeeds

---

## 2. Composition Assistance

### Scenario 2.1: Dark Synthwave Chord Progression

**User Prompt (Web UI)**:
```
Goal: Write a dark synthwave chord progression in F minor with an 8-bar A section and a lift into the chorus
Genre: synthwave
Mood: dark, mysterious
Key: F minor
Tempo: 85 BPM
Output Format: chord_chart
```

**User Prompt (Discord)**:
```
/compose goal:dark synthwave chord progression with 8-bar A section and lift to chorus genre:synthwave mood:dark key:F minor
```

**API Call**:
```json
POST /api/musician/composition
{
  "goal": "Write a dark synthwave chord progression in F minor with an 8-bar A section and a lift into the chorus",
  "genre": "synthwave",
  "mood": "dark",
  "key": "F minor",
  "tempo": 85,
  "outputFormat": "chord_chart"
}
```

**Expected Response Shape**:
```json
{
  "success": true,
  "content": "# Dark Synthwave Chord Progression\n\n## Key: F Minor | Tempo: 85 BPM\n\n### A Section (8 bars)\n\n| Bar | Chord | Duration | Notes |\n|-----|-------|----------|-------|\n| 1-2 | Fm | 2 bars | Root, establish dark mood |\n| 3-4 | Db | 2 bars | bVI, synthwave staple |\n| 5-6 | Eb | 2 bars | bVII, building tension |\n| 7-8 | Cm | 2 bars | v, minor dominant feeling |\n\n**Chord Voicings** (Synth pads):\n```\nFm:  F-Ab-C-F\nDb:  Db-F-Ab-Db (bVI creates nostalgic feel)\nEb:  Eb-G-Bb-Eb (bVII adds vintage synth color)\nCm:  C-Eb-G-C (v sets up the lift)\n```\n\n### Pre-Chorus Lift (4 bars)\n\nTo create a \"lift\" into the chorus:\n\n| Bar | Chord | Duration | Notes |\n|-----|-------|----------|-------|\n| 1 | Bbm | 1 bar | iv, keeps dark mood |\n| 2 | Eb/G | 1 bar | bVII with bass movement |\n| 3 | Ab | 1 bar | bIII, major lift moment |\n| 4 | C7 | 1 bar | V7, tension before chorus |\n\n**The Lift**: The move from Cm (v) to Bbm (iv) to Ab (bIII) creates upward harmonic motion. The C7 (V7/relative major) provides dominant tension.\n\n### Chorus Entry Suggestion\n\nAfter the C7 lift, these options work:\n\n1. **Dark resolution**: Return to Fm (i)\n2. **Bright contrast**: Move to Ab major (bIII) for major chorus\n3. **Suspended tension**: Fm7sus4 for ethereal feel\n\n## Synth Arrangement Tips\n\n**Low End**:\n- Bass synth: Root notes on downbeats\n- Sub bass: Sustained root notes\n\n**Mid**:\n- Pad: Full chord voicings with slow attack\n- Arp: 16th note patterns on Fm pentatonic\n\n**High**:\n- Lead: Sparse melodic phrases in bars 7-8\n- Texture: Detuned saw waves for width\n\n## Production Notes\n\n- Use sidechain compression on pads to drums\n- Add tape saturation for vintage warmth\n- Reverb: Large hall (3-4s decay) on pads\n- Filter automation: Open low-pass on lift (bars 5-8)\n\n## Melodic Suggestions\n\nFor the A section melody:\n- Stay in F natural minor (F-G-Ab-Bb-C-Db-Eb)\n- Emphasize Ab (b3) and Db (b6) for dark character\n- Use longer note values (half notes, whole notes)\n- Peak on C (5th) in bar 7 before the lift\n\n**Example melody rhythm**:\n```\nBar 1-2: Whole note F, dotted half C\nBar 3-4: Half notes: Db-C-Ab-F\nBar 5-6: Whole note Eb, dotted half G\nBar 7-8: Sustained C (2 bars) - creates anticipation\n```"
}
```

**Backend Requirements**:
- None - Deterministic music theory and composition knowledge
- LLM for creative composition generation
- No audio processing needed

**Fallback Behavior**:
- Always succeeds
- If LLM unavailable: Return template-based chord progressions
- No external service dependencies

**QA Verification**:
- [ ] Chord progression is in F minor
- [ ] 8-bar A section provided
- [ ] Lift mechanism explained and implemented
- [ ] Synthwave-appropriate chord choices (bVI, bVII)
- [ ] Production and arrangement tips included
- [ ] Output format matches request (chord chart)

---

### Scenario 2.2: Indie Pop Verse-Chorus Structure

**User Prompt**:
```
Goal: Write a complete verse-chorus structure for an indie pop song
Genre: indie pop
Mood: uplifting but introspective
Key: G major
Tempo: 110 BPM
Time Signature: 4/4
Output Format: arrangement_plan
```

**Expected Response Elements**:
- Complete song structure (intro, verse, pre-chorus, chorus, bridge)
- Chord progressions for each section
- Melodic contour suggestions
- Instrumentation recommendations
- Dynamics and arrangement build
- Transition ideas between sections

---

## 3. Arrangement Development

### Scenario 3.1: Acoustic to Full Band Arrangement

**User Prompt**:
```
Goal: Turn this acoustic verse/chorus idea into a full band arrangement with drums, bass, guitars, keys, and backing vocals
Genre: alternative rock
Mood: anthemic
Tempo: 130 BPM
Key: D major
Constraints: Must maintain intimacy in verse, explode in chorus
Existing Chord Progression: Verse: D-A-Bm-G, Chorus: G-D-A-Bm
```

**API Call**:
```json
POST /api/musician/composition
{
  "goal": "Turn this acoustic verse/chorus idea into a full band arrangement with drums, bass, guitars, keys, and backing vocals",
  "genre": "alternative rock",
  "mood": "anthemic",
  "tempo": 130,
  "key": "D major",
  "constraints": "Must maintain intimacy in verse, explode in chorus",
  "chordProgression": "Verse: D-A-Bm-G, Chorus: G-D-A-Bm",
  "outputFormat": "arrangement_plan"
}
```

**Expected Response Shape**:
```json
{
  "success": true,
  "content": "# Full Band Arrangement: Acoustic to Anthemic Rock\n\n## Key: D Major | Tempo: 130 BPM | 4/4\n\n## Original Material\n\n**Verse**: D - A - Bm - G\n**Chorus**: G - D - A - Bm\n\n---\n\n## VERSE ARRANGEMENT (Intimate)\n\n### Drums\n- **Bars 1-4**: Kick and snare only, quarter notes\n- **Bars 5-8**: Add light hi-hat (8th notes, low volume)\n- **Pattern**: Kick on 1 & 3, Snare on 2 & 4\n- **Dynamics**: p-mp (quiet to medium-quiet)\n\n### Bass\n- **Bars 1-4**: Root notes only (whole notes)\n  - D (bar 1), A (bar 2), B (bar 3), G (bar 4)\n- **Bars 5-8**: Add passing tones on &-of-4\n- **Tone**: Round, muted, finger-style\n- **Dynamics**: mp\n\n### Guitars\n\n**Acoustic Guitar** (Primary):\n- Fingerpicking pattern throughout\n- Pattern: Thumb on root, fingers on 3rd/5th\n- **Bars 1-4**: Sparse (thumb + 2 fingers)\n- **Bars 5-8**: Fuller (thumb + 3 fingers, add 6th string notes)\n\n**Electric Guitar 1** (Clean, enters bar 5):\n- Arpeggiated triads, 16th notes\n- High register (12th fret area)\n- Light reverb and chorus\n- **Dynamics**: pp-p (very quiet, textural)\n\n**Electric Guitar 2**:\n- Absent in verse (saves for chorus impact)\n\n### Keys\n- **Bars 1-4**: None (preserve space)\n- **Bars 5-8**: Soft pad, long release\n  - Root position triads, sustained\n  - Strings patch or warm pad\n  - **Dynamics**: pp\n\n### Vocals\n- **Lead**: Single vocal, conversational delivery\n- **Backing**: None in verse\n- **Effects**: Minimal reverb, slight compression\n\n**Lyric rhythm suggestion**:\n- Conversational phrasing\n- Pauses between lines for breath\n- Build syllable density bars 5-8\n\n---\n\n## PRE-CHORUS (Building Energy)\n\n**Duration**: 4 bars\n**Chords**: Bm - G - D - A\n\n### Drums\n- **Bars 1-2**: Add crash on 1, open hi-hat on 2 & 4\n- **Bars 3-4**: Build with 16th note snare fill (bar 4)\n- **Dynamics**: mf-f\n\n### Bass\n- Switch to 8th note patterns\n- Octave jumps on root notes\n- Drive increases\n\n### Guitars\n- **Acoustic**: Continue fingerpicking but with more attack\n- **Electric 1**: Switch to strummed power chords, palm-muted\n- **Electric 2** (enters bar 3): Sustained power chords, no palm mute\n\n### Keys\n- Pad swells with filter opening\n- Add octave doubling\n\n### Vocals\n- Lead builds in intensity\n- **Backing vocals enter bar 3**: Unison on key words\n\n---\n\n## CHORUS ARRANGEMENT (Anthemic Explosion)\n\n**Chords**: G - D - A - Bm (repeats 2x, 8 bars total)\n\n### Drums\n- **Full kit engaged**:\n  - Kick: 1 & 3 (add &-of-2 for drive)\n  - Snare: 2 & 4 (loud, open)\n  - Hi-hat: 8th notes, open on 2 & 4\n  - Crash: On 1 of each chord change\n  - Ride bell: Added bar 5-8 for lift\n- **Dynamics**: f-ff (loud to very loud)\n\n### Bass\n- **Active 8th note lines with movement**:\n  - G: G-G-A-B-A-G-F#-E\n  - D: D-D-E-F#-E-D-C#-B\n  - A: A-A-B-C#-B-A-G-F#\n  - Bm: B-B-C#-D-C#-B-A-G\n- **Tone**: Aggressive, pick attack, slight overdrive\n- **Dynamics**: f\n\n### Guitars\n\n**Acoustic**:\n- Full strumming, all strings\n- Downstrokes on 1 & 3, upstrokes on & of each beat\n- Prominent in left channel\n\n**Electric 1**:\n- **Power chords, open voicings**:\n  - G5 (3rd fret), D5 (5th fret), A5 (5th fret), B5 (7th fret)\n- Aggressive strumming, palm-muted on verses of beats\n- **Dynamics**: f\n- Panned right\n\n**Electric 2**:\n- **Octave chords, higher register**:\n  - Play in 10th-12th fret range\n  - Sustained, let ring\n- **Dynamics**: mf-f\n- Panned center-right\n\n**Electric 3** (Lead):\n- **Melodic fills between vocal lines**:\n  - Call-and-response with vocals\n  - Pentatonic and major scale runs\n  - Bends on 3rds and 5ths\n- **Tone**: Moderate gain, delay (dotted 8th), reverb\n\n### Keys\n\n**Pad**:\n- Full, thick pad with octave doubling\n- Root position + inversions for movement\n- **Dynamics**: f\n\n**Piano** (optional):\n- 8th note chords in mid-range\n- Doubles root motion with bass\n- Adds percussive attack\n\n### Vocals\n\n**Lead**:\n- Full voice, belted\n- Higher range than verse\n- Compression and saturation for power\n- Double-tracked and panned L/R\n\n**Backing Vocals**:\n- **Layer 1**: Harmony (3rd above), 2 voices L/R\n- **Layer 2**: Harmony (5th above), 2 voices L/R\n- **Layer 3**: Unison octave lower (bars 5-8 only)\n- **\"Oh\" or \"Ah\"** backgrounds sustaining through chord changes\n\n**Dynamics**: ff on chorus peak (bars 5-8)\n\n---\n\n## TRANSITION: CHORUS BACK TO VERSE 2\n\n**Duration**: 2 bars\n\n### Arrangement\n- **Bar 1**: Full band\n- **Bar 2**: Dropout - only acoustic guitar and bass remain\n  - Drums: Fill into silence on beat 4\n  - Other instruments: Cut on beat 1 of bar 2\n\n**Effect**: Creates contrast and intimacy for verse 2\n\n---\n\n## BRIDGE ARRANGEMENT (Optional)\n\n**Chords**: Em - Bm - G - A (4 bars, repeat)\n\n### Concept: \"Breakdown then Build\"\n\n**Bars 1-4** (Breakdown):\n- Drums: Half-time feel, kick on 1, snare on 3\n- Bass: Whole notes\n- Guitars: Ambient swells, delay/reverb heavy\n- Keys: Pad only\n- Vocals: Softer, intimate\n\n**Bars 5-8** (Build):\n- Drums: Add 16th note hi-hat, build snare fill\n- Bass: 8th notes return\n- Guitars: Power chords return\n- Keys: Arpeggios added\n- Vocals: Build to shout/belt\n\n**Bar 8**: Big fill into final chorus\n\n---\n\n## FINAL CHORUS (Climax)\n\n**Same as chorus but with additions**:\n\n- **Drums**: More crashes, possibly double-time hi-hat (16th notes)\n- **Bass**: Octave jumps on beat 4 of each bar\n- **Guitars**: All 3 electric guitars + acoustic\n- **Keys**: Add synth lead doubling vocal melody\n- **Vocals**:\n  - Lead: Double-tracked with slight pitch variation\n  - Backing: All 3 harmony layers throughout\n  - **Choir effect**: Stack 6-8 vocal tracks on final word\n\n**Ending**:\n- Option 1: Big ending on D major (all instruments hit, sustain)\n- Option 2: Pull back to acoustic + vocal for intimate outro\n\n---\n\n## PRODUCTION NOTES\n\n### Mixing Strategy\n\n**Verse**:\n- Acoustic guitar: Centered, prominent\n- Electric guitar (when enters): Wide stereo, quiet\n- Vocals: Centered, intimate (short reverb)\n- Overall: Sparse, clear, focused\n\n**Chorus**:\n- Guitars: Wide stereo spread (acoustic center, electrics L/R)\n- Vocals: Thick doubled center, harmonies wide\n- Bass: Centered, compressed for power\n- Drums: Overhead wide, kick/snare centered\n- Overall: Dense, loud, energetic\n\n### Dynamics\n\n- Verse: -18 to -15 LUFS\n- Chorus: -10 to -8 LUFS\n- Final Chorus: -8 to -6 LUFS\n\n**Compression**: Parallel compression on drum bus and vocal bus for power\n\n### Effects\n\n- **Reverb**: Short on verse (0.8s), longer on chorus (2.0s)\n- **Delay**: Dotted 8th on lead guitar, quarter note on lead vocal\n- **Saturation**: Subtle on bass and guitars for warmth\n\n---\n\n## SUMMARY: ARRANGEMENT JOURNEY\n\n**Verse**: Intimate, sparse, acoustic-driven\n↓\n**Pre-Chorus**: Building energy, more instruments\n↓\n**Chorus**: Full band, anthemic, powerful\n↓\n**Verse 2**: Pull back to intimacy (contrast)\n↓\n**Chorus 2**: Full band returns\n↓\n**Bridge**: Breakdown then build\n↓\n**Final Chorus**: Climax, all elements, maximum energy\n\n**Key Contrast**: Intimate verse vs. explosive chorus achieved through:\n1. Instrumental density (few vs. many)\n2. Dynamics (quiet vs. loud)\n3. Vocal treatment (single vs. doubled + harmonies)\n4. Drum complexity (simple vs. full)\n5. Guitar textures (fingerpicking vs. power chords)"
}
```

**Backend Requirements**:
- None - Composition and arrangement expertise
- LLM for detailed arrangement planning
- No audio processing

**Fallback Behavior**: Always succeeds

**QA Verification**:
- [ ] Verse arrangement is intimate (sparse instrumentation)
- [ ] Chorus arrangement is anthemic (full band)
- [ ] All requested instruments covered (drums, bass, guitars, keys, vocals)
- [ ] Transition and dynamics clearly explained
- [ ] Specific playing techniques and voicings provided
- [ ] Production notes included

---

## 4. Mix Feedback Analysis

### Scenario 4.1: Rough Mix Analysis

**User Prompt**:
```
Analysis Type: mixdown
Genre: indie rock
Reference Notes: "Check for low-end buildup, vocal presence, stereo width, and translation issues. Mix sounds muddy on laptop speakers but okay on monitors."
Include Technical Metrics: ✓
Include Action Plan: ✓
```

**API Call**:
```json
POST /api/musician/upload
Content-Type: multipart/form-data
{
  "audio": <binary file>
}

// Then:
POST /api/musician/analyze
{
  "fileId": "audio_123456",
  "analysisType": "mixdown",
  "genre": "indie rock",
  "userQuestions": [
    "Check for low-end buildup",
    "Assess vocal presence",
    "Evaluate stereo width",
    "Identify translation issues"
  ],
  "listeningContext": "streaming",
  "includeTechnicalMetrics": true,
  "includeActionPlan": true
}
```

**Expected Response Shape**:
```json
{
  "success": true,
  "metrics": {
    "durationSeconds": 205.3,
    "sampleRate": 44100,
    "channels": 2,
    "integratedLufs": -12.4,
    "truePeakDbtp": -0.8,
    "peakDbfs": -0.2,
    "dynamicRange": 6.8,
    "stereoWidth": 68,
    "phaseCorrelation": 0.82,
    "tempoBpm": 128,
    "keyEstimate": "E major",
    "spectralBalance": {
      "low": 4,
      "sub": 6,
      "lowMid": 2,
      "mid": -1,
      "highMid": 0,
      "high": 1
    }
  },
  "report": {
    "summary": "Mix shows strong fundamental elements but has low-frequency buildup in the 200-400Hz range causing muddiness. Vocal presence is adequate at -14dB relative to mix but could benefit from high-mid boost. Stereo width is appropriate for genre but has minor phase correlation issues in low-end.",
    "strengths": [
      "Good overall loudness (-12.4 LUFS) appropriate for streaming",
      "Strong transient preservation (DR 6.8)",
      "Vocals are intelligible and sit well in the mix",
      "Stereo imaging is wide without excessive processing"
    ],
    "issues": [
      "Low-mid buildup (200-400Hz) causing muddiness",
      "Excessive sub-bass energy (80-100Hz) may not translate to small speakers",
      "Vocal high-mid presence (2-4kHz) could be more forward",
      "Phase correlation dips to 0.65 in low frequencies",
      "True peak at -0.8dBTP leaves little headroom for mastering"
    ],
    "frequencyBalance": {
      "overallAssessment": "muddy",
      "bassEnergy": "excessive",
      "midClarity": "muffled",
      "highExtension": "sparkle",
      "frequencyGauge": {
        "sub": 6,
        "bass": 4,
        "lowMid": 2,
        "mid": -1,
        "highMid": 0,
        "high": 1
      }
    },
    "dynamics": {
      "overallAssessment": "moderate",
      "compressionAmount": "moderate",
      "punch": "preserved",
      "sustain": "natural",
      "loudnessLufs": -12.4
    },
    "stereoImage": {
      "overallAssessment": "wide",
      "width": 68,
      "centerImageStability": "stable",
      "panningBalance": "balanced",
      "stereoToolsUsed": ["Stereo widening on guitars", "Haas effect on vocals"]
    },
    "lowEnd": {
      "overallAssessment": "muddy",
      "subBass": "uncontrolled",
      "kickDrum": "loose",
      "bassClarity": "muddy",
      "phaseIssues": true
    },
    "translationRisks": [
      "Excessive low-end will disappear on laptop/phone speakers",
      "Muddy 200-400Hz buildup will worsen on small speakers",
      "Phase issues in bass may cause cancellation in mono playback",
      "Vocal may get buried on earbuds due to lack of high-mid presence"
    ],
    "prioritizedFixes": [
      {
        "priority": "critical",
        "issue": "Low-mid buildup (200-400Hz) causing muddiness",
        "recommendation": "Apply high-pass filter at 80Hz on all non-bass instruments. Use EQ to cut 2-3dB in 200-400Hz range on guitars and keys.",
        "estimatedImpact": "Significant clarity improvement, especially on small speakers"
      },
      {
        "priority": "high",
        "issue": "Excessive sub-bass (80-100Hz)",
        "recommendation": "Reduce bass guitar low shelf by 2-3dB. Tighten kick drum EQ. Check for overlapping bass and kick frequencies.",
        "estimatedImpact": "Better translation to small speakers, tighter low end"
      },
      {
        "priority": "high",
        "issue": "Vocal presence in high-mids (2-4kHz)",
        "recommendation": "Boost vocal EQ by 2-3dB at 3kHz (bell/peaking). Add slight saturation for harmonic excitement.",
        "estimatedImpact": "Vocals will cut through mix better, more intelligibility"
      },
      {
        "priority": "medium",
        "issue": "Phase correlation issues in low end",
        "recommendation": "Check bass and kick for phase alignment. Consider mono-ing everything below 120Hz using mid-side EQ or utility plugin.",
        "estimatedImpact": "Better mono compatibility, tighter bass response"
      },
      {
        "priority": "low",
        "issue": "True peak headroom",
        "recommendation": "Reduce output level by 1dB or apply gentle limiting to keep true peaks below -1.0dBTP for mastering headroom.",
        "estimatedImpact": "Safer for mastering, prevents inter-sample peaks"
      }
    ],
    "suggestedPluginsOrProcesses": [
      {
        "purpose": "Reduce low-mid buildup on guitars",
        "type": "eq_parametric",
        "suggestedChain": [
          "High-pass filter at 80Hz (12dB/oct or steeper)",
          "Parametric cut: -3dB at 250Hz, Q=1.5",
          "Parametric cut: -2dB at 350Hz, Q=1.0"
        ]
      },
      {
        "purpose": "Tighten bass and kick relationship",
        "type": "eq_parametric",
        "suggestedChain": [
          "Bass: Low shelf -2dB at 80Hz",
          "Bass: Bell boost +1.5dB at 150Hz (fundamental)",
          "Kick: Bell boost +2dB at 60Hz (punch)",
          "Kick: Notch cut -3dB at 150Hz (clear space for bass)"
        ]
      },
      {
        "purpose": "Enhance vocal presence",
        "type": "eq_peaking",
        "suggestedChain": [
          "Parametric boost: +3dB at 3kHz, Q=1.2",
          "Parametric boost: +1dB at 8kHz, Q=0.8 (air)",
          "High-pass filter at 100Hz (remove rumble)"
        ]
      },
      {
        "purpose": "Fix phase issues in low end",
        "type": "stereo_midi",
        "suggestedChain": [
          "Mid-side EQ: Mono (sides to 0%) below 120Hz",
          "Or: Utility plugin to collapse stereo width below 120Hz"
        ]
      },
      {
        "purpose": "Control true peaks",
        "type": "limiter_true",
        "suggestedChain": [
          "True peak limiter on master bus",
          "Threshold: -1.0dBTP",
          "Very short attack (0.1ms) and release (50ms)"
        ]
      }
    ],
    "confidence": 0.85
  },
  "warnings": [
    "Essentia analysis not available - using ffprobe metadata and deterministic analysis only",
    "True peak measurement estimated - for production, use pyloudnorm or ebur128"
  ]
}
```

**Backend Requirements**:
- **Minimal**: ffprobe for basic metadata
- **Enhanced**: Essentia for spectral analysis
- **Full**: LUFS/true peak measurement via pyloudnorm
- Mix feedback generation is deterministic based on metrics

**Fallback Behavior**:
- **If no Essentia**: Use estimated spectral balance from ffprobe
- **If no LUFS meter**: Estimate from peak levels
- **Always returns**: Deterministic mix feedback based on available metrics
- **Warnings added**: Lists which backends are unavailable

**QA Verification**:
- [ ] Technical metrics extracted (duration, sample rate, LUFS, etc.)
- [ ] Frequency balance analyzed (identifies muddy/thin/harsh)
- [ ] Specific EQ suggestions provided with frequencies and dB values
- [ ] Translation risks identified
- [ ] Prioritized fixes listed with impact estimates
- [ ] Plugin recommendations include specific parameter suggestions
- [ ] User's specific questions addressed (low-end, vocal, stereo, translation)
- [ ] Confidence score reflects backend availability

---

### Scenario 4.2: Electronic Music Mix Check

**User Prompt**:
```
Analysis Type: mixdown
Genre: drum-and-bass
Listening Context: club
User Questions: "Is the sub-bass powerful enough? Are the drums punchy? Will this cut through a club system?"
```

**Expected Response Elements**:
- Genre-specific analysis (D&B targets: -7 to -5 LUFS, heavy sub)
- Sub-bass assessment (60-80Hz energy)
- Transient preservation check
- Loudness war considerations for club playback
- Stereo width appropriate for large systems
- Phase coherence in bass for mono club systems

**Backend Requirements**: Same as Scenario 4.1

---

## 5. Mastering Feedback

### Scenario 5.1: Streaming Master Check

**User Prompt**:
```
Analysis Type: mastering
Genre: pop
Target References: "Modern streaming releases"
User Questions: "Check whether this master is ready for streaming and suggest final export settings"
Include Technical Metrics: ✓
```

**API Call**:
```json
POST /api/musician/analyze
{
  "fileId": "audio_789012",
  "analysisType": "mastering",
  "genre": "pop",
  "targetReferences": ["Modern streaming releases"],
  "userQuestions": ["Is this ready for streaming?", "What export settings should I use?"],
  "includeTechnicalMetrics": true
}
```

**Expected Response Shape**:
```json
{
  "success": true,
  "metrics": {
    "durationSeconds": 198.5,
    "sampleRate": 44100,
    "channels": 2,
    "integratedLufs": -14.1,
    "truePeakDbtp": -1.2,
    "loudnessRange": 4.5,
    "dynamicRange": 5.2,
    "phaseCorrelation": 0.91
  },
  "report": {
    "releaseReadiness": "ready",
    "loudness": {
      "currentLufs": -14.1,
      "targetLufs": -14.0,
      "loudnessRange": 4.5,
      "luRange": "4-6 (moderate compression, appropriate for pop)",
      "streamingNormalization": "already_normalized",
      "loudnessWarStatus": "moderate"
    },
    "truePeak": {
      "measuredDbtp": -1.2,
      "maxAllowedDbtp": -1.0,
      "headroom": 0.2,
      "interSamplePeak": false
    },
    "dynamics": {
      "dynamicRange": 5.2,
      "compressorsUsed": ["Multiband compression", "Brick-wall limiting"],
      "limitingCycles": 2,
      "punchRetained": true,
      "loudnessVersusDynamicRange": "moderate"
    },
    "tonalBalance": {
      "overallAssessment": "balanced",
      "bass": 0,
      "midrange": 1,
      "treble": 0,
      "consistency": "consistent"
    },
    "streamingReadiness": {
      "spotify": "ready",
      "appleMusic": "ready",
      "youtube": "ready",
      "soundcloud": "ready",
      "bandcamp": "ready"
    },
    "prioritizedFixes": [
      {
        "priority": "low",
        "issue": "True peak slightly above -1.0dBTP recommendation",
        "masteringSolution": "Apply gentle true peak limiting to bring peaks to -1.0dBTP or lower",
        "pluginType": "limiter_true"
      }
    ],
    "exportRecommendations": {
      "idealFormat": "wav",
      "bitDepth": "24",
      "sampleRate": "44.1",
      "ditherRecommended": false,
      "ditherType": "noise-shaped",
      "exportChain": [
        "Ensure no clipping on output",
        "True peak limit to -1.0dBTP",
        "Export as 24-bit WAV at 44.1kHz",
        "Do NOT apply dither (already at 24-bit)",
        "Use lossless format for distribution masters"
      ],
      "clippingCheck": "passed"
    }
  },
  "warnings": [
    "Loudness measurement based on estimated values - for final release, use professional LUFS meter"
  ]
}
```

**Backend Requirements**:
- **Minimal**: ffprobe for metadata
- **Recommended**: pyloudnorm or ebur128 for accurate LUFS
- Mastering feedback is deterministic based on measurements

**Fallback Behavior**:
- If no LUFS meter: Estimate from peak measurements
- If no true peak meter: Estimate from standard peak
- Always provides export recommendations
- Warnings indicate measurement confidence

**QA Verification**:
- [ ] Release readiness clearly stated
- [ ] Loudness compared to streaming targets (-14 LUFS)
- [ ] True peak headroom verified (<-1.0dBTP)
- [ ] Streaming platform readiness for all major platforms
- [ ] Specific export settings provided (format, bit depth, sample rate)
- [ ] Dithering recommendation based on bit depth
- [ ] Export chain with step-by-step instructions

---

## 6. Practice Planning

### Scenario 6.1: Bass Groove and Walking Lines

**User Prompt**:
```
Instrument: bass
Goal: Create a 30-minute daily practice routine for intermediate bass focused on groove, arpeggios, and walking lines
Minutes per Day: 30
Days per Week: 5
Current Skill Level: intermediate
```

**API Call**:
```json
POST /api/musician/practice-plan
{
  "instrument": "bass",
  "goal": "focused on groove, arpeggios, and walking lines",
  "minutesPerDay": 30,
  "daysPerWeek": 5,
  "skillLevel": "intermediate"
}
```

**Expected Response Shape**:
```json
{
  "success": true,
  "content": "# 30-Minute Daily Bass Practice Plan\n\n**Focus**: Groove, Arpeggios, Walking Lines\n**Skill Level**: Intermediate\n**Frequency**: 5 days/week\n\n---\n\n## Daily Structure\n\n### Warm-up (5 minutes)\n\n**Minutes 0-3: Chromatic Exercise**\n- Start on E string, 1st finger on 1st fret\n- Pattern: 1-2-3-4, 1-2-3-4, 1-2-3-4, 1-2-3-4 (ascending)\n- Move across all strings (E-A-D-G)\n- Tempo: Start at 60 BPM, increase to 80 BPM\n- Focus: Clean note separation, consistent pressure\n\n**Minutes 3-5: Major Scale Review**\n- Play 2-octave major scales: E, A, D, G\n- Pattern: Up and down in 8th notes\n- Tempo: 80 BPM\n- Focus: Smooth position shifts, even tone\n\n---\n\n### Focus 1: Groove (10 minutes)\n\n**Minutes 5-10: Groove Fundamentals**\n\n**Exercise 1**: Locked Kick-Bass Pattern (3 min)\n- Play root notes on E string\n- Pattern: Quarter notes on 1-2-3-4\n- Play along with drum loop or metronome\n- Tempo: 90 BPM\n- **Key**: Play right in the pocket, slightly behind the beat\n\n**Exercise 2**: Adding the &'s (3 min)\n- Same root notes\n- Pattern: 1-&-2-&-3-&-4-& (8th notes)\n- Alternate: Root on downbeats, ghost notes on &'s\n- Tempo: 90 BPM\n- **Focus**: Finger pressure variation (loud vs. soft)\n\n**Exercise 3**: Groove Variation (4 min)\n- E Blues progression: E7 (4 bars) - A7 (2 bars) - E7 (2 bars)\n- Pattern: Root on 1 & 3, octave jump on 2 & 4\n- Add passing tones on &-of-4\n- Tempo: 100 BPM\n- **Example**:\n  ```\n  E7: E(1) - E(2) - E(3) - E(4-&) F-F#\n  ```\n\n**Variation Days**:\n- Monday/Wednesday: Practice with metronome\n- Tuesday/Thursday: Practice with drum backing track\n- Friday: Record yourself and listen back\n\n---\n\n### Focus 2: Arpeggios (8 minutes)\n\n**Minutes 10-15: Major & Minor Arpeggios**\n\n**Exercise 1**: Triad Arpeggios (3 min)\n- Major triads: C, F, G\n- Minor triads: Am, Dm, Em\n- Pattern: Root-3rd-5th-Octave, descending\n- Tempo: 80 BPM\n- **Positions**: Practice in multiple positions\n  - Cmaj: 3rd fret (E string root)\n  - Cmaj: 8th fret (A string root)\n\n**Exercise 2**: 7th Chord Arpeggios (5 min)\n- Dominant 7th: C7, F7, G7\n- Minor 7th: Am7, Dm7, Em7\n- Pattern: Root-3rd-5th-7th-Octave, ascending & descending\n- Tempo: 70 BPM\n- **Application**: Play over ii-V-I progression (Dm7-G7-Cmaj7)\n\n**Example Arpeggio**:\n```\nCmaj7:\nE|---3---5---7---8---\nA|-------------------\nD|-------------------\nG|-------------------\nRoot-3rd-5th-7th\n```\n\n**Progressive Challenge**:\n- Week 1: Major and minor triads\n- Week 2: Add dominant 7th\n- Week 3: Add minor 7th and major 7th\n- Week 4: Combine into progressions\n\n---\n\n### Focus 3: Walking Lines (7 minutes)\n\n**Minutes 15-22: Jazz Walking Bass**\n\n**Exercise 1**: Quarter Note Walking (3 min)\n- Progression: Cmaj7 - Am7 - Dm7 - G7\n- Pattern: Quarter notes on each beat\n- Rules:\n  1. Beat 1: Root\n  2. Beat 2: 3rd or 5th\n  3. Beat 3: Passing tone\n  4. Beat 4: Approach note (half-step or chromatic to next root)\n- Tempo: 120 BPM\n\n**Example Line Over Cmaj7**:\n```\nBeats: 1   2   3   4\nNotes: C - E - F - G# (approaches Am)\n```\n\n**Exercise 2**: Adding Chord Tones (4 min)\n- Same progression\n- Expand vocabulary:\n  - Use scale tones (major scale)\n  - Add chromatic passing tones\n  - Target strong chord tones on strong beats (1 & 3)\n- Tempo: 120 BPM\n\n**Example Expanded Line**:\n```\nCmaj7:  C - G - A - B (approaches C of Am7)\nAm7:    A - C - D - Eb (chromatic approach to D)\nDm7:    D - F - G - Ab (chromatic approach to G)\nG7:     G - B - D - C (resolves to C)\n```\n\n**Variation**:\n- Monday: Focus on root-5th movement\n- Tuesday: Add 3rds and 7ths\n- Wednesday: Chromatic passing tones\n- Thursday: Combine all concepts\n- Friday: Play over backing track, improvise\n\n---\n\n## Cool-down & Application (5 minutes)\n\n**Minutes 22-27: Play Along (4 min)**\n- Choose a song you love (jazz, blues, or funk)\n- Play along, applying concepts learned:\n  - Groove: Lock with drums\n  - Arpeggios: Outline chord changes\n  - Walking: Create movement and interest\n- **Songs to Try**:\n  - Blues: \"Blue Monk\" (Thelonious Monk)\n  - Jazz: \"Autumn Leaves\"\n  - Funk: \"Cissy Strut\" (The Meters)\n\n**Minutes 27-30: Reflection (3 min)**\n- Play freely, experiment\n- Review what felt good today\n- Note areas to focus on tomorrow\n- **Journal Prompt**: What groove/line felt most natural?\n\n---\n\n## Weekly Progress Milestones\n\n### Week 1: Foundation\n- [ ] Comfortable with major/minor arpeggios in 2 positions\n- [ ] Can lock groove with metronome at 90 BPM\n- [ ] Can create basic walking line over ii-V-I\n\n### Week 2: Expansion\n- [ ] Added 7th chord arpeggios\n- [ ] Comfortable with groove variations (adding &'s)\n- [ ] Using chromatic passing tones in walking lines\n\n### Week 3: Fluency\n- [ ] Can play arpeggios in 3+ positions\n- [ ] Groove feels natural, slightly behind beat\n- [ ] Walking lines flow smoothly through chord changes\n\n### Week 4: Application\n- [ ] Can play along with backing tracks confidently\n- [ ] Improvising walking lines over unfamiliar progressions\n- [ ] Mixing groove concepts (locked vs. loose)\n\n---\n\n## Practice Tips\n\n1. **Use a Metronome**: Always. Start slow, increase gradually.\n2. **Record Yourself**: Weekly recordings help track progress.\n3. **Finger Placement**: Keep fingers close to strings for efficiency.\n4. **Tone**: Aim for even volume across all notes.\n5. **Relax**: Tension kills groove. Stay loose.\n6. **Listen**: Spend time listening to great bassists:\n   - James Jamerson (groove)\n   - Jaco Pastorius (arpeggios)\n   - Ron Carter (walking lines)\n\n---\n\n## Adjust for Shorter/Longer Sessions\n\n**20-Minute Version**:\n- Warm-up: 3 min\n- Groove: 6 min\n- Arpeggios: 5 min\n- Walking: 4 min\n- Cool-down: 2 min\n\n**45-Minute Version**:\n- Warm-up: 7 min\n- Groove: 15 min (add slap/fingerstyle variation)\n- Arpeggios: 12 min (add diminished, augmented)\n- Walking: 10 min (add II-V-I in multiple keys)\n- Cool-down: 8 min\n\n---\n\n## Resources\n\n**Books**:\n- \"Building Walking Bass Lines\" by Ed Friedland\n- \"The Improviser's Bass Method\" by Chuck Sher\n\n**Backing Tracks**:\n- iRealPro app (jazz progressions)\n- YouTube: \"Jazz bass backing tracks\"\n\n**Metronome Apps**:\n- Soundbrenner\n- Pro Metronome\n\n---\n\nStay consistent, have fun, and groove on! 🎸"
}
```

**Backend Requirements**: None (deterministic practice plan generation)

**Fallback Behavior**: Always succeeds

**QA Verification**:
- [ ] 30-minute structure provided
- [ ] All three focus areas covered (groove, arpeggios, walking lines)
- [ ] Warm-up and cool-down included
- [ ] Specific exercises with notation/tabs
- [ ] Tempo markings provided
- [ ] Progressive difficulty (Week 1-4 milestones)
- [ ] Practice tips and resources included
- [ ] Variations for different session lengths

---

### Scenario 6.2: Piano Sight-Reading Improvement

**User Prompt**:
```
Instrument: piano
Goal: Improve sight-reading speed and accuracy
Minutes per Day: 45
Days per Week: 6
Skill Level: advanced
```

**Expected Response Elements**:
- Daily sight-reading exercises
- Progressive difficulty levels
- Rhythm and note reading drills
- Chunking techniques for complex passages
- Hand independence exercises
- Weekly sight-reading challenges

---

## 7. Sample Generation

### Scenario 7.1: Lo-Fi Hip-Hop Loop

**User Prompt**:
```
Prompt: "Generate a 12-second lo-fi hip-hop loop with dusty drums, mellow Rhodes chords, vinyl noise, and a simple bassline"
Duration: 12 seconds
Genre: hip-hop
Mood: relaxed
Tempo: 85 BPM
Dry Run: false
```

**API Call**:
```json
POST /api/musician/generate
{
  "prompt": "lo-fi hip-hop loop with dusty drums, mellow Rhodes chords, vinyl noise, and a simple bassline",
  "durationSeconds": 12,
  "genre": "hip-hop",
  "mood": "relaxed",
  "tempo": 85,
  "dryRun": false
}
```

**Expected Response Shape (Mock Mode)**:
```json
{
  "success": true,
  "assetId": "mock_gen_1234567890_abc123",
  "filePath": "/data/musician/generated/mock_gen_1234567890_abc123_metadata.json",
  "durationSeconds": 12,
  "prompt": "lo-fi hip-hop loop with dusty drums, mellow Rhodes chords, vinyl noise, and a simple bassline",
  "model": "mock-v1",
  "seed": 847392,
  "createdAt": "2026-05-17T10:30:00.000Z",
  "metadata": {
    "genre": "hip-hop",
    "mood": "relaxed",
    "tempo": 85,
    "key": "C",
    "duration": 12,
    "modelVersion": "mock-v1.0.0",
    "generationTimeSeconds": 0,
    "license": "personal"
  },
  "warnings": [
    "Mock mode: This is a sample generation. No actual audio was created.",
    "To generate real audio, configure MUSICIAN_GENERATION_PROVIDER environment variable.",
    "Metadata file created at: /data/musician/generated/mock_gen_1234567890_abc123_metadata.json"
  ]
}
```

**Expected Response Shape (Real Generation)**:
```json
{
  "success": true,
  "assetId": "gen_1234567890_xyz789",
  "filePath": "/data/musician/generated/gen_1234567890_xyz789.wav",
  "durationSeconds": 12,
  "prompt": "lo-fi hip-hop loop with dusty drums, mellow Rhodes chords, vinyl noise, and a simple bassline",
  "model": "facebook/musicgen-small",
  "seed": 847392,
  "createdAt": "2026-05-17T10:30:00.000Z",
  "metadata": {
    "genre": "hip-hop",
    "mood": "relaxed",
    "tempo": 85,
    "key": "C",
    "duration": 12,
    "modelVersion": "facebook/musicgen-small",
    "generationTimeSeconds": 8.5,
    "license": "personal"
  },
  "warnings": []
}
```

**Backend Requirements**:
- **Mock Mode**: No backend required
- **Local Generation**: MusicGen with Python worker
- **HuggingFace**: API token and endpoint

**Fallback Behavior**:
- If worker unavailable: Mock mode
- If prompt unsafe: Rejection with alternative suggestion
- If duration exceeds 60s: Capped at 60s with warning

**QA Verification**:
- [ ] Prompt accepted (no artist names)
- [ ] Duration is 12 seconds
- [ ] Response includes asset ID
- [ ] Metadata includes all request parameters
- [ ] Warnings indicate mock vs. real generation
- [ ] Model information provided

---

### Scenario 7.2: Unsafe Prompt (Artist Soundalike)

**User Prompt (Intentionally Unsafe)**:
```
Prompt: "Make it sound exactly like a Drake song with The Weeknd vocals"
Duration: 15 seconds
```

**API Call**:
```json
POST /api/musician/generate
{
  "prompt": "Make it sound exactly like a Drake song with The Weeknd vocals",
  "durationSeconds": 15
}
```

**Expected Response (Error)**:
```json
{
  "success": false,
  "error": "Unsafe generation request: Prompt requests a direct soundalike of protected artist: Drake\nOriginal prompt: \"Make it sound exactly like a Drake song with The Weeknd vocals\"\nSuggested alternative: \"Contemporary hip-hop with modern production and R&B influences\"",
  "statusCode": 400
}
```

**QA Verification**:
- [ ] Request rejected (not generated)
- [ ] Clear error message explaining why
- [ ] Suggested alternative provided
- [ ] Status code 400 (bad request)

---

### Scenario 7.3: Dry Run Mode

**User Prompt**:
```
Prompt: "Ambient electronic soundscape with evolving pads and subtle arpeggios"
Duration: 30 seconds
Dry Run: true
```

**Expected Response**:
```json
{
  "success": true,
  "assetId": "dryrun_preview_timestamp",
  "filePath": "",
  "durationSeconds": 30,
  "prompt": "Ambient electronic soundscape with evolving pads and subtle arpeggios",
  "model": "preview-mode",
  "seed": 0,
  "metadata": {
    "genre": "ambient",
    "duration": 30,
    "preview": true
  },
  "warnings": [
    "Dry run mode: Prompt validated but no audio generated",
    "Estimated generation time: 12-15 seconds",
    "To generate audio, set dryRun=false"
  ]
}
```

**QA Verification**:
- [ ] No actual audio generated
- [ ] Prompt validated (accepted or rejected)
- [ ] Estimated generation time provided
- [ ] Clear indication this is a preview

---

## 8. Audio Transcription

### Scenario 8.1: Guitar Riff Transcription

**User Prompt**:
```
Analysis Type: transcription
Genre: rock
User Questions: "Transcribe this guitar riff into notes/tabs/MIDI-style output and suggest harmonization options"
```

**API Call**:
```json
POST /api/musician/upload
// Upload guitar riff audio file

POST /api/musician/analyze
{
  "fileId": "audio_riff_123",
  "analysisType": "transcription",
  "genre": "rock",
  "userQuestions": [
    "Transcribe to notes and tabs",
    "Suggest harmonization options"
  ]
}
```

**Expected Response Shape (Full Backend)**:
```json
{
  "success": true,
  "metrics": {
    "durationSeconds": 8.5,
    "sampleRate": 44100,
    "channels": 1,
    "tempoBpm": 120,
    "keyEstimate": "E minor"
  },
  "report": "# Guitar Riff Transcription\n\n## Detected Notes\n\nThe riff consists of the following notes:\n\n**Measure 1**:\n- E (0.00s - 0.25s) - Low E string, open\n- G (0.25s - 0.50s) - Low E string, 3rd fret\n- A (0.50s - 0.75s) - A string, open\n- B (0.75s - 1.00s) - A string, 2nd fret\n\n**Measure 2**:\n- D (1.00s - 1.25s) - D string, open\n- E (1.25s - 1.50s) - D string, 2nd fret\n- G (1.50s - 1.75s) - D string, 5th fret\n- A (1.75s - 2.00s) - D string, 7th fret\n\n## Guitar Tablature\n\n```\nE|---------------|\nB|---------------|\nG|---------------|\nD|---0-2-5-7-----|\nA|-0-2-----------|\nE|-0-3-----------|\n   ↑ measure 1\n```\n\n## MIDI-Style Output\n\n```\nTime (s) | Note | MIDI# | Velocity | Duration\n---------|------|-------|----------|----------\n0.00     | E2   | 40    | 80       | 0.25s\n0.25     | G2   | 43    | 85       | 0.25s\n0.50     | A2   | 45    | 82       | 0.25s\n0.75     | B2   | 47    | 88       | 0.25s\n1.00     | D3   | 50    | 80       | 0.25s\n1.25     | E3   | 52    | 78       | 0.25s\n1.50     | G3   | 55    | 85       | 0.25s\n1.75     | A3   | 57    | 90       | 0.25s\n```\n\n## Harmonization Options\n\n### Option 1: Power Chords (Rock Standard)\n\nAdd a 5th above each note:\n\n```\nE5  = E + B (0th and 2nd fret, E and A strings)\nG5  = G + D\nA5  = A + E\nB5  = B + F#\nD5  = D + A\n```\n\n**Tab with Power Chords**:\n```\nE|-------------------|\nB|-------------------|\nG|-------------------|\nD|-2-5-7-9-0-2-5-7---|\nA|-2-5-7-9-0-2-5-7---|\nE|-0-3-5-7-----------|\n```\n\n### Option 2: Triad Harmony (Thirds Above)\n\nAdd a major or minor third:\n\n```\nE minor = E + G (minor 3rd)\nG major = G + B (major 3rd)\nA minor = A + C (minor 3rd)\nB diminished = B + D (minor 3rd)\n```\n\n### Option 3: Lead Guitar Counterpoint\n\nPlay a counter-melody in a higher register:\n\n```\nE|--12-10-8-7--------| (High E string)\nB|-------------------|\nG|-------------------|\nD|---0-2-5-7---------| (Original riff)\nA|-------------------|\nE|-------------------|\n```\n\nUses E minor pentatonic scale (E-G-A-B-D) for melodic continuity.\n\n## Key and Scale Analysis\n\n**Detected Key**: E minor\n**Scale**: E natural minor (E-F#-G-A-B-C-D)\n**Chord Progression Implied**: Em - G - Am - Bm\n\n## Performance Notes\n\n- Tempo: 120 BPM (quarter note = 120)\n- Time Signature: 4/4\n- Playing Style: Palm-muted power chords for verses, open chords for chorus\n- Suggested Techniques: Alternate picking, slight vibrato on sustained notes",
  "transcription": {
    "notes": [
      { "pitch": "E2", "startTime": 0.00, "endTime": 0.25, "velocity": 80, "confidence": 0.92 },
      { "pitch": "G2", "startTime": 0.25, "endTime": 0.50, "velocity": 85, "confidence": 0.89 },
      { "pitch": "A2", "startTime": 0.50, "endTime": 0.75, "velocity": 82, "confidence": 0.91 },
      { "pitch": "B2", "startTime": 0.75, "endTime": 1.00, "velocity": 88, "confidence": 0.94 },
      { "pitch": "D3", "startTime": 1.00, "endTime": 1.25, "velocity": 80, "confidence": 0.87 },
      { "pitch": "E3", "startTime": 1.25, "endTime": 1.50, "velocity": 78, "confidence": 0.90 },
      { "pitch": "G3", "startTime": 1.50, "endTime": 1.75, "velocity": 85, "confidence": 0.93 },
      { "pitch": "A3", "startTime": 1.75, "endTime": 2.00, "velocity": 90, "confidence": 0.95 }
    ],
    "midiPath": "/tmp/transcription_riff_123.mid"
  },
  "warnings": [],
  "confidence": 0.91
}
```

**Expected Response Shape (Fallback - No Basic Pitch)**:
```json
{
  "success": true,
  "metrics": {
    "durationSeconds": 8.5,
    "sampleRate": 44100,
    "channels": 1
  },
  "report": "# Guitar Riff Analysis\n\nTranscription feature requires Basic Pitch backend.\n\n## Available Information\n\n- Duration: 8.5 seconds\n- Format: Mono audio\n- Sample Rate: 44100 Hz\n\n## Transcription Unavailable\n\nTo enable automatic transcription:\n1. Install Basic Pitch Python worker\n2. Set MUSICIAN_ENABLE_BASIC_PITCH=true\n3. Re-run analysis\n\n## Manual Transcription Tips\n\nFor manual transcription:\n1. Slow down audio using DAW (50-75% speed)\n2. Identify root notes first\n3. Use spectrogram to visualize pitch\n4. Transcribe rhythm before pitch\n5. Check against reference tuning (A=440Hz)\n\n## Harmonization Planning\n\nWithout note data, consider:\n- Determine key by ear\n- Use parallel harmonies (3rds, 5ths, 6ths)\n- Try power chords for rock context\n- Add counterpoint in higher register",
  "transcription": undefined,
  "warnings": [
    "Basic Pitch transcription not available - backend not configured",
    "Install Python worker and enable MUSICIAN_ENABLE_BASIC_PITCH=true",
    "Manual transcription required"
  ],
  "confidence": 0.3
}
```

**Backend Requirements**:
- **Full**: Basic Pitch for note detection
- **Partial**: Essentia for key/tempo detection
- **Minimal**: ffprobe for metadata only

**Fallback Behavior**:
- If Basic Pitch unavailable: Return helpful manual transcription guide
- If file too complex: Lower confidence, warn about potential errors
- Always provide key/tempo if Essentia available

**QA Verification**:
- [ ] Notes detected with timestamps
- [ ] Guitar tablature generated
- [ ] MIDI-style note list provided
- [ ] Harmonization options suggested (at least 3)
- [ ] Key and scale analysis included
- [ ] Performance notes for context
- [ ] Confidence scores per note
- [ ] Graceful degradation if backend unavailable

---

## Summary: QA Test Matrix

| Scenario | Tool | Backend Required | Fallback OK | QA Priority |
|----------|------|------------------|-------------|-------------|
| 1.1 Secondary Dominants | Theory | None | N/A | High |
| 1.2 Modal Scales | Theory | None | N/A | Medium |
| 2.1 Synthwave Progression | Composition | None | N/A | High |
| 2.2 Indie Pop Structure | Composition | None | N/A | Medium |
| 3.1 Full Band Arrangement | Composition | None | N/A | High |
| 4.1 Rough Mix Analysis | Audio Analysis | Essentia + LUFS | ✓ | Critical |
| 4.2 D&B Mix Check | Audio Analysis | Essentia + LUFS | ✓ | Medium |
| 5.1 Streaming Master | Mastering | LUFS meter | ✓ | Critical |
| 6.1 Bass Practice Plan | Practice | None | N/A | High |
| 6.2 Piano Sight-Reading | Practice | None | N/A | Low |
| 7.1 Lo-Fi Loop | Generation | MusicGen worker | ✓ | High |
| 7.2 Unsafe Prompt | Generation | None (validation) | N/A | Critical |
| 7.3 Dry Run | Generation | None | N/A | Medium |
| 8.1 Guitar Transcription | Transcription | Basic Pitch | ✓ | High |

---

## Manual QA Checklist

For each scenario:

- [ ] Request accepted with valid parameters
- [ ] Response format matches specification
- [ ] Response time acceptable (<30s for most, <60s for generation)
- [ ] Error messages clear and actionable
- [ ] Warnings included when backends unavailable
- [ ] Confidence scores realistic
- [ ] No artist names or copyrighted material in examples
- [ ] Style-neutral language used throughout
- [ ] Markdown formatting renders correctly
- [ ] Technical accuracy verified (music theory, notation)

---

**Document Version**: 1.0
**Last Updated**: 2026-05-17
**Maintained By**: AI Work Assistant - Musician Assistant Team
