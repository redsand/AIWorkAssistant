# Music Theory Tutor Implementation

## Overview
Comprehensive music theory education system providing explanations, exercises, answer checking, and instrument-specific examples for 19+ music theory topics across three skill levels.

## Features

### Concept Explanations
Six functions covering all aspects of music theory education:

1. **explainConcept(topic, skillLevel, instrument?, style?)** - Detailed concept explanations
2. **generateExercises(topic, skillLevel, instrument?, count?)** - Practice exercise generation
3. **checkAnswer(topic, userAnswer, expected?)** - Answer validation with enharmonic support
4. **createFretboardExample(notes, instrument, highlightNotes?)** - Guitar/bass fretboard diagrams
5. **createKeyboardExample(notes, startOctave, highlightNotes?)** - Piano keyboard diagrams
6. **createEarTrainingDrill(topic, skillLevel)** - Ear training exercises

### Skill Levels
Three tiers of difficulty:
- **Beginner** - Simple explanations, basic concepts, fundamental examples
- **Intermediate** - Detailed explanations, applied theory, practical examples
- **Advanced** - Comprehensive theory, professional concepts, complex examples

### Supported Topics (19+)

#### Fundamentals
- **intervals** - Major, minor, perfect, augmented, diminished intervals
- **scales** - Major, minor, pentatonic, blues, harmonic/melodic minor
- **modes** - Ionian, Dorian, Phrygian, Lydian, Mixolydian, Aeolian, Locrian
- **chords** - Triads, seventh chords, extensions, alterations
- **chord-extensions** - 9ths, 11ths, 13ths, alterations

#### Reading and Analysis
- **key-signatures** - Sharp/flat keys, relative major/minor
- **circle-of-fifths** - Key relationships, modulation, progressions
- **roman-numeral-analysis** - Functional analysis, secondary dominants, borrowed chords
- **nashville-numbers** - Number system, charts, session notation

#### Advanced Harmony
- **voice-leading** - Common tones, stepwise motion, contrary motion, parallel motion rules
- **counterpoint** - Species counterpoint, independent lines
- **functional-harmony** - Tonic, subdominant, dominant functions
- **jazz-harmony** - Extensions, alterations, substitutions
- **blues-harmony** - Blues progressions, dominant harmony
- **modal-interchange** - Borrowed chords, parallel major/minor
- **secondary-dominants** - V/V, V/vi, tonicization
- **modulation** - Key changes, pivot chords, common tone modulation

#### Rhythm and Form
- **rhythm-meter** - Time signatures, subdivisions, syncopation
- **arrangement** - Form, structure, instrumentation

### Explanation Structure

Each explanation includes:
- **Short explanation** - Concept overview appropriate for skill level
- **Musical importance** - Why it matters, practical applications
- **Examples** - 2-5 concrete examples with notation
- **Common mistakes** - What to avoid, misconceptions
- **Exercises** - 3-5 practice exercises
- **Next concepts** - Recommended learning path
- **Instrument-specific guidance** (optional) - Tailored to guitar, bass, piano, or keys

### Exercise Generation

Generates exercises with:
- **Question** - Clear, specific task
- **Expected answer** - Correct solution
- **Hint** - Optional guidance
- **Difficulty** - Matches requested skill level
- **Count** - Customizable (default 5)

Topics covered:
- Interval identification and construction
- Scale spelling and patterns
- Chord construction and analysis
- Key signature identification
- Theory application

### Answer Checking

Features:
- **Exact matching** - Case-insensitive, whitespace-flexible
- **Enharmonic equivalents** - C# = Db, F# = Gb, etc.
- **Partial credit** - Similarity scoring for close answers (>70% similarity)
- **Helpful feedback** - "Correct", "Close", or "Incorrect" with explanations

### Fretboard Examples (Guitar/Bass)

Creates ASCII fretboard diagrams showing:
- **Standard tuning** - Guitar (E-A-D-G-B-E), Bass (E-A-D-G)
- **Note positions** - All occurrences up to 12th fret
- **Highlighting** - Emphasize specific notes (root, chord tones, etc.)
- **Fret markers** - Position markers at 3, 5, 7, 9, 12

Example output:
```
     0  1  2  3  4  5  6  7  8  9 10 11 12
  ---------------------------------------
E  |  |  | [C] |  |  |  |  | [C] |  |  |
A  |  |  | [C] |  |  |  |  |  |  | [C] |
D  |  |  |  |  |  |  |  |  |  | [C] |  |
G  |  |  |  |  | [C] |  |  |  |  |  |  |
B [C] |  |  |  |  |  |  |  |  |  |  | [C]
E  |  |  | [C] |  |  |  |  | [C] |  |  |
```

### Keyboard Examples (Piano)

Creates ASCII keyboard diagrams showing:
- **Two octaves** - Default C4-B5, customizable
- **White keys** - Natural notes (C, D, E, F, G, A, B)
- **Black keys** - Accidentals (C#, D#, F#, G#, A#)
- **Highlighting** - Emphasize specific notes
- **Labels** - Note names on highlighted keys

Example output:
```
  #   #     #   #   #
[C] D [E] F  G  A  B [C] D [E] F  G  A  B
```

### Ear Training Drills

Generates listening exercises:
- **Drill count** - 5 (beginner), 7 (intermediate), 10 (advanced)
- **Task description** - What to identify
- **Audio description** - What to play/listen for
- **Hidden answers** - Spoiler syntax for self-checking

Topics:
- Interval recognition
- Chord quality identification
- Scale/mode recognition
- Rhythm patterns
- Melodic dictation

## API

### explainConcept
```typescript
export function explainConcept(
  topic: string,
  skillLevel: SkillLevel,
  instrument?: Instrument,
  style?: string
): ConceptExplanation
```

Returns comprehensive explanation with examples, mistakes, exercises, and next steps.

### generateExercises
```typescript
export function generateExercises(
  topic: string,
  skillLevel: SkillLevel,
  instrument?: Instrument,
  count?: number
): ExerciseSet
```

Returns set of practice exercises with questions and answers.

### checkAnswer
```typescript
export function checkAnswer(
  topic: string,
  userAnswer: string,
  expectedAnswer: string
): AnswerCheck
```

Returns correctness, feedback, and optional explanation.

### createFretboardExample
```typescript
export function createFretboardExample(
  notes: string[],
  instrument: "guitar" | "bass",
  highlightNotes?: string[]
): FretboardExample
```

Returns fretboard diagram with note positions.

### createKeyboardExample
```typescript
export function createKeyboardExample(
  notes: string[],
  startOctave?: number,
  highlightNotes?: string[]
): KeyboardExample
```

Returns keyboard diagram with highlighted notes.

### createEarTrainingDrill
```typescript
export function createEarTrainingDrill(
  topic: string,
  skillLevel: SkillLevel
): EarTrainingDrill
```

Returns set of ear training exercises with audio descriptions.

## Test Coverage

54 tests covering:
- Concept explanations at all skill levels
- Explanation depth progression
- Instrument-specific guidance (guitar, bass, piano)
- Exercise generation with custom counts
- Answer checking (exact, enharmonic, partial)
- Fretboard diagram generation
- Keyboard diagram generation
- Ear training drill creation
- Topic coverage (intervals, scales, modes, chords, etc.)
- Integration workflows (complete learning paths)

## Example Usage

### Basic Concept Explanation
```typescript
const explanation = explainConcept("intervals", "beginner");
console.log(explanation.explanation); // "An interval is the distance..."
console.log(explanation.examples); // ["C to E is a major 3rd...", ...]
console.log(explanation.nextConcepts); // ["scales", "chords", "ear-training"]
```

### Guitar-Specific Learning
```typescript
const explanation = explainConcept("scales", "intermediate", "guitar");
const exercises = generateExercises("scales", "intermediate", "guitar", 5);
const fretboard = createFretboardExample(["C", "D", "E", "F", "G", "A", "B"], "guitar");

console.log(explanation.instrumentSpecific); // "For guitar: Practice across fretboard..."
console.log(fretboard.markdown); // ASCII fretboard diagram
```

### Piano Practice Workflow
```typescript
const chordExplanation = explainConcept("chords", "beginner", "piano");
const exercises = generateExercises("chords", "beginner", "piano", 5);
const keyboard = createKeyboardExample(["C", "E", "G"], 4);

console.log(keyboard.markdown); // ASCII keyboard with C-E-G highlighted
```

### Exercise with Answer Checking
```typescript
const exercises = generateExercises("intervals", "beginner", undefined, 3);
const userAnswer = "E";
const check = checkAnswer("intervals", userAnswer, exercises.exercises[0].expectedAnswer);

if (check.correct) {
  console.log(check.feedback); // "Correct! Well done."
} else {
  console.log(check.feedback); // "Incorrect. Review the concept..."
  console.log(check.explanation); // Expected answer
}
```

### Ear Training Practice
```typescript
const drills = createEarTrainingDrill("intervals", "intermediate");
console.log(drills.markdown);
// # Ear Training: Intervals
// ## Drill 1
// **Task:** Identify this interval
// **Audio:** Play C then E
// **Answer:** ||major 3rd||
```

### Complete Learning Path
```typescript
// Step 1: Learn concept
const explanation = explainConcept("voice-leading", "intermediate", "piano");

// Step 2: Practice exercises
const exercises = generateExercises("voice-leading", "intermediate", "piano", 5);

// Step 3: Check understanding
const answer = checkAnswer("voice-leading", "common tones", exercises.exercises[0].expectedAnswer);

// Step 4: Visualize on instrument
const keyboard = createKeyboardExample(["C", "E", "G"], 4);

// Step 5: Ear training
const earTraining = createEarTrainingDrill("chords", "intermediate");

// Step 6: Move to next concept
console.log(explanation.nextConcepts); // ["counterpoint", "harmonization", "jazz-voicing"]
```

## Design Principles

### Deterministic
- All outputs are deterministic and reproducible
- No randomness in content generation
- Exercises cycle through keys predictably

### Educational
- Progressive difficulty across skill levels
- Clear explanations appropriate for target audience
- Emphasis on practical application

### Comprehensive
- 19+ topics covering fundamentals through advanced harmony
- Multiple learning modalities (reading, exercises, ear training, visual)
- Instrument-specific guidance when applicable

### Practical
- Markdown output for easy rendering
- ASCII diagrams work in any terminal/text environment
- Ready for integration into learning management systems

## File Locations
- Implementation: `src/musician/theory.ts`
- Tests: `tests/unit/musician/theory.test.ts`
- Documentation: `THEORY_TUTOR_IMPLEMENTATION.md`

## Music Theory Topics Covered

### Beginner-Friendly Topics
- Intervals (distance between notes)
- Scales (major, minor, pentatonic)
- Chords (triads)
- Key signatures (reading sharps/flats)
- Nashville numbers (chord charts)

### Intermediate Topics
- Modes (Dorian, Phrygian, Lydian, etc.)
- Chord extensions (7ths, 9ths)
- Circle of fifths (key relationships)
- Roman numeral analysis (functional harmony)
- Voice leading (smooth progressions)

### Advanced Topics
- Modal interchange (borrowed chords)
- Secondary dominants (tonicization)
- Jazz harmony (alterations, substitutions)
- Counterpoint (independent melodic lines)
- Modulation (key changes)

## Learning Paths

### Recommended Progression

**Beginner Path:**
1. Intervals → Scales → Chords → Key Signatures
2. Circle of Fifths → Roman Numeral Analysis
3. Nashville Numbers → Chord Progressions

**Intermediate Path:**
1. Modes → Modal Harmony
2. Chord Extensions → Voice Leading
3. Secondary Dominants → Functional Harmony

**Advanced Path:**
1. Modal Interchange → Jazz Harmony
2. Counterpoint → Advanced Voice Leading
3. Modulation → Reharmonization

## Common Use Cases

### Self-Study
Use explainConcept + generateExercises + checkAnswer for complete self-paced learning.

### Teaching
Use markdown output for lesson plans, handouts, and student assignments.

### Practice Tools
Use ear training drills and fretboard/keyboard diagrams for instrument practice.

### Music Theory Apps
Integrate functions into web or mobile apps for interactive learning.

### Assessment
Use generateExercises + checkAnswer for quizzes and tests.
