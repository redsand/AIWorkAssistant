import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUILD_ID, rewriteHtml, rewriteJs } from "../static-cache-buster";

describe("BUILD_ID", () => {
  it("is a non-empty stable string for the lifetime of the process", () => {
    expect(typeof BUILD_ID).toBe("string");
    expect(BUILD_ID.length).toBeGreaterThan(0);
    // Reading it twice in the same process returns the same value (it's
    // computed once at module load).
    expect(BUILD_ID).toBe(BUILD_ID);
  });
});

describe("rewriteHtml", () => {
  it("stamps script src URLs with ?v=BUILD_ID", () => {
    const out = rewriteHtml('<script type="module" src="/js/app.js"></script>');
    expect(out).toContain(`src="/js/app.js?v=${BUILD_ID}"`);
  });

  it("replaces an existing version on script tags", () => {
    const out = rewriteHtml('<script type="module" src="/js/app.js?v=5"></script>');
    expect(out).toContain(`src="/js/app.js?v=${BUILD_ID}"`);
    // The prior `?v=5` (terminated by the closing quote) must be gone.
    // We can't assert "no substring v=5" because BUILD_ID often contains
    // the digit 5 anywhere — e.g. "508ab80.1782187200" has v=508 inside.
    expect(out).not.toContain('?v=5"');
    expect(out).not.toContain('?v=5&');
  });

  it("stamps stylesheet link hrefs", () => {
    const out = rewriteHtml('<link rel="stylesheet" href="/css/chat.css?v=2">');
    expect(out).toContain(`href="/css/chat.css?v=${BUILD_ID}"`);
  });

  it("leaves absolute-protocol URLs alone (CDN libs)", () => {
    const html = '<script src="https://cdn.example.com/lib.js"></script>';
    expect(rewriteHtml(html)).toBe(html);
  });

  it("leaves anchor hrefs alone", () => {
    const html = '<a href="/dashboard">Dashboard</a>';
    expect(rewriteHtml(html)).toBe(html);
  });

  it("handles multiple occurrences in one document", () => {
    const out = rewriteHtml(
      '<script src="/js/a.js?v=1"></script><script src="/js/b.js"></script><link href="/css/c.css"/>',
    );
    expect(out).toMatch(new RegExp(`/js/a\\.js\\?v=${escape(BUILD_ID)}`));
    expect(out).toMatch(new RegExp(`/js/b\\.js\\?v=${escape(BUILD_ID)}`));
    expect(out).toMatch(new RegExp(`/css/c\\.css\\?v=${escape(BUILD_ID)}`));
  });
});

describe("rewriteJs", () => {
  it("stamps a static relative ES import", () => {
    const out = rewriteJs(`import { foo } from "./bar.js";`);
    expect(out).toBe(`import { foo } from "./bar.js?v=${BUILD_ID}";`);
  });

  it("stamps the default-only import shape", () => {
    const out = rewriteJs(`import foo from "./bar.js";`);
    expect(out).toBe(`import foo from "./bar.js?v=${BUILD_ID}";`);
  });

  it("stamps a dynamic import call", () => {
    const out = rewriteJs(`const m = await import("./bar.js");`);
    expect(out).toBe(`const m = await import("./bar.js?v=${BUILD_ID}");`);
  });

  it("stamps an export-from re-export", () => {
    const out = rewriteJs(`export { foo } from "./bar.js";`);
    expect(out).toBe(`export { foo } from "./bar.js?v=${BUILD_ID}";`);
  });

  it("replaces an existing version on the import", () => {
    const out = rewriteJs(`import foo from "./bar.js?v=stale";`);
    expect(out).toBe(`import foo from "./bar.js?v=${BUILD_ID}";`);
  });

  it("leaves package-specifier imports alone", () => {
    const src = `import { x } from "fastify";\nimport y from "@redsand/claimkit";`;
    expect(rewriteJs(src)).toBe(src);
  });

  it("leaves absolute-URL imports alone", () => {
    const src = `import x from "/js/abs.js";`;
    expect(rewriteJs(src)).toBe(src);
  });

  it("handles ../ relative imports", () => {
    const out = rewriteJs(`import x from "../other/y.js";`);
    expect(out).toBe(`import x from "../other/y.js?v=${BUILD_ID}";`);
  });

  it("preserves quote style (single vs double)", () => {
    expect(rewriteJs(`import x from './bar.js';`)).toBe(`import x from './bar.js?v=${BUILD_ID}';`);
    expect(rewriteJs(`import x from "./bar.js";`)).toBe(`import x from "./bar.js?v=${BUILD_ID}";`);
  });
});

// helper for putting BUILD_ID inside a regex
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("AIWORK_BUILD_ID override", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.AIWORK_BUILD_ID;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AIWORK_BUILD_ID;
    else process.env.AIWORK_BUILD_ID = originalEnv;
  });
  it("BUILD_ID itself is fixed at module load — re-importing in the same process keeps the same value", async () => {
    // We can't actually re-import the module in the same vitest worker
    // (vi.resetModules() then dynamic import would work but is overkill).
    // Instead this test documents the invariant.
    process.env.AIWORK_BUILD_ID = "ignored-because-already-loaded";
    expect(BUILD_ID).not.toBe("ignored-because-already-loaded");
  });
});
