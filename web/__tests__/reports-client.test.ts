/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sessionId: "sess-123" as string | null }));

vi.mock("../js/state.js", () => ({
  API_BASE: "",
  get currentSessionId() {
    return state.sessionId;
  },
}));

vi.mock("../js/auth.js", () => ({
  authHeaders: () => ({
    "Content-Type": "application/json",
    Authorization: "Bearer test-token",
  }),
}));

vi.mock("../js/messages.js", () => ({
  addMessage: vi.fn((content: string, _role: string) => {
    const id = "msg-" + Math.random().toString(36).slice(2);
    const div = document.createElement("div");
    div.id = id;
    const content_el = document.createElement("div");
    content_el.className = "message-content";
    content_el.textContent = content;
    div.appendChild(content_el);
    document.body.appendChild(div);
    return id;
  }),
  scrollChatToBottom: vi.fn(),
}));

describe("reports-client", () => {
  beforeEach(() => {
    state.sessionId = "sess-123";
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("parses bare /report into the default template + formats", async () => {
    const { __test } = await import("../js/reports-client.js");
    expect(__test.parseReportCommand("/report")).toEqual({
      template: "incident-response",
      formats: ["markdown", "docx"],
    });
  });

  it("parses /report with explicit formats", async () => {
    const { __test } = await import("../js/reports-client.js");
    expect(__test.parseReportCommand("/report docx,markdown")).toEqual({
      template: "incident-response",
      formats: ["docx", "markdown"],
    });
  });

  it("parses /report with template + formats in either order", async () => {
    const { __test } = await import("../js/reports-client.js");
    expect(__test.parseReportCommand("/report generic html,markdown")).toEqual({
      template: "generic",
      formats: ["html", "markdown"],
    });
    expect(__test.parseReportCommand("/report pdf incident-response")).toEqual({
      template: "incident-response",
      formats: ["pdf"],
    });
  });

  it("ignores unknown tokens but still parses what it can", async () => {
    const { __test } = await import("../js/reports-client.js");
    expect(__test.parseReportCommand("/report bogus docx")).toEqual({
      template: "incident-response",
      formats: ["docx"],
    });
  });

  it("returns null for non-/report messages", async () => {
    const { __test } = await import("../js/reports-client.js");
    expect(__test.parseReportCommand("hello world")).toBeNull();
    expect(__test.parseReportCommand("/help")).toBeNull();
  });

  it("recognizes report-download URLs by UUID + format suffix", async () => {
    const { __test } = await import("../js/reports-client.js");
    expect(
      __test.isReportDownloadUrl(
        "/api/reports/12345678-1234-1234-1234-1234567890ab/download/docx",
      ),
    ).toBe(true);
    expect(
      __test.isReportDownloadUrl(
        "https://example.com/api/reports/12345678-1234-1234-1234-1234567890ab/download/markdown",
      ),
    ).toBe(true);
    expect(
      __test.isReportDownloadUrl("/api/reports/12345678/download/docx"),
    ).toBe(false);
    expect(
      __test.isReportDownloadUrl(
        "/api/reports/12345678-1234-1234-1234-1234567890ab/download/exe",
      ),
    ).toBe(false);
    expect(__test.isReportDownloadUrl("/chat/sessions/abc/messages")).toBe(false);
  });

  it("infers filename from Content-Disposition or path", async () => {
    const { __test } = await import("../js/reports-client.js");
    const fakeRes = {
      headers: { get: () => 'attachment; filename="hunt-companies-report.docx"' },
    } as unknown as Response;
    expect(
      __test.inferFilename(
        "/api/reports/abc/download/docx",
        fakeRes,
      ),
    ).toBe("hunt-companies-report.docx");

    const fallbackRes = { headers: { get: () => null } } as unknown as Response;
    expect(
      __test.inferFilename(
        "/api/reports/abc/download/markdown",
        fallbackRes,
      ),
    ).toBe("report.md");
  });

  it("/report short-circuits to POST /api/reports and renders download buttons", async () => {
    const { handleReportSlashCommand } = await import("../js/reports-client.js");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reportId: "abc",
        metadata: { title: "Investigation 2026-06-19" },
        files: [
          {
            format: "markdown",
            bytes: 1024,
            downloadUrl: "/api/reports/abc/download/markdown",
          },
          {
            format: "docx",
            bytes: 4096,
            downloadUrl: "/api/reports/abc/download/docx",
          },
        ],
        warnings: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const handled = await handleReportSlashCommand("/report");
    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reports");
    const body = JSON.parse(init.body);
    expect(body.sessionId).toBe("sess-123");
    expect(body.template).toBe("incident-response");
    expect(body.formats).toEqual(["markdown", "docx"]);

    // Bubble should now contain links to both formats.
    const html = document.body.innerHTML;
    expect(html).toContain("/api/reports/abc/download/markdown");
    expect(html).toContain("/api/reports/abc/download/docx");
    expect(html).toContain("Markdown");
    expect(html).toContain("Word");
  });

  it("/report without a current session shows a helpful message and does not call the API", async () => {
    state.sessionId = null;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { handleReportSlashCommand } = await import("../js/reports-client.js");
    const handled = await handleReportSlashCommand("/report");
    expect(handled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false for unrelated messages so the chat stream still runs", async () => {
    const { handleReportSlashCommand } = await import("../js/reports-client.js");
    expect(await handleReportSlashCommand("can you summarize the case?")).toBe(false);
  });
});
