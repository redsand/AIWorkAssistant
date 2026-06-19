/**
 * Markdown renderer — always-available baseline. Produces a single .md
 * file with image references to chart files saved alongside.
 */

import * as fs from "fs";
import * as path from "path";
import { renderChart } from "../charts/svg-charts";
import type { RenderedFile, ReportManifest, ReportSection } from "../types";

const HEADING_HASH = ["#", "##", "###", "####"];

function escapeCell(s: string): string {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderSection(
  section: ReportSection,
  chartIndex: { idx: number },
  reportDir: string,
): string {
  const out: string[] = [];
  if (section.heading) {
    const level = Math.min(Math.max(section.headingLevel ?? 2, 1), 4);
    out.push(`${HEADING_HASH[level - 1]} ${section.heading}`);
    out.push("");
  }
  if (section.body) {
    out.push(section.body.trim());
    out.push("");
  }
  if (section.bullets && section.bullets.length > 0) {
    for (const b of section.bullets) out.push(`- ${b}`);
    out.push("");
  }
  if (section.table) {
    const { columns, rows, caption } = section.table;
    if (caption) out.push(`**${caption}**\n`);
    out.push("| " + columns.map(escapeCell).join(" | ") + " |");
    out.push("| " + columns.map(() => "---").join(" | ") + " |");
    for (const row of rows) {
      out.push("| " + row.map(escapeCell).join(" | ") + " |");
    }
    out.push("");
  }
  if (section.chart) {
    chartIndex.idx += 1;
    const filename = `chart-${String(chartIndex.idx).padStart(2, "0")}.svg`;
    const svg = renderChart(section.chart);
    const chartsDir = path.join(reportDir, "charts");
    fs.mkdirSync(chartsDir, { recursive: true });
    fs.writeFileSync(path.join(chartsDir, filename), svg, "utf-8");
    out.push(`![${section.chart.caption ?? section.chart.kind}](charts/${filename})`);
    if (section.chart.caption) {
      out.push(`<sub>${section.chart.caption}</sub>`);
    }
    out.push("");
  }
  if (section.evidence && section.evidence.length > 0) {
    out.push("**Evidence:** " + section.evidence
      .map((e) => e.summary ? `\`${e.ref}\` (${e.summary})` : `\`${e.ref}\``)
      .join(", "));
    out.push("");
  }
  return out.join("\n");
}

export function renderMarkdown(
  manifest: ReportManifest,
  reportDir: string,
): RenderedFile {
  const chartIndex = { idx: 0 };
  const lines: string[] = [];
  const meta = manifest.metadata;
  lines.push(`# ${meta.title}`);
  if (meta.subtitle) lines.push(`## ${meta.subtitle}`);
  lines.push("");
  if (meta.customer) lines.push(`**Customer:** ${meta.customer}  `);
  if (meta.author) lines.push(`**Author:** ${meta.author}  `);
  if (meta.localTimezone) lines.push(`**Local timezone:** ${meta.localTimezone}  `);
  lines.push(`**Generated (UTC):** ${meta.generatedAt}  `);
  if (meta.sessionId) lines.push(`**Source session:** \`${meta.sessionId}\`  `);
  if (meta.template) lines.push(`**Template:** ${meta.template}  `);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const section of manifest.sections) {
    lines.push(renderSection(section, chartIndex, reportDir));
  }

  if (manifest.evidence && manifest.evidence.length > 0) {
    lines.push("## Evidence index");
    lines.push("");
    lines.push("| Ref | Tool | Called at (UTC) | Summary |");
    lines.push("| --- | --- | --- | --- |");
    for (const e of manifest.evidence) {
      lines.push(`| \`${escapeCell(e.ref)}\` | ${escapeCell(e.toolName ?? "")} | ${escapeCell(e.calledAt ?? "")} | ${escapeCell(e.summary ?? "")} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Report generated ${meta.generatedAt} by ai-assist-tim · template: ${meta.template}*`);

  const outPath = path.join(reportDir, "report.md");
  const content = lines.join("\n");
  fs.writeFileSync(outPath, content, "utf-8");
  return {
    format: "markdown",
    path: outPath,
    bytes: Buffer.byteLength(content),
    mime: "text/markdown",
  };
}
