import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../agent/opencode-client", () => ({
  aiClient: {
    chat: vi.fn().mockResolvedValue({ content: "stub", model: "test", done: true }),
  },
}));

describe("report-builder", () => {
  let originalCwd: string;
  let originalReportsPath: string | undefined;
  let tempDir: string;
  let manager: InstanceType<typeof import("../../memory/conversation-manager").ConversationManager> | null = null;

  beforeEach(() => {
    vi.resetModules();
    originalCwd = process.cwd();
    originalReportsPath = process.env.REPORTS_BASE_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-builder-"));
    process.chdir(tempDir);
    process.env.REPORTS_BASE_PATH = path.join(tempDir, "reports");
    manager = null;
  });

  afterEach(() => {
    if (manager) {
      manager.close();
      manager = null;
    }
    process.chdir(originalCwd);
    if (originalReportsPath === undefined) delete process.env.REPORTS_BASE_PATH;
    else process.env.REPORTS_BASE_PATH = originalReportsPath;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  async function seedSession(): Promise<string> {
    const { ConversationManager } = await import("../../memory/conversation-manager.js");
    manager = new ConversationManager();
    const sessionId = manager.startSession("demo", "productivity");
    manager.addMessage(sessionId, { role: "user", content: "Investigate the phishing incident on 2026-06-17." });
    manager.addMessage(sessionId, {
      role: "assistant",
      content: [
        "# Incident Response Report",
        "",
        "## Executive Summary",
        "The malicious IP 2603:8080:9c00:27e4::1 sent a phishing email at 2026-06-17T15:38:20Z.",
        "",
        "## Timeline",
        "",
        "| UTC | Event | Source | Ref |",
        "| --- | --- | --- | --- |",
        "| 2026-06-17T15:20:09Z | Test send to ea202929@gmail.com | babette.sepulveda@huntcompanies.com | tc-aaaaaaaaaaaa |",
        "| 2026-06-17T15:38:20Z | Phishing send to 336 recipients | babette.sepulveda | tc-bbbbbbbbbbbb |",
        "| 2026-06-17T15:52:01Z | Account disabled | admin.missy.moraga | tc-cccccccccccc |",
        "",
        "## Recommendations",
        "1. Block the attacker IP.",
        "2. Rotate babette's credentials.",
        "",
        "## Gaps",
        "[UNVERIFIED] No body content for the test send.",
      ].join("\n"),
    });
    return sessionId;
  }

  it("generates markdown + docx files for the incident-response template", async () => {
    const sessionId = await seedSession();
    const { buildAndPersist } = await import("../report-builder.js");
    const result = await buildAndPersist({
      sessionId,
      template: "incident-response",
      formats: ["markdown", "docx"],
      customer: "Hunt Companies",
      localTimezone: "MDT (UTC-6)",
    });
    expect(result.reportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.files.map((f) => f.format).sort()).toEqual(["docx", "markdown"]);
    for (const f of result.files) {
      expect(fs.existsSync(f.path)).toBe(true);
      expect(f.bytes).toBeGreaterThan(100);
    }
    // Manifest persisted
    expect(fs.existsSync(path.join(result.directory, "manifest.json"))).toBe(true);
    // Markdown contains key fields
    const md = fs.readFileSync(result.files.find((f) => f.format === "markdown")!.path, "utf-8");
    expect(md).toContain("Hunt Companies");
    expect(md).toContain("MDT (UTC-6)");
    expect(md).toContain("Phishing send");
    expect(md).toContain("tc-bbbbbbbbbbbb");
  });

  it("HTML render produces a self-contained HTML file", async () => {
    const sessionId = await seedSession();
    const { buildAndPersist } = await import("../report-builder.js");
    const result = await buildAndPersist({
      sessionId,
      template: "incident-response",
      formats: ["html"],
      title: "Incident Response Report",
    });
    const htmlFile = result.files.find((f) => f.format === "html");
    expect(htmlFile).toBeDefined();
    const html = fs.readFileSync(htmlFile!.path, "utf-8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Incident Response Report");
  });

  it("PDF render is gracefully skipped when puppeteer is not installed", async () => {
    const sessionId = await seedSession();
    const { buildAndPersist } = await import("../report-builder.js");
    const result = await buildAndPersist({
      sessionId,
      template: "incident-response",
      formats: ["markdown", "pdf"],
    });
    // Markdown still ships
    expect(result.files.some((f) => f.format === "markdown")).toBe(true);
    // PDF skipped with a warning
    expect(result.warnings.some((w) => /pdf/i.test(w))).toBe(true);
  });

  it("listReports + getReportFilePath return the saved entry", async () => {
    const sessionId = await seedSession();
    const { buildAndPersist } = await import("../report-builder.js");
    const result = await buildAndPersist({
      sessionId,
      template: "generic",
      formats: ["markdown"],
      title: "Babette Phishing Investigation",
    });
    const { listReports, getReportFilePath, getReport } = await import("../storage.js");
    const rows = listReports({ sessionId });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].id).toBe(result.reportId);
    const detail = getReport(result.reportId);
    expect(detail?.title).toBe("Babette Phishing Investigation");
    const filePath = getReportFilePath(result.reportId, "markdown");
    expect(filePath).not.toBeNull();
    expect(fs.existsSync(filePath!)).toBe(true);
  });

  it("deleteReport removes the row and the on-disk directory", async () => {
    const sessionId = await seedSession();
    const { buildAndPersist } = await import("../report-builder.js");
    const result = await buildAndPersist({
      sessionId,
      template: "generic",
      formats: ["markdown"],
    });
    const { deleteReport, getReport } = await import("../storage.js");
    expect(deleteReport(result.reportId)).toBe(true);
    expect(getReport(result.reportId)).toBeNull();
    expect(fs.existsSync(result.directory)).toBe(false);
    // Second delete is a no-op (returns false)
    expect(deleteReport(result.reportId)).toBe(false);
  });

  it("rejects path-traversal report IDs at the storage layer", async () => {
    const { getReportDirectory } = await import("../storage.js");
    expect(() => getReportDirectory("../escape")).toThrow();
    expect(() => getReportDirectory("..\\escape")).toThrow();
    expect(() => getReportDirectory("/etc/passwd")).toThrow();
  });
});
