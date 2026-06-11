import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { ErrorLogEntry } from "../../../src/observability/error-log";

const originalErrorLogFile = process.env.ERROR_LOG_FILE;

async function loadErrorLog(logFile: string) {
  vi.resetModules();
  process.env.ERROR_LOG_FILE = logFile;
  return import("../../../src/observability/error-log");
}

describe("errorLog", () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ERROR_LOG_FILE = originalErrorLogFile;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty result when the log file is missing or unreadable", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "error-log-test-"));
    const missingFile = path.join(tmpDir, "missing", "errors.jsonl");
    const { errorLog } = await loadErrorLog(missingFile);

    await expect(errorLog.query()).resolves.toEqual([]);

    const unreadableDir = path.join(tmpDir, "as-dir");
    fs.mkdirSync(unreadableDir);
    const { errorLog: dirBackedLog } = await loadErrorLog(unreadableDir);

    await expect(dirBackedLog.query()).resolves.toEqual([]);
  });

  it("writes entries with derived messages, stack traces, and stable fingerprints", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "error-log-test-"));
    const logFile = path.join(tmpDir, "nested", "errors.jsonl");
    const { errorLog } = await loadErrorLog(logFile);
    const error = new Error("failed for run 123e4567-e89b-12d3-a456-426614174000 item 42");

    const first = await errorLog.log({
      source: "agent",
      category: "run",
      message: "",
      error,
      userId: "user-1",
      sessionId: "session-1",
      runId: "run-1",
      context: { provider: "zai" },
    });
    const second = await errorLog.log({
      severity: "critical",
      source: "agent",
      category: "run",
      message: "",
      error: "failed for run 00000000-0000-0000-0000-000000000000 item 99",
    });

    expect(first.severity).toBe("error");
    expect(first.message).toBe(error.message);
    expect(first.stack).toContain("failed for run");
    expect(first.context).toEqual({ provider: "zai" });
    expect(first.fingerprint).toBe(second.fingerprint);

    const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("swallows write failures after returning the constructed entry", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "error-log-test-"));
    const { errorLog } = await loadErrorLog(tmpDir);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const entry = await errorLog.log({
      severity: "warn",
      source: "server",
      category: "io",
      message: "",
      error: { code: "EISDIR" },
    });

    expect(entry.message).toBe(JSON.stringify({ code: "EISDIR" }));
    expect(errorSpy).toHaveBeenCalledWith(
      "[ErrorLog] Failed to write error log:",
      expect.any(Error),
    );
  });

  it("filters, sorts, and limits parsed entries while skipping invalid lines", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "error-log-test-"));
    const logFile = path.join(tmpDir, "errors.jsonl");
    const { errorLog } = await loadErrorLog(logFile);
    const entries: ErrorLogEntry[] = [
      {
        id: "old-info",
        timestamp: "2026-06-10T10:00:00.000Z",
        severity: "info",
        source: "server",
        category: "request",
        message: "old",
        fingerprint: "a",
        sessionId: "session-a",
        runId: "run-a",
      },
      {
        id: "new-error",
        timestamp: "2026-06-11T10:00:00.000Z",
        severity: "error",
        source: "agent",
        category: "run",
        message: "new",
        fingerprint: "b",
        sessionId: "session-b",
        runId: "run-b",
      },
      {
        id: "critical",
        timestamp: "2026-06-11T11:00:00.000Z",
        severity: "critical",
        source: "agent",
        category: "run",
        message: "critical",
        fingerprint: "c",
        sessionId: "session-b",
        runId: "run-c",
      },
    ];
    fs.writeFileSync(
      logFile,
      ["", "not json", ...entries.map((entry) => JSON.stringify(entry)), ""].join("\n"),
    );

    const result = await errorLog.query({
      severity: "error",
      source: "agent",
      category: "run",
      sessionId: "session-b",
      startTime: new Date("2026-06-11T09:00:00.000Z"),
      endTime: new Date("2026-06-11T12:00:00.000Z"),
      limit: 1,
    });

    expect(result.map((entry) => entry.id)).toEqual(["critical"]);
    await expect(errorLog.query({ runId: "run-b" })).resolves.toMatchObject([
      { id: "new-error" },
    ]);
  });
});
