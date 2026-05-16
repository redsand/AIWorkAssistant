/**
 * Tests for Musician Assistant Audio Asset Storage
 *
 * Tests path traversal protection, file size limits, and asset management.
 */

import { describe, it, expect, beforeEach, afterEach, vi, mock } from "vitest";
import * as path from "path";
import * as fs from "fs";

// Mock the env module BEFORE importing assets.ts
vi.mock("../../../src/config/env", () => ({
  env: {
    MUSICIAN_AUDIO_UPLOAD_DIR: "./data/test-audio/uploads",
    MUSICIAN_AUDIO_ANALYSIS_DIR: "./data/test-audio/analysis",
    MUSICIAN_GENERATED_AUDIO_DIR: "./data/test-audio/generated",
    MUSICIAN_MAX_UPLOAD_MB: 1, // 1MB max
    MUSICIAN_MAX_GENERATION_SECONDS: 30,
    MUSICIAN_DEFAULT_SAMPLE_RATE: 44100,
  },
}));

// Import after mocking
import {
  saveUploadedAudio,
  getAudioAsset,
  getAudioAssetPath,
  listMusicianAssets,
  deleteMusicianAsset,
  initializeMusicianStorage,
} from "../../../src/musician/assets";

describe("Musician Assistant Audio Asset Storage", () => {
  const TEST_UPLOAD_DIR = "./data/test-audio/uploads";
  const TEST_METADATA_FILE = "./data/test-audio/uploads/metadata.jsonl";

  beforeEach(() => {
    // Ensure test directories exist
    fs.mkdirSync(TEST_UPLOAD_DIR, { recursive: true });
    fs.mkdirSync("./data/test-audio/analysis", { recursive: true });
    fs.mkdirSync("./data/test-audio/generated", { recursive: true });
    // Clear previous test metadata
    if (fs.existsSync(TEST_METADATA_FILE)) {
      fs.unlinkSync(TEST_METADATA_FILE);
    }
  });

  afterEach(() => {
    // Cleanup test files
    if (fs.existsSync("./data/test-audio")) {
      fs.rmSync("./data/test-audio", { recursive: true, force: true });
    }
  });

  // Utility to create a test audio buffer
  const createWavBuffer = (): Buffer => {
    // Create a minimal WAV file header + silence
    const sampleRate = 44100;
    const duration = 1; // 1 second
    const numChannels = 1;
    const bitsPerSample = 16;

    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataLength = duration * byteRate;

    const buffer = Buffer.alloc(44 + dataLength);

    // RIFF header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write("WAVE", 8);

    // fmt  chunk
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // WAVE_FORMAT_PCM
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    buffer.write("data", 38);
    buffer.writeUInt32LE(dataLength, 42);

    // Add silence
    buffer.fill(0, 44);

    return buffer;
  };

  describe("saveUploadedAudio", () => {
    it("should save a valid audio file", async () => {
      const buffer = createWavBuffer();
      const filename = "test-audio.wav";
      const mimeType = "audio/wav";

      const asset = await saveUploadedAudio(buffer, filename, mimeType);

      expect(asset).toBeDefined();
      expect(asset.id).toBeDefined();
      expect(asset.storedFilename).toBe(asset.id);
      expect(asset.originalFilename).toBe(filename);
      expect(asset.size).toBe(buffer.length);
      expect(asset.mimeType).toBe("audio/wav");
      expect(asset.sha256).toBeDefined();
      expect(asset.userId).toBeUndefined();
      expect(asset.createdAt).toBeDefined();
      expect(asset.filePath).toContain(path.normalize(TEST_UPLOAD_DIR));

      // Verify file exists on disk
      expect(fs.existsSync(asset.filePath)).toBe(true);

      // Verify metadata was saved
      const metadata = fs.readFileSync(TEST_METADATA_FILE, "utf8");
      expect(metadata).toContain(filename);
    });

    it("should save file with userId", async () => {
      const buffer = createWavBuffer();
      const filename = "user-audio.flac";
      const mimeType = "audio/flac";
      const userId = "test-user-123";

      const asset = await saveUploadedAudio(buffer, filename, mimeType, userId);

      expect(asset.userId).toBe(userId);
    });

    it("should validate MIME type", async () => {
      const buffer = createWavBuffer();

      await expect(
        saveUploadedAudio(buffer, "test.txt", "text/plain")
      ).rejects.toThrow(/Invalid MIME type/);
      await expect(
        saveUploadedAudio(buffer, "test.mp3", "video/mp4")
      ).rejects.toThrow(/Invalid MIME type/);
    });

    it("should accept all valid MIME types", async () => {
      const validMimeTypes = [
        "audio/wav",
        "audio/mpeg",
        "audio/mp3",
        "audio/flac",
        "audio/aac",
        "audio/mp4",
        "audio/x-m4a",
        "audio/webm",
      ];

      for (const mimeType of validMimeTypes) {
        const buffer = Buffer.from([0x00]); // Minimal valid data
        await expect(
          saveUploadedAudio(buffer, `test.${mimeType.split("/")[1]}`, mimeType)
        ).resolves.toBeDefined();
      }
    });

    it("should enforce file size limit", async () => {
      const buffer = Buffer.alloc(2 * 1024 * 1024); // 2MB, exceeds 1MB limit
      const filename = "too-large.wav";
      const mimeType = "audio/wav";

      await expect(
        saveUploadedAudio(buffer, filename, mimeType)
      ).rejects.toThrow(/File size.*exceeds maximum/);
    });

    it("should handle potentially dangerous filenames safely", async () => {
      const buffer = createWavBuffer();
      const filename = "../../../etc/passwd"; // Path traversal attempt
      const mimeType = "audio/wav";

      // This should work because sanitizeFilename removes path components
      // and uuidv4() generates a safe unique filename
      const asset = await saveUploadedAudio(buffer, filename, mimeType);

      // The original filename is preserved, but the stored file is safe
      expect(asset).toBeDefined();
      // storedFilename is a UUID without extension since sanitized filename has no extension
      expect(asset.storedFilename).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      // The original filename is preserved for metadata
      expect(asset.originalFilename).toBe("../../../etc/passwd");
    });
  });

  describe("getAudioAsset", () => {
    it("should find an existing asset", async () => {
      const buffer = createWavBuffer();
      const asset = await saveUploadedAudio(buffer, "test.wav", "audio/wav");

      const found = await getAudioAsset(asset.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(asset.id);
      expect(found?.filePath).toBe(asset.filePath);
    });

    it("should return null for non-existent asset", async () => {
      const found = await getAudioAsset("non-existent-id");

      expect(found).toBeNull();
    });
  });

  describe("getAudioAssetPath", () => {
    it("should return the file path for an existing asset", async () => {
      const buffer = createWavBuffer();
      const asset = await saveUploadedAudio(buffer, "test.wav", "audio/wav");

      const path = await getAudioAssetPath(asset.id);

      expect(path).toBe(asset.filePath);
    });

    it("should throw error for non-existent asset", async () => {
      await expect(getAudioAssetPath("non-existent-id")).rejects.toThrow(
        "Asset not found"
      );
    });
  });

  describe("listMusicianAssets", () => {
    it("should list uploaded assets", async () => {
      const buffer = createWavBuffer();

      // Create multiple assets
      for (let i = 0; i < 3; i++) {
        await saveUploadedAudio(
          buffer,
          `test-${i}.wav`,
          "audio/wav"
        );
      }

      const result = listMusicianAssets();

      expect(result.assets.length).toBe(3);
      expect(result.total).toBe(3);
    });

    it("should support pagination", async () => {
      const buffer = createWavBuffer();

      // Create 5 assets
      for (let i = 0; i < 5; i++) {
        await saveUploadedAudio(buffer, `test-${i}.wav`, "audio/wav");
      }

      // Get with limit and offset
      const result = listMusicianAssets({ limit: 2, offset: 1 });

      expect(result.assets.length).toBe(2);
      expect(result.total).toBe(5);
    });

    it("should filter by type", async () => {
      const buffer = createWavBuffer();
      await saveUploadedAudio(buffer, "upload.wav", "audio/wav");

      const result = listMusicianAssets({ type: "upload" });

      expect(result.assets.length).toBe(1);
    });

    it("should sort by createdAt descending", async () => {
      const buffer = createWavBuffer();

      await saveUploadedAudio(buffer, "first.wav", "audio/wav");
      await new Promise((r) => setTimeout(r, 10)); // Small delay
      await saveUploadedAudio(buffer, "second.wav", "audio/wav");

      const result = listMusicianAssets();

      if (result.assets.length >= 2) {
        const firstDate = new Date(result.assets[0].createdAt).getTime();
        const secondDate = new Date(result.assets[1].createdAt).getTime();
        expect(firstDate).toBeGreaterThanOrEqual(secondDate);
      }
    });
  });

  describe("deleteMusicianAsset", () => {
    it("should delete an existing asset", async () => {
      const buffer = createWavBuffer();
      const asset = await saveUploadedAudio(buffer, "to-delete.wav", "audio/wav");

      const deleted = await deleteMusicianAsset(asset.id);

      expect(deleted).toBe(true);
      expect(fs.existsSync(asset.filePath)).toBe(false);
      expect(await getAudioAsset(asset.id)).toBeNull();
    });

    it("should return false for non-existent asset", async () => {
      const deleted = await deleteMusicianAsset("non-existent-id");

      expect(deleted).toBe(false);
    });
  });

  describe("initializeMusicianStorage", () => {
    it("should create all required directories", () => {
      const uploadDir = "./data/test-audio/uploads";
      const analysisDir = "./data/test-audio/analysis";
      const generatedDir = "./data/test-audio/generated";

      // Ensure directories don't exist
      ["./data/test-audio"].forEach(dir => {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });

      initializeMusicianStorage();

      expect(fs.existsSync(uploadDir)).toBe(true);
      expect(fs.existsSync(analysisDir)).toBe(true);
      expect(fs.existsSync(generatedDir)).toBe(true);
    });
  });
});
