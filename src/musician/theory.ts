/**
 * Music Theory Tutor Helpers
 *
 * Deterministic functions for explaining music theory concepts, generating exercises,
 * checking answers, and providing instrument-specific examples.
 */

// =============================================================================
// Constants
// =============================================================================

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

const INTERVALS = {
  unison: { semitones: 0, quality: "perfect" },
  minor2nd: { semitones: 1, quality: "minor" },
  major2nd: { semitones: 2, quality: "major" },
  minor3rd: { semitones: 3, quality: "minor" },
  major3rd: { semitones: 4, quality: "major" },
  perfect4th: { semitones: 5, quality: "perfect" },
  tritone: { semitones: 6, quality: "augmented" },
  perfect5th: { semitones: 7, quality: "perfect" },
  minor6th: { semitones: 8, quality: "minor" },
  major6th: { semitones: 9, quality: "major" },
  minor7th: { semitones: 10, quality: "minor" },
  major7th: { semitones: 11, quality: "major" },
  octave: { semitones: 12, quality: "perfect" },
};

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

const KEY_SIGNATURES = {
  "C": { sharps: 0, flats: 0, accidentals: [] },
  "G": { sharps: 1, flats: 0, accidentals: ["F#"] },
  "D": { sharps: 2, flats: 0, accidentals: ["F#", "C#"] },
  "A": { sharps: 3, flats: 0, accidentals: ["F#", "C#", "G#"] },
  "E": { sharps: 4, flats: 0, accidentals: ["F#", "C#", "G#", "D#"] },
  "B": { sharps: 5, flats: 0, accidentals: ["F#", "C#", "G#", "D#", "A#"] },
  "F#": { sharps: 6, flats: 0, accidentals: ["F#", "C#", "G#", "D#", "A#", "E#"] },
  "F": { sharps: 0, flats: 1, accidentals: ["Bb"] },
  "Bb": { sharps: 0, flats: 2, accidentals: ["Bb", "Eb"] },
  "Eb": { sharps: 0, flats: 3, accidentals: ["Bb", "Eb", "Ab"] },
  "Ab": { sharps: 0, flats: 4, accidentals: ["Bb", "Eb", "Ab", "Db"] },
  "Db": { sharps: 0, flats: 5, accidentals: ["Bb", "Eb", "Ab", "Db", "Gb"] },
  "Gb": { sharps: 0, flats: 6, accidentals: ["Bb", "Eb", "Ab", "Db", "Gb", "Cb"] },
};

const CIRCLE_OF_FIFTHS = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"];

// Guitar standard tuning (E A D G B E)
const GUITAR_TUNING = [4, 9, 2, 7, 11, 4]; // MIDI note offsets from C
const BASS_TUNING = [4, 9, 2, 7]; // E A D G

// =============================================================================
// Types
// =============================================================================

export type SkillLevel = "beginner" | "intermediate" | "advanced";
export type Instrument = "guitar" | "bass" | "piano" | "keys" | "general";

export interface ConceptExplanation {
  topic: string;
  skillLevel: SkillLevel;
  explanation: string;
  musicalImportance: string;
  examples: string[];
  commonMistakes: string[];
  exercises: string[];
  nextConcepts: string[];
  instrumentSpecific?: string;
  markdown: string;
}

export interface Exercise {
  question: string;
  expectedAnswer: string;
  hint?: string;
  difficulty: SkillLevel;
}

export interface ExerciseSet {
  topic: string;
  skillLevel: SkillLevel;
  exercises: Exercise[];
  markdown: string;
}

export interface AnswerCheck {
  correct: boolean;
  feedback: string;
  explanation?: string;
}

export interface FretboardExample {
  tuning: string[];
  positions: Array<{ string: number; fret: number; note: string; highlight?: boolean }>;
  markdown: string;
}

export interface KeyboardExample {
  keys: Array<{ note: string; octave: number; highlight: boolean; label?: string }>;
  markdown: string;
}

export interface EarTrainingDrill {
  topic: string;
  skillLevel: SkillLevel;
  drills: Array<{
    description: string;
    audioDescription: string;
    expectedAnswer: string;
  }>;
  markdown: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

function getNoteIndex(noteName: string): number {
  const cleanNote = noteName.replace(/[0-9]/g, "").toUpperCase();
  let index = NOTE_NAMES.indexOf(cleanNote);
  if (index === -1) {
    index = NOTE_NAMES_FLAT.indexOf(cleanNote);
  }
  return index;
}

function getNoteName(index: number, useFlats: boolean = false): string {
  const normalizedIndex = ((index % 12) + 12) % 12;
  return useFlats ? NOTE_NAMES_FLAT[normalizedIndex] : NOTE_NAMES[normalizedIndex];
}

function buildScale(root: string, intervals: number[]): string[] {
  const rootIndex = getNoteIndex(root);
  const useFlats = root.includes("b") || ["F", "Bb", "Eb", "Ab", "Db", "Gb"].includes(root);

  return intervals.map(interval => {
    const noteIndex = (rootIndex + interval) % 12;
    return getNoteName(noteIndex, useFlats);
  });
}

function getIntervalName(semitones: number): string {
  const normalized = ((semitones % 12) + 12) % 12;
  for (const [name, data] of Object.entries(INTERVALS)) {
    if (data.semitones === normalized) {
      return name;
    }
  }
  return "unknown";
}

function getExplanationDepth(skillLevel: SkillLevel): { simple: boolean; detailed: boolean; advanced: boolean } {
  return {
    simple: skillLevel === "beginner",
    detailed: skillLevel === "intermediate" || skillLevel === "advanced",
    advanced: skillLevel === "advanced",
  };
}

// =============================================================================
// Topic Explanations Database
// =============================================================================

const TOPIC_DATA: Record<string, any> = {
  intervals: {
    beginner: {
      explanation: "An interval is the distance between two notes. Intervals are measured in semitones (half steps). The most common intervals are: major 2nd (2 semitones), major 3rd (4 semitones), perfect 4th (5 semitones), perfect 5th (7 semitones), and octave (12 semitones).",
      importance: "Intervals are the foundation of melody and harmony. Understanding intervals helps you recognize melodies by ear, build chords, and understand music theory.",
      examples: ["C to E is a major 3rd (4 semitones)", "C to G is a perfect 5th (7 semitones)", "C to C (octave higher) is an octave (12 semitones)"],
      mistakes: ["Counting the starting note twice", "Confusing major and minor intervals", "Not recognizing perfect intervals (4th, 5th, octave)"],
      nextConcepts: ["scales", "chords", "ear-training"],
    },
    intermediate: {
      explanation: "Intervals can be major, minor, perfect, augmented, or diminished. Major/minor applies to 2nds, 3rds, 6ths, and 7ths. Perfect applies to unison, 4ths, 5ths, and octaves. Augmented means widened by a half step, diminished means narrowed by a half step. Understanding interval quality is essential for chord construction and voice leading.",
      importance: "Interval quality determines chord quality (major, minor, diminished, augmented). Recognizing intervals by ear is crucial for improvisation, transcription, and composition.",
      examples: ["Major 3rd (C-E, 4 semitones) vs Minor 3rd (C-Eb, 3 semitones)", "Perfect 5th (C-G, 7 semitones) vs Diminished 5th (C-Gb, 6 semitones)", "Tritone (augmented 4th or diminished 5th, 6 semitones) is the most dissonant interval"],
      mistakes: ["Confusing augmented 4th with diminished 5th (enharmonic but different contexts)", "Not recognizing compound intervals (intervals larger than an octave)", "Ignoring harmonic vs melodic context"],
      nextConcepts: ["chord-extensions", "voice-leading", "modal-interchange"],
    },
    advanced: {
      explanation: "Intervals have both melodic (successive) and harmonic (simultaneous) properties. Consonant intervals (3rds, 6ths, perfect 5ths) create stability, while dissonant intervals (2nds, 7ths, tritones) create tension. Compound intervals (9ths, 11ths, 13ths) are intervals beyond an octave. Understanding interval tensions and resolutions is fundamental to counterpoint, voice leading, and advanced harmony.",
      importance: "Interval theory underlies all harmonic motion. The resolution of dissonance to consonance drives tonal music. In jazz, altered intervals (b9, #9, #11, b13) create color and tension. In classical counterpoint, proper treatment of dissonance is essential.",
      examples: ["Major 7th (B-C) resolves down by half step", "Tritone (F-B in C7) resolves outward to E-C in resolution to Fmaj7", "b9 interval in altered dominant chords creates maximum tension", "Compound intervals: 9th = octave + 2nd, 11th = octave + 4th, 13th = octave + 6th"],
      mistakes: ["Not considering harmonic context when analyzing intervals", "Overlooking enharmonic equivalents in different keys", "Ignoring the voice leading implications of interval choices"],
      nextConcepts: ["counterpoint", "jazz-harmony", "voice-leading"],
    },
  },
  scales: {
    beginner: {
      explanation: "A scale is a collection of notes arranged in ascending or descending order. The major scale has the pattern: Whole-Whole-Half-Whole-Whole-Whole-Half (W-W-H-W-W-W-H). The natural minor scale has: W-H-W-W-H-W-W. Pentatonic scales use only 5 notes and are common in many music styles.",
      importance: "Scales provide the notes you use to create melodies and harmonies. Knowing scales helps you improvise, write melodies, and understand which notes work together.",
      examples: ["C major scale: C-D-E-F-G-A-B-C", "A minor scale: A-B-C-D-E-F-G-A", "C major pentatonic: C-D-E-G-A"],
      mistakes: ["Not memorizing the interval patterns", "Confusing relative major and minor scales", "Not practicing scales in different keys"],
      nextConcepts: ["key-signatures", "modes", "chords"],
    },
    intermediate: {
      explanation: "Beyond major and minor, there are harmonic minor (raised 7th), melodic minor (raised 6th and 7th ascending), blues scale (with b3, b5, and b7), and pentatonic variations. Each scale has a unique character and emotional quality. Scales generate chords through harmonization.",
      importance: "Different scales create different moods and are associated with specific genres. The harmonic minor's exotic sound, the melodic minor's smoothness, and the blues scale's soulful quality are essential colors in your musical palette.",
      examples: ["A harmonic minor: A-B-C-D-E-F-G#-A (exotic sound)", "A melodic minor: A-B-C-D-E-F#-G#-A ascending, A-G-F-E-D-C-B-A descending", "E blues scale: E-G-A-Bb-B-D (classic blues sound)"],
      mistakes: ["Not understanding when to use each scale type", "Forgetting melodic minor descends as natural minor", "Overlooking the pentatonic scales as legitimate melodic material"],
      nextConcepts: ["modes", "modal-interchange", "chord-extensions"],
    },
    advanced: {
      explanation: "Scales generate harmonic and melodic material. The melodic minor scale is the parent scale for many altered jazz chords. Synthetic scales (whole tone, diminished, augmented) create specific harmonic colors. Understanding scale-chord relationships enables sophisticated improvisation and composition.",
      importance: "Each scale degree generates a specific chord quality. Melodic minor generates altered dominant chords. The diminished scale fits over diminished and dominant b9 chords. Understanding these relationships enables you to see harmony as derived from scales rather than memorizing chord-scale pairs.",
      examples: ["C melodic minor over Cm(maj7), D7alt over Eb melodic minor", "Whole tone scale (C-D-E-F#-G#-A#) over augmented or dominant #5 chords", "Diminished scale (C-D-Eb-F-Gb-Ab-A-B) over C7b9 or Cdim7"],
      mistakes: ["Not connecting scale theory to chord-scale relationships", "Overlooking symmetric scales (whole tone, diminished, augmented)", "Not understanding parent scale relationships"],
      nextConcepts: ["jazz-harmony", "modal-interchange", "chord-extensions"],
    },
  },
  modes: {
    beginner: {
      explanation: "Modes are scales built from different starting points of the major scale. Each mode has a unique sound. The seven modes are: Ionian (major), Dorian, Phrygian, Lydian, Mixolydian, Aeolian (minor), and Locrian. They're used in rock, jazz, and classical music.",
      importance: "Modes give you more melodic options beyond just major and minor. Each mode has a different emotional character, from the bright Lydian to the dark Phrygian.",
      examples: ["D Dorian uses the same notes as C major but starts on D: D-E-F-G-A-B-C", "G Mixolydian: G-A-B-C-D-E-F (major scale with b7)", "E Phrygian: E-F-G-A-B-C-D (minor scale with b2)"],
      mistakes: ["Thinking modes are just different scales rather than different tonal centers", "Not hearing the unique character of each mode", "Confusing the mode names"],
      nextConcepts: ["modal-interchange", "chord-progressions", "voice-leading"],
    },
    intermediate: {
      explanation: "Each mode has characteristic intervals that define its sound. Dorian has a raised 6th vs natural minor, Lydian has a raised 4th vs major, Mixolydian has a lowered 7th vs major. Modes can be used melodically (soloing over chords) or harmonically (modal progressions that avoid traditional cadences).",
      importance: "Modal thinking opens up composition beyond major/minor tonality. Modal harmony avoids the dominant-tonic relationship, creating static or circular progressions. This is fundamental to rock, jazz, and modern film music.",
      examples: ["Dorian mode: jazz minor sound (So What by Miles Davis)", "Mixolydian: rock and blues sound (Sweet Child O' Mine)", "Phrygian: Spanish/metal sound (flamenco music)"],
      mistakes: ["Playing modes but thinking in parent major scale", "Not emphasizing characteristic tones", "Using strong V-I cadences in modal contexts"],
      nextConcepts: ["modal-interchange", "jazz-harmony", "functional-harmony"],
    },
    advanced: {
      explanation: "Modes generate specific chord qualities and progressions. Dorian is often used over ii chords, Mixolydian over V chords (especially in jazz and blues). Lydian dominants (Lydian with b7) are built from the 4th degree of melodic minor. Modal harmony avoids functional progressions, using parallel motion, pedal tones, and static harmony instead.",
      importance: "Understanding modal harmony and melody allows you to compose beyond functional tonality. The ability to switch modes mid-progression (modal interchange) is essential for sophisticated harmony. Modal jazz (Miles Davis, John Coltrane) and prog rock (King Crimson, Yes) rely on modal concepts.",
      examples: ["Lydian Dominant (C-D-E-F#-G-A-Bb) over C7#11 chord", "Modal interchange: borrowing bVII from Mixolydian into major key", "Dorian vamp: i-IV (minor to major IV, characteristic Dorian sound)"],
      mistakes: ["Not understanding the difference between modal and tonal music", "Forcing functional progressions in modal contexts", "Not recognizing modes of melodic minor and harmonic minor"],
      nextConcepts: ["modal-interchange", "jazz-harmony", "counterpoint"],
    },
  },
  chords: {
    beginner: {
      explanation: "A chord is three or more notes played together. The most basic chords are triads: major (root-major 3rd-perfect 5th), minor (root-minor 3rd-perfect 5th), diminished (root-minor 3rd-diminished 5th), and augmented (root-major 3rd-augmented 5th). Chords are built by stacking intervals, usually 3rds.",
      importance: "Chords provide the harmonic foundation for music. Understanding chord construction helps you play, compose, and analyze music. Most songs use just a handful of chord types.",
      examples: ["C major: C-E-G", "A minor: A-C-E", "B diminished: B-D-F", "C augmented: C-E-G#"],
      mistakes: ["Not understanding the interval structure of chords", "Confusing chord symbols (m vs min, + vs aug)", "Not recognizing chord inversions"],
      nextConcepts: ["chord-progressions", "chord-extensions", "roman-numeral-analysis"],
    },
    intermediate: {
      explanation: "Beyond triads, seventh chords add a 7th above the root: major 7th (Cmaj7: C-E-G-B), dominant 7th (C7: C-E-G-Bb), minor 7th (Cm7: C-Eb-G-Bb), half-diminished 7th (Cm7b5: C-Eb-Gb-Bb), diminished 7th (Cdim7: C-Eb-Gb-Bbb). Chord inversions change the bass note without changing the chord identity.",
      importance: "Seventh chords are fundamental to jazz, classical, and modern pop. They create more complex harmonies and voice leading. Understanding inversions helps with bass lines and smooth progressions.",
      examples: ["Cmaj7 vs C7: major 7th is B (11 semitones), dominant 7th is Bb (10 semitones)", "First inversion C major: E-G-C (E in bass)", "Minor 7th chords are built on the ii, iii, and vi degrees of major scales"],
      mistakes: ["Confusing maj7 with dominant 7", "Not understanding the function of different seventh chord types", "Overlooking sus chords (sus2, sus4) and their uses"],
      nextConcepts: ["chord-extensions", "voice-leading", "functional-harmony"],
    },
    advanced: {
      explanation: "Extended chords add 9ths, 11ths, and 13ths. Altered chords modify these extensions (b9, #9, #11, b13). Chord voicing and voice leading are as important as chord choice. Upper structure triads allow pianists and guitarists to voice complex chords. Understanding chord-scale relationships connects harmony to melody.",
      importance: "Extended and altered chords create sophisticated harmony in jazz, R&B, and modern pop. Voicing choices affect the mood and texture of harmony. Understanding tensions and their resolutions enables advanced composition and reharmonization.",
      examples: ["Cmaj9: C-E-G-B-D", "C7#9#5 (Hendrix chord): C-E-G#-Bb-D#", "C13: C-E-G-Bb-D-F-A (often voiced as Bb-D-F-A over C bass)"],
      mistakes: ["Overusing extensions without musical purpose", "Not understanding which extensions are available on which chord types", "Ignoring voice leading in favor of chord labeling"],
      nextConcepts: ["jazz-harmony", "voice-leading", "reharmonization"],
    },
  },
  "key-signatures": {
    beginner: {
      explanation: "A key signature tells you which notes are sharp or flat throughout a piece. It appears at the beginning of each staff. Keys with sharps follow the pattern: F#, C#, G#, D#, A#, E#, B#. Keys with flats follow: Bb, Eb, Ab, Db, Gb, Cb, Fb. The key signature determines which major or minor key the piece is in.",
      importance: "Key signatures let you read music without writing accidentals on every note. Knowing key signatures helps you identify what key a song is in and which chords to expect.",
      examples: ["C major / A minor: no sharps or flats", "G major / E minor: one sharp (F#)", "F major / D minor: one flat (Bb)"],
      mistakes: ["Not memorizing the order of sharps and flats", "Confusing relative major and minor keys", "Not recognizing key changes in music"],
      nextConcepts: ["circle-of-fifths", "scales", "modulation"],
    },
    intermediate: {
      explanation: "Every major key has a relative minor (3 semitones below) that shares the same key signature. Sharps are added in fifths: F#, C#, G#, D#, A#, E#, B#. Flats are added in fourths: Bb, Eb, Ab, Db, Gb, Cb, Fb. The key signature alone doesn't tell you if it's major or minor—you need to look at the tonic and chord progressions.",
      importance: "Understanding key signatures helps you transpose music, recognize patterns across keys, and understand the relationship between keys. This is essential for reading, composing, and arranging.",
      examples: ["D major (F#, C#) and B minor share the same key signature", "To find major key from sharps: go up a half step from last sharp", "To find major key from flats: second-to-last flat is the key (except F)"],
      mistakes: ["Not using the tricks to identify keys quickly", "Forgetting that key signature affects all octaves", "Not recognizing parallel vs relative key relationships"],
      nextConcepts: ["circle-of-fifths", "modulation", "roman-numeral-analysis"],
    },
    advanced: {
      explanation: "Key signatures represent diatonic collections but don't limit chromatic possibilities. Modal music uses major key signatures with different tonic centers. Jazz and classical music frequently modulate between keys. Understanding enharmonic keys (F# major = Gb major) and theoretical keys helps with advanced analysis and composition.",
      importance: "Advanced music transcends simple key signatures through modulation, modal interchange, and chromaticism. Understanding how key signatures relate to the circle of fifths, modes, and harmonic function enables sophisticated analysis and composition.",
      examples: ["Chopin often uses enharmonic modulation (C# minor to Db minor)", "Modal jazz uses key signatures but centers on modal tonic, not major/minor", "Theoretical keys (C# major with 7 sharps vs Db major with 5 flats)"],
      mistakes: ["Assuming key signature determines all harmonic content", "Not recognizing modal vs tonal use of key signatures", "Overlooking enharmonic relationships in modulation"],
      nextConcepts: ["modulation", "modal-interchange", "functional-harmony"],
    },
  },
  "circle-of-fifths": {
    beginner: {
      explanation: "The circle of fifths shows the relationship between all 12 keys. Moving clockwise adds sharps (up a 5th), moving counter-clockwise adds flats (down a 5th). It's a tool for understanding key relationships, transposing, and finding relative minor keys.",
      importance: "The circle of fifths helps you memorize key signatures, transpose songs, and understand which keys are closely related. It's one of the most useful tools in music theory.",
      examples: ["C → G (add F#) → D (add C#) → A (add G#)", "C → F (add Bb) → Bb (add Eb) → Eb (add Ab)", "Adjacent keys share all but one note"],
      mistakes: ["Not memorizing the order", "Forgetting counter-clockwise goes to flat keys", "Not using it for transposition"],
      nextConcepts: ["key-signatures", "modulation", "chord-progressions"],
    },
    intermediate: {
      explanation: "The circle of fifths reveals chord progressions (I-IV-V is a circle of fifths motion), common modulations (adjacent keys are closely related), and secondary dominants. The inner circle shows relative minors. Jazz progressions often follow circle of fifths motion (ii-V-I).",
      importance: "Circle of fifths motion is the strongest harmonic movement in tonal music. Understanding this helps you compose stronger progressions, recognize patterns in existing music, and understand modulation.",
      examples: ["ii-V-I progression: Dm7-G7-Cmaj7 (circle of fifths motion)", "Secondary dominants follow circle of fifths: D7 (V/V) → G7 (V) → C (I)", "Closely related keys (one position away) are common modulation targets"],
      mistakes: ["Not recognizing circle of fifths motion in progressions", "Thinking circle of fifths only applies to key signatures", "Not using it for voice leading"],
      nextConcepts: ["secondary-dominants", "modulation", "functional-harmony"],
    },
    advanced: {
      explanation: "The circle of fifths underlies functional harmony. Chord progressions moving counter-clockwise create stronger resolutions. Extended circle of fifths progressions (like Coltrane's 'Giant Steps') can cycle through distant keys. Understanding the circle's harmonic implications enables advanced reharmonization and composition.",
      importance: "The circle of fifths explains why V-I is the strongest resolution, why ii-V-I works so well, and why descending fifths create momentum. It's the basis for understanding substitutions (tritone substitution) and extended harmony.",
      examples: ["Giant Steps: B major → G major → Eb major (divides octave in major thirds, each with ii-V-I)", "Tritone substitution replaces V7 with opposite side of circle (G7 → Db7)", "Backdoor progression: iv-bVII-I (reverse circle motion)"],
      mistakes: ["Not understanding the harmonic strength of fifth relationships", "Overlooking tritone substitution possibilities", "Not recognizing circle of fifths patterns in complex progressions"],
      nextConcepts: ["jazz-harmony", "reharmonization", "modulation"],
    },
  },
  "roman-numeral-analysis": {
    beginner: {
      explanation: "Roman numeral analysis labels chords by their position in the scale. Capital letters (I, IV, V) are major chords, lowercase (ii, iii, vi) are minor chords, and lowercase with ° (vii°) are diminished. This system works in any key, making it easier to understand chord progressions.",
      importance: "Roman numerals let you understand progressions independently of key. The progression I-V-vi-IV works in every key. This makes transposing, analyzing, and communicating about music much easier.",
      examples: ["In C major: I=C, ii=Dm, iii=Em, IV=F, V=G, vi=Am, vii°=Bdim", "I-V-vi-IV in C is C-G-Am-F, in G is G-D-Em-C", "Most pop songs use I, IV, V, and vi"],
      mistakes: ["Not understanding the difference between major and minor keys", "Forgetting lowercase for minor chords", "Not recognizing chord function"],
      nextConcepts: ["functional-harmony", "nashville-numbers", "chord-progressions"],
    },
    intermediate: {
      explanation: "Roman numerals can include seventh chords (Imaj7, V7, iim7) and inversions (I⁶, V⁶₄). In functional harmony, chords have roles: tonic (I, vi), subdominant (IV, ii), and dominant (V, vii°). Secondary dominants are shown as V/x (e.g., V/V means the dominant of the dominant).",
      importance: "Understanding chord function helps you compose and improvise. You can substitute chords with the same function (ii can replace IV). Secondary dominants add color and motion to progressions.",
      examples: ["iim7-V7-Imaj7: Dm7-G7-Cmaj7 in C, Em7-A7-Dmaj7 in D", "V/V-V-I: D7-G7-C (D7 is V/V, dominant of G)", "I⁶₄ (second inversion) is often used in cadential progressions"],
      mistakes: ["Not understanding chord function and substitution", "Confusing secondary dominants with borrowed chords", "Not recognizing inversion symbols"],
      nextConcepts: ["secondary-dominants", "functional-harmony", "voice-leading"],
    },
    advanced: {
      explanation: "Advanced Roman numeral analysis includes modal interchange (bVI, bVII from parallel minor), Neapolitan chords (bII), augmented sixth chords (It⁶, Fr⁶, Ger⁶), and chromatic mediants (bIII, bVI). Extended analysis considers voice leading, harmonic rhythm, and phrase structure. Some theorists use additional symbols for altered chords and complex harmonies.",
      importance: "Advanced Roman numeral analysis reveals the architecture of complex classical and jazz pieces. Understanding borrowed chords, chromaticism, and voice leading through Roman numerals enables sophisticated composition and reharmonization.",
      examples: ["Modal interchange in C: I-bVII-bVI-V (C-Bb-Ab-G)", "Neapolitan sixth: bII⁶ in minor (Db major in first inversion in C minor)", "Augmented sixth chords resolve outward to dominant: It⁶, Fr⁶, Ger⁶"],
      mistakes: ["Over-analyzing instead of hearing harmonic function", "Not considering voice leading in analysis", "Forcing Roman numerals onto non-functional harmony"],
      nextConcepts: ["modal-interchange", "voice-leading", "functional-harmony"],
    },
  },
  "nashville-numbers": {
    beginner: {
      explanation: "Nashville numbers are like Roman numerals but use Arabic numbers (1, 2, 3...). They're popular in country, pop, and worship music. Major chords are just numbers (1, 4, 5), minor chords have 'm' (2m, 3m, 6m), and 7th chords add '7' (1maj7, 57). This makes transposing and communicating easy in studio settings.",
      importance: "Nashville numbers are the standard in many professional music settings. They let you quickly transpose songs and communicate chord changes. If you work in country, pop, or contemporary Christian music, you'll use this system constantly.",
      examples: ["1-5-6m-4 is C-G-Am-F in C, G-D-Em-C in G", "157-4 is C7-F in C (dominant 7th)", "Common progression: 1-4-1-5-1"],
      mistakes: ["Confusing with Roman numerals (uppercase/lowercase)", "Not indicating major 7th vs dominant 7th correctly", "Forgetting to mark minor chords"],
      nextConcepts: ["roman-numeral-analysis", "chord-progressions", "transposition"],
    },
    intermediate: {
      explanation: "Nashville numbers can show bass movement with slashes (1/3 = first inversion), rhythm with slashes (///1/// = whole note), and extensions (1add9, 59, 2m7). They're used with chord charts that show form and hits. The system is optimized for quick reading and transposition in recording sessions.",
      importance: "Professional session musicians need to sight-read Nashville number charts instantly. The system's efficiency makes it ideal for recording studios where time is money. Understanding advanced notation helps you work professionally.",
      examples: ["1/3-4/5-1 shows bassline movement", "2m7-57-1maj7 is ii-V-I in Nashville system", "1 (/) (/) 4 (/) 1 (/) 5 shows rhythm"],
      mistakes: ["Not understanding rhythm notation", "Confusing slash with bass note vs rhythm slash", "Not writing clear, readable charts"],
      nextConcepts: ["chart-reading", "session-playing", "arrangement"],
    },
    advanced: {
      explanation: "Advanced Nashville charts include rhythmic hits, ensemble parts, dynamics, and form markers. They may include melody cues, solo sections, and arrangement details. The system can represent complex jazz harmony (2m7b5-57b9-1maj7#11) though Roman numerals are often preferred for classical analysis.",
      importance: "At the professional level, Nashville charts must be accurate, clear, and quick to read. Understanding how to write comprehensive charts that include all necessary information while remaining readable is essential for arrangers and bandleaders.",
      examples: ["Complex chord: 57(b9,#11) = G7b9#11 in C", "Form notation: [Intro: 1-5] [Verse: 1-4-5-1] [Chorus: 1-5-6m-4]", "Hits and kicks: 1 (/) X (/) (/) 4 X (/) shows rhythmic hits on 2 and 4"],
      mistakes: ["Overcomplicating charts with unnecessary detail", "Not balancing detail with readability", "Inconsistent notation within a chart"],
      nextConcepts: ["arrangement", "orchestration", "professional-charts"],
    },
  },
  "voice-leading": {
    beginner: {
      explanation: "Voice leading is how individual notes move from chord to chord. Good voice leading uses small movements (common tones, stepwise motion) rather than large jumps. This creates smooth, connected harmony. The most basic rule: keep common tones between chords and move other voices by step when possible.",
      importance: "Voice leading makes chord progressions sound smooth and professional. Poor voice leading sounds jumpy and disconnected. Good voice leading is essential for piano, guitar voicing, vocal arranging, and composition.",
      examples: ["C to F: C-E-G to C-F-A (C stays, E→F, G→A, all move by step)", "G to C: G-B-D to C-E-G (G→G stays, B→C and D→E move by step)", "I-vi-IV-V: smooth motion with mostly stepwise movement"],
      mistakes: ["Moving all voices in the same direction (parallel motion)", "Large jumps when small movements are available", "Not identifying common tones"],
      nextConcepts: ["chord-progressions", "counterpoint", "harmonization"],
    },
    intermediate: {
      explanation: "Voice leading rules include: avoid parallel fifths and octaves, resolve tendency tones (7th resolves up, 4th resolves down), move contrary motion when possible, and keep voices within reasonable ranges. Inner voices should move as little as possible. Proper voice leading creates independence between melodic lines.",
      importance: "Classical harmony is built on voice leading principles. Jazz voicings prioritize extensions while maintaining smooth voice leading. Understanding these principles helps you create sophisticated arrangements and avoid amateurish progressions.",
      examples: ["Leading tone (7th degree) resolves up to tonic", "V7 to I: the 7th (F in G7) resolves down to E (3rd of C)", "Contrary motion: bass descends while upper voice ascends"],
      mistakes: ["Parallel perfect fifths and octaves (sounds hollow)", "Not resolving tendency tones", "Crossing voices unnecessarily"],
      nextConcepts: ["counterpoint", "harmonization", "jazz-voicing"],
    },
    advanced: {
      explanation: "Advanced voice leading includes chromatic voice leading, voice exchange, pedal tones, and sophisticated contrary motion. Modern harmony uses smooth chromatic voice leading to connect distant chords (neo-Riemannian theory). Jazz voice leading often moves guide tones (3rd and 7th) by half step in ii-V-I progressions.",
      importance: "Chromatic voice leading enables smooth modulation and reharmonization. Understanding how to connect any chord to any other chord smoothly is essential for advanced composition. Voice leading by half steps is particularly strong and is used extensively in jazz and film music.",
      examples: ["ii-V-I guide tones: Dm7 (C-F) → G7 (B-F) → Cmaj7 (B-E), smooth half-step motion", "Voice exchange: bass and soprano trade notes between chords", "Chromatic mediants: C major to Ab major (E-Eb chromatic link)"],
      mistakes: ["Prioritizing chord labels over voice leading", "Not using chromatic motion strategically", "Overlooking voice leading as a compositional tool"],
      nextConcepts: ["counterpoint", "reharmonization", "jazz-harmony"],
    },
  },
};

// Add more topics (abbreviated for length)
const ADDITIONAL_TOPICS = [
  "chord-extensions",
  "rhythm-meter",
  "counterpoint",
  "functional-harmony",
  "jazz-harmony",
  "blues-harmony",
  "modal-interchange",
  "secondary-dominants",
  "modulation",
  "arrangement",
];

// Add placeholder data for additional topics
ADDITIONAL_TOPICS.forEach(topic => {
  if (!TOPIC_DATA[topic]) {
    TOPIC_DATA[topic] = {
      beginner: {
        explanation: `Introduction to ${topic.replace(/-/g, " ")}.`,
        importance: `Understanding ${topic.replace(/-/g, " ")} expands your musical vocabulary.`,
        examples: [`Example 1 for ${topic}`, `Example 2 for ${topic}`],
        mistakes: ["Common mistake 1", "Common mistake 2"],
        nextConcepts: ["scales", "chords", "harmony"],
      },
      intermediate: {
        explanation: `Intermediate concepts in ${topic.replace(/-/g, " ")}.`,
        importance: `${topic.replace(/-/g, " ")} is essential for advanced musicianship.`,
        examples: [`Advanced example 1`, `Advanced example 2`],
        mistakes: ["Intermediate mistake 1", "Intermediate mistake 2"],
        nextConcepts: ["jazz-harmony", "voice-leading", "composition"],
      },
      advanced: {
        explanation: `Advanced theory and application of ${topic.replace(/-/g, " ")}.`,
        importance: `Mastery of ${topic.replace(/-/g, " ")} enables professional-level musicianship.`,
        examples: [`Professional example 1`, `Professional example 2`],
        mistakes: ["Advanced mistake 1", "Advanced mistake 2"],
        nextConcepts: ["counterpoint", "orchestration", "composition"],
      },
    };
  }
});

// =============================================================================
// Main Functions
// =============================================================================

/**
 * Explain a music theory concept
 */
export function explainConcept(
  topic: string,
  skillLevel: SkillLevel,
  instrument?: Instrument,
  style?: string
): ConceptExplanation {
  const normalizedTopic = topic.toLowerCase().replace(/\s+/g, "-");
  const topicData = TOPIC_DATA[normalizedTopic]?.[skillLevel] || TOPIC_DATA[normalizedTopic]?.beginner;

  if (!topicData) {
    throw new Error(`Topic "${topic}" not found. Available topics: ${Object.keys(TOPIC_DATA).join(", ")}`);
  }

  const depth = getExplanationDepth(skillLevel);

  // Generate exercises based on topic
  const exercises = generateTopicExercises(normalizedTopic, skillLevel, 3);

  // Add instrument-specific examples if requested
  let instrumentSpecific: string | undefined;
  if (instrument && (instrument === "guitar" || instrument === "bass")) {
    instrumentSpecific = `For ${instrument}: Practice this concept across the fretboard in different positions. Start in open position, then move to 5th, 7th, and 12th positions.`;
  } else if (instrument === "piano" || instrument === "keys") {
    instrumentSpecific = `For ${instrument}: Practice this concept in all 12 keys. Start with C major, then move through the circle of fifths.`;
  }

  // Build markdown
  const markdown = `# ${topic.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase())}

**Skill Level:** ${skillLevel}
${instrument ? `**Instrument:** ${instrument}` : ""}
${style ? `**Style:** ${style}` : ""}

## Explanation

${topicData.explanation}

## Why It Matters

${topicData.importance}

## Examples

${topicData.examples.map((ex: string, i: number) => `${i + 1}. ${ex}`).join("\n")}

${instrumentSpecific ? `## Instrument-Specific Practice\n\n${instrumentSpecific}\n` : ""}

## Common Mistakes

${topicData.mistakes.map((mistake: string, i: number) => `${i + 1}. ${mistake}`).join("\n")}

## Practice Exercises

${exercises.map((ex, i) => `${i + 1}. ${ex}`).join("\n")}

## Next Concepts to Learn

${topicData.nextConcepts.map((concept: string, i: number) => `${i + 1}. ${concept.replace(/-/g, " ")}`).join("\n")}
`;

  return {
    topic: normalizedTopic,
    skillLevel,
    explanation: topicData.explanation,
    musicalImportance: topicData.importance,
    examples: topicData.examples,
    commonMistakes: topicData.mistakes,
    exercises,
    nextConcepts: topicData.nextConcepts,
    instrumentSpecific,
    markdown,
  };
}

/**
 * Generate exercises for a topic
 */
export function generateExercises(
  topic: string,
  skillLevel: SkillLevel,
  instrument?: Instrument,
  count: number = 5
): ExerciseSet {
  const normalizedTopic = topic.toLowerCase().replace(/\s+/g, "-");
  const exercises: Exercise[] = [];

  for (let i = 0; i < count; i++) {
    const exercise = generateSingleExercise(normalizedTopic, skillLevel, instrument, i);
    exercises.push(exercise);
  }

  const markdown = `# ${topic.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase())} - Exercises

**Skill Level:** ${skillLevel}
${instrument ? `**Instrument:** ${instrument}` : ""}

${exercises.map((ex, i) => `## Exercise ${i + 1}

**Question:** ${ex.question}

${ex.hint ? `**Hint:** ${ex.hint}\n` : ""}
**Difficulty:** ${ex.difficulty}
`).join("\n")}
`;

  return {
    topic: normalizedTopic,
    skillLevel,
    exercises,
    markdown,
  };
}

/**
 * Check user's answer
 */
export function checkAnswer(
  topic: string,
  userAnswer: string,
  expectedAnswer: string
): AnswerCheck {
  const normalizedUser = userAnswer.trim().toLowerCase().replace(/\s+/g, "");
  const normalizedExpected = expectedAnswer.trim().toLowerCase().replace(/\s+/g, "");

  // Check for exact match
  if (normalizedUser === normalizedExpected) {
    return {
      correct: true,
      feedback: "Correct! Well done.",
    };
  }

  // Check for enharmonic equivalents
  const enharmonicPairs: Record<string, string[]> = {
    "c#": ["db"],
    "d#": ["eb"],
    "f#": ["gb"],
    "g#": ["ab"],
    "a#": ["bb"],
  };

  for (const [sharp, flats] of Object.entries(enharmonicPairs)) {
    if (normalizedUser.includes(sharp) && normalizedExpected.includes(flats[0])) {
      return {
        correct: true,
        feedback: "Correct! (Note: You used an enharmonic equivalent, which is also correct)",
      };
    }
  }

  // Check for partial correctness
  const similarity = calculateSimilarity(normalizedUser, normalizedExpected);
  if (similarity > 0.7) {
    return {
      correct: false,
      feedback: "Close, but not quite right. Check your answer again.",
      explanation: `Expected: ${expectedAnswer}`,
    };
  }

  return {
    correct: false,
    feedback: "Incorrect. Review the concept and try again.",
    explanation: `Expected: ${expectedAnswer}`,
  };
}

/**
 * Create fretboard example for guitar/bass
 */
export function createFretboardExample(
  notes: string[],
  instrument: "guitar" | "bass" = "guitar",
  highlightNotes?: string[]
): FretboardExample {
  const tuning = instrument === "guitar" ? GUITAR_TUNING : BASS_TUNING;
  const stringNames = instrument === "guitar"
    ? ["E", "A", "D", "G", "B", "E"]
    : ["E", "A", "D", "G"];

  const positions: Array<{ string: number; fret: number; note: string; highlight?: boolean }> = [];

  // Find positions for each note on the fretboard (first 12 frets)
  notes.forEach(note => {
    const noteIndex = getNoteIndex(note);
    tuning.forEach((stringRoot, stringNum) => {
      for (let fret = 0; fret <= 12; fret++) {
        const fretNote = (stringRoot + fret) % 12;
        if (fretNote === noteIndex) {
          const highlight = highlightNotes?.some(hn => getNoteIndex(hn) === noteIndex);
          positions.push({
            string: stringNum,
            fret,
            note,
            highlight,
          });
        }
      }
    });
  });

  // Generate ASCII fretboard
  const fretboard: string[] = [];
  const fretMarkers = [3, 5, 7, 9, 12];

  // Header
  fretboard.push("  " + Array.from({ length: 13 }, (_, i) => i.toString().padStart(3)).join(""));
  fretboard.push("  " + "-".repeat(13 * 3));

  // Strings
  stringNames.forEach((stringName, stringNum) => {
    let line = stringName + " ";
    for (let fret = 0; fret <= 12; fret++) {
      const pos = positions.find(p => p.string === stringNum && p.fret === fret);
      if (pos) {
        line += pos.highlight ? `[${pos.note[0]}]` : ` ${pos.note[0]} `;
      } else {
        line += fretMarkers.includes(fret) ? " • " : " | ";
      }
    }
    fretboard.push(line);
  });

  const markdown = `# Fretboard Diagram - ${instrument.charAt(0).toUpperCase() + instrument.slice(1)}

\`\`\`
${fretboard.join("\n")}
\`\`\`

**Notes:** ${notes.join(", ")}
${highlightNotes ? `**Highlighted:** ${highlightNotes.join(", ")}` : ""}

**Tuning:** ${stringNames.join("-")} (standard ${instrument} tuning)
`;

  return {
    tuning: stringNames,
    positions,
    markdown,
  };
}

/**
 * Create keyboard example for piano
 */
export function createKeyboardExample(
  notes: string[],
  startOctave: number = 4,
  highlightNotes?: string[]
): KeyboardExample {
  const keys: Array<{ note: string; octave: number; highlight: boolean; label?: string }> = [];

  // Generate two octaves
  for (let octave = startOctave; octave <= startOctave + 1; octave++) {
    NOTE_NAMES.forEach(note => {
      const highlight = notes.some(n => {
        const noteIndex = getNoteIndex(n);
        const thisNoteIndex = getNoteIndex(note);
        return noteIndex === thisNoteIndex;
      });

      const shouldHighlightExtra = highlightNotes?.some(n => {
        const noteIndex = getNoteIndex(n);
        const thisNoteIndex = getNoteIndex(note);
        return noteIndex === thisNoteIndex;
      });

      keys.push({
        note,
        octave,
        highlight: highlight || !!shouldHighlightExtra,
        label: highlight ? note : undefined,
      });
    });
  }

  // Generate ASCII keyboard
  const whiteKeys = ["C", "D", "E", "F", "G", "A", "B"];
  const blackKeys = ["C#", "D#", "F#", "G#", "A#"];

  const keyboard: string[] = [];

  // Top line (black keys)
  let topLine = " ";
  for (let octave = startOctave; octave <= startOctave + 1; octave++) {
    whiteKeys.forEach((note, idx) => {
      if (idx < whiteKeys.length - 1 && idx !== 2) {
        const blackKey = note + "#";
        const key = keys.find(k => k.note === blackKey && k.octave === octave);
        topLine += key?.highlight ? "[#]" : " # ";
      } else {
        topLine += "   ";
      }
    });
  }
  keyboard.push(topLine);

  // Bottom line (white keys)
  let bottomLine = "";
  for (let octave = startOctave; octave <= startOctave + 1; octave++) {
    whiteKeys.forEach(note => {
      const key = keys.find(k => k.note === note && k.octave === octave);
      bottomLine += key?.highlight ? `[${note}]` : ` ${note} `;
    });
  }
  keyboard.push(bottomLine);

  const markdown = `# Piano Keyboard Diagram

\`\`\`
${keyboard.join("\n")}
\`\`\`

**Notes:** ${notes.join(", ")}
${highlightNotes ? `**Highlighted:** ${highlightNotes.join(", ")}` : ""}
**Range:** ${whiteKeys[0]}${startOctave} to ${whiteKeys[whiteKeys.length - 1]}${startOctave + 1}
`;

  return {
    keys,
    markdown,
  };
}

/**
 * Create ear training drill
 */
export function createEarTrainingDrill(
  topic: string,
  skillLevel: SkillLevel
): EarTrainingDrill {
  const normalizedTopic = topic.toLowerCase().replace(/\s+/g, "-");
  const drillCount = skillLevel === "beginner" ? 5 : skillLevel === "intermediate" ? 7 : 10;

  const drills = [];

  for (let i = 0; i < drillCount; i++) {
    const drill = generateEarTrainingQuestion(normalizedTopic, skillLevel, i);
    drills.push(drill);
  }

  const markdown = `# Ear Training: ${topic.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase())}

**Skill Level:** ${skillLevel}

## Instructions

Listen to each example and identify what you hear. Use a piano, guitar, or ear training app to play the audio described.

${drills.map((drill, i) => `## Drill ${i + 1}

**Task:** ${drill.description}

**Audio:** ${drill.audioDescription}

**Answer:** ||${drill.expectedAnswer}|| (hidden - try to answer first!)
`).join("\n")}

## Practice Tips

- Start slowly and repeat each drill multiple times
- Sing or hum what you hear before identifying it
- Use an instrument to check your answers
- Practice daily for best results
`;

  return {
    topic: normalizedTopic,
    skillLevel,
    drills,
    markdown,
  };
}

// =============================================================================
// Helper Functions for Exercise Generation
// =============================================================================

function generateTopicExercises(topic: string, skillLevel: SkillLevel, count: number): string[] {
  const exercises: string[] = [];

  switch (topic) {
    case "intervals":
      exercises.push(
        `Identify the interval from C to E`,
        `Name a major 3rd above G`,
        `What is the interval from A to F?`
      );
      break;
    case "scales":
      exercises.push(
        `Write out the C major scale`,
        `What are the notes in A natural minor?`,
        `Name the notes in the G major pentatonic scale`
      );
      break;
    case "chords":
      exercises.push(
        `Build a C major triad`,
        `What notes are in an F minor chord?`,
        `Spell a G7 chord`
      );
      break;
    default:
      exercises.push(
        `Practice ${topic} in multiple keys`,
        `Apply ${topic} to a simple melody`,
        `Analyze ${topic} in a song you know`
      );
  }

  return exercises.slice(0, count);
}

function generateSingleExercise(
  topic: string,
  skillLevel: SkillLevel,
  instrument: Instrument | undefined,
  index: number
): Exercise {
  const keys = ["C", "D", "E", "F", "G", "A", "B"];
  const randomKey = keys[index % keys.length];

  let question = "";
  let expectedAnswer = "";
  let hint = "";

  switch (topic) {
    case "intervals":
      const intervals = ["major 3rd", "perfect 5th", "minor 7th", "major 6th", "perfect 4th"];
      const interval = intervals[index % intervals.length];
      question = `What is a ${interval} above ${randomKey}?`;
      expectedAnswer = calculateInterval(randomKey, interval);
      hint = "Count the semitones from the root note";
      break;

    case "scales":
      question = `Write the ${randomKey} major scale`;
      expectedAnswer = buildScale(randomKey, SCALES.major).join(", ");
      hint = "Use the pattern: W-W-H-W-W-W-H";
      break;

    case "chords":
      question = `Spell a ${randomKey} major chord`;
      const scale = buildScale(randomKey, SCALES.major);
      expectedAnswer = `${scale[0]}, ${scale[2]}, ${scale[4]}`;
      hint = "Use the 1st, 3rd, and 5th notes of the major scale";
      break;

    case "key-signatures":
      question = `How many sharps or flats are in ${randomKey} major?`;
      const keySig = KEY_SIGNATURES[randomKey];
      if (keySig) {
        expectedAnswer = keySig.sharps > 0
          ? `${keySig.sharps} sharp${keySig.sharps > 1 ? "s" : ""}`
          : `${keySig.flats} flat${keySig.flats > 1 ? "s" : ""}`;
      } else {
        expectedAnswer = "0";
      }
      hint = "Use the circle of fifths to find the answer";
      break;

    default:
      question = `What is an example of ${topic} in the key of ${randomKey}?`;
      expectedAnswer = `Example in ${randomKey}`;
      hint = "Review the concept explanation";
  }

  return {
    question,
    expectedAnswer,
    hint,
    difficulty: skillLevel,
  };
}

function calculateInterval(root: string, intervalName: string): string {
  const rootIndex = getNoteIndex(root);
  let semitones = 0;

  if (intervalName.includes("major 3rd")) semitones = 4;
  else if (intervalName.includes("minor 3rd")) semitones = 3;
  else if (intervalName.includes("perfect 5th")) semitones = 7;
  else if (intervalName.includes("perfect 4th")) semitones = 5;
  else if (intervalName.includes("major 6th")) semitones = 9;
  else if (intervalName.includes("minor 6th")) semitones = 8;
  else if (intervalName.includes("major 7th")) semitones = 11;
  else if (intervalName.includes("minor 7th")) semitones = 10;
  else if (intervalName.includes("octave")) semitones = 12;

  const targetIndex = (rootIndex + semitones) % 12;
  return getNoteName(targetIndex);
}

function generateEarTrainingQuestion(
  topic: string,
  skillLevel: SkillLevel,
  index: number
): { description: string; audioDescription: string; expectedAnswer: string } {
  const keys = ["C", "D", "E", "F", "G"];
  const randomKey = keys[index % keys.length];

  switch (topic) {
    case "intervals":
      const intervals = ["major 3rd", "perfect 5th", "minor 3rd", "perfect 4th"];
      const interval = intervals[index % intervals.length];
      return {
        description: `Identify this interval`,
        audioDescription: `Play ${randomKey} then ${calculateInterval(randomKey, interval)}`,
        expectedAnswer: interval,
      };

    case "chords":
      const quality = index % 2 === 0 ? "major" : "minor";
      return {
        description: `Is this chord major or minor?`,
        audioDescription: `Play ${randomKey} ${quality} chord (${randomKey}-${quality === "major" ? "E" : "Eb"}-G)`,
        expectedAnswer: quality,
      };

    case "scales":
      return {
        description: `Identify if this is major or minor`,
        audioDescription: `Play ${randomKey} ${index % 2 === 0 ? "major" : "minor"} scale`,
        expectedAnswer: index % 2 === 0 ? "major" : "minor",
      };

    default:
      return {
        description: `Identify this ${topic} example`,
        audioDescription: `Play example in ${randomKey}`,
        expectedAnswer: `${topic} in ${randomKey}`,
      };
  }
}

function calculateSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1.0;

  const editDistance = calculateEditDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function calculateEditDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}

// =============================================================================
// Exports
// =============================================================================

export const supportedTopics = Object.keys(TOPIC_DATA);
