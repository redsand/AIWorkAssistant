/**
 * DOCX renderer — produces an editable Microsoft Word document.
 *
 * Uses the `docx` npm package (pure JS, no native deps). Chart SVGs are
 * embedded as ImageRun with type:"svg" — Word ≥2016 renders SVG natively;
 * older versions show a placeholder.
 *
 * The output is intentionally minimal-styled so a downstream editor can
 * apply corporate branding without fighting the renderer.
 */

import * as fs from "fs";
import * as path from "path";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { renderChart } from "../charts/svg-charts";
import type { RenderedFile, ReportManifest, ReportSection } from "../types";

const HEADING_LEVELS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
};

function paragraphFromInline(line: string): Paragraph {
  // Very light inline parsing: **bold**, `code`. Anything else stays plain.
  const runs: TextRun[] = [];
  let i = 0;
  while (i < line.length) {
    const boldStart = line.indexOf("**", i);
    const codeStart = line.indexOf("`", i);
    const nextSpecial = (boldStart === -1) ? codeStart : (codeStart === -1) ? boldStart : Math.min(boldStart, codeStart);
    if (nextSpecial === -1) {
      runs.push(new TextRun({ text: line.slice(i) }));
      break;
    }
    if (nextSpecial > i) {
      runs.push(new TextRun({ text: line.slice(i, nextSpecial) }));
    }
    if (nextSpecial === boldStart) {
      const close = line.indexOf("**", nextSpecial + 2);
      if (close === -1) {
        runs.push(new TextRun({ text: line.slice(nextSpecial) }));
        break;
      }
      runs.push(new TextRun({ text: line.slice(nextSpecial + 2, close), bold: true }));
      i = close + 2;
    } else {
      const close = line.indexOf("`", nextSpecial + 1);
      if (close === -1) {
        runs.push(new TextRun({ text: line.slice(nextSpecial) }));
        break;
      }
      runs.push(new TextRun({ text: line.slice(nextSpecial + 1, close), font: "Consolas" }));
      i = close + 1;
    }
  }
  return new Paragraph({ children: runs });
}

function bodyToParagraphs(body: string): Paragraph[] {
  const out: Paragraph[] = [];
  const lines = body.split("\n");
  let inCode = false;
  let codeBuf: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("```")) {
      if (inCode) {
        out.push(new Paragraph({
          children: [new TextRun({ text: codeBuf.join("\n"), font: "Consolas", size: 18 })],
        }));
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (line.trim() === "") {
      out.push(new Paragraph({ text: "" }));
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      out.push(new Paragraph({ text: line.slice(2), bullet: { level: 0 } }));
      continue;
    }
    const numMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      out.push(new Paragraph({ text: numMatch[2], numbering: { reference: "default-numbered", level: 0 } }));
      continue;
    }
    out.push(paragraphFromInline(line));
  }
  if (inCode && codeBuf.length > 0) {
    out.push(new Paragraph({
      children: [new TextRun({ text: codeBuf.join("\n"), font: "Consolas", size: 18 })],
    }));
  }
  return out;
}

function buildTable(t: NonNullable<ReportSection["table"]>): Paragraph | Table {
  const totalWeight = (t.columnWeights ?? t.columns.map(() => 1)).reduce((a, b) => a + b, 0);
  const headerCells = t.columns.map((c) =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: c, bold: true })] })],
      shading: { fill: "F1F5F9" },
    }),
  );
  const headerRow = new TableRow({ children: headerCells, tableHeader: true });
  const dataRows = t.rows.map((row) =>
    new TableRow({
      children: row.map((cell) => new TableCell({
        children: bodyToParagraphs(String(cell ?? "")),
      })),
    }),
  );
  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: t.columns.map((_, i) => {
      const w = (t.columnWeights?.[i] ?? 1) / totalWeight;
      // Word column widths use DXA (twentieths of a point); 9000 ≈ 7.5"
      return Math.round(9000 * w);
    }),
  });
}

// 1x1 transparent PNG (smallest valid PNG). Used as the raster fallback
// required by docx's SvgMediaOptions. Word 2016+ renders the SVG natively;
// older Office versions show this near-invisible placeholder and the user
// references the SVG file in the charts/ sibling directory.
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function chartParagraphs(section: ReportSection, reportDir: string, chartIndex: { idx: number }): Paragraph[] {
  if (!section.chart) return [];
  chartIndex.idx += 1;
  const filename = `chart-${String(chartIndex.idx).padStart(2, "0")}.svg`;
  const svg = renderChart(section.chart);
  const chartsDir = path.join(reportDir, "charts");
  fs.mkdirSync(chartsDir, { recursive: true });
  fs.writeFileSync(path.join(chartsDir, filename), svg, "utf-8");
  const width = section.chart.width ?? 720;
  const height = section.chart.height ?? 360;
  const displayW = Math.min(Math.round(width * 0.75), 540);
  const displayH = Math.min(Math.round(height * 0.75), 270);
  const out: Paragraph[] = [];
  out.push(new Paragraph({
    children: [
      new ImageRun({
        data: Buffer.from(svg, "utf-8"),
        transformation: { width: displayW, height: displayH },
        type: "svg",
        fallback: {
          type: "png",
          data: TRANSPARENT_PNG,
        },
      }),
    ],
    alignment: AlignmentType.CENTER,
  }));
  if (section.chart.caption) {
    out.push(new Paragraph({
      children: [new TextRun({ text: section.chart.caption, italics: true, size: 20 })],
      alignment: AlignmentType.CENTER,
    }));
  }
  return out;
}

function sectionToDocxChildren(
  section: ReportSection,
  reportDir: string,
  chartIndex: { idx: number },
): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  if (section.heading) {
    const level = Math.min(Math.max(section.headingLevel ?? 2, 1), 4);
    out.push(new Paragraph({
      text: section.heading,
      heading: HEADING_LEVELS[level],
    }));
  }
  if (section.body) {
    out.push(...bodyToParagraphs(section.body));
  }
  if (section.bullets && section.bullets.length > 0) {
    for (const b of section.bullets) {
      out.push(new Paragraph({ text: b, bullet: { level: 0 } }));
    }
  }
  if (section.table) {
    if (section.table.caption) {
      out.push(new Paragraph({
        children: [new TextRun({ text: section.table.caption, bold: true })],
      }));
    }
    out.push(buildTable(section.table));
    out.push(new Paragraph({ text: "" }));
  }
  if (section.chart) {
    out.push(...chartParagraphs(section, reportDir, chartIndex));
  }
  if (section.evidence && section.evidence.length > 0) {
    const evidenceText = "Evidence: " + section.evidence
      .map((e) => e.summary ? `${e.ref} (${e.summary})` : e.ref)
      .join(", ");
    out.push(new Paragraph({
      children: [new TextRun({ text: evidenceText, italics: true, size: 20 })],
    }));
  }
  return out;
}

function coverParagraphs(manifest: ReportManifest): Paragraph[] {
  const meta = manifest.metadata;
  const out: Paragraph[] = [];
  out.push(new Paragraph({ text: meta.title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }));
  if (meta.subtitle) {
    out.push(new Paragraph({
      children: [new TextRun({ text: meta.subtitle, size: 28, italics: true })],
      alignment: AlignmentType.CENTER,
    }));
  }
  out.push(new Paragraph({ text: "" }));
  if (meta.customer) {
    out.push(new Paragraph({
      children: [new TextRun({ text: "Customer: ", bold: true }), new TextRun({ text: meta.customer })],
      alignment: AlignmentType.CENTER,
    }));
  }
  if (meta.author) {
    out.push(new Paragraph({
      children: [new TextRun({ text: "Author: ", bold: true }), new TextRun({ text: meta.author })],
      alignment: AlignmentType.CENTER,
    }));
  }
  if (meta.localTimezone) {
    out.push(new Paragraph({
      children: [new TextRun({ text: "Local timezone: ", bold: true }), new TextRun({ text: meta.localTimezone })],
      alignment: AlignmentType.CENTER,
    }));
  }
  out.push(new Paragraph({
    children: [
      new TextRun({ text: "Generated (UTC): ", bold: true }),
      new TextRun({ text: meta.generatedAt }),
    ],
    alignment: AlignmentType.CENTER,
  }));
  out.push(new Paragraph({ text: "" }));
  return out;
}

function evidenceAppendix(manifest: ReportManifest): (Paragraph | Table)[] {
  const evidence = manifest.evidence ?? [];
  if (evidence.length === 0) return [];
  const out: (Paragraph | Table)[] = [];
  out.push(new Paragraph({ text: "Evidence index", heading: HeadingLevel.HEADING_1 }));
  out.push(buildTable({
    columns: ["Ref", "Tool", "Called at (UTC)", "Summary"],
    columnWeights: [2, 3, 3, 8],
    rows: evidence.map((e) => [e.ref, e.toolName ?? "", e.calledAt ?? "", e.summary ?? ""]),
  }));
  return out;
}

export async function renderDocx(
  manifest: ReportManifest,
  reportDir: string,
): Promise<RenderedFile> {
  const chartIndex = { idx: 0 };
  const children: (Paragraph | Table)[] = [];
  children.push(...coverParagraphs(manifest));
  for (const section of manifest.sections) {
    children.push(...sectionToDocxChildren(section, reportDir, chartIndex));
  }
  children.push(...evidenceAppendix(manifest));
  children.push(new Paragraph({ text: "" }));
  children.push(new Paragraph({
    children: [new TextRun({
      text: `Report generated ${manifest.metadata.generatedAt} by ai-assist-tim · template: ${manifest.metadata.template}`,
      italics: true,
      size: 18,
      color: "64748B",
    })],
    alignment: AlignmentType.CENTER,
  }));

  const doc = new Document({
    creator: manifest.metadata.author ?? "ai-assist-tim",
    title: manifest.metadata.title,
    description: manifest.metadata.subtitle ?? manifest.metadata.template,
    numbering: {
      config: [{
        reference: "default-numbered",
        levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }],
      }],
    },
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(doc);
  const outPath = path.join(reportDir, "report.docx");
  fs.writeFileSync(outPath, buffer);
  return {
    format: "docx",
    path: outPath,
    bytes: buffer.length,
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}
