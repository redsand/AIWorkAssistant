/**
 * Report manifest types — the intermediate representation every renderer
 * consumes.
 *
 * Templates produce a ReportManifest from a chat session (or other source).
 * Renderers (markdown / docx / pdf / html) consume it and emit a file.
 * Storage indexes the resulting artifacts.
 */

export type ReportFormat = "markdown" | "docx" | "pdf" | "html";

/** Logical kind of section, used by renderers for styling and TOC. */
export type SectionKind =
  | "cover"
  | "executive_summary"
  | "timeline_table"
  | "findings"
  | "indicators"
  | "evidence_appendix"
  | "recommendations"
  | "gaps"
  | "footer"
  | "generic_text";

export interface ReportSection {
  kind: SectionKind;
  /** Heading text shown in the rendered document. Omit for footer / cover blocks. */
  heading?: string;
  /** Heading level 1-4. Default = 2. */
  headingLevel?: 1 | 2 | 3 | 4;
  /** Markdown body. Renderers may parse links, lists, code blocks, etc. */
  body?: string;
  /** Optional table — rendered as a real table in docx/html. */
  table?: ReportTable;
  /** Optional bullet list. */
  bullets?: string[];
  /** Optional embedded chart (rendered as SVG; PNG fallback when needed). */
  chart?: ReportChart;
  /** Evidence citations for this section (tc-xxx refs). Rendered as footnotes / inline. */
  evidence?: EvidenceRef[];
}

export interface ReportTable {
  caption?: string;
  /** Column headers. */
  columns: string[];
  /** Row data; one inner array per row, length = columns.length. */
  rows: string[][];
  /** Optional column widths (1..10 weights). Defaults to equal. */
  columnWeights?: number[];
}

export interface EvidenceRef {
  /** tc-xxx ref. */
  ref: string;
  /** Optional one-line summary of the evidence. */
  summary?: string;
  /** Optional source tool name. */
  toolName?: string;
  /** Optional UTC timestamp when the tool was called. */
  calledAt?: string;
}

export type ChartKind = "timeline" | "bar" | "pie";

export interface ReportChart {
  kind: ChartKind;
  caption?: string;
  /** Width in pixels (used by SVG viewBox). Default 720. */
  width?: number;
  /** Height in pixels. Default 360. */
  height?: number;
  /** Chart-specific data payload. */
  data: TimelineChartData | BarChartData | PieChartData;
}

export interface TimelineChartData {
  /** Sorted ascending by `at`. */
  events: Array<{
    at: string;     // ISO UTC
    label: string;
    /** Visual category — colors map per series; default = "default". */
    series?: string;
  }>;
  /** ISO UTC bounds; if omitted, derived from events. */
  startsAt?: string;
  endsAt?: string;
}

export interface BarChartData {
  /** Ordered bars left to right. */
  bars: Array<{ label: string; value: number; series?: string }>;
  /** y-axis caption. */
  yLabel?: string;
}

export interface PieChartData {
  slices: Array<{ label: string; value: number }>;
}

export interface ReportMetadata {
  /** Final document title shown on the cover. */
  title: string;
  /** Subtitle / customer name / investigation handle. */
  subtitle?: string;
  /** Free-form author label (e.g. "ai-assist-tim · investigator: tim"). */
  author?: string;
  /** Customer / org name (separate field so cover renders cleanly). */
  customer?: string;
  /** Display timezone for any "local time" columns (e.g. "MDT (UTC-6)"). */
  localTimezone?: string;
  /** ISO UTC generation time. */
  generatedAt: string;
  /** Originating session id (for back-reference). */
  sessionId?: string;
  /** Template id used. */
  template: string;
  /** Arbitrary tags. */
  tags?: string[];
}

export interface ReportManifest {
  metadata: ReportMetadata;
  sections: ReportSection[];
  /** Top-level evidence index — appended as a final appendix automatically
   *  if the template doesn't include one. */
  evidence?: EvidenceRef[];
}

/** Result of a single renderer run. */
export interface RenderedFile {
  format: ReportFormat;
  /** Absolute path on disk. */
  path: string;
  /** Size in bytes. */
  bytes: number;
  /** MIME type. */
  mime: string;
}

/** What the orchestrator returns from a generate() call. */
export interface GenerateReportResult {
  reportId: string;
  /** Absolute directory containing all artifacts and manifest.json. */
  directory: string;
  metadata: ReportMetadata;
  files: RenderedFile[];
  /** Warnings collected during rendering (e.g. PDF skipped, format not enabled). */
  warnings: string[];
}
