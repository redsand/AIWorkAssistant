/**
 * Tests for Music Theory Tutor Helpers
 */

import { describe, it, expect } from "vitest";
import {
  explainConcept,
  generateExercises,
  checkAnswer,
  createFretboardExample,
  createKeyboardExample,
  createEarTrainingDrill,
  supportedTopics,
  type SkillLevel,
  type Instrument,
} from "../../../src/musician/theory";

describe("Music Theory Tutor", () => {
  describe("explainConcept", () => {
    it("should explain intervals at beginner level", () => {
      const result = explainConcept("intervals", "beginner");

      expect(result.topic).toBe("intervals");
      expect(result.skillLevel).toBe("beginner");
      expect(result.explanation).toBeTruthy();
      expect(result.explanation.length).toBeGreaterThan(50);
      expect(result.musicalImportance).toBeTruthy();
      expect(result.examples).toBeInstanceOf(Array);
      expect(result.examples.length).toBeGreaterThan(0);
      expect(result.commonMistakes).toBeInstanceOf(Array);
      expect(result.exercises).toBeInstanceOf(Array);
      expect(result.nextConcepts).toBeInstanceOf(Array);
      expect(result.markdown).toContain("# Intervals");
      expect(result.markdown).toContain("## Explanation");
      expect(result.markdown).toContain("## Why It Matters");
    });

    it("should provide different depth for different skill levels", () => {
      const beginner = explainConcept("scales", "beginner");
      const intermediate = explainConcept("scales", "intermediate");
      const advanced = explainConcept("scales", "advanced");

      // Content should be increasingly sophisticated
      expect(beginner.explanation).toContain("major scale");
      expect(intermediate.explanation).toContain("harmonic minor");
      expect(advanced.explanation).toContain("melodic minor");

      // Advanced should mention more complex concepts
      expect(advanced.explanation.toLowerCase()).toContain("chord");
      expect(advanced.examples.length).toBeGreaterThanOrEqual(beginner.examples.length);
    });

    it("should include instrument-specific guidance for guitar", () => {
      const result = explainConcept("chords", "intermediate", "guitar");

      expect(result.instrumentSpecific).toBeTruthy();
      expect(result.instrumentSpecific).toContain("guitar");
      expect(result.instrumentSpecific).toContain("fretboard");
      expect(result.markdown).toContain("Instrument-Specific Practice");
    });

    it("should include instrument-specific guidance for piano", () => {
      const result = explainConcept("scales", "intermediate", "piano");

      expect(result.instrumentSpecific).toBeTruthy();
      expect(result.instrumentSpecific).toContain("piano");
      expect(result.instrumentSpecific).toContain("keys");
      expect(result.markdown).toContain("circle of fifths");
    });

    it("should handle modes topic", () => {
      const result = explainConcept("modes", "intermediate");

      expect(result.topic).toBe("modes");
      expect(result.explanation).toContain("Dorian");
      expect(result.examples.length).toBeGreaterThan(0);
      expect(result.nextConcepts).toContain("modal-interchange");
    });

    it("should handle key signatures topic", () => {
      const result = explainConcept("key-signatures", "beginner");

      expect(result.topic).toBe("key-signatures");
      expect(result.explanation).toContain("sharp");
      expect(result.explanation).toContain("flat");
      expect(result.nextConcepts).toContain("circle-of-fifths");
    });

    it("should handle circle of fifths topic", () => {
      const result = explainConcept("circle-of-fifths", "intermediate");

      expect(result.topic).toBe("circle-of-fifths");
      expect(result.explanation).toBeTruthy();
      expect(result.examples.length).toBeGreaterThan(0);
    });

    it("should handle roman numeral analysis", () => {
      const result = explainConcept("roman-numeral-analysis", "intermediate");

      expect(result.topic).toBe("roman-numeral-analysis");
      expect(result.explanation).toContain("I");
      expect(result.explanation).toContain("IV");
      expect(result.explanation).toContain("V");
    });

    it("should handle Nashville numbers", () => {
      const result = explainConcept("nashville-numbers", "beginner");

      expect(result.topic).toBe("nashville-numbers");
      expect(result.explanation).toContain("number");
      expect(result.examples.length).toBeGreaterThan(0);
    });

    it("should handle voice leading", () => {
      const result = explainConcept("voice-leading", "advanced");

      expect(result.topic).toBe("voice-leading");
      expect(result.explanation).toContain("voice");
      expect(result.explanation.length).toBeGreaterThan(100);
    });

    it("should throw error for unknown topic", () => {
      expect(() => {
        explainConcept("invalid-topic-xyz", "beginner");
      }).toThrow();
    });

    it("should include style parameter in markdown when provided", () => {
      const result = explainConcept("chords", "intermediate", "guitar", "jazz");

      expect(result.markdown).toContain("**Style:** jazz");
    });
  });

  describe("generateExercises", () => {
    it("should generate correct number of exercises", () => {
      const result = generateExercises("intervals", "beginner", undefined, 5);

      expect(result.exercises).toHaveLength(5);
      expect(result.topic).toBe("intervals");
      expect(result.skillLevel).toBe("beginner");
    });

    it("should generate 10 exercises when requested", () => {
      const result = generateExercises("scales", "intermediate", undefined, 10);

      expect(result.exercises).toHaveLength(10);
    });

    it("should include question, answer, and hint in each exercise", () => {
      const result = generateExercises("chords", "intermediate", undefined, 3);

      result.exercises.forEach(exercise => {
        expect(exercise.question).toBeTruthy();
        expect(exercise.expectedAnswer).toBeTruthy();
        expect(exercise.difficulty).toBe("intermediate");
        // Hint is optional but should be string if present
        if (exercise.hint) {
          expect(typeof exercise.hint).toBe("string");
        }
      });
    });

    it("should generate exercises appropriate for skill level", () => {
      const beginner = generateExercises("intervals", "beginner", undefined, 3);
      const advanced = generateExercises("intervals", "advanced", undefined, 3);

      beginner.exercises.forEach(ex => {
        expect(ex.difficulty).toBe("beginner");
      });

      advanced.exercises.forEach(ex => {
        expect(ex.difficulty).toBe("advanced");
      });
    });

    it("should include markdown with all exercises", () => {
      const result = generateExercises("scales", "intermediate", undefined, 3);

      expect(result.markdown).toContain("# Scales - Exercises");
      expect(result.markdown).toContain("## Exercise 1");
      expect(result.markdown).toContain("## Exercise 2");
      expect(result.markdown).toContain("## Exercise 3");
      expect(result.markdown).toContain("**Question:**");
      expect(result.markdown).toContain("**Difficulty:**");
    });

    it("should generate different exercises for different topics", () => {
      const intervals = generateExercises("intervals", "beginner", undefined, 2);
      const scales = generateExercises("scales", "beginner", undefined, 2);

      expect(intervals.exercises[0].question).not.toBe(scales.exercises[0].question);
    });

    it("should include instrument in markdown when provided", () => {
      const result = generateExercises("chords", "intermediate", "guitar", 3);

      expect(result.markdown).toContain("**Instrument:** guitar");
    });
  });

  describe("checkAnswer", () => {
    it("should recognize correct answers", () => {
      const result = checkAnswer("intervals", "major 3rd", "major 3rd");

      expect(result.correct).toBe(true);
      expect(result.feedback).toContain("Correct");
    });

    it("should recognize incorrect answers", () => {
      const result = checkAnswer("intervals", "perfect 5th", "major 3rd");

      expect(result.correct).toBe(false);
      expect(result.feedback).toContain("Incorrect");
      expect(result.explanation).toContain("major 3rd");
    });

    it("should handle case insensitive matching", () => {
      const result = checkAnswer("scales", "C MAJOR", "c major");

      expect(result.correct).toBe(true);
    });

    it("should handle whitespace differences", () => {
      const result = checkAnswer("chords", "C  E  G", "C E G");

      expect(result.correct).toBe(true);
    });

    it("should recognize enharmonic equivalents", () => {
      const result1 = checkAnswer("intervals", "C#", "Db");
      const result2 = checkAnswer("intervals", "F#", "Gb");
      const result3 = checkAnswer("intervals", "A#", "Bb");

      expect(result1.correct).toBe(true);
      expect(result1.feedback).toContain("enharmonic");
      expect(result2.correct).toBe(true);
      expect(result3.correct).toBe(true);
    });

    it("should provide helpful feedback for close answers", () => {
      const result = checkAnswer("chords", "major 3rd", "minor 3rd");

      expect(result.correct).toBe(false);
      expect(result.feedback).toContain("Close");
      expect(result.explanation).toBeTruthy();
    });

    it("should handle comma-separated note lists", () => {
      const result = checkAnswer("scales", "C,D,E,F,G,A,B", "C, D, E, F, G, A, B");

      expect(result.correct).toBe(true);
    });
  });

  describe("createFretboardExample", () => {
    it("should create guitar fretboard with standard tuning", () => {
      const result = createFretboardExample(["C", "E", "G"], "guitar");

      expect(result.tuning).toEqual(["E", "A", "D", "G", "B", "E"]);
      expect(result.positions).toBeInstanceOf(Array);
      expect(result.positions.length).toBeGreaterThan(0);
      expect(result.markdown).toContain("# Fretboard Diagram - Guitar");
      expect(result.markdown).toContain("**Tuning:** E-A-D-G-B-E");
    });

    it("should create bass fretboard with standard tuning", () => {
      const result = createFretboardExample(["E", "A", "D", "G"], "bass");

      expect(result.tuning).toEqual(["E", "A", "D", "G"]);
      expect(result.positions.length).toBeGreaterThan(0);
      expect(result.markdown).toContain("# Fretboard Diagram - Bass");
      expect(result.markdown).toContain("**Tuning:** E-A-D-G");
    });

    it("should find positions for notes on fretboard", () => {
      const result = createFretboardExample(["C"], "guitar");

      // C should appear on multiple strings and frets
      const cPositions = result.positions.filter(p => p.note === "C");
      expect(cPositions.length).toBeGreaterThan(3);

      // Each position should have valid string and fret numbers
      result.positions.forEach(pos => {
        expect(pos.string).toBeGreaterThanOrEqual(0);
        expect(pos.string).toBeLessThan(6);
        expect(pos.fret).toBeGreaterThanOrEqual(0);
        expect(pos.fret).toBeLessThanOrEqual(12);
        expect(pos.note).toBeTruthy();
      });
    });

    it("should highlight specified notes", () => {
      const result = createFretboardExample(["C", "E", "G"], "guitar", ["E"]);

      const highlightedPositions = result.positions.filter(p => p.highlight);
      expect(highlightedPositions.length).toBeGreaterThan(0);
      highlightedPositions.forEach(pos => {
        expect(pos.note).toBe("E");
      });
    });

    it("should include notes in markdown", () => {
      const result = createFretboardExample(["C", "E", "G"], "guitar");

      expect(result.markdown).toContain("C, E, G");
    });

    it("should generate ASCII fretboard diagram", () => {
      const result = createFretboardExample(["C"], "guitar");

      expect(result.markdown).toContain("```");
      expect(result.markdown).toMatch(/E\s+/); // String name
      expect(result.markdown).toMatch(/A\s+/);
      expect(result.markdown).toMatch(/[0-9]+/); // Fret numbers
    });
  });

  describe("createKeyboardExample", () => {
    it("should create piano keyboard with two octaves", () => {
      const result = createKeyboardExample(["C", "E", "G"]);

      expect(result.keys).toBeInstanceOf(Array);
      expect(result.keys.length).toBe(24); // 12 notes * 2 octaves
      expect(result.markdown).toContain("# Piano Keyboard Diagram");
    });

    it("should use correct starting octave", () => {
      const result = createKeyboardExample(["C"], 5);

      const c5Keys = result.keys.filter(k => k.note === "C" && k.octave === 5);
      expect(c5Keys.length).toBe(1);

      const c6Keys = result.keys.filter(k => k.note === "C" && k.octave === 6);
      expect(c6Keys.length).toBe(1);
    });

    it("should highlight specified notes", () => {
      const result = createKeyboardExample(["C", "E", "G"], 4);

      const highlightedKeys = result.keys.filter(k => k.highlight);
      expect(highlightedKeys.length).toBeGreaterThan(0);

      // C, E, G should appear twice (once per octave)
      const cKeys = highlightedKeys.filter(k => k.note === "C");
      expect(cKeys.length).toBe(2);
    });

    it("should add labels to highlighted notes", () => {
      const result = createKeyboardExample(["C", "E", "G"], 4, ["E"]);

      const labeledKeys = result.keys.filter(k => k.label);
      expect(labeledKeys.length).toBeGreaterThan(0);
    });

    it("should include range in markdown", () => {
      const result = createKeyboardExample(["C"], 4);

      expect(result.markdown).toContain("C4");
      expect(result.markdown).toContain("B5");
    });

    it("should generate ASCII keyboard diagram", () => {
      const result = createKeyboardExample(["C", "E", "G"], 4);

      expect(result.markdown).toContain("```");
      expect(result.markdown).toMatch(/[#]/); // Black keys
      expect(result.markdown).toMatch(/[C]/); // White keys
    });

    it("should show black and white keys separately in diagram", () => {
      const result = createKeyboardExample(["C", "C#"], 4);

      // The diagram should have two lines: black keys and white keys
      const lines = result.markdown.split("\n").filter(l => l.trim().length > 0);
      const diagramLines = lines.filter(l => l.includes("#") || l.includes("C"));
      expect(diagramLines.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("createEarTrainingDrill", () => {
    it("should create appropriate number of drills for skill level", () => {
      const beginner = createEarTrainingDrill("intervals", "beginner");
      const intermediate = createEarTrainingDrill("intervals", "intermediate");
      const advanced = createEarTrainingDrill("intervals", "advanced");

      expect(beginner.drills).toHaveLength(5);
      expect(intermediate.drills).toHaveLength(7);
      expect(advanced.drills).toHaveLength(10);
    });

    it("should include description, audio, and answer for each drill", () => {
      const result = createEarTrainingDrill("chords", "intermediate");

      result.drills.forEach(drill => {
        expect(drill.description).toBeTruthy();
        expect(drill.audioDescription).toBeTruthy();
        expect(drill.expectedAnswer).toBeTruthy();
      });
    });

    it("should generate interval ear training drills", () => {
      const result = createEarTrainingDrill("intervals", "beginner");

      expect(result.topic).toBe("intervals");
      expect(result.drills[0].description).toContain("interval");
      expect(result.drills[0].audioDescription).toContain("Play");
    });

    it("should generate chord ear training drills", () => {
      const result = createEarTrainingDrill("chords", "beginner");

      expect(result.topic).toBe("chords");
      result.drills.forEach(drill => {
        expect(drill.description).toBeTruthy();
        expect(drill.audioDescription).toContain("Play");
      });
    });

    it("should generate scale ear training drills", () => {
      const result = createEarTrainingDrill("scales", "intermediate");

      expect(result.topic).toBe("scales");
      expect(result.drills.length).toBeGreaterThan(0);
    });

    it("should include markdown with all drills", () => {
      const result = createEarTrainingDrill("intervals", "beginner");

      expect(result.markdown).toContain("# Ear Training: Intervals");
      expect(result.markdown).toContain("## Drill 1");
      expect(result.markdown).toContain("**Task:**");
      expect(result.markdown).toContain("**Audio:**");
      expect(result.markdown).toContain("**Answer:**");
      expect(result.markdown).toContain("## Practice Tips");
    });

    it("should hide answers with spoiler syntax", () => {
      const result = createEarTrainingDrill("chords", "intermediate");

      expect(result.markdown).toContain("||");
      expect(result.markdown).toContain("hidden");
    });

    it("should provide practice tips", () => {
      const result = createEarTrainingDrill("scales", "beginner");

      expect(result.markdown).toContain("Practice Tips");
      expect(result.markdown).toContain("daily");
    });
  });

  describe("supportedTopics", () => {
    it("should export list of supported topics", () => {
      expect(supportedTopics).toBeInstanceOf(Array);
      expect(supportedTopics.length).toBeGreaterThan(0);
    });

    it("should include core music theory topics", () => {
      expect(supportedTopics).toContain("intervals");
      expect(supportedTopics).toContain("scales");
      expect(supportedTopics).toContain("modes");
      expect(supportedTopics).toContain("chords");
      expect(supportedTopics).toContain("key-signatures");
      expect(supportedTopics).toContain("circle-of-fifths");
      expect(supportedTopics).toContain("roman-numeral-analysis");
      expect(supportedTopics).toContain("nashville-numbers");
      expect(supportedTopics).toContain("voice-leading");
    });
  });

  describe("Integration Tests", () => {
    it("should provide complete learning path for intervals", () => {
      const explanation = explainConcept("intervals", "beginner");
      const exercises = generateExercises("intervals", "beginner", undefined, 3);
      const earTraining = createEarTrainingDrill("intervals", "beginner");

      expect(explanation.topic).toBe("intervals");
      expect(exercises.topic).toBe("intervals");
      expect(earTraining.topic).toBe("intervals");

      // Next concepts should guide progression
      expect(explanation.nextConcepts.length).toBeGreaterThan(0);
    });

    it("should work for guitar-specific scale practice", () => {
      const explanation = explainConcept("scales", "intermediate", "guitar");
      const exercises = generateExercises("scales", "intermediate", "guitar", 5);
      const fretboard = createFretboardExample(["C", "D", "E", "F", "G", "A", "B"], "guitar");

      expect(explanation.instrumentSpecific).toContain("guitar");
      expect(exercises.markdown).toContain("guitar");
      expect(fretboard.tuning).toEqual(["E", "A", "D", "G", "B", "E"]);
    });

    it("should work for piano-specific chord practice", () => {
      const explanation = explainConcept("chords", "intermediate", "piano");
      const exercises = generateExercises("chords", "intermediate", "piano", 5);
      const keyboard = createKeyboardExample(["C", "E", "G"], 4);

      expect(explanation.instrumentSpecific).toContain("piano");
      expect(exercises.markdown).toContain("piano");
      expect(keyboard.keys.length).toBe(24);
    });

    it("should provide progressive difficulty across skill levels", () => {
      const beginnerChords = explainConcept("chords", "beginner");
      const intermediateChords = explainConcept("chords", "intermediate");
      const advancedChords = explainConcept("chords", "advanced");

      // Beginner should be simpler
      expect(beginnerChords.explanation).toContain("triad");

      // Intermediate should mention 7ths
      expect(intermediateChords.explanation).toContain("7th");

      // Advanced should mention extensions
      expect(advancedChords.explanation.toLowerCase()).toContain("extended");
    });

    it("should provide complete voice leading curriculum", () => {
      const beginner = explainConcept("voice-leading", "beginner");
      const intermediate = explainConcept("voice-leading", "intermediate");
      const advanced = explainConcept("voice-leading", "advanced");

      expect(beginner.explanation).toContain("smooth");
      expect(intermediate.explanation).toContain("parallel");
      expect(advanced.explanation).toContain("chromatic");
    });
  });
});
