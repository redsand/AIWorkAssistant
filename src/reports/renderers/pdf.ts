/**
 * PDF renderer — optional, only runs if `puppeteer` is installed.
 *
 * We deliberately do NOT add puppeteer to the default dependencies because
 * it downloads ~170 MB of Chromium. Users who need PDF run:
 *   npm install puppeteer
 * and the renderer auto-detects + uses it.
 *
 * Fallback when puppeteer is missing: caller is told via a warning, and the
 * markdown / docx outputs still ship. No silent crash.
 */

import * as fs from "fs";
import * as path from "path";
import { renderChart } from "../charts/svg-charts";
import type { RenderedFile, ReportManifest, ReportSection } from "../types";

function buildHtml(manifest: ReportManifest, reportDir: string): { html: string; charts: Array<{ name: string; svg: string }>; } {
  const meta = manifest.metadata;
  const charts: Array<{ name: string; svg: string }> = [];
  const sectionsHtml: string[] = [];
  let chartIdx = 0;
  for (const section of manifest.sections) {
    sectionsHtml.push(renderSectionHtml(section, () => {
      chartIdx += 1;
      const name = `chart-${String(chartIdx).padStart(2, "0")}.svg`;
      const svg = section.chart ? renderChart(section.chart) : "";
      charts.push({ name, svg });
      return name;
    }));
  }
  const evidenceHtml = manifest.evidence && manifest.evidence.length > 0
    ? `<h2>Evidence index</h2><table><thead><tr><th>Ref</th><th>Tool</th><th>Called at (UTC)</th><th>Summary</th></tr></thead><tbody>${
        manifest.evidence.map((e) =>
          `<tr><td><code>${escHtml(e.ref)}</code></td><td>${escHtml(e.toolName ?? "")}</td><td>${escHtml(e.calledAt ?? "")}</td><td>${escHtml(e.summary ?? "")}</td></tr>`,
        ).join("")
      }</tbody></table>`
    : "";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>${escHtml(meta.title)}</title>
<style>
  @page { size: Letter; margin: 0.75in; }
  body { font-family: Inter, Arial, sans-serif; color: #1e293b; line-height: 1.5; }
  h1 { font-size: 26pt; color: #0f172a; margin-bottom: 6pt; }
  h2 { font-size: 16pt; color: #0f172a; border-bottom: 1px solid #cbd5e1; padding-bottom: 4pt; margin-top: 24pt; }
  h3 { font-size: 13pt; color: #0f172a; margin-top: 18pt; }
  h4 { font-size: 11pt; color: #475569; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 10pt; }
  th, td { border: 1px solid #cbd5e1; padding: 6pt 8pt; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; }
  code { background: #f1f5f9; padding: 1pt 4pt; font-family: Consolas, monospace; font-size: 10pt; }
  pre  { background: #f1f5f9; padding: 8pt; font-family: Consolas, monospace; font-size: 9pt; white-space: pre-wrap; }
  .cover { text-align: center; padding: 40pt 0; }
  .cover .subtitle { font-style: italic; color: #475569; }
  .cover .meta { color: #64748b; font-size: 10pt; margin-top: 12pt; }
  .chart { text-align: center; margin: 12pt 0; }
  .chart img, .chart svg { max-width: 6.5in; height: auto; }
  .caption { font-style: italic; color: #64748b; font-size: 9pt; }
  .evidence { font-style: italic; color: #475569; font-size: 9pt; }
  footer { text-align: center; color: #64748b; font-size: 8pt; margin-top: 36pt; }
</style></head><body>
<div class="cover">
  <h1>${escHtml(meta.title)}</h1>
  ${meta.subtitle ? `<div class="subtitle">${escHtml(meta.subtitle)}</div>` : ""}
  <div class="meta">
    ${meta.customer ? `<div><strong>Customer:</strong> ${escHtml(meta.customer)}</div>` : ""}
    ${meta.author ? `<div><strong>Author:</strong> ${escHtml(meta.author)}</div>` : ""}
    ${meta.localTimezone ? `<div><strong>Local timezone:</strong> ${escHtml(meta.localTimezone)}</div>` : ""}
    <div><strong>Generated (UTC):</strong> ${escHtml(meta.generatedAt)}</div>
    ${meta.sessionId ? `<div><strong>Session:</strong> <code>${escHtml(meta.sessionId)}</code></div>` : ""}
  </div>
</div>
${sectionsHtml.join("\n")}
${evidenceHtml}
<footer>Report generated ${escHtml(meta.generatedAt)} by ai-assist-tim · template: ${escHtml(meta.template)}</footer>
</body></html>`;
  // Persist the HTML alongside chart files so the puppeteer base URL can be the report dir.
  // Save charts now so HTML img-src resolves on disk.
  const chartsDir = path.join(reportDir, "charts");
  fs.mkdirSync(chartsDir, { recursive: true });
  for (const c of charts) {
    fs.writeFileSync(path.join(chartsDir, c.name), c.svg, "utf-8");
  }
  return { html, charts };
}

function renderSectionHtml(section: ReportSection, nextChartName: () => string): string {
  const out: string[] = [];
  if (section.heading) {
    const level = Math.min(Math.max(section.headingLevel ?? 2, 1), 4);
    out.push(`<h${level}>${escHtml(section.heading)}</h${level}>`);
  }
  if (section.body) out.push(markdownToHtml(section.body));
  if (section.bullets && section.bullets.length > 0) {
    out.push("<ul>" + section.bullets.map((b) => `<li>${escHtml(b)}</li>`).join("") + "</ul>");
  }
  if (section.table) {
    out.push("<table>");
    if (section.table.caption) out.push(`<caption><strong>${escHtml(section.table.caption)}</strong></caption>`);
    out.push("<thead><tr>" + section.table.columns.map((c) => `<th>${escHtml(c)}</th>`).join("") + "</tr></thead>");
    out.push("<tbody>");
    for (const row of section.table.rows) {
      out.push("<tr>" + row.map((c) => `<td>${escHtml(c)}</td>`).join("") + "</tr>");
    }
    out.push("</tbody></table>");
  }
  if (section.chart) {
    const name = nextChartName();
    out.push(`<div class="chart"><img src="charts/${name}" alt="${escHtml(section.chart.caption ?? section.chart.kind)}"/>`);
    if (section.chart.caption) out.push(`<div class="caption">${escHtml(section.chart.caption)}</div>`);
    out.push("</div>");
  }
  if (section.evidence && section.evidence.length > 0) {
    out.push(`<div class="evidence">Evidence: ${section.evidence
      .map((e) => e.summary ? `<code>${escHtml(e.ref)}</code> (${escHtml(e.summary)})` : `<code>${escHtml(e.ref)}</code>`)
      .join(", ")}</div>`);
  }
  return out.join("\n");
}

function markdownToHtml(body: string): string {
  // Same lightweight conversion the markdown renderer does, just emitted as
  // HTML so puppeteer can paginate. Not a full md parser — handles paragraphs,
  // bold, inline code, and code blocks.
  const lines = body.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) {
      const txt = para.join(" ");
      out.push("<p>" + inline(txt) + "</p>");
      para = [];
    }
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      flushPara();
      if (inCode) {
        out.push("<pre>" + escHtml(codeBuf.join("\n")) + "</pre>");
        codeBuf = [];
        inCode = false;
      } else inCode = true;
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    if (line.trim() === "") { flushPara(); continue; }
    para.push(line);
  }
  flushPara();
  return out.join("\n");
}

function inline(s: string): string {
  return escHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function escHtml(s: string): string {
  return String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] as string));
}

export async function renderPdf(
  manifest: ReportManifest,
  reportDir: string,
): Promise<RenderedFile> {
  // puppeteer is intentionally not a declared dependency — it ships with a
  // ~170 MB Chromium download. Users who want PDF run `npm install puppeteer`
  // and the renderer auto-detects. Typed as `any` here so the compile path
  // doesn't require the puppeteer types either.
  let puppeteer: { launch: (opts?: unknown) => Promise<{ newPage: () => Promise<unknown>; close: () => Promise<void> }> };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    puppeteer = require("puppeteer");
  } catch {
    throw new Error("PDF requested but puppeteer is not installed. Run `npm install puppeteer` to enable PDF output.");
  }
  const { html } = buildHtml(manifest, reportDir);
  const htmlPath = path.join(reportDir, "report.html");
  fs.writeFileSync(htmlPath, html, "utf-8");
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage() as { goto: (url: string, opts?: unknown) => Promise<void>; pdf: (opts?: unknown) => Promise<Buffer> };
    await page.goto("file://" + htmlPath.replace(/\\/g, "/"), { waitUntil: "networkidle0" });
    const outPath = path.join(reportDir, "report.pdf");
    const buffer = await page.pdf({ path: outPath, format: "Letter", printBackground: true, margin: { top: "0.75in", right: "0.75in", bottom: "0.75in", left: "0.75in" } });
    return {
      format: "pdf",
      path: outPath,
      bytes: buffer.length,
      mime: "application/pdf",
    };
  } finally {
    await browser.close();
  }
}

/** Also export an HTML-only renderer for the always-available read-only format. */
export function renderHtml(
  manifest: ReportManifest,
  reportDir: string,
): RenderedFile {
  const { html } = buildHtml(manifest, reportDir);
  const outPath = path.join(reportDir, "report.html");
  fs.writeFileSync(outPath, html, "utf-8");
  return {
    format: "html",
    path: outPath,
    bytes: Buffer.byteLength(html),
    mime: "text/html",
  };
}
