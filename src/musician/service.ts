/**
 * Musician Assistant Service Layer
 *
 * Centralized service for musician assistant operations.
 * This service layer is called by the tool dispatcher to handle musician.* tools.
 */

import {
  analyzeWithEssentia,
  getAudioMetadata,
  transcribeWithBasicPitch,
} from "../integrations/audio";
import {
  MusicalTheoryRequest,
  CompositionRequest,
  AudioAnalysisRequest,
  MusicGenerationRequest,
  MusicGenerationResult,
  AudioTechnicalMetrics,
} from "./analysis-types";
import { TranscriptionResult } from "../integrations/audio/types";

/**
 * Musician Assistant Service
 */
export interface MusicianService {
  explainTheory(request: MusicalTheoryRequest): Promise<{ markdown: string }>;
  compose(request: CompositionRequest): Promise<{ markdown: string }>;
  analyzeAudio(request: AudioAnalysisRequest): Promise<{
    metrics: Partial<AudioTechnicalMetrics>;
    report?: string;
    warnings: string[];
  }>;
  generateSample(request: MusicGenerationRequest): Promise<MusicGenerationResult>;
  transcribeAudio(filePath: string, outputDir: string): Promise<TranscriptionResult>;
  createPracticePlan(params: {
    instrument: string;
    goal: string;
    skillLevel: "beginner" | "intermediate" | "advanced" | "pro";
    minutesPerDay: number;
    days: number;
  }): Promise<{ markdown: string }>;
}

export class MusicianService implements MusicianService {
  async explainTheory(request: MusicalTheoryRequest): Promise<{ markdown: string }> {
    const { topic, skillLevel, instrument, style, includeExercises, includeExamples } = request;

    // Build context for the theory explanation
    let context = `Topic: ${topic}\n`;
    if (skillLevel) context += `Skill Level: ${skillLevel}\n`;
    if (instrument) context += `Instrument: ${instrument}\n`;
    if (style) context += `Style: ${style}\n`;

    context += `Include exercises: ${includeExercises ?? true}\n`;
    context += `Include examples: ${includeExamples ?? true}\n`;

    // For MVP, return a structured theory response
    // In production, this would call an LLM with the musician mode
    let markdown = `# ${topic}\n\n## Overview\n\nThis section covers ${topic} for ${instrument || "music"}.\n\n## Concepts\n\nKey concepts about ${topic}:\n\n1. **Fundamental Understanding**\n   - Core principles of ${topic}\n   - Common patterns and variations\n\n2. **Practical Application**\n   - How to apply ${topic} in practice\n   - Common mistakes to avoid\n\n3. **Further Study**\n   - Recommended resources\n   - Related topics to explore\n`;

    if (includeExercises) {
      markdown += `\n## Exercises\n\nPractice exercises for ${topic}:\n\n1. Exercise 1: Basic application\n2. Exercise 2: Advanced variation\n3. Exercise 3: Creative exploration\n`;
    }

    return { markdown };
  }

  async compose(request: CompositionRequest): Promise<{ markdown: string }> {
    const { goal, genre, mood, tempo } = request;

    // Build context for composition
    let context = `Goal: ${goal}\n`;
    if (genre) context += `Genre: ${genre}\n`;
    if (mood) context += `Mood: ${mood}\n`;
    if (tempo) context += `Tempo: ${tempo} BPM\n`;

    // For MVP, return a structured composition response
    const markdown = `# Composition Guidance\n\n## Goal Assessment\n\nPrimary Goal: ${goal}\n\n## Composition Plan\n\n### Chord Progressions\n- Suggested progressions based on ${genre || "the style"}\n- Function analysis for each progression\n\n### Melodic Contour\n- Recommended melodic patterns\n- Voice leading suggestions\n\n### Arrangement\n- Instrumentation breakdown\n- Dynamic structure\n\n### Lyric Ideas (if applicable)\n- Thematic directions\n- Rhyme scheme suggestions\n`;

    return { markdown };
  }

  async analyzeAudio(request: AudioAnalysisRequest): Promise<{
    metrics: Partial<AudioTechnicalMetrics>;
    report?: string;
    warnings: string[];
  }> {
    const { fileId, filePath, analysisType } = request;
    const warnings: string[] = [];
    const metrics: Partial<AudioTechnicalMetrics> = {};

    try {
      // Determine actual file path
      const actualPath = filePath || (fileId ? `./audio-files/${fileId}` : "");
      if (!actualPath) {
        warnings.push("Either fileId or filePath is required");
        return { metrics, warnings };
      }

      // Check if file exists
      const fs = require("fs");
      if (!fs.existsSync(actualPath)) {
        warnings.push(`File not found: ${actualPath}`);
        return { metrics, warnings };
      }

      // Get basic audio metadata
      const metadataResult = await getAudioMetadata(actualPath);
      warnings.push(...metadataResult.warnings);

      if (metadataResult.metrics) {
        Object.assign(metrics, metadataResult.metrics);
      }

      // For MVP, add analysis-specific logic based on analysisType
      if (analysisType === "all" || analysisType === "mixdown" || analysisType === "mastering") {
        // Use Essentia for detailed analysis if available
        const essentiaResult = await analyzeWithEssentia(actualPath);
        if (essentiaResult.warnings) {
          warnings.push(...essentiaResult.warnings);
        }

        if (essentiaResult.tempo) {
          metrics.tempoBpm = essentiaResult.tempo;
        }
        if (essentiaResult.key && essentiaResult.scale) {
          metrics.keyEstimate = `${essentiaResult.key} ${essentiaResult.scale}`;
        }
      }

      // Generate report if requested
      const report = this.buildAnalysisReport(metrics, warnings, analysisType);

      return { metrics, report, warnings };
    } catch (error) {
      warnings.push(`Analysis error: ${error instanceof Error ? error.message : "Unknown error"}`);
      return { metrics, warnings };
    }
  }

  private buildAnalysisReport(
    metrics: Partial<AudioTechnicalMetrics>,
    warnings: string[],
    analysisType: string
  ): string {
    let report = `# Audio Analysis Report (${analysisType})\n\n`;

    if (Object.keys(metrics).length === 0) {
      report += "No metrics available.\n";
    } else {
      report += "## Technical Metrics\n\n";
      if (metrics.durationSeconds) {
        report += `- **Duration**: ${metrics.durationSeconds} seconds\n`;
      }
      if (metrics.sampleRate) {
        report += `- **Sample Rate**: ${metrics.sampleRate} Hz\n`;
      }
      if (metrics.channels) {
        report += `- **Channels**: ${metrics.channels}\n`;
      }
      if (metrics.tempoBpm) {
        report += `- **Tempo**: ${metrics.tempoBpm} BPM\n`;
      }
      if (metrics.keyEstimate) {
        report += `- **Key**: ${metrics.keyEstimate}\n`;
      }
    }

    if (warnings.length > 0) {
      report += "\n## Warnings\n\n";
      warnings.forEach((w) => {
        report += `- ${w}\n`;
      });
    }

    return report;
  }

  async generateSample(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    const { prompt, durationSeconds, dryRun, genre, mood, tempo } = request;

    // For MVP, return a dry-run style response
    // In production, this would call MusicGen or another generation service
    const outputDir = process.env.MUSICGEN_OUTPUT_DIR || "./generated-audio";
    const fs = require("fs");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const result: MusicGenerationResult = {
      assetId: `gen_${Date.now()}`,
      filePath: dryRun ? "" : `${outputDir}/generated_${Date.now()}.wav`,
      durationSeconds: durationSeconds || 15,
      prompt,
      model: dryRun ? "mock" : "musicgen-large",
      seed: 42,
      createdAt: new Date().toISOString(),
      metadata: {
        genre: genre || "any",
        mood: mood || "neutral",
        tempo: tempo || 120,
        key: "C",
        duration: durationSeconds || 15,
        modelVersion: "1.0.0",
        generationTimeSeconds: 0,
        tokensUsed: 0,
        costEstimate: 0,
        license: "personal",
      },
      warnings: dryRun ? ["Dry run mode - no audio generated"] : [],
    };

    return result;
  }

  async transcribeAudio(
    filePath: string,
    outputDir: string
  ): Promise<TranscriptionResult> {
    const warnings: string[] = [];
    const tempFiles: string[] = [];
    const result: TranscriptionResult = {
      warnings,
      tempFiles,
    };

    try {
      const fs = require("fs");
      if (!fs.existsSync(filePath)) {
        warnings.push(`File not found: ${filePath}`);
        return result;
      }

      // Create output directory if needed
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // Try to transcribe using Basic Pitch
      const transcribeResult = await transcribeWithBasicPitch(filePath, outputDir);
      return transcribeResult;
    } catch (error) {
      warnings.push(`Transcription error: ${error instanceof Error ? error.message : "Unknown error"}`);
      return result;
    }
  }

  async createPracticePlan(params: {
    instrument: string;
    goal: string;
    skillLevel: "beginner" | "intermediate" | "advanced" | "pro";
    minutesPerDay: number;
    days: number;
  }): Promise<{ markdown: string }> {
    const { instrument, goal, skillLevel, minutesPerDay, days } = params;

    const markdown = `# Practice Plan\n\n## Goals\n- ${goal}\n\n## Schedule\n- ${minutesPerDay} minutes/day for ${days} days\n- Instrument: ${instrument}\n- Skill Level: ${skillLevel}\n\n## Recommendations\n\n### Warm-up (5 min)\n1. Scales in ${instrument || "your instrument"}
2. Finger exercises\n\n### Main Practice (${minutesPerDay - 5} min)\n1. Focus on ${goal}\n2. Review ${skillLevel} level concepts\n\n### Review (5 min)\n1. Record yourself\n2. Identify areas for improvement\n\n`;

    return { markdown };
  }
}

// Export singleton instance
export const musicianService = new MusicianService();
