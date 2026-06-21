import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  enrichPrompt,
  buildCapabilitiesSection,
  buildNonInteractiveSection,
} from "../prompt-enricher";

describe("prompt enrichment — non-interactive instructions", () => {
  let originalFin: string | undefined;

  beforeEach(() => {
    originalFin = process.env.FIN_SIGNAL;
  });

  afterEach(() => {
    if (originalFin === undefined) delete process.env.FIN_SIGNAL;
    else process.env.FIN_SIGNAL = originalFin;
  });

  it("buildNonInteractiveSection contains the never-ask + emit-FIN rules", () => {
    const section = buildNonInteractiveSection("FIN");
    expect(section).toMatch(/NEVER ask questions/i);
    // The phrase wraps across a soft newline in the actual prompt; allow any whitespace.
    expect(section).toMatch(/Want\s+me\s+to\s+push/i);
    expect(section).toMatch(/`FIN`/);
    expect(section).toMatch(/NEVER wait for input/i);
  });

  it("buildNonInteractiveSection respects a custom FIN_SIGNAL token", () => {
    const section = buildNonInteractiveSection("DONE");
    expect(section).toMatch(/`DONE`/);
    expect(section).not.toMatch(/`FIN`/);
  });

  it("enrichPrompt always appends the non-interactive section after capabilities", async () => {
    process.env.FIN_SIGNAL = "FIN";
    const enriched = await enrichPrompt("do the thing", process.cwd());
    expect(enriched).toMatch(/do the thing/);
    expect(enriched).toMatch(/Shell Access/);
    expect(enriched).toMatch(/Non-Interactive Operation/);
    expect(enriched).toMatch(/NEVER ask questions/i);
    // The non-interactive section MUST appear after capabilities so the
    // agent reads it as the authoritative final rule.
    const shellIdx = enriched.indexOf("Shell Access");
    const niIdx = enriched.indexOf("Non-Interactive Operation");
    expect(niIdx).toBeGreaterThan(shellIdx);
  });

  it("enrichPrompt threads FIN_SIGNAL env var into the section", async () => {
    process.env.FIN_SIGNAL = "DONE_TOKEN";
    const enriched = await enrichPrompt("task", process.cwd());
    expect(enriched).toMatch(/`DONE_TOKEN`/);
  });

  it("enrichPrompt returns the original prompt when enrichment throws", async () => {
    // Pass a bogus workspace so getProjectConfig inside the test section
    // is exercised but the safety try/catch around the whole flow still
    // produces a usable prompt. The shell capability section reads
    // workspace as a string literal so it shouldn't throw — we just
    // verify the no-throw contract holds.
    const enriched = await enrichPrompt("test prompt", "/nonexistent/path");
    expect(enriched).toMatch(/test prompt/);
  });

  it("buildCapabilitiesSection still says 'do not ask for permission' for shell commands", () => {
    const section = buildCapabilitiesSection("/ws");
    expect(section).toMatch(/Do not ask for permission/i);
    expect(section).toMatch(/`\/ws`/);
  });
});
