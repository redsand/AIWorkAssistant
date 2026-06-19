/**
 * Report builder — single entry point. Pulls a session, runs a template,
 * renders the requested formats, persists, and returns artifact metadata.
 */

import { renderMarkdown } from "./renderers/markdown";
import { renderDocx } from "./renderers/docx";
import { renderHtml, renderPdf } from "./renderers/pdf";
import { buildManifest, type TemplateBuildInput, type TemplateId, KNOWN_TEMPLATES } from "./templates";
import { enforceQuota, generateReportId, getReportDirectory, saveReport } from "./storage";
import type { GenerateReportResult, RenderedFile, ReportFormat, ReportManifest } from "./types";

export interface BuildOptions extends TemplateBuildInput {
  template: TemplateId;
  formats: ReportFormat[];
}

export function listTemplates(): TemplateId[] {
  return [...KNOWN_TEMPLATES];
}

export async function buildAndPersist(opts: BuildOptions): Promise<GenerateReportResult> {
  if (!KNOWN_TEMPLATES.includes(opts.template)) {
    throw new Error(`Unknown template: ${opts.template}. Available: ${KNOWN_TEMPLATES.join(", ")}`);
  }
  if (opts.formats.length === 0) {
    throw new Error("At least one format must be requested.");
  }
  const manifest = buildManifest(opts.template, opts);
  const warnings: string[] = [];

  const reportId = generateReportId();
  const directory = getReportDirectory(reportId);
  const fs = await import("fs");
  fs.mkdirSync(directory, { recursive: true });

  const files: RenderedFile[] = [];

  // Markdown is cheap and always produced — used by HTML and as the canonical source.
  files.push(renderMarkdown(manifest, directory));

  if (opts.formats.includes("docx")) {
    try {
      files.push(await renderDocx(manifest, directory));
    } catch (err) {
      warnings.push(`docx render failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (opts.formats.includes("html") || opts.formats.includes("pdf")) {
    try {
      files.push(renderHtml(manifest, directory));
    } catch (err) {
      warnings.push(`html render failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (opts.formats.includes("pdf")) {
    try {
      files.push(await renderPdf(manifest, directory));
    } catch (err) {
      warnings.push(`pdf render skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Filter the files list to only the formats the caller asked for, plus
  // markdown (always included as canonical source).
  const wanted = new Set<ReportFormat>(["markdown", ...opts.formats]);
  const finalFiles = files.filter((f) => wanted.has(f.format));

  const result = saveReport(reportId, manifest, { files: finalFiles, warnings });

  // Quota enforcement runs out-of-line — best effort, don't break the
  // current generate call if it fails.
  try { enforceQuota(); } catch { /* non-fatal */ }

  return result;
}

export function readManifest(manifest: ReportManifest): ReportManifest { return manifest; }
