/**
 * Tests for Composition and Songwriting Helpers
 *
 * Tests chord progression generation, arrangement mapping, melody guidance,
 * lyric structures, and music theory analysis.
 */

import { describe, it, expect } from "vitest";
import {
  generateChordProgressions,
  generateArrangementMap,
  generateMelodyGuidance,
  generateLyricStructure,
  analyzeChordProgression,
  reharmonizeProgression,
  generatePracticeEtude,
} from "../../../src/musician/composition";

describe("Composition Helpers", () => {
  describe("generateChordProgressions", () => {
    it("should generate pop progression in major key", () => {
      const result = generateChordProgressions({
        key: "C",
        mode: "major",
        genre: "pop",
        mood: "happy",
        length: 4,
      });

      expect(result.progression).toBeDefined();
      expect(result.progression.length).toBe(4);
      expect(result.nashville).toBeDefined();
      expect(result.roman).toBeDefined();
      expect(result.markdown).toContain("Chord Progression");
      expect(result.markdown).toContain("C major");
    });

    it("should generate rock progression", () => {
      const result = generateChordProgressions({
        key: "A",
        mode: "major",
        genre: "rock",
        mood: "energetic",
        length: 3,
      });

      expect(result.progression.length).toBe(3);
      expect(result.markdown).toContain("rock");
    });

    it("should generate jazz progression with sevenths", () => {
      const result = generateChordProgressions({
        key: "F",
        mode: "major",
        genre: "jazz",
        complexity: "complex",
        length: 4,
      });

      expect(result.progression.length).toBe(4);
      // Jazz progressions should include 7th chords
      const hasSeventh = result.progression.some(chord => chord.includes("7"));
      expect(hasSeventh).toBe(true);
    });

    it("should generate blues progression", () => {
      const result = generateChordProgressions({
        key: "E",
        mode: "major",
        genre: "blues",
        length: 12,
      });

      expect(result.progression.length).toBe(12);
      expect(result.markdown).toContain("blues");
    });

    it("should generate progression in minor key", () => {
      const result = generateChordProgressions({
        key: "Am",
        mode: "minor",
        genre: "pop",
        mood: "sad",
        length: 4,
      });

      expect(result.progression).toBeDefined();
      expect(result.markdown).toContain("minor");
    });

    it("should generate progression in Dorian mode", () => {
      const result = generateChordProgressions({
        key: "D",
        mode: "dorian",
        genre: "folk",
        length: 4,
      });

      expect(result.progression).toBeDefined();
      expect(result.markdown).toContain("dorian");
    });

    it("should include Nashville numbers", () => {
      const result = generateChordProgressions({
        key: "G",
        mode: "major",
        genre: "pop",
        length: 4,
      });

      expect(result.nashville).toBeDefined();
      expect(result.nashville.length).toBe(4);
      expect(result.nashville.every(n => /^\d/.test(n))).toBe(true);
    });

    it("should include Roman numerals", () => {
      const result = generateChordProgressions({
        key: "C",
        mode: "major",
        genre: "pop",
        length: 4,
      });

      expect(result.roman).toBeDefined();
      expect(result.roman.length).toBe(4);
      expect(result.roman.some(r => /^[IViv]/.test(r))).toBe(true);
    });

    it("should provide analysis", () => {
      const result = generateChordProgressions({
        key: "C",
        mode: "major",
        genre: "pop",
        length: 4,
      });

      expect(result.analysis).toBeDefined();
      expect(result.analysis.length).toBeGreaterThan(0);
    });

    it("should handle different complexity levels", () => {
      const simple = generateChordProgressions({
        key: "C",
        mode: "major",
        genre: "pop",
        complexity: "simple",
        length: 4,
      });

      const complex = generateChordProgressions({
        key: "C",
        mode: "major",
        genre: "jazz",
        complexity: "complex",
        length: 4,
      });

      expect(simple.progression).toBeDefined();
      expect(complex.progression).toBeDefined();
    });
  });

  describe("generateArrangementMap", () => {
    it("should generate basic arrangement", () => {
      const result = generateArrangementMap({
        genre: "pop",
        duration: 180,
      });

      expect(result.sections).toBeDefined();
      expect(result.sections.length).toBeGreaterThan(0);
      expect(result.totalDuration).toBe(180);
      expect(result.markdown).toContain("Arrangement Map");
    });

    it("should have sections with required properties", () => {
      const result = generateArrangementMap({
        genre: "rock",
        duration: 200,
      });

      result.sections.forEach(section => {
        expect(section).toHaveProperty("name");
        expect(section).toHaveProperty("startTime");
        expect(section).toHaveProperty("duration");
        expect(section).toHaveProperty("energy");
        expect(section).toHaveProperty("description");
        expect(section.energy).toBeGreaterThanOrEqual(0);
        expect(section.energy).toBeLessThanOrEqual(10);
      });
    });

    it("should respect custom sections", () => {
      const customSections = ["intro", "verse", "chorus", "outro"];
      const result = generateArrangementMap({
        genre: "folk",
        duration: 120,
        sections: customSections,
      });

      expect(result.sections.length).toBe(customSections.length);
      expect(result.sections.map(s => s.name)).toEqual(customSections);
    });

    it("should apply building energy curve", () => {
      const result = generateArrangementMap({
        genre: "electronic",
        duration: 180,
        energyCurve: "building",
      });

      // Energy should generally increase
      const energies = result.sections.map(s => s.energy);
      const firstHalf = energies.slice(0, Math.floor(energies.length / 2));
      const secondHalf = energies.slice(Math.floor(energies.length / 2));
      const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

      expect(avgSecond).toBeGreaterThanOrEqual(avgFirst - 1); // Allow some variance
    });

    it("should apply explosive energy curve", () => {
      const result = generateArrangementMap({
        genre: "edm",
        duration: 180,
        energyCurve: "explosive",
      });

      expect(result.sections).toBeDefined();
      expect(result.markdown).toContain("explosive");
    });

    it("should apply dynamic energy curve", () => {
      const result = generateArrangementMap({
        genre: "rock",
        duration: 180,
        energyCurve: "dynamic",
      });

      expect(result.sections).toBeDefined();
      expect(result.markdown).toContain("dynamic");
    });

    it("should provide chord suggestions", () => {
      const result = generateArrangementMap({
        genre: "pop",
        duration: 180,
      });

      result.sections.forEach(section => {
        expect(section.chordSuggestion).toBeDefined();
        expect(section.chordSuggestion.length).toBeGreaterThan(0);
      });
    });

    it("should sum section durations to total", () => {
      const result = generateArrangementMap({
        genre: "jazz",
        duration: 240,
      });

      const sumDurations = result.sections.reduce((sum, s) => sum + s.duration, 0);
      expect(Math.abs(sumDurations - result.totalDuration)).toBeLessThan(1);
    });
  });

  describe("generateMelodyGuidance", () => {
    it("should generate melody guidance for progression", () => {
      const result = generateMelodyGuidance({
        key: "C",
        chordProgression: ["C", "Am", "F", "G"],
        range: "medium",
        style: "mixed",
      });

      expect(result.guidance).toBeDefined();
      expect(result.guidance.length).toBe(4);
      expect(result.scaleNotes).toBeDefined();
      expect(result.chordTones).toBeDefined();
      expect(result.markdown).toContain("Melody Guidance");
    });

    it("should provide chord tones for each chord", () => {
      const result = generateMelodyGuidance({
        key: "G",
        chordProgression: ["G", "Em", "C", "D"],
      });

      expect(result.chordTones).toHaveProperty("G");
      expect(result.chordTones).toHaveProperty("Em");
      expect(result.chordTones).toHaveProperty("C");
      expect(result.chordTones).toHaveProperty("D");

      // Each chord should have 3 tones (triad)
      expect(result.chordTones["G"].length).toBe(3);
      expect(result.chordTones["Em"].length).toBe(3);
    });

    it("should handle different ranges", () => {
      const low = generateMelodyGuidance({
        key: "C",
        chordProgression: ["C", "F", "G"],
        range: "low",
      });

      const high = generateMelodyGuidance({
        key: "C",
        chordProgression: ["C", "F", "G"],
        range: "high",
      });

      expect(low.markdown).toContain("low");
      expect(high.markdown).toContain("high");
    });

    it("should handle different melodic styles", () => {
      const stepwise = generateMelodyGuidance({
        key: "D",
        chordProgression: ["D", "G", "A"],
        style: "stepwise",
      });

      const leaps = generateMelodyGuidance({
        key: "D",
        chordProgression: ["D", "G", "A"],
        style: "leaps",
      });

      const arpeggiated = generateMelodyGuidance({
        key: "D",
        chordProgression: ["D", "G", "A"],
        style: "arpeggiated",
      });

      expect(stepwise.markdown).toContain("step");
      expect(leaps.markdown).toContain("leap");
      expect(arpeggiated.markdown).toContain("arpeggio");
    });

    it("should provide scale notes for key", () => {
      const result = generateMelodyGuidance({
        key: "F",
        chordProgression: ["F", "Bb", "C"],
      });

      expect(result.scaleNotes).toBeDefined();
      expect(result.scaleNotes.length).toBe(7);
      expect(result.scaleNotes[0]).toBe("F");
    });

    it("should handle minor chords", () => {
      const result = generateMelodyGuidance({
        key: "A",
        chordProgression: ["Am", "Dm", "E"],
      });

      expect(result.chordTones["Am"]).toBeDefined();
      expect(result.chordTones["Dm"]).toBeDefined();
    });
  });

  describe("generateLyricStructure", () => {
    it("should generate basic lyric structure", () => {
      const result = generateLyricStructure({
        theme: "love",
        genre: "pop",
        rhymeDensity: "moderate",
      });

      expect(result.structure).toBeDefined();
      expect(result.structure.length).toBeGreaterThan(0);
      expect(result.markdown).toContain("Lyric Structure");
    });

    it("should have proper section structure", () => {
      const result = generateLyricStructure({
        genre: "rock",
      });

      result.structure.forEach(section => {
        expect(section).toHaveProperty("section");
        expect(section).toHaveProperty("lines");
        expect(section).toHaveProperty("rhymeScheme");
        expect(section.lines).toBeGreaterThan(0);
        expect(section.rhymeScheme.length).toBeGreaterThan(0);
      });
    });

    it("should handle different rhyme densities", () => {
      const minimal = generateLyricStructure({
        rhymeDensity: "minimal",
      });

      const moderate = generateLyricStructure({
        rhymeDensity: "moderate",
      });

      const heavy = generateLyricStructure({
        rhymeDensity: "heavy",
      });

      expect(minimal.structure).toBeDefined();
      expect(moderate.structure).toBeDefined();
      expect(heavy.structure).toBeDefined();
    });

    it("should respect custom sections", () => {
      const customSections = ["verse", "chorus", "verse"];
      const result = generateLyricStructure({
        sections: customSections,
      });

      expect(result.structure.length).toBe(customSections.length);
      expect(result.structure.map(s => s.section)).toEqual(customSections);
    });

    it("should provide rhyme schemes", () => {
      const result = generateLyricStructure({
        genre: "pop",
        rhymeDensity: "moderate",
      });

      result.structure.forEach(section => {
        expect(section.rhymeScheme).toMatch(/^[A-Z]+$/);
      });
    });

    it("should include syllable patterns", () => {
      const result = generateLyricStructure({
        genre: "folk",
      });

      const hasPatterns = result.structure.some(s => s.syllablePattern !== undefined);
      expect(hasPatterns).toBe(true);
    });

    it("should provide writing tips in markdown", () => {
      const result = generateLyricStructure({
        genre: "pop",
        rhymeDensity: "heavy",
      });

      expect(result.markdown).toContain("Writing Tips");
    });
  });

  describe("analyzeChordProgression", () => {
    it("should analyze major key progression", () => {
      const result = analyzeChordProgression({
        progression: ["C", "Am", "F", "G"],
        key: "C",
      });

      expect(result.key).toBe("C");
      expect(result.mode).toBe("major");
      expect(result.romanNumerals).toBeDefined();
      expect(result.romanNumerals.length).toBe(4);
      expect(result.functions).toBeDefined();
      expect(result.markdown).toContain("Analysis");
    });

    it("should detect Roman numerals correctly", () => {
      const result = analyzeChordProgression({
        progression: ["C", "Dm", "Em", "F"],
        key: "C",
      });

      expect(result.romanNumerals).toContain("I");
      expect(result.romanNumerals).toContain("ii");
      expect(result.romanNumerals).toContain("iii");
      expect(result.romanNumerals).toContain("IV");
    });

    it("should identify chord functions", () => {
      const result = analyzeChordProgression({
        progression: ["C", "F", "G", "C"],
        key: "C",
      });

      expect(result.functions).toBeDefined();
      expect(result.functions.length).toBe(4);
      expect(result.functions[0]).toContain("Tonic");
    });

    it("should detect cadences", () => {
      const result = analyzeChordProgression({
        progression: ["C", "F", "G", "C"],
        key: "C",
      });

      expect(result.cadences).toBeDefined();
      expect(result.cadences.length).toBeGreaterThan(0);
    });

    it("should identify borrowed chords", () => {
      const result = analyzeChordProgression({
        progression: ["C", "Bb", "F", "G"],
        key: "C",
      });

      expect(result.borrowedChords).toBeDefined();
      // Bb is not diatonic in C major
      expect(result.borrowedChords.length).toBeGreaterThan(0);
    });

    it("should analyze minor key progression", () => {
      const result = analyzeChordProgression({
        progression: ["Am", "Dm", "E", "Am"],
        key: "A",
      });

      expect(result.mode).toBe("minor");
      expect(result.romanNumerals).toBeDefined();
    });

    it("should detect authentic cadence", () => {
      const result = analyzeChordProgression({
        progression: ["C", "G", "C"],
        key: "C",
      });

      const hasAuthentic = result.cadences.some(c => c.includes("Authentic"));
      expect(hasAuthentic).toBe(true);
    });

    it("should detect plagal cadence", () => {
      const result = analyzeChordProgression({
        progression: ["C", "F", "C"],
        key: "C",
      });

      const hasPlagal = result.cadences.some(c => c.includes("Plagal"));
      expect(hasPlagal).toBe(true);
    });

    it("should detect deceptive cadence", () => {
      const result = analyzeChordProgression({
        progression: ["C", "G", "Am"],
        key: "C",
      });

      const hasDeceptive = result.cadences.some(c => c.includes("Deceptive"));
      expect(hasDeceptive).toBe(true);
    });
  });

  describe("reharmonizeProgression", () => {
    it("should reharmonize to jazzier sound", () => {
      const result = reharmonizeProgression({
        progression: ["C", "Am", "F", "G"],
        key: "C",
        targetMood: "jazzier",
        complexity: "moderate",
      });

      expect(result.progression).toBeDefined();
      expect(result.progression.length).toBe(4);
      // Should add 7th chords
      const has7th = result.progression.some(c => c.includes("7"));
      expect(has7th).toBe(true);
    });

    it("should reharmonize to darker mood", () => {
      const result = reharmonizeProgression({
        progression: ["C", "F", "G", "C"],
        key: "C",
        targetMood: "darker",
      });

      expect(result.progression).toBeDefined();
      // Should convert to minor chords
      const hasMinor = result.progression.some(c => c.includes("m"));
      expect(hasMinor).toBe(true);
    });

    it("should reharmonize to brighter mood", () => {
      const result = reharmonizeProgression({
        progression: ["Am", "Dm", "Em", "Am"],
        key: "A",
        targetMood: "brighter",
      });

      expect(result.progression).toBeDefined();
      expect(result.markdown).toContain("Reharmonization");
    });

    it("should maintain progression length", () => {
      const original = ["C", "Am", "F", "G"];
      const result = reharmonizeProgression({
        progression: original,
        key: "C",
        targetMood: "jazzier",
      });

      expect(result.progression.length).toBe(original.length);
    });

    it("should provide analysis of changes", () => {
      const result = reharmonizeProgression({
        progression: ["C", "Am", "F", "G"],
        key: "C",
        targetMood: "darker",
      });

      expect(result.analysis).toBeDefined();
      expect(result.analysis.length).toBeGreaterThan(0);
    });

    it("should handle different complexity levels", () => {
      const simple = reharmonizeProgression({
        progression: ["C", "F", "G"],
        key: "C",
        targetMood: "jazzier",
        complexity: "simple",
      });

      const complex = reharmonizeProgression({
        progression: ["C", "F", "G"],
        key: "C",
        targetMood: "jazzier",
        complexity: "complex",
      });

      expect(simple.progression).toBeDefined();
      expect(complex.progression).toBeDefined();
    });
  });

  describe("generatePracticeEtude", () => {
    it("should generate basic practice etude", () => {
      const result = generatePracticeEtude({
        instrument: "piano",
        concept: "scales",
        skillLevel: "beginner",
      });

      expect(result.markdown).toBeDefined();
      expect(result.markdown).toContain("Practice Etude");
      expect(result.markdown).toContain("piano");
      expect(result.markdown).toContain("scales");
    });

    it("should handle different instruments", () => {
      const piano = generatePracticeEtude({
        instrument: "piano",
        concept: "arpeggios",
        skillLevel: "intermediate",
      });

      const guitar = generatePracticeEtude({
        instrument: "guitar",
        concept: "arpeggios",
        skillLevel: "intermediate",
      });

      expect(piano.markdown).toContain("piano");
      expect(guitar.markdown).toContain("guitar");
    });

    it("should handle different concepts", () => {
      const scales = generatePracticeEtude({
        instrument: "piano",
        concept: "scales",
        skillLevel: "intermediate",
      });

      const arpeggios = generatePracticeEtude({
        instrument: "piano",
        concept: "arpeggios",
        skillLevel: "intermediate",
      });

      expect(scales.markdown).toContain("scales");
      expect(arpeggios.markdown).toContain("arpeggios");
    });

    it("should handle different skill levels", () => {
      const beginner = generatePracticeEtude({
        instrument: "piano",
        concept: "scales",
        skillLevel: "beginner",
      });

      const advanced = generatePracticeEtude({
        instrument: "piano",
        concept: "scales",
        skillLevel: "advanced",
      });

      expect(beginner.markdown).toContain("beginner");
      expect(advanced.markdown).toContain("advanced");
    });

    it("should include exercise structure", () => {
      const result = generatePracticeEtude({
        instrument: "bass",
        concept: "scales",
        skillLevel: "intermediate",
      });

      expect(result.markdown).toContain("Exercise Structure");
    });

    it("should include practice routine", () => {
      const result = generatePracticeEtude({
        instrument: "drums",
        concept: "rudiments",
        skillLevel: "beginner",
      });

      expect(result.markdown).toContain("Practice Routine");
    });

    it("should include tips", () => {
      const result = generatePracticeEtude({
        instrument: "voice",
        concept: "breath control",
        skillLevel: "intermediate",
      });

      expect(result.markdown).toContain("Tips");
    });

    it("should include progression steps", () => {
      const result = generatePracticeEtude({
        instrument: "guitar",
        concept: "fingerpicking",
        skillLevel: "advanced",
      });

      expect(result.markdown).toContain("Progression");
      expect(result.markdown).toContain("Week");
    });
  });

  describe("Integration Tests", () => {
    it("should generate complete songwriting workflow", () => {
      // 1. Generate chord progression
      const chords = generateChordProgressions({
        key: "C",
        mode: "major",
        genre: "pop",
        mood: "happy",
        length: 4,
      });

      expect(chords.progression).toBeDefined();

      // 2. Generate arrangement
      const arrangement = generateArrangementMap({
        genre: "pop",
        duration: 180,
      });

      expect(arrangement.sections).toBeDefined();

      // 3. Generate melody guidance
      const melody = generateMelodyGuidance({
        key: "C",
        chordProgression: chords.progression,
        range: "medium",
        style: "mixed",
      });

      expect(melody.guidance).toBeDefined();

      // 4. Generate lyric structure
      const lyrics = generateLyricStructure({
        theme: "love",
        genre: "pop",
        rhymeDensity: "moderate",
      });

      expect(lyrics.structure).toBeDefined();

      // All components should be compatible
      expect(chords.progression.length).toBeGreaterThan(0);
      expect(arrangement.sections.length).toBeGreaterThan(0);
      expect(melody.guidance.length).toBe(chords.progression.length);
    });

    it("should handle jazz composition workflow", () => {
      const chords = generateChordProgressions({
        key: "Bb",
        mode: "major",
        genre: "jazz",
        complexity: "complex",
        length: 4,
      });

      const analysis = analyzeChordProgression({
        progression: chords.progression,
        key: "Bb",
      });

      const reharmonized = reharmonizeProgression({
        progression: chords.progression,
        key: "Bb",
        targetMood: "jazzier",
        complexity: "complex",
      });

      expect(chords.progression).toBeDefined();
      expect(analysis.romanNumerals).toBeDefined();
      expect(reharmonized.progression).toBeDefined();
    });
  });
});
