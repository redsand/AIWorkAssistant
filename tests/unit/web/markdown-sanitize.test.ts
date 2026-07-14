import { describe, it, expect } from "vitest";
import { renderMarkdown, sanitizeUrl } from "../../../web/js/markdown.js";

describe("renderMarkdown — XSS sanitization", () => {
  it("escapes raw SVG injection attempts instead of emitting a real <svg> element", () => {
    const html = renderMarkdown('<svg onload="alert(1)"><animate attributeName=x></svg>');
    // The dangerous part isn't the literal substring "onload=" (harmless as
    // inert text) — it's whether a real <svg>/<animate> element gets
    // created. Escaping `<`/`>` means the browser's HTML parser never sees
    // an opening tag here at all.
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<animate");
    expect(html).toContain("&lt;svg");
  });

  it("escapes raw <script> tags", () => {
    const html = renderMarkdown('<script>alert(document.cookie)</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes img onerror injection", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    // No real <img> element is created — the whole tag is inert escaped text.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("rejects data: URIs in markdown links", () => {
    const html = renderMarkdown("[click me](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain('href="data:');
    expect(html).toContain('href="#"');
  });

  it("rejects unquoted javascript: links", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="#"');
  });

  it("rejects javascript: links obfuscated via a single layer of HTML entity encoding", () => {
    const html = renderMarkdown("[click me](jav&#97;script:alert(1))");
    expect(html).not.toMatch(/href="[^"]*script:/i);
    expect(html).toContain('href="#"');
  });

  it("rejects javascript: links obfuscated via double-encoded entities", () => {
    const html = renderMarkdown("[click me](jav&amp;#97;script:alert(1))");
    expect(html).not.toMatch(/href="[^"]*script:/i);
    expect(html).toContain('href="#"');
  });

  it("rejects javascript: links obfuscated with control characters", () => {
    const html = renderMarkdown("[click me](java\tscript:alert(1))");
    expect(html).not.toMatch(/href="[^"]*script:/i);
    expect(html).toContain('href="#"');
  });

  it("rejects vbscript: links", () => {
    const html = renderMarkdown("[click me](vbscript:msgbox(1))");
    expect(html).toContain('href="#"');
  });

  it("allows https links through untouched", () => {
    const html = renderMarkdown("[docs](https://example.com/path?a=1&b=2)");
    expect(html).toContain('href="https://example.com/path?a=1&amp;b=2"');
  });

  it("allows mailto and tel links", () => {
    expect(renderMarkdown("[email](mailto:test@example.com)")).toContain('href="mailto:test@example.com"');
    expect(renderMarkdown("[call](tel:+15551234567)")).toContain('href="tel:+15551234567"');
  });

  it("allows relative and anchor links through untouched", () => {
    expect(renderMarkdown("[here](#section)")).toContain('href="#section"');
    expect(renderMarkdown("[here](/some/path)")).toContain('href="/some/path"');
  });

  it("prevents attribute breakout via quotes in the URL", () => {
    const html = renderMarkdown('[x](https://evil.com/"onmouseover="alert(1))');
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("escapes attacker content inside link text", () => {
    const html = renderMarkdown('[<img src=x onerror=alert(1)>](https://example.com)');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("does not allow mutation XSS via unbalanced tags across markdown constructs", () => {
    const html = renderMarkdown("# <style><img src=x onerror=alert(1)></style>\n\nBody <noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<style>");
    expect(html).not.toContain("<noscript>");
  });

  it("escapes code block content instead of interpreting it as HTML", () => {
    const html = renderMarkdown("```html\n<b onclick=alert(1)>bold</b>\n```");
    expect(html).toContain("&lt;b onclick=alert(1)&gt;");
    expect(html).not.toContain("<b onclick");
  });

  it("escapes inline code content", () => {
    const html = renderMarkdown("Use `<script>` carefully");
    expect(html).toContain("<code>&lt;script&gt;</code>");
  });

  it("still renders blockquotes correctly now that > is escaped first", () => {
    const html = renderMarkdown("> a wise quote");
    expect(html).toContain("<blockquote>a wise quote</blockquote>");
  });

  it("still renders standard markdown constructs correctly", () => {
    const html = renderMarkdown("# Title\n\n**bold** and *italic* and `code`\n\n- one\n- two");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });
});

describe("sanitizeUrl", () => {
  it("allows http/https/mailto/tel", () => {
    expect(sanitizeUrl("https://example.com")).toBe("https://example.com");
    expect(sanitizeUrl("http://example.com")).toBe("http://example.com");
    expect(sanitizeUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(sanitizeUrl("tel:+1555")).toBe("tel:+1555");
  });

  it("rejects javascript/data/vbscript schemes", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBe("#");
    expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe("#");
    expect(sanitizeUrl("vbscript:msgbox(1)")).toBe("#");
  });

  it("allows relative and anchor URLs", () => {
    expect(sanitizeUrl("/path/to/page")).toBe("/path/to/page");
    expect(sanitizeUrl("#anchor")).toBe("#anchor");
    expect(sanitizeUrl("../relative")).toBe("../relative");
  });

  it("strips control characters before checking scheme", () => {
    expect(sanitizeUrl("java\tscript:alert(1)")).toBe("#");
    expect(sanitizeUrl("java\nscript:alert(1)")).toBe("#");
  });

  it("decodes entity-obfuscated schemes before validating", () => {
    expect(sanitizeUrl("jav&#97;script:alert(1)")).toBe("#");
    expect(sanitizeUrl("jav&#x61;script:alert(1)")).toBe("#");
  });

  it("returns a safe fallback for null/undefined", () => {
    expect(sanitizeUrl(null)).toBe("#");
    expect(sanitizeUrl(undefined)).toBe("#");
  });
});
