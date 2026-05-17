import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  analyzeWithEssentia,
  getAudioMetadata,
} from "../integrations/audio";
import { transcribeWithBasicPitch } from "../integrations/audio/basic-pitch-adapter";
import { generateWithMusicGen } from "../integrations/audio/musicgen-adapter";
import {
  MusicGenerationRequest,
  AudioTechnicalMetrics,
} from "../musician/analysis-types";
import {
  saveUploadedAudio,
  listMusicianAssets,
  initializeMusicianStorage,
} from "../musician/assets";

/**
 * Zod validation schemas for musician API endpoints
 */

// Duration limit configuration (configurable via environment)
const getDurationLimits = () => {
  const min = parseInt(process.env.MUSICIAN_MIN_DURATION || "8", 10);
  const defaultDuration = parseInt(process.env.MUSICIAN_DEFAULT_DURATION || "15", 10);
  const max = parseInt(process.env.MUSICIAN_MAX_DURATION || "60", 10);
  return { min, defaultDuration, max };
};

// Common output format validation
const outputFormatSchema = z.enum(["wav", "mp3", "flac", "mid", "midi"], {
  errorMap: () => ({
    message:
      "Output format must be one of: wav, mp3, flac, mid, midi",
  }),
});

// Transcription mode validation
const transcriptionModeSchema = z.enum(
  ["notes", "chords", "midi", "all"],
  {
    errorMap: () => ({
      message:
        "Transcription mode must be one of: notes, chords, midi, all",
    }),
  }
);

// Practice plan request schema
const practicePlanSchema = z.object({
  instrument: z.string().min(1, "Instrument is required").max(100),
  goal: z.string().min(1, "Goal is required").max(500),
  skillLevel: z.enum(["beginner", "intermediate", "advanced", "expert"]),
  minutesPerDay: z.number().int().min(1).max(480),
  days: z.number().int().min(1).max(365),
});

// Transcribe audio request schema
const transcribeAudioSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  mode: transcriptionModeSchema.optional().default("notes"),
  instrument: z.string().max(100).optional(),
  outputFormat: outputFormatSchema.optional().default("mid"),
});

// Generate sample request schema with duration validation
const generateSampleSchema = z.object({
  prompt: z.string().min(1, "Prompt is required").max(2000),
  durationSeconds: z.number()
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      const limits = getDurationLimits();
      if (val < limits.min) return limits.min;
      if (val > limits.max) return limits.max;
      return val;
    }),
  dryRun: z.boolean().optional(),
  style: z.string().max(100).optional(),
});

// Analysis request schema
const analyzeAudioSchema = z.object({
  filePath: z.string().min(1, "File path is required"),
  analyzeTechnical: z.boolean().optional(),
  analyzeHarmonic: z.boolean().optional(),
  analyzeRhythm: z.boolean().optional(),
  generateReport: z.boolean().optional(),
});

// Theory request schema
const theoryRequestSchema = z.object({
  topic: z.string().min(1, "Topic is required").max(500),
  instrument: z.string().max(100).optional(),
  skillLevel: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  examples: z.boolean().optional(),
});

// Composition request schema
const compositionRequestSchema = z.object({
  genre: z.string().max(100).optional(),
  mood: z.string().max(100).optional(),
  instrumentation: z.array(z.string().max(100)).max(20).optional(),
  structure: z.enum(["verse-chorus", "aaba", "sonata", "free"]).optional(),
  reference: z.string().max(500).optional(),
});

/**
 * Register musician API routes
 */
export async function musicianRoutes(server: FastifyInstance) {
  const limits = getDurationLimits();

  // Helper: Get music generation enabled flag
  const isGenerationEnabled = () => {
    return process.env.MUSICIAN_GENERATION_ENABLED === "true";
  };

  // POST /api/musician/theory
  server.post("/theory", async (request, reply) => {
    const parsed = theoryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const { topic, instrument } = parsed.data;

    try {
      // For MVP, return a mock response with theory content
      // In production, this would call an LLM with the musician mode
      const theoryResponse = {
        markdown: `# ${topic}\n\n## Overview\n\nThis section covers ${topic} for ${instrument || "music"}.\n\n`,
        mode: "theory",
        createdAt: new Date().toISOString(),
      };

      return reply.status(200).send(theoryResponse);
    } catch (err) {
      server.log.error(err);
      return reply.status(500).send({
        error: "Internal server error",
        message: (err as Error).message,
      });
    }
  });

  // POST /api/musician/compose
  server.post("/compose", async (request, reply) => {
    const parsed = compositionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const { genre, mood } = parsed.data;

    try {
      // For MVP, return a mock composition
      const compositionResponse = {
        markdown: `# Composition\n\nGenre: ${genre || "any"}\nMood: ${mood || "neutral"}\n\n[Composition content would be generated here]`,
        mode: "composition",
        createdAt: new Date().toISOString(),
      };

      return reply.status(200).send(compositionResponse);
    } catch (err) {
      server.log.error(err);
      return reply.status(500).send({
        error: "Internal server error",
        message: (err as Error).message,
      });
    }
  });

  // POST /api/musician/practice-plan
  server.post("/practice-plan", async (request, reply) => {
    const parsed = practicePlanSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const { instrument, goal, skillLevel, minutesPerDay, days } =
      parsed.data;

    try {
      const practicePlan = {
        markdown: `# Practice Plan\n\n## Goals\n- ${goal}\n\n## Schedule\n- ${minutesPerDay} minutes/day for ${days} days\n- Instrument: ${instrument}\n- Skill Level: ${skillLevel}\n\n## Recommendations\n\n### Warm-up (5 min)\n1. Scales in ${instrument || "your instrument"}
2. Finger exercises\n\n### Main Practice (${minutesPerDay - 5} min)\n1. Focus on ${goal}\n2. Review ${skillLevel} level concepts\n\n### Review (5 min)\n1. Record yourself\n2. Identify areas for improvement\n\n`,
        createdAt: new Date().toISOString(),
      };

      return reply.status(200).send(practicePlan);
    } catch (err) {
      server.log.error(err);
      return reply.status(500).send({
        error: "Internal server error",
        message: (err as Error).message,
      });
    }
  });

  // POST /api/musician/analyze-audio
  server.post("/analyze-audio", async (request, reply) => {
    const parsed = analyzeAudioSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const { filePath, analyzeTechnical, analyzeHarmonic, analyzeRhythm, generateReport } =
      parsed.data;

    const warnings: string[] = [];
    const metrics: Partial<AudioTechnicalMetrics> = {};

    try {
      // Check if file exists
      const fs = require("fs");
      if (!fs.existsSync(filePath)) {
        warnings.push(`File not found: ${filePath}`);
        return reply.status(200).send({
          metrics,
          warnings,
          createdAt: new Date().toISOString(),
        });
      }

      // Get basic audio metadata
      const metadataResult = await getAudioMetadata(filePath);
      warnings.push(...metadataResult.warnings);

      // Extract metrics from metadata
      if (metadataResult.metrics) {
        Object.assign(metrics, metadataResult.metrics);
      }

      // Analyze technical metrics if requested
      if (analyzeTechnical || analyzeHarmonic || analyzeRhythm) {
        // Use Essentia for detailed analysis if available
        const essentiaResult = await analyzeWithEssentia(filePath);
        if (essentiaResult.warnings) {
          warnings.push(...essentiaResult.warnings);
        }

        // Convert Essentia results to audio metrics
        if (essentiaResult.tempo) {
          metrics.tempoBpm = essentiaResult.tempo;
        }
        if (essentiaResult.key && essentiaResult.scale) {
          metrics.keyEstimate = `${essentiaResult.key} ${essentiaResult.scale}`;
        }
      }

      // Generate report if requested
      const report = generateReport
        ? {
            summary: "Audio analysis complete",
            warnings: warnings.filter((w) => w.includes("Essentia")),
          }
        : undefined;

      return reply.status(200).send({
        metrics,
        report,
        warnings,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      server.log.error(err);
      warnings.push(`Analysis error: ${(err as Error).message}`);
      return reply.status(200).send({
        metrics,
        warnings,
        createdAt: new Date().toISOString(),
      });
    }
  });

  // POST /api/musician/generate-sample
  server.post("/generate-sample", async (request, reply) => {
    // Check if generation is enabled globally
    if (!isGenerationEnabled()) {
      return reply.status(403).send({
        error: "Music generation is disabled",
        message:
          "Set MUSICIAN_GENERATION_ENABLED=true to enable music generation",
      });
    }

    const parsed = generateSampleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const { prompt, durationSeconds, dryRun, style } = parsed.data;

    try {
      // Get output directory (ensure it exists)
      const outputDir = process.env.MUSICGEN_OUTPUT_DIR || "./generated-audio";
      const fs = require("fs");
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const requestObj: MusicGenerationRequest = {
        prompt,
        durationSeconds: durationSeconds ?? limits.defaultDuration,
        dryRun: dryRun ?? false,
        genre: style,
      };

      const result = await generateWithMusicGen(requestObj, outputDir);

      return reply.status(200).send({
        ...result,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      server.log.error(err);
      return reply.status(500).send({
        error: "Internal server error",
        message: (err as Error).message,
      });
    }
  });

  // POST /api/musician/transcribe-audio
  server.post("/transcribe-audio", async (request, reply) => {
    const parsed = transcribeAudioSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const { fileId, outputFormat } = parsed.data;

    try {
      // Get file path from fileId (in production, this would look up the actual path)
      // For MVP, we assume the fileId is the file path or construct it
      const filePath = fileId.startsWith("/") ? fileId : `./audio-files/${fileId}`;

      // Get output directory
      const outputDir = process.env.BASIC_PITCH_OUTPUT_DIR || "./transcriptions";
      const fs = require("fs");
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const result = await transcribeWithBasicPitch(filePath, outputDir);

      // Validate output format for MIDI files
      if (result.midiPath && outputFormat && !["mid", "midi"].includes(outputFormat)) {
        result.warnings.push(`MIDI output is only available in 'mid' or 'midi' format`);
      }

      return reply.status(200).send({
        ...result,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      server.log.error(err);
      return reply.status(500).send({
        error: "Internal server error",
        message: (err as Error).message,
        createdAt: new Date().toISOString(),
      });
    }
  });

  // GET /api/musician/capabilities - return musician-specific capabilities
  server.get("/capabilities", async (_request, reply) => {
    const isGenerationEnabledFlag = isGenerationEnabled();
    const limits = getDurationLimits();

    return reply.status(200).send({
      modes: ["theory", "composition", "generation", "audio_feedback", "practice", "session_coach"],
      endpoints: [
        { path: "/api/musician/theory", method: "POST" },
        { path: "/api/musician/compose", method: "POST" },
        { path: "/api/musician/practice-plan", method: "POST" },
        { path: "/api/musician/analyze-audio", method: "POST" },
        { path: "/api/musician/generate-sample", method: "POST" },
        { path: "/api/musician/transcribe-audio", method: "POST" },
      ],
      features: [
        "Music theory explanation and education",
        "Composition generation with genre/mood guidance",
        "Practice plan generation with schedule",
        "Audio analysis (technical, harmonic, rhythm)",
        "Music generation from text prompts",
        "Audio transcription to MIDI/notes/chords",
      ],
      limits: {
        minDuration: limits.min,
        defaultDuration: limits.defaultDuration,
        maxDuration: limits.max,
        maxPromptLength: 2000,
      },
      generationEnabled: isGenerationEnabledFlag,
      supportedOutputFormats: ["wav", "mp3", "flac", "mid", "midi"],
      createdAt: new Date().toISOString(),
    });
  });

  // Initialize musician storage on route registration
  initializeMusicianStorage();

  // POST /api/musician/audio/upload - Upload audio file
  server.post("/audio/upload", async (request, reply) => {
    const body = request.body as { fileData: string; filename: string; mimeType: string; userId?: string };

    // Validate required fields
    if (!body.fileData || !body.filename || !body.mimeType) {
      return reply.status(400).send({
        error: "Validation failed",
        details: [
          { field: "fileData", message: "File data is required" },
          { field: "filename", message: "Filename is required" },
          { field: "mimeType", message: "MIME type is required" },
        ],
      });
    }

    try {
      // Decode base64 file data
      const fileData = body.fileData.startsWith("data:")
        ? body.fileData.split(",")[1]
        : body.fileData;
      const buffer = Buffer.from(fileData, "base64");

      const asset = await saveUploadedAudio(
        buffer,
        body.filename,
        body.mimeType,
        body.userId
      );

      return reply.status(201).send({
        success: true,
        asset,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      const err = error as Error;
      if (err.message.includes("File size") || err.message.includes("exceeds maximum")) {
        return reply.status(413).send({
          error: "File too large",
          message: err.message,
        });
      }
      if (err.message.includes("Invalid MIME type")) {
        return reply.status(400).send({
          error: "Invalid file type",
          message: err.message,
        });
      }
      server.log.error(err);
      return reply.status(500).send({
        error: "Upload failed",
        message: err.message,
      });
    }
  });

  // GET /api/musician/audio/assets - List uploaded assets
  server.get("/audio/assets", async (request, reply) => {
    const { type, limit, offset, userId } = request.query as {
      type?: "upload" | "generated";
      limit?: string;
      offset?: string;
      userId?: string;
    };

    try {
      const result = listMusicianAssets({
        type,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
        userId,
      });

      return reply.status(200).send({
        ...result,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({
        error: "Failed to list assets",
        message: (error as Error).message,
      });
    }
  });
}
