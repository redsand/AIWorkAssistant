/**
 * Composition and Songwriting Helpers
 *
 * Deterministic functions for generating chord progressions, arrangements,
 * melody guidance, lyric structures, and music theory analysis.
 */

// =============================================================================
// Music Theory Constants
// =============================================================================

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

// Scale intervals (semitones from root)
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], // Natural minor
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],

  // Modes
  ionian: [0, 2, 4, 5, 7, 9, 11], // Major
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10], // Natural minor
  locrian: [0, 1, 3, 5, 6, 8, 10],

  // Other scales
  blues: [0, 3, 5, 6, 7, 10],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
};

// Diatonic chord qualities for major and minor keys
const DIATONIC_CHORDS = {
  major: ["", "m", "m", "", "", "m", "dim"], // I, ii, iii, IV, V, vi, vii°
  minor: ["m", "dim", "", "m", "m", "", ""], // i, ii°, III, iv, v, VI, VII
};

const DIATONIC_SEVENTHS = {
  major: ["maj7", "m7", "m7", "maj7", "7", "m7", "m7b5"], // Imaj7, iim7, iiim7, IVmaj7, V7, vim7, viim7b5
  minor: ["m7", "m7b5", "maj7", "m7", "m7", "maj7", "7"], // im7, iim7b5, IIImaj7, ivm7, vm7, VImaj7, VII7
};

// Roman numerals
const ROMAN_NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII"];
const ROMAN_NUMERALS_LOWER = ["i", "ii", "iii", "iv", "v", "vi", "vii"];

// Common progressions by genre
const COMMON_PROGRESSIONS = {
  pop: [
    { name: "Four Chords", progression: [1, 5, 6, 4], nashville: "1-5-6-4", description: "I-V-vi-IV - Most popular pop progression" },
    { name: "Sensitive", progression: [6, 4, 1, 5], nashville: "6-4-1-5", description: "vi-IV-I-V - Emotional and building" },
    { name: "Canon", progression: [1, 5, 6, 3, 4, 1, 4, 5], nashville: "1-5-6-3-4-1-4-5", description: "I-V-vi-iii-IV-I-IV-V - Pachelbel Canon" },
    { name: "50s", progression: [1, 6, 4, 5], nashville: "1-6-4-5", description: "I-vi-IV-V - Classic doo-wop" },
  ],
  rock: [
    { name: "Basic Rock", progression: [1, 4, 5], nashville: "1-4-5", description: "I-IV-V - Foundation of rock" },
    { name: "Blues Rock", progression: [1, 1, 4, 1, 5, 4, 1, 5], nashville: "1-1-4-1-5-4-1-5", description: "12-bar blues structure" },
    { name: "Power Ballad", progression: [1, 5, 6, 4], nashville: "1-5-6-4", description: "I-V-vi-IV - Rock ballad staple" },
    { name: "Phrygian Rock", progression: [6, 7, 1], nashville: "b6-b7-1", description: "bVI-bVII-i - Metal/Spanish rock" },
  ],
  jazz: [
    { name: "ii-V-I", progression: [2, 5, 1], nashville: "2-5-1", description: "iim7-V7-Imaj7 - Most important jazz cadence" },
    { name: "I-vi-ii-V", progression: [1, 6, 2, 5], nashville: "1-6-2-5", description: "Imaj7-vim7-iim7-V7 - Turnaround" },
    { name: "Autumn Leaves", progression: [2, 5, 1, 4, 7, 3, 6], nashville: "2-5-1-4-7-3-6", description: "iim7-V7-Imaj7-IVmaj7-vii°7-iiim7-vim7" },
    { name: "Rhythm Changes", progression: [1, 6, 2, 5], nashville: "1-6-2-5", description: "Based on 'I Got Rhythm'" },
  ],
  blues: [
    { name: "12-Bar Blues", progression: [1, 1, 1, 1, 4, 4, 1, 1, 5, 4, 1, 5], nashville: "1-1-1-1-4-4-1-1-5-4-1-5", description: "Classic 12-bar blues" },
    { name: "8-Bar Blues", progression: [1, 4, 1, 5, 4, 1, 5, 1], nashville: "1-4-1-5-4-1-5-1", description: "Compact blues form" },
    { name: "Minor Blues", progression: [1, 1, 1, 1, 4, 4, 1, 1, 5, 4, 1, 5], nashville: "1-1-1-1-4-4-1-1-5-4-1-5", description: "12-bar in minor key" },
  ],
  folk: [
    { name: "Singer-Songwriter", progression: [1, 4, 6, 5], nashville: "1-4-6-5", description: "I-IV-vi-V - Folk standard" },
    { name: "Ballad", progression: [1, 5, 6, 4], nashville: "1-5-6-4", description: "I-V-vi-IV - Storytelling progression" },
    { name: "Modal Folk", progression: [1, 7, 4], nashville: "1-b7-4", description: "Mixolydian vibe" },
  ],
  electronic: [
    { name: "EDM Build", progression: [6, 4, 1, 5], nashville: "6-4-1-5", description: "vi-IV-I-V - Drop progression" },
    { name: "Minimal", progression: [1, 6], nashville: "1-6", description: "I-vi - Two-chord hypnosis" },
    { name: "Progressive", progression: [1, 3, 6, 4], nashville: "1-3-6-4", description: "I-iii-vi-IV - Melodic progression" },
  ],
};

// Cadence types
const CADENCES = {
  authentic: { chords: [5, 1], name: "Authentic Cadence", description: "V-I, strongest resolution" },
  plagal: { chords: [4, 1], name: "Plagal Cadence", description: "IV-I, 'Amen' cadence" },
  half: { chords: [1, 5], name: "Half Cadence", description: "Any-V, leaves tension" },
  deceptive: { chords: [5, 6], name: "Deceptive Cadence", description: "V-vi, unexpected resolution" },
};

// =============================================================================
// Types
// =============================================================================

export interface ChordProgressionOptions {
  key: string;
  mode?: "major" | "minor" | "dorian" | "phrygian" | "lydian" | "mixolydian" | "aeolian" | "locrian";
  genre?: "pop" | "rock" | "jazz" | "blues" | "folk" | "electronic" | "custom";
  mood?: "happy" | "sad" | "dark" | "bright" | "tense" | "relaxed" | "energetic";
  complexity?: "simple" | "moderate" | "complex";
  length?: number; // Number of chords
}

export interface ChordProgressionResult {
  progression: string[]; // Chord symbols (e.g., ["C", "Am", "F", "G"])
  nashville: string[]; // Nashville numbers (e.g., ["1", "6m", "4", "5"])
  roman: string[]; // Roman numerals (e.g., ["I", "vi", "IV", "V"])
  analysis: string;
  markdown: string;
}

export interface ArrangementMapOptions {
  genre: string;
  duration?: number; // In seconds
  sections?: string[]; // e.g., ["intro", "verse", "chorus", "bridge"]
  energyCurve?: "building" | "dynamic" | "steady" | "explosive";
}

export interface ArrangementSection {
  name: string;
  startTime: number;
  duration: number;
  energy: number; // 0-10
  description: string;
  chordSuggestion?: string;
}

export interface ArrangementMapResult {
  sections: ArrangementSection[];
  totalDuration: number;
  markdown: string;
}

export interface MelodyGuidanceOptions {
  key: string;
  chordProgression: string[];
  range?: "low" | "medium" | "high";
  style?: "stepwise" | "leaps" | "arpeggiated" | "mixed";
}

export interface MelodyGuidanceResult {
  guidance: string[];
  scaleNotes: string[];
  chordTones: Record<string, string[]>;
  markdown: string;
}

export interface LyricStructureOptions {
  theme?: string;
  genre?: string;
  rhymeDensity?: "minimal" | "moderate" | "heavy";
  sections?: string[];
}

export interface LyricStructureResult {
  structure: Array<{
    section: string;
    lines: number;
    rhymeScheme: string;
    syllablePattern?: string;
  }>;
  markdown: string;
}

export interface ChordAnalysisResult {
  key: string;
  mode: string;
  romanNumerals: string[];
  functions: string[];
  borrowedChords: string[];
  secondaryDominants: string[];
  cadences: string[];
  analysis: string;
  markdown: string;
}

export interface ReharmonizeOptions {
  progression: string[];
  key: string;
  targetMood?: "brighter" | "darker" | "jazzier" | "simpler";
  complexity?: "simple" | "moderate" | "complex";
}

export interface PracticeEtudeOptions {
  instrument: string;
  concept: string; // e.g., "arpeggios", "scales", "voice leading"
  skillLevel: "beginner" | "intermediate" | "advanced" | "pro";
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get note index from name
 */
function getNoteIndex(noteName: string): number {
  const cleanNote = noteName.replace(/[0-9]/g, "").toUpperCase();
  let index = NOTE_NAMES.indexOf(cleanNote);
  if (index === -1) {
    index = NOTE_NAMES_FLAT.indexOf(cleanNote);
  }
  return index;
}

/**
 * Get note name from index
 */
function getNoteName(index: number, useFlats: boolean = false): string {
  const normalizedIndex = ((index % 12) + 12) % 12;
  return useFlats ? NOTE_NAMES_FLAT[normalizedIndex] : NOTE_NAMES[normalizedIndex];
}

/**
 * Build scale from root and intervals
 */
function buildScale(root: string, intervals: number[]): string[] {
  const rootIndex = getNoteIndex(root);
  const useFlats = root.includes("b") || ["F", "Bb", "Eb", "Ab", "Db", "Gb"].includes(root);

  return intervals.map(interval => {
    const noteIndex = (rootIndex + interval) % 12;
    return getNoteName(noteIndex, useFlats);
  });
}

/**
 * Build chord from root and quality
 */
function buildChord(root: string, quality: string): string {
  if (!quality) return root; // Major triad
  if (quality === "m") return root + "m";
  if (quality === "dim") return root + "dim";
  return root + quality;
}

/**
 * Get scale degree chord
 */
function getScaleDegreeChord(
  key: string,
  degree: number, // 1-7
  mode: string,
  useSeventh: boolean = false
): string {
  const modeData = mode === "minor" ? "minor" : mode;
  const scale = SCALES[modeData as keyof typeof SCALES] || SCALES.major;
  const scaleNotes = buildScale(key, scale);

  const degreeIndex = degree - 1;
  if (degreeIndex < 0 || degreeIndex >= scaleNotes.length) {
    return scaleNotes[0]; // Fallback to root
  }

  const root = scaleNotes[degreeIndex];
  const chordQualities = mode === "minor" ? DIATONIC_CHORDS.minor : DIATONIC_CHORDS.major;
  const seventhQualities = mode === "minor" ? DIATONIC_SEVENTHS.minor : DIATONIC_SEVENTHS.major;

  const quality = useSeventh ? seventhQualities[degreeIndex] : chordQualities[degreeIndex];

  return buildChord(root, quality);
}

/**
 * Convert degree to Nashville number
 */
function degreeToNashville(degree: number, quality: string): string {
  let result = degree.toString();
  if (quality.includes("m") && !quality.includes("maj")) {
    result += "m";
  } else if (quality.includes("dim")) {
    result += "dim";
  } else if (quality.includes("7") && !quality.includes("maj7")) {
    result += "7";
  } else if (quality.includes("maj7")) {
    result += "maj7";
  }
  return result;
}

/**
 * Convert degree to Roman numeral
 */
function degreeToRoman(degree: number, mode: string): string {
  const chordQualities = mode === "minor" ? DIATONIC_CHORDS.minor : DIATONIC_CHORDS.major;
  const quality = chordQualities[degree - 1];
  const isMajor = quality === "" || quality === "7" || quality === "maj7";

  let roman = isMajor ? ROMAN_NUMERALS[degree - 1] : ROMAN_NUMERALS_LOWER[degree - 1];

  if (quality === "dim") {
    roman += "°";
  }

  return roman;
}

// =============================================================================
// Main Functions
// =============================================================================

/**
 * Generate chord progressions
 */
export function generateChordProgressions(options: ChordProgressionOptions): ChordProgressionResult {
  const {
    key,
    mode = "major",
    genre = "pop",
    mood = "happy",
    complexity = "moderate",
    length = 4,
  } = options;

  // Get common progressions for genre
  const genreProgressions = COMMON_PROGRESSIONS[genre as keyof typeof COMMON_PROGRESSIONS] || COMMON_PROGRESSIONS.pop;

  // Select progression based on mood, complexity, and length
  let selectedProgression = genreProgressions[0];

  // First, try to find a progression that matches the requested length
  if (length) {
    const matchingLength = genreProgressions.find(p => p.progression.length === length);
    if (matchingLength) {
      selectedProgression = matchingLength;
    }
  }

  // Then apply mood preferences
  if (mood === "sad" || mood === "dark") {
    // Prefer progressions with minor chords
    const moodMatch = genreProgressions.find(p =>
      p.progression.includes(6) && (!length || p.progression.length >= length)
    );
    if (moodMatch) {
      selectedProgression = moodMatch;
    }
  }

  // Build chord progression
  const degrees = length ? selectedProgression.progression.slice(0, length) : selectedProgression.progression;
  const useSeventh = complexity !== "simple" && genre === "jazz";

  const chords = degrees.map(degree => getScaleDegreeChord(key, degree, mode, useSeventh));
  const nashville = degrees.map((degree, i) => {
    const chord = chords[i];
    const quality = chord.replace(key, "").replace(/[A-G][#b]?/, "");
    return degreeToNashville(degree, quality);
  });
  const roman = degrees.map(degree => degreeToRoman(degree, mode));

  // Analysis
  const analysis = `${selectedProgression.name} progression in ${key} ${mode}. ${selectedProgression.description}`;

  // Markdown
  const markdown = `# Chord Progression: ${selectedProgression.name}

**Key:** ${key} ${mode}
**Genre:** ${genre}
**Mood:** ${mood}

## Progression

| Chords | Nashville | Roman |
|--------|-----------|-------|
| ${chords.join(" - ")} | ${nashville.join(" - ")} | ${roman.join(" - ")} |

## Analysis

${analysis}

## Usage Tips

${getUsageTips(genre, selectedProgression.name)}
`;

  return {
    progression: chords,
    nashville,
    roman,
    analysis,
    markdown,
  };
}

/**
 * Generate arrangement map
 */
export function generateArrangementMap(options: ArrangementMapOptions): ArrangementMapResult {
  const {
    genre,
    duration = 180, // 3 minutes default
    sections: customSections,
    energyCurve = "building",
  } = options;

  // Default section structure
  const defaultSections = ["intro", "verse", "chorus", "verse", "chorus", "bridge", "chorus", "outro"];
  const sectionNames = customSections || defaultSections;

  // Section duration percentages
  const sectionDurations: Record<string, number> = {
    intro: 8,
    verse: 15,
    chorus: 18,
    bridge: 12,
    outro: 8,
    breakdown: 10,
    solo: 15,
  };

  // Energy levels by section
  const sectionEnergy: Record<string, number> = {
    intro: 3,
    verse: 5,
    chorus: 8,
    bridge: 6,
    breakdown: 4,
    solo: 7,
    outro: 3,
  };

  // Apply energy curve
  const energyMultiplier = (index: number, total: number): number => {
    const progress = index / total;
    switch (energyCurve) {
      case "building":
        return 0.7 + (progress * 0.3);
      case "explosive":
        return progress < 0.3 ? 0.8 : 1.2;
      case "dynamic":
        return Math.sin(progress * Math.PI * 2) * 0.3 + 1;
      default:
        return 1;
    }
  };

  // Calculate total percentage to normalize durations
  const totalPercentage = sectionNames.reduce((sum, name) => sum + (sectionDurations[name] || 15), 0);
  const normalizationFactor = 100 / totalPercentage;

  // Build sections
  let currentTime = 0;
  const sections: ArrangementSection[] = sectionNames.map((name, index) => {
    const normalizedPercentage = (sectionDurations[name] || 15) * normalizationFactor;
    const baseDuration = normalizedPercentage * duration / 100;
    const baseEnergy = sectionEnergy[name] || 5;
    const adjustedEnergy = Math.min(10, baseEnergy * energyMultiplier(index, sectionNames.length));

    const section: ArrangementSection = {
      name,
      startTime: currentTime,
      duration: baseDuration,
      energy: Math.round(adjustedEnergy),
      description: getSectionDescription(name, genre),
      chordSuggestion: getSectionChordSuggestion(name),
    };

    currentTime += baseDuration;
    return section;
  });

  // Markdown
  const markdown = `# Arrangement Map

**Genre:** ${genre}
**Duration:** ${Math.round(duration)}s (${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, "0")})
**Energy Curve:** ${energyCurve}

## Section Breakdown

${sections.map(s => `### ${s.name.charAt(0).toUpperCase() + s.name.slice(1)} (${formatTime(s.startTime)} - ${formatTime(s.startTime + s.duration)})

- **Energy Level:** ${s.energy}/10
- **Duration:** ${Math.round(s.duration)}s
- **Chord Suggestion:** ${s.chordSuggestion}
- **Description:** ${s.description}
`).join("\n")}

## Timeline

\`\`\`
${sections.map(s => `${formatTime(s.startTime).padEnd(8)} | ${"█".repeat(s.energy)} ${s.name}`).join("\n")}
\`\`\`
`;

  return {
    sections,
    totalDuration: duration,
    markdown,
  };
}

/**
 * Generate melody guidance
 */
export function generateMelodyGuidance(options: MelodyGuidanceOptions): MelodyGuidanceResult {
  const { key, chordProgression, range = "medium", style = "mixed" } = options;

  // Get scale notes
  const scaleNotes = buildScale(key, SCALES.major);

  // Get chord tones for each chord
  const chordTones: Record<string, string[]> = {};
  chordProgression.forEach(chord => {
    const root = chord.replace(/[^A-G#b]/g, "");
    const rootIndex = getNoteIndex(root);

    // Build triad
    const third = getNoteName((rootIndex + (chord.includes("m") ? 3 : 4)) % 12);
    const fifth = getNoteName((rootIndex + 7) % 12);

    chordTones[chord] = [root, third, fifth];
  });

  // Generate guidance
  const guidance = chordProgression.map((chord, i) => {
    const tones = chordTones[chord];
    return `Over ${chord}: Target chord tones ${tones.join(", ")}. ${getStyleGuidance(style, i === 0)}`;
  });

  // Markdown
  const markdown = `# Melody Guidance

**Key:** ${key}
**Range:** ${range}
**Style:** ${style}

## Scale Notes

${scaleNotes.join(" - ")}

## Chord-by-Chord Guidance

${chordProgression.map((chord, i) => `### ${i + 1}. ${chord}

**Chord Tones:** ${chordTones[chord].join(", ")}
**Guidance:** ${guidance[i]}

**Scale Degrees:** ${getScaleDegrees(chordTones[chord], scaleNotes)}
`).join("\n")}

## General Tips

- Start phrases on chord tones for stability
- Use passing tones between chord tones
- ${range === "high" ? "Emphasize upper register for brightness" : range === "low" ? "Use lower register for warmth" : "Stay in comfortable middle range"}
- ${style === "stepwise" ? "Move mostly by step (1-2 semitones)" : style === "leaps" ? "Use larger intervals (3+ semitones)" : "Mix steps and leaps for interest"}
`;

  return {
    guidance,
    scaleNotes,
    chordTones,
    markdown,
  };
}

/**
 * Generate lyric structure
 */
export function generateLyricStructure(options: LyricStructureOptions): LyricStructureResult {
  const {
    theme = "universal",
    genre = "pop",
    rhymeDensity = "moderate",
    sections = ["verse", "chorus", "verse", "chorus", "bridge", "chorus"],
  } = options;

  const structure = sections.map(section => {
    const config = getLyricSectionConfig(section, rhymeDensity);
    return {
      section,
      lines: config.lines,
      rhymeScheme: config.rhymeScheme,
      syllablePattern: config.syllablePattern,
    };
  });

  const markdown = `# Lyric Structure

**Theme:** ${theme}
**Genre:** ${genre}
**Rhyme Density:** ${rhymeDensity}

## Structure

${structure.map((s, i) => `### ${i + 1}. ${s.section.charAt(0).toUpperCase() + s.section.slice(1)}

- **Lines:** ${s.lines}
- **Rhyme Scheme:** ${s.rhymeScheme}
${s.syllablePattern ? `- **Syllable Pattern:** ${s.syllablePattern}\n` : ""}
**Example:**
${getLyricExample(s.section, s.rhymeScheme)}
`).join("\n")}

## Writing Tips

${getLyricWritingTips(genre, rhymeDensity)}
`;

  return {
    structure,
    markdown,
  };
}

/**
 * Analyze chord progression
 */
export function analyzeChordProgression(params: {
  progression: string[];
  key: string;
}): ChordAnalysisResult {
  const { progression, key } = params;

  // Detect mode (simplified - assumes major or natural minor)
  const mode = progression[0].includes("m") ? "minor" : "major";

  // Get scale
  const scale = buildScale(key, mode === "minor" ? SCALES.minor : SCALES.major);

  // Analyze each chord
  const romanNumerals: string[] = [];
  const functions: string[] = [];
  const borrowedChords: string[] = [];
  const secondaryDominants: string[] = [];

  progression.forEach((chord, i) => {
    const root = chord.replace(/[^A-G#b]/g, "");
    const degreeIndex = scale.indexOf(root);

    if (degreeIndex >= 0) {
      // Diatonic chord
      const degree = degreeIndex + 1;
      romanNumerals.push(degreeToRoman(degree, mode));
      functions.push(getChordFunction(degree, mode));
    } else {
      // Non-diatonic chord
      romanNumerals.push("?");
      functions.push("borrowed/chromatic");
      borrowedChords.push(chord);
    }
  });

  // Detect cadences
  const cadences: string[] = [];
  for (let i = 0; i < progression.length - 1; i++) {
    const current = romanNumerals[i];
    const next = romanNumerals[i + 1];

    if (current === "V" && next === "I") cadences.push(`Authentic cadence (${i + 1}-${i + 2})`);
    if (current === "IV" && next === "I") cadences.push(`Plagal cadence (${i + 1}-${i + 2})`);
    if (next === "V") cadences.push(`Half cadence (${i + 1}-${i + 2})`);
    if (current === "V" && next === "vi") cadences.push(`Deceptive cadence (${i + 1}-${i + 2})`);
  }

  const analysis = `Progression in ${key} ${mode}. Contains ${borrowedChords.length} borrowed chord(s). ${cadences.length} cadence(s) detected.`;

  const markdown = `# Chord Progression Analysis

**Key:** ${key} ${mode}
**Progression:** ${progression.join(" - ")}

## Analysis Table

| Chord | Roman | Function |
|-------|-------|----------|
${progression.map((chord, i) => `| ${chord} | ${romanNumerals[i]} | ${functions[i]} |`).join("\n")}

${borrowedChords.length > 0 ? `## Borrowed Chords\n\n${borrowedChords.join(", ")}\n` : ""}

${cadences.length > 0 ? `## Cadences\n\n${cadences.map(c => `- ${c}`).join("\n")}\n` : ""}

## Summary

${analysis}
`;

  return {
    key,
    mode,
    romanNumerals,
    functions,
    borrowedChords,
    secondaryDominants,
    cadences,
    analysis,
    markdown,
  };
}

/**
 * Reharmonize progression
 */
export function reharmonizeProgression(options: ReharmonizeOptions): ChordProgressionResult {
  const { progression, key, targetMood = "jazzier", complexity = "moderate" } = options;

  // Simple reharmonization strategies
  const reharmonized = progression.map((chord, i) => {
    if (targetMood === "jazzier") {
      // Add 7ths and extensions
      if (!chord.includes("7") && !chord.includes("maj")) {
        return chord.includes("m") ? chord + "7" : chord + "maj7";
      }
    } else if (targetMood === "darker") {
      // Convert major to minor
      if (!chord.includes("m") && !chord.includes("dim")) {
        return chord + "m";
      }
    } else if (targetMood === "brighter") {
      // Convert minor to major, add maj7
      return chord.replace("m", "") + "maj7";
    }
    return chord;
  });

  const analysis = `Reharmonized from ${progression.join("-")} to ${reharmonized.join("-")} with ${targetMood} mood.`;

  const markdown = `# Reharmonization

**Original:** ${progression.join(" - ")}
**Reharmonized:** ${reharmonized.join(" - ")}
**Target Mood:** ${targetMood}
**Complexity:** ${complexity}

## Changes

${progression.map((orig, i) => orig !== reharmonized[i] ? `- ${orig} → ${reharmonized[i]}` : null).filter(Boolean).join("\n")}

## Analysis

${analysis}
`;

  return {
    progression: reharmonized,
    nashville: [],
    roman: [],
    analysis,
    markdown,
  };
}

/**
 * Generate practice etude
 */
export function generatePracticeEtude(options: PracticeEtudeOptions): { markdown: string } {
  const { instrument, concept, skillLevel } = options;

  const markdown = `# Practice Etude: ${concept}

**Instrument:** ${instrument}
**Concept:** ${concept}
**Skill Level:** ${skillLevel}

## Exercise Structure

${getEtudeStructure(concept, skillLevel)}

## Practice Routine

${getPracticeRoutine(concept, skillLevel)}

## Tips

${getEtudeTips(instrument, concept, skillLevel)}

## Progression

${getProgressionSteps(skillLevel)}
`;

  return { markdown };
}

// =============================================================================
// Helper Functions for Markdown Generation
// =============================================================================

function getUsageTips(genre: string, progressionName: string): string {
  return `- Works well in ${genre} contexts
- ${progressionName} progression is versatile and can be adapted to different tempos
- Try varying the rhythm and voicings for different feels`;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function getSectionDescription(name: string, genre: string): string {
  const descriptions: Record<string, string> = {
    intro: `Sets the mood, establishes key and tempo`,
    verse: `Storytelling section with lower energy`,
    chorus: `Main hook, highest energy and memorability`,
    bridge: `Contrasting section, often in different key`,
    outro: `Concluding section, brings closure`,
    breakdown: `Stripped down section, builds anticipation`,
    solo: `Instrumental showcase section`,
  };
  return descriptions[name] || "Transitional section";
}

function getSectionChordSuggestion(name: string): string {
  const suggestions: Record<string, string> = {
    intro: "I or vi (establish tonality)",
    verse: "ii-V-I or I-vi-ii-V (stable foundation)",
    chorus: "I-V-vi-IV (strong and memorable)",
    bridge: "IV-V-iii-vi (contrasting harmony)",
    outro: "IV-I or V-I (resolution)",
    breakdown: "vi or iv (tension)",
    solo: "ii-V-I cycle (improvisation vehicle)",
  };
  return suggestions[name] || "Use main progression";
}

function getStyleGuidance(style: string, isFirst: boolean): string {
  const guidance: Record<string, string> = {
    stepwise: "Move to adjacent scale tones for smooth motion",
    leaps: "Jump to distant notes for dramatic effect",
    arpeggiated: "Outline the chord tones in sequence using arpeggio motion",
    mixed: "Combine steps, leaps, and arpeggios for variety",
  };
  const prefix = isFirst ? "Start on the root or fifth for stability. " : "";
  return prefix + (guidance[style] || guidance.mixed);
}

function getScaleDegrees(chordTones: string[], scaleNotes: string[]): string {
  return chordTones
    .map(tone => {
      const index = scaleNotes.indexOf(tone);
      return index >= 0 ? `${index + 1}` : "?";
    })
    .join(", ");
}

function getLyricSectionConfig(
  section: string,
  rhymeDensity: string
): { lines: number; rhymeScheme: string; syllablePattern?: string } {
  const configs: Record<string, { lines: number; rhymeScheme: string; syllablePattern?: string }> = {
    verse: {
      lines: 4,
      rhymeScheme: rhymeDensity === "heavy" ? "AABB" : rhymeDensity === "moderate" ? "ABAB" : "ABCB",
      syllablePattern: "8-8-8-8",
    },
    chorus: {
      lines: 4,
      rhymeScheme: "AABA",
      syllablePattern: "8-8-8-6",
    },
    bridge: {
      lines: 4,
      rhymeScheme: "CDCD",
      syllablePattern: "7-7-7-7",
    },
    prechorus: {
      lines: 2,
      rhymeScheme: "AA",
      syllablePattern: "8-8",
    },
  };
  return configs[section] || configs.verse;
}

function getLyricExample(section: string, rhymeScheme: string): string {
  const examples: Record<string, string> = {
    verse: `Line 1 - establishes scene (A)
Line 2 - develops thought (B)
Line 3 - adds detail (A/C)
Line 4 - concludes idea (B)`,
    chorus: `Hook line - main message (A)
Supporting line (A)
Build line (B)
Resolution line (A)`,
    bridge: `Contrasting perspective (C)
New angle (D)
Deeper insight (C)
Bridge to final chorus (D)`,
  };
  return examples[section] || examples.verse;
}

function getLyricWritingTips(genre: string, rhymeDensity: string): string {
  return `- ${genre} typically emphasizes ${genre === "pop" ? "catchy hooks and repetition" : genre === "rock" ? "powerful imagery and attitude" : "storytelling and authenticity"}
- With ${rhymeDensity} rhyme density, ${rhymeDensity === "heavy" ? "use frequent rhymes for rhythmic impact" : rhymeDensity === "moderate" ? "balance rhyme with natural speech" : "prioritize natural phrasing over rhyme"}
- Use concrete imagery and specific details
- Show, don't tell emotions
- Write from personal experience or deep empathy`;
}

function getChordFunction(degree: number, mode: string): string {
  const functions: Record<number, string> = {
    1: "Tonic (home)",
    2: mode === "minor" ? "Subdominant" : "Supertonic",
    3: "Mediant",
    4: "Subdominant",
    5: "Dominant",
    6: mode === "minor" ? "Submediant" : "Submediant (relative minor)",
    7: mode === "minor" ? "Subtonic" : "Leading tone",
  };
  return functions[degree] || "Unknown";
}

function getEtudeStructure(concept: string, skillLevel: string): string {
  if (concept.toLowerCase().includes("scale")) {
    return `1. Play scale ascending (whole notes)
2. Play scale descending (whole notes)
3. Play in thirds
4. Play in arpeggios
5. Apply to musical context`;
  }
  if (concept.toLowerCase().includes("arpeggio")) {
    return `1. Root position (1-3-5-octave)
2. First inversion (3-5-octave-3)
3. Second inversion (5-octave-3-5)
4. Combine all positions
5. Apply to chord changes`;
  }
  return `Structured exercise focusing on ${concept} development`;
}

function getPracticeRoutine(concept: string, skillLevel: string): string {
  const durations = { beginner: "15-20", intermediate: "20-30", advanced: "30-45", pro: "45-60" };
  return `1. Warm up (5 minutes)
2. Slow practice at ${skillLevel === "beginner" ? "60" : skillLevel === "intermediate" ? "80" : "100"} BPM (${durations[skillLevel]} minutes)
3. Increase tempo gradually
4. Apply to real musical situations
5. Cool down and reflect

**Total Time:** ${durations[skillLevel]} minutes`;
}

function getEtudeTips(instrument: string, concept: string, skillLevel: string): string {
  return `- Focus on accuracy before speed
- Use a metronome for timing
- ${instrument}-specific: ${getInstrumentSpecificTip(instrument)}
- Record yourself to track progress
- ${skillLevel === "beginner" ? "Take breaks when needed" : skillLevel === "advanced" ? "Push technical boundaries" : "Maintain steady progress"}`;
}

function getInstrumentSpecificTip(instrument: string): string {
  const tips: Record<string, string> = {
    piano: "Keep wrists relaxed and fingers curved",
    guitar: "Alternate picking for speed, maintain finger independence",
    bass: "Focus on timing and groove, less is more",
    drums: "Develop limb independence, start slow",
    voice: "Support from diaphragm, maintain breath control",
  };
  return tips[instrument.toLowerCase()] || "Focus on proper technique";
}

function getProgressionSteps(skillLevel: string): string {
  return `**Week 1:** Master at slow tempo
**Week 2:** Increase speed by 10-20 BPM
**Week 3:** Add musical expression
**Week 4:** Apply to improvisation or composition

${skillLevel === "pro" ? "Push beyond comfort zone regularly" : "Advance when consistently accurate"}`;
}
